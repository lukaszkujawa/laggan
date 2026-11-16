import * as THREE from 'three/webgpu';
import {
  Fn, uniform, float, vec3, vec4, attribute, positionGeometry, normalGeometry, cameraPosition, distance, smoothstep,
  mix, normalize, cross, length, step, max, select, abs, sin, pow, fract, clamp, transformNormalToView, positionPrevious,
  positionWorld,
} from 'three/tsl';
import { U, windBend, fbm2, noise2, saturate3, lampPool } from '../core/tsl.js';

const REC = 13;
const TILE = 64;

export const GRASS_QUALITY = {
  low: { r0: 10, r1: 45, minDens: 0.3, cap0: 6000, cap1: 30000 },
  medium: { r0: 16, r1: 70, minDens: 0.3, cap0: 12000, cap1: 55000 },
  high: { r0: 24, r1: 100, minDens: 0.3, cap0: 24000, cap1: 90000 },
  ultra: { r0: 34, r1: 140, minDens: 0.28, cap0: 45000, cap1: 160000 },
};

const qrot = (q, v) => v.add(cross(q.xyz, cross(q.xyz, v).add(v.mul(q.w))).mul(2.0));

function grassMaterial(lod, uGrass) {
  const iPos = attribute('iPos', 'vec3');
  const iQuat = attribute('iQuat', 'vec4');
  const iScale = attribute('iScale', 'vec3');
  const iTint = attribute('iTint', 'vec3');
  const iRank = attribute('iRank', 'float');
  const wnd = attribute('_wind', 'vec3');
  const m = new THREE.MeshSSSNodeMaterial({ side: THREE.DoubleSide, roughness: 0.55 });

  m.positionNode = Fn(() => {
    const d = distance(cameraPosition.xz, iPos.xz);
    const r0 = uGrass.x, r1 = uGrass.y;
    const dens = mix(1.0, uGrass.z, smoothstep(r0.mul(1.2), r1, d));
    const vis = float(1).sub(smoothstep(dens.sub(0.08), dens, iRank)).toVar();
    vis.mulAssign(float(1).sub(smoothstep(r1.mul(0.82), r1, d)));
    const band = max(2.0, r0.mul(0.25));
    vis.mulAssign(lod === 0 ? float(1).sub(smoothstep(r0.sub(band), r0, d)) : smoothstep(r0.sub(band), r0, d));
    const hgt = float(1).sub(U.snow.mul(0.55));
    const p = positionGeometry.mul(iScale).toVar();
    p.y.mulAssign(vis.mul(hgt));
    p.x.mulAssign(mix(0.6, 1.0, vis));
    p.z.mulAssign(mix(0.6, 1.0, vis));
    const wp = iPos.add(qrot(iQuat, p));
    const phase = iPos.x.mul(0.37).add(iPos.z.mul(0.61)).add(wnd.z.mul(6.2831));
    const H = iScale.y.mul(0.4).mul(vis).mul(hgt);
    const bend = windBend(wnd, iPos.xz.add(p.xz), phase).mul(H.mul(0.9)).toVar();
    bend.y.subAssign(wnd.x.mul(wnd.x).mul(H).mul(0.15).mul(U.rain));
    // trample: blades bend away from the walker
    const away = wp.xz.sub(U.player.xz);
    const pd = length(away);
    const push = float(1).sub(smoothstep(0.2, 1.4, pd)).mul(wnd.x).mul(step(abs(wp.y.sub(U.player.y)), 2.5));
    const pushV = vec3(away.x.div(max(pd, 0.001)).mul(push).mul(H).mul(1.2), push.mul(H).mul(-0.6), away.y.div(max(pd, 0.001)).mul(push).mul(H).mul(1.2));
    const outP = select(vis.lessThan(0.01), vec3(0, -1e5, 0), wp.add(bend).add(pushV));
    positionPrevious.assign(outP);
    return outP;
  })();

  m.normalNode = Fn(() => transformNormalToView(normalize(mix(qrot(iQuat, normalGeometry), vec3(0, 1, 0), 0.6))))();

  const rnd = fract(wnd.z.mul(91.7).add(iRank.mul(13.1)));
  const h = clamp(wnd.x, 0.0, 1.0);
  const bloomMask = step(0.965, rnd).mul(smoothstep(0.75, 0.95, h)).mul(float(1).sub(U.snow));
  m.colorNode = Fn(() => {
    const root = vec3(0.022, 0.055, 0.01);
    const mid = vec3(0.1, 0.21, 0.028);
    const tip = vec3(0.33, 0.52, 0.06);
    const c = mix(root, mid, smoothstep(0.0, 0.45, h)).toVar();
    c.assign(mix(c, tip, smoothstep(0.4, 1.0, h)));
    const dry = smoothstep(0.55, 0.85, fbm2(positionWorld.xz.mul(0.03))).mul(smoothstep(0.5, 1.0, h));
    c.assign(mix(c, vec3(0.36, 0.33, 0.1), dry.mul(0.35)));
    c.mulAssign(iTint.mul(rnd.mul(0.3).add(0.85)));
    // scattered blossoms: heather, buttercup, clover
    const bloomCol = select(rnd.greaterThan(0.988), vec3(0.9, 0.75, 0.08), select(rnd.greaterThan(0.978), vec3(0.85, 0.85, 0.8), vec3(0.45, 0.12, 0.42)));
    c.assign(mix(c, bloomCol, bloomMask));
    c.assign(saturate3(c, U.fantasy.mul(0.25).add(1.0)));
    c.mulAssign(mix(1.0, 0.7, U.wetness));
    c.assign(mix(c, vec3(0.8, 0.84, 0.9), U.snow.mul(smoothstep(0.3, 1.0, h)).mul(0.85)));
    return vec4(c, 1.0);
  })();
  m.roughnessNode = mix(float(0.6), float(0.42), U.wetness);
  m.thicknessColorNode = vec3(0.45, 0.75, 0.1).mul(h);
  m.thicknessDistortionNode = float(0.3);
  m.thicknessAmbientNode = float(0.02);
  m.thicknessAttenuationNode = float(0.8);
  m.thicknessPowerNode = float(2.5);
  m.thicknessScaleNode = float(5.0);
  m.emissiveNode = Fn(() => {
    const lamp = lampPool(m.colorNode.rgb);
    // fantasy: bioluminescent tips breathing at night
    const glow = pow(h, 6.0).mul(U.night).mul(U.fantasy).mul(float(1).sub(U.snow)).mul(float(1).sub(U.rain.mul(0.7)));
    const pulse = sin(U.time.mul(0.9).add(positionWorld.x.mul(0.35)).add(positionWorld.z.mul(0.27)).add(rnd.mul(6.0))).mul(0.5).add(0.5);
    const patchy = smoothstep(0.45, 0.8, noise2(positionWorld.xz.mul(0.08).add(U.time.mul(0.01))));
    const tipGlow = mix(vec3(0.05, 0.6, 0.45), vec3(0.3, 0.35, 1.0), rnd).mul(glow).mul(pulse).mul(patchy).mul(0.35);
    return tipGlow.add(vec3(0.6, 0.3, 0.9).mul(bloomMask).mul(U.night).mul(U.fantasy).mul(0.6).mul(pulse)).add(lamp);
  })();
  return m;
}

