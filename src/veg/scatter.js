import * as THREE from 'three/webgpu';
import { speciesOf } from './species.js';

// Densify the scanned vegetation: new plants are seeded around existing ones (so they stay where the
// landscape already supports vegetation), mixing in other species of the same category for variety.
// Roads, water, buildings and garden furniture are rasterised into a keep-out mask first.

const HALF = 1200;
const CELL = 1; // metres per mask cell
const N = (2 * HALF) / CELL;

function rasterise(mask, roots) {
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (const root of roots) {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh) return;
      const pos = o.geometry.attributes.position;
      const idx = o.geometry.index ? o.geometry.index.array : null;
      const triCount = idx ? idx.length / 3 : pos.count / 3;
      const m = o.matrixWorld;
      for (let t = 0; t < triCount; t++) {
        const i0 = idx ? idx[t * 3] : t * 3, i1 = idx ? idx[t * 3 + 1] : t * 3 + 1, i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(m);
        b.fromBufferAttribute(pos, i1).applyMatrix4(m);
        c.fromBufferAttribute(pos, i2).applyMatrix4(m);
        const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) + HALF) / CELL));
        const x1 = Math.min(N - 1, Math.floor((Math.max(a.x, b.x, c.x) + HALF) / CELL));
        const z0 = Math.max(0, Math.floor((Math.min(a.z, b.z, c.z) + HALF) / CELL));
        const z1 = Math.min(N - 1, Math.floor((Math.max(a.z, b.z, c.z) + HALF) / CELL));
        if (x1 - x0 > 400 || z1 - z0 > 400) continue; // skip degenerate giants
        // tiny triangles: mark the bbox directly
        if (x1 - x0 <= 1 && z1 - z0 <= 1) {
          for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) mask[z * N + x] = 1;
          continue;
        }
        const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
        if (Math.abs(d) < 1e-9) continue;
        for (let z = z0; z <= z1; z++) {
          const pz = (z + 0.5) * CELL - HALF;
          for (let x = x0; x <= x1; x++) {
            const px = (x + 0.5) * CELL - HALF;
            const l1 = ((b.z - c.z) * (px - c.x) + (c.x - b.x) * (pz - c.z)) / d;
            const l2 = ((c.z - a.z) * (px - c.x) + (a.x - c.x) * (pz - c.z)) / d;
            if (l1 >= -0.05 && l2 >= -0.05 && l1 + l2 <= 1.05) mask[z * N + x] = 1;
          }
        }
      }
    });
  }
}