export class Grass {
  constructor(scene, baseGeoLod0, baseGeoLod1, records, tiles) {
    this.scene = scene;
    this.records = records;
    this.tiles = new Map();
    for (const [tx, ty, first, count] of tiles) {
      let minY = 1e9, maxY = -1e9;
      for (let i = first; i < first + count; i += 7) { const y = records[i * REC + 1]; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      this.tiles.set(tx * 1000 + ty, { tx, ty, first, count, minY, maxY });
    }
    this.q = GRASS_QUALITY.high;
    this.uGrass = [uniform(new THREE.Vector4(24, 100, 0.3, 0)), uniform(new THREE.Vector4(24, 100, 0.3, 1))];
    this.mats = [grassMaterial(0, this.uGrass[0]), grassMaterial(1, this.uGrass[1])];
    this.bases = [baseGeoLod0, baseGeoLod1];
    this.lods = [this.makeLod(0), this.makeLod(1)];
    this.frustum = new THREE.Frustum();
    this.m = new THREE.Matrix4();
    this.lastKey = '';
  }

  makeLod(lod) {
    const base = this.bases[lod];
    const cap = lod === 0 ? this.q.cap0 : this.q.cap1;
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    for (const k of ['position', 'normal', 'uv', '_wind']) if (base.attributes[k]) geo.setAttribute(k, base.attributes[k]);
    // separate per-instance streams (interleaved instanced buffers misbehave on the WebGPU backend)
    const mk = (size) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size); return a; };
    const attrs = { iPos: mk(3), iQuat: mk(4), iScale: mk(3), iTint: mk(3), iRank: mk(1) };
    for (const [k, a] of Object.entries(attrs)) geo.setAttribute(k, a);
    geo.instanceCount = 0;
    const mesh = new THREE.Mesh(geo, this.mats[lod]);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = 'grass_lod' + lod;
    this.scene.add(mesh);
    return { mesh, geo, attrs, cap };
  }

  setQuality(q) {
    this.q = GRASS_QUALITY[q];
    for (const l of this.lods) { this.scene.remove(l.mesh); }
    this.lods = [this.makeLod(0), this.makeLod(1)];
    for (const u of this.uGrass) { u.value.x = this.q.r0; u.value.y = this.q.r1; u.value.z = this.q.minDens; }
    this.lastKey = '';
  }

  update(camera) {
    const e = camera.matrixWorld.elements;
    const key = e.map((v) => v.toFixed(2)).join(',');
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m);
    const planes = this.frustum.planes;
    const { r0, r1, minDens } = this.q;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const L0 = this.lods[0], L1 = this.lods[1];
    let n0 = 0, n1 = 0;
    const band = Math.max(2, r0 * 0.25);
    const rec = this.records;
    const put = (A, n, o, rank) => {
      const p = A.iPos.array, q = A.iQuat.array, sc = A.iScale.array, t = A.iTint.array;
      p[n * 3] = rec[o]; p[n * 3 + 1] = rec[o + 1]; p[n * 3 + 2] = rec[o + 2];
      q[n * 4] = rec[o + 3]; q[n * 4 + 1] = rec[o + 4]; q[n * 4 + 2] = rec[o + 5]; q[n * 4 + 3] = rec[o + 6];
      sc[n * 3] = rec[o + 7]; sc[n * 3 + 1] = rec[o + 8]; sc[n * 3 + 2] = rec[o + 9];
      t[n * 3] = rec[o + 10]; t[n * 3 + 1] = rec[o + 11]; t[n * 3 + 2] = rec[o + 12];
      A.iRank.array[n] = rank;
    };
    const hAbove = cy - (this.groundAt ? this.groundAt(cx, cz) : cy);
    const reach = Math.sqrt(Math.max(0, r1 * r1 - hAbove * hAbove));
    if (reach > 1) {
      const tx0 = Math.floor((cx - reach + 1200) / TILE), tx1 = Math.floor((cx + reach + 1200) / TILE);
      const ty0 = Math.floor((-cz - reach + 1200) / TILE), ty1 = Math.floor((-cz + reach + 1200) / TILE);
      const sph = new THREE.Sphere();
      for (let tx = tx0; tx <= tx1; tx++) {
        for (let ty = ty0; ty <= ty1; ty++) {
          const t = this.tiles.get(tx * 1000 + ty);
          if (!t) continue;
          const minx = tx * TILE - 1200, maxx = minx + TILE;
          const maxz = -(ty * TILE - 1200), minz = maxz - TILE;
          const ddx = Math.max(minx - cx, 0, cx - maxx), ddz = Math.max(minz - cz, 0, cz - maxz);
          if (ddx * ddx + ddz * ddz > r1 * r1) continue;
          sph.center.set((minx + maxx) / 2, (t.minY + t.maxY) / 2, (minz + maxz) / 2);
          sph.radius = 46 + (t.maxY - t.minY) / 2 + 1;
          if (!this.frustum.intersectsSphere(sph)) continue;
          const inv = 1 / t.count;
          for (let k = 0; k < t.count; k++) {
            const o = (t.first + k) * REC;
            const x = rec[o], y = rec[o + 1], z = rec[o + 2];
            const dx = x - cx, dz = z - cz;
            const d2 = dx * dx + dz * dz;
            if (d2 > r1 * r1) continue;
            const d = Math.sqrt(d2);
            const rank = k * inv;
            const sm = Math.min(Math.max((d - r0 * 1.2) / (r1 - r0 * 1.2), 0), 1);
            const dens = 1 + (minDens - 1) * sm * sm * (3 - 2 * sm);
            if (rank > dens) continue;
            let inside = true;
            for (let p = 0; p < 6; p++) {
              const pl = planes[p];
              if (pl.normal.x * x + pl.normal.y * y + pl.normal.z * z + pl.constant < -1.2) { inside = false; break; }
            }
            if (!inside) continue;
            if (d < r0 && n0 < L0.cap) { put(L0.attrs, n0, o, rank); n0++; }
            if (d > r0 - band && n1 < L1.cap) { put(L1.attrs, n1, o, rank); n1++; }
          }
        }
      }
    }
    for (const [L, n] of [[L0, n0], [L1, n1]]) {
      L.geo.instanceCount = n;
      L.mesh.visible = n > 0;
      for (const a of Object.values(L.attrs)) {
        a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, n) * a.itemSize); a.needsUpdate = true;
      }
    }
    this.count = n0 + n1;
  }
}