function dilate(src, r) {
  // separable max filter
  const tmp = new Uint8Array(N * N), out = new Uint8Array(N * N);
  for (let z = 0; z < N; z++) {
    let run = -1e9;
    for (let x = 0; x < N; x++) { if (src[z * N + x]) run = x; if (x - run <= r) tmp[z * N + x] = 1; }
    run = 1e9;
    for (let x = N - 1; x >= 0; x--) { if (src[z * N + x]) run = x; if (run - x <= r) tmp[z * N + x] = 1; }
  }
  for (let x = 0; x < N; x++) {
    let run = -1e9;
    for (let z = 0; z < N; z++) { if (tmp[z * N + x]) run = z; if (z - run <= r) out[z * N + x] = 1; }
    run = 1e9;
    for (let z = N - 1; z >= 0; z--) { if (tmp[z * N + x]) run = z; if (run - z <= r) out[z * N + x] = 1; }
  }
  return out;
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// scatter group of a model (null: hand-placed props, saplings, moss and rocks are left as exported)
const catOf = (name) => speciesOf(name).scatter;

// spawn rules per group: children per parent, distance range (m), min spacing to other plants of the group (m).
// The November export already places ~45% more shrubs and ~70% more ferns, so those get fewer extras than before.
const RULES = {
  tree: { extra: 1.7, dist: [3.0, 12], spacing: 2.4, clear: 4 },
  shrub: { extra: 0.8, dist: [1.5, 6], spacing: 1.1, clear: 2 },
  small: { extra: 0.6, dist: [0.6, 2.6], spacing: 0.35, clear: 1 },
  // wildflowers, nettles and weeds: small clumps around each placed plant
  flower: { extra: 1.2, dist: [0.3, 1.6], spacing: 0.22, clear: 1 },
};

/**
 * @param vegArr [{name, records(Float32Array, 10 floats per instance)}]
 * @param blockers Object3D roots to keep clear (roads, water, buildings, surroundings)
 * @param hf Heightfield
 * @returns new vegArr with denser records
 */
export function densify(vegArr, blockers, hf, { density = 1, cats = ['tree', 'shrub', 'small', 'flower'] } = {}) {
  const t0 = performance.now();
  const base = new Uint8Array(N * N);
  rasterise(base, blockers);
  const masks = {};
  for (const [cat, r] of Object.entries(RULES)) masks[cat] = dilate(base, Math.round(r.clear / CELL));
  const blocked = (cat, x, z) => {
    const ix = Math.floor((x + HALF) / CELL), iz = Math.floor((z + HALF) / CELL);
    if (ix < 0 || iz < 0 || ix >= N || iz >= N) return true;
    return masks[cat][iz * N + ix] === 1;
  };

  const rnd = mulberry(1337);
  const byCat = { tree: [], shrub: [], small: [], flower: [] };
  for (const v of vegArr) { const c = catOf(v.name); if (byCat[c]) byCat[c].push(v); }
  const out = new Map(vegArr.map((v) => [v.name, [v.records]]));

  for (const [cat, models] of Object.entries(byCat)) {
    if (!models.length || !cats.includes(cat)) continue;
    const rule = RULES[cat];
    // spacing hash for the whole category
    const cs = rule.spacing;
    const occ = new Set();
    const key = (x, z) => Math.floor(x / cs) * 100000 + Math.floor(z / cs);
    for (const m of models) for (let i = 0; i < m.records.length; i += 10) occ.add(key(m.records[i], m.records[i + 2]));
    // variety: children are often a different species (weighted towards the rarer ones)
    const weights = models.map((m) => Math.sqrt(m.records.length / 10));
    const wsum = weights.reduce((a, b) => a + b, 0);
    const pick = (parent) => {
      if (rnd() < 0.45) return parent;
      let r = rnd() * wsum;
      for (let i = 0; i < models.length; i++) { r -= weights[i]; if (r <= 0) return models[i]; }
      return models[models.length - 1];
    };
    const sampleScale = (m) => {
      const n = m.records.length / 10;
      const i = Math.floor(rnd() * n) * 10;
      return m.records[i + 8] * (0.8 + rnd() * 0.3);
    };
    const add = new Map(models.map((m) => [m.name, []]));
    for (const m of models) {
      const r = m.records;
      for (let i = 0; i < r.length; i += 10) {
        let k = Math.floor(rule.extra * density + rnd());
        while (k-- > 0) {
          const child = pick(m);
          const ang = rnd() * Math.PI * 2;
          const dist = rule.dist[0] + rnd() * (rule.dist[1] - rule.dist[0]);
          const x = r[i] + Math.cos(ang) * dist, z = r[i + 2] + Math.sin(ang) * dist;
          if (blocked(cat, x, z)) continue;
          const kk = key(x, z);
          if (occ.has(kk)) continue;
          occ.add(kk);
          const s = sampleScale(child);
          const yaw = rnd() * Math.PI * 2;
          add.get(child.name).push(x, hf.sample(x, z) - 0.05, z, 0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2), s, s, s);
        }
      }
    }
    for (const [name, arr] of add) if (arr.length) out.get(name).push(new Float32Array(arr));
  }

  let before = 0, after = 0;
  const res = vegArr.map((v) => {
    const parts = out.get(v.name);
    const total = parts.reduce((a, p) => a + p.length, 0);
    const recs = new Float32Array(total);
    let o = 0;
    for (const p of parts) { recs.set(p, o); o += p.length; }
    before += v.records.length / 10; after += total / 10;
    return { ...v, records: recs };
  });
  console.log(`[scatter] ${before} -> ${after} plants in ${(performance.now() - t0).toFixed(0)} ms`);
  return res;
}
