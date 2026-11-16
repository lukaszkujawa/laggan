import * as THREE from 'three/webgpu';
import {
  Fn, uniform, float, vec3, vec4, attribute, positionLocal, cross, positionWorld, normalLocal, cameraPosition, distance,
  smoothstep, mix, normalize, transformNormalToView, positionPrevious, interleavedGradientNoise, screenCoordinate,
  materialColor, materialRoughness, floor, fract, length, sin, bool, normalView, texture, normalMap,
} from 'three/tsl';
import { U, windBend, windFlutter, saturate3, hash3, foliageVariety } from '../core/tsl.js';
import { toNodeMaterial, weatherLayer } from '../core/materials.js';
import { bakeImpostor, createImpostorMaterial, impostorShared } from './impostor.js';
import { speciesOf } from './species.js';

const CELL = 32;

export const CATS = {
  tree: { sway: 0.016, flutter: 0.05, radial: 0.55, sss: 1, shadow: true, impostor: true, cell: 512 },
  shrub: { sway: 0.05, flutter: 0.03, radial: 0.5, sss: 1, shadow: true, impostor: true, cell: 192 },
  small: { sway: 0.2, flutter: 0.012, radial: 0.35, sss: 1, shadow: false, impostor: false },
  // sizeK: an instance is drawn out to (bounding radius x sizeK) metres, so pebbles vanish long before boulders
  rock: { sway: 0, flutter: 0, radial: 0, sss: 0, shadow: true, impostor: false, sizeK: 150 },
  // knee-high pine / fir saplings: shrub-like, impostors beyond a few tens of metres
  sapling: { sway: 0.035, flutter: 0.03, radial: 0.4, sss: 1, shadow: true, impostor: true, cell: 192, shadowDist: 22 },
  // fallen wood, stumps, roots, bark: static, casts shadows, simply stops being drawn far away
  debris: { sway: 0, flutter: 0, radial: 0, sss: 0, shadow: true, impostor: false, sizeK: 120 },
  // tiny moss cushions on the forest floor
  moss: { sway: 0, flutter: 0, radial: 0, sss: 0, shadow: false, impostor: false, sizeK: 450 },
};

// LOD switch distance(s): [near-detail edge, far edge]. Beyond the far edge: impostors (trees/shrubs) or nothing.
// beyond this distance tree/shrub meshes stop casting shadows (impostors take over in the shadow maps)
export const SHADOW_MESH_DIST = { low: 25, medium: 40, high: 60, ultra: 90 };

export const QUALITY_DIST = {
  low: { tree: [8, 55], shrub: [14, 60], small: [8, 30], rock: [20, 150], boulder: [30, 160],
    youngTree: [8, 40], sapling: [8, 25], flower: [6, 22], moss: [8], debris: [6, 25], log: [12, 80] },
  medium: { tree: [10, 65], shrub: [18, 70], small: [12, 42], rock: [30, 220], boulder: [45, 240],
    youngTree: [12, 55], sapling: [10, 35], flower: [8, 30], moss: [12], debris: [9, 35], log: [18, 120] },
  high: { tree: [14, 110], shrub: [24, 110], small: [18, 80], rock: [40, 320], boulder: [60, 320],
    youngTree: [16, 75], sapling: [14, 45], flower: [10, 40], moss: [16], debris: [12, 45], log: [25, 160] },
  ultra: { tree: [22, 170], shrub: [36, 170], small: [26, 110], rock: [60, 450], boulder: [80, 450],
    youngTree: [24, 100], sapling: [20, 65], flower: [14, 55], moss: [22], debris: [16, 60], log: [35, 220] },
};


// share of plants showing early-autumn colour (mid-September in the Highlands)
export function autumnShare(name) {
  if (/tree_small|island_tree/.test(name)) return 0.22;
  if (/fern/.test(name)) return 0.18; // bracken turning
  if (/grass_medium/.test(name)) return 0.12;
  if (/nettle|weed_plant/.test(name)) return 0.08;
  if (/shrub/.test(name)) return 0.1;
  return 0.0; // conifers stay green
}

const NO_UV_COLORS = { twig: 0x2a5420, bark: 0x4a3a2c, trunk: 0x5b4a3b, dead: 0x4d4237 };
// the scanned foliage albedos are very dark; lift them towards a lush, slightly storybook green
const LEAF_TINT = [
  [/tree_small/, [2.0, 2.65, 1.05]],
  [/island_tree/, [2.1, 2.75, 1.1]],
  [/pine_tree/, [1.1, 1.42, 0.85]],
  [/fir_tree/, [1.0, 1.12, 0.85]],
  // sapling needles are scanned much darker than the grown trees' (fir sapling texels average rgb 26,19,9)
  [/pine_sapling/, [1.3, 1.7, 0.9]],
  [/fir_sapling/, [1.75, 2.3, 1.0]],
  [/nettle|weed_plant|grass_medium_02/, [1.08, 1.38, 0.74]],
  [/^moss_/, [1.1, 1.3, 0.75]],
  [/shrub/, [1.05, 1.3, 0.72]],
  [/fern|grass_medium/, [1.12, 1.45, 0.72]],
];

function fixSource(src, geo, modelName) {
  const m = src.clone();
  const hasUv = !!geo.attributes.uv;
  const name = m.name || '';
  let leaf = m.alphaTest > 0 || m.transparent || /twig|lea|fern|grass/.test(name);
  if (!hasUv) {
    m.map = null; m.normalMap = null; m.roughnessMap = null; m.metalnessMap = null;
    m.alphaTest = 0; m.transparent = false;
    const key = Object.keys(NO_UV_COLORS).find((k) => name.includes(k)) || 'bark';
    m.color.set(NO_UV_COLORS[key]);
    m.roughness = 0.85;
    leaf = key === 'twig';
  }
  if (m.transparent) { m.transparent = false; m.alphaTest = Math.max(m.alphaTest, 0.4); }
  if (m.alphaTest > 0 || /twig/.test(name)) m.side = THREE.DoubleSide;
  m.metalness = 0;
  m.userData.isLeaf = leaf;
  if (leaf) {
    const t = LEAF_TINT.find(([re]) => re.test(modelName));
    if (t) m.color.multiply(new THREE.Color(...t[1]));
  }
  return m;
}

function vegMaterial(src, { cat, centerY, height, ext, autumn = 0 }) {
  const c = CATS[cat];
  const leaf = src.userData.isLeaf;
  const Klass = leaf && c.sss > 0 ? THREE.MeshSSSNodeMaterial : THREE.MeshStandardNodeMaterial;
  const m = toNodeMaterial(src, Klass);
  m.side = src.side;
  const uFade = uniform(new THREE.Vector4(-2, -1, 1e6, 1e6 + 1));
  const iCenter = attribute('iCenter', 'vec4'); // xyz = instance origin, w = scale
  const w = weatherLayer({ porosity: cat === 'rock' ? 0.45 : 0.3, snow: cat === 'rock' ? 1.0 : 0.85, wetGloss: cat === 'rock' ? 0.2 : 0.35 });

  m.positionNode = Fn(() => {
    // own instancing (no InstancedMesh: avoids three's per-frame previous-matrix uploads)
    const iQuat = attribute('iQuat', 'vec4');
    const qrot = (q, v) => v.add(cross(q.xyz, cross(q.xyz, v).add(v.mul(q.w))).mul(2.0));
    normalLocal.assign(qrot(iQuat, normalLocal));
    const p = iCenter.xyz.add(qrot(iQuat, positionLocal.mul(iCenter.w))).toVar();
    if (c.sway > 0) {
      const wnd = attribute('_wind', 'vec3');
      const phase = iCenter.x.mul(0.37).add(iCenter.z.mul(0.61));
      const amp = iCenter.w.mul(height);
      p.addAssign(windBend(wnd, p.xz, phase).mul(amp.mul(c.sway)));
      if (leaf) p.addAssign(normalLocal.mul(windFlutter(wnd, phase.add(positionLocal.x.mul(3.0)))).mul(c.flutter).mul(iCenter.w));
    }
    positionPrevious.assign(p); // camera-only motion vectors (instances are re-packed every frame)
    return p;
  })();

  const d = distance(cameraPosition, iCenter.xyz);
  m.maskNode = Fn(() => {
    const dv = interleavedGradientNoise(screenCoordinate.xy);
    const visIn = smoothstep(uFade.x, uFade.y, d);
    const visOut = float(1).sub(smoothstep(uFade.z, uFade.w, d));
    return dv.lessThan(visOut).and(float(1).sub(dv).lessThan(visIn));
  })();
  m.maskShadowNode = bool(true);

  m.colorNode = Fn(() => {
    const col = materialColor.rgb.toVar();
    // living plants get the storybook saturation lift; stone and dead wood stay muted
    const solid = cat === 'rock' || cat === 'debris';
    col.assign(saturate3(col, solid ? float(0.85) : U.fantasy.mul(0.18).add(1.0)));
    const seed = fract(iCenter.x.mul(0.123).add(iCenter.z.mul(0.789)));
    if (leaf) col.assign(foliageVariety(col, seed, float(autumn)));
    else col.mulAssign(seed.mul(0.2).add(0.9));
    return vec4(w.color(col), materialColor.a);
  })();
  m.roughnessNode = w.roughness(materialRoughness);

  if (leaf && c.radial > 0) {
    // soft, volumetric canopy shading: bend normals towards the crown's outward direction
    const base = src.normalMap && src.map ? normalMap(texture(src.normalMap)) : normalView;
    m.normalNode = Fn(() => {
      const ctr = iCenter.xyz.add(vec3(0, centerY, 0).mul(iCenter.w));
      const rdir = normalize(positionWorld.sub(ctr).div(vec3(ext.x, ext.y, ext.z).mul(iCenter.w)));
      return normalize(mix(base, transformNormalToView(rdir), c.radial));
    })();
  }
  if (leaf && Klass === THREE.MeshSSSNodeMaterial) {
    // backlit leaves glow a clear yellow-green
    m.thicknessColorNode = materialColor.rgb.mul(vec3(1.1, 1.35, 0.45)).add(vec3(0.03, 0.06, 0.0));
    m.thicknessDistortionNode = float(0.25);
    m.thicknessAmbientNode = float(0.03);
    m.thicknessAttenuationNode = float(0.9);
    m.thicknessPowerNode = float(3.0);
    m.thicknessScaleNode = float(cat === 'tree' ? 6.0 : 4.0);
    // fantasy: glow-berries and lichen sparks waking up after dark
    m.emissiveNode = Fn(() => {
      const gp = positionWorld.mul(5.0);
      const gh = hash3(floor(gp));
      const gd = length(fract(gp).sub(0.5));
      const pulse = sin(U.time.mul(gh.mul(2.0).add(0.8)).add(gh.mul(40.0))).mul(0.45).add(0.55);
      const gcol = mix(vec3(0.3, 0.95, 0.8), vec3(1.0, 0.55, 0.2), smoothstep(0.49, 0.51, fract(gh.mul(731.0))));
      return gcol.mul(smoothstep(0.32, 0.05, gd)).mul(smoothstep(0.992, 0.993, gh)).mul(U.night).mul(U.fantasy).mul(pulse).mul(3.0);
    })();
  }
  m.userData.fade = uFade;
  return m;
}

function frustumPlanes(frustum, out) {
  for (let i = 0; i < 6; i++) {
    const p = frustum.planes[i];
    out[i * 4] = p.normal.x; out[i * 4 + 1] = p.normal.y; out[i * 4 + 2] = p.normal.z; out[i * 4 + 3] = p.constant;
  }
  return out;
}
function sphereIn(pl, x, y, z, r) {
  for (let i = 0; i < 24; i += 4) if (pl[i] * x + pl[i + 1] * y + pl[i + 2] * z + pl[i + 3] < -r) return false;
  return true;
}

export class Vegetation {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.models = [];
    this.quality = 'high';
    this.planes = new Float32Array(24);
    this.frustum = new THREE.Frustum();
    this.projScreen = new THREE.Matrix4();
    this.lastKey = '';
  }

  async addModel(name, gltf, records, nodes) {
    const sp = speciesOf(name);
    const cat = sp.cat;
    const c = CATS[cat];
    const lods = [];
    for (const nodeName of nodes) {
      const node = gltf.scene.getObjectByName(nodeName);
      if (!node) continue;
      const parts = [];
      node.traverse((o) => { if (o.isMesh) parts.push({ geometry: o.geometry, material: o.material }); });
      lods.push(parts);
    }
    if (!lods.length) return;
    // some exported LOD1 materials lost their textures (flat white): reuse the LOD0 material
    for (let li = 1; li < lods.length; li++) {
      lods[li].forEach((part, j) => {
        if (part.material.map || !part.geometry.attributes.uv) return;
        const ref = lods[0][j] || lods[0][0];
        if (ref && ref.material.map) part.material = ref.material;
      });
    }
    const box = new THREE.Box3();
    for (const p of lods[0]) { p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox); }
    const size = box.getSize(new THREE.Vector3());
    const ext = new THREE.Vector3(Math.max(size.x, size.z) * 0.5, size.y * 0.5, Math.max(size.x, size.z) * 0.5);
    const centerY = box.min.y + size.y * 0.55;
    const radius = 0.5 * size.length();

    const n = records.length / 10;
    const mats = new Float32Array(n * 8); // x, y, z, scale, qx, qy, qz, qw
    const scl = new Float32Array(n);
    const cells = new Map();
    for (let i = 0; i < n; i++) {
      const r = i * 10, o = i * 8;
      const sc = Math.max(records[r + 7], records[r + 8], records[r + 9]);
      mats[o] = records[r]; mats[o + 1] = records[r + 1]; mats[o + 2] = records[r + 2]; mats[o + 3] = sc;
      mats[o + 4] = records[r + 3]; mats[o + 5] = records[r + 4]; mats[o + 6] = records[r + 5]; mats[o + 7] = records[r + 6];
      scl[i] = sc;
      const key = Math.floor((records[r] + 1200) / CELL) * 1000 + Math.floor((records[r + 2] + 1200) / CELL);
      let arr = cells.get(key);
      if (!arr) { arr = []; cells.set(key, arr); }
      arr.push(i);
    }
    for (const [k, v] of cells) cells.set(k, Int32Array.from(v));

    const model = { name, cat, range: sp.range, lods: [], mats, scl, cells, count: n, radius };
    lods.forEach((parts, li) => {
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
     
      const cattr = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
     
      const lod = { meshes: [], attr, cattr, count: 0, fades: [], buf: attr.array, cbuf: cattr.array };
      if (c.shadow && c.impostor) {
        const nattr = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
        const ncattr = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
        lod.ns = { attr: nattr, cattr: ncattr, buf: nattr.array, cbuf: ncattr.array, count: 0, meshes: [] };
      }
      for (const part of parts) {
        const src = fixSource(part.material, part.geometry, name);
        const geo = new THREE.InstancedBufferGeometry();
        geo.index = part.geometry.index;
        for (const [k, a] of Object.entries(part.geometry.attributes)) geo.setAttribute(k, a);
        geo.setAttribute('iCenter', cattr); geo.setAttribute('iQuat', attr);
        geo.instanceCount = 0;
        const mat = vegMaterial(src, { cat, centerY, height: size.y, ext, autumn: autumnShare(name) });
        lod.fades.push(mat.userData.fade);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false;
        // the detailed LOD never renders into the shadow maps: the next LOD acts as its shadow proxy
        mesh.castShadow = c.shadow && !(li === 0 && lods.length > 1);
        mesh.receiveShadow = true;
        mesh.name = `${name}_lod${li}`;
        this.scene.add(mesh);
        lod.meshes.push(mesh);
        if (lod.ns) {
          // same material, separate instance stream for far instances that do not cast shadows
          const g2 = new THREE.InstancedBufferGeometry();
        g2.index = part.geometry.index;
        for (const [k, a] of Object.entries(part.geometry.attributes)) g2.setAttribute(k, a);
        g2.setAttribute('iCenter', lod.ns.cattr); g2.setAttribute('iQuat', lod.ns.attr);
        g2.instanceCount = 0;
          const m2 = new THREE.Mesh(g2, mat);
          m2.frustumCulled = false; m2.castShadow = false; m2.receiveShadow = true;
          m2.name = `${name}_lod${li}_ns`;
          this.scene.add(m2);
          lod.ns.meshes.push(m2);
        }
      }
      model.lods.push(lod);
    });
    if (c.impostor) {
      const parts = lods[0].map((pp) => ({ geometry: pp.geometry, material: fixSource(pp.material, pp.geometry, name) }));
      const bake = bakeImpostor(this.renderer, parts, { cell: c.cell, radial: c.radial });
      const mat = createImpostorMaterial(bake, { autumn: autumnShare(name), fadeNear: 150, fadeBand: 15, flipY: !!this.renderer.backend.isWebGPUBackend });
      const geo = new THREE.InstancedBufferGeometry();
      const plane = new THREE.PlaneGeometry(1, 1);
      geo.index = plane.index;
      geo.setAttribute('position', plane.attributes.position);
      geo.setAttribute('normal', plane.attributes.normal);
      geo.setAttribute('uv', plane.attributes.uv);
      const pa = new Float32Array(n * 3), qa = new Float32Array(n * 4), sa = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const r = i * 10;
        pa.set(records.subarray(r, r + 3), i * 3); qa.set(records.subarray(r + 3, r + 7), i * 4); sa.set(records.subarray(r + 7, r + 10), i * 3);
      }
      geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(pa, 3));
      geo.setAttribute('iQuat', new THREE.InstancedBufferAttribute(qa, 4));
      geo.setAttribute('iScale', new THREE.InstancedBufferAttribute(sa, 3));
      geo.instanceCount = n;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = name + '_impostor';
      this.scene.add(mesh);
      model.impostor = { mesh, mat, bake };
    }
    this.models.push(model);
    this.applyQuality(this.quality);
  }

  applyQuality(q) {
    this.quality = q;
    const D = QUALITY_DIST[q];
    this.shadowDist = SHADOW_MESH_DIST[q];
    impostorShared.shadowDist.value = this.shadowDist;
    for (const m of this.models) {
      const edges = D[m.range];
      const nl = m.lods.length;
      const far = edges[edges.length - 1];
      const ranges = nl === 1 || edges.length === 1 ? m.lods.map((_, i) => (i === 0 ? [0, far] : [far, far]))
        : m.lods.map((_, i) => (i === 0 ? [0, edges[0]] : i === 1 ? [edges[0], far] : [far, far]));
      m.lods.forEach((lod, i) => {
        const [near, fr] = ranges[i];
        const bandN = Math.max(3, near * 0.1);
        const bandF = Math.max(3, fr * 0.1);
        // LOD1 is also selected inside the LOD0 range: there it only casts shadows (its main-pass fade mask discards it)
        lod.selNear = i === 0 || (i === 1 && CATS[m.cat].shadow) ? 0 : near - bandN;
        lod.selFar = fr;
        for (const f of lod.fades) f.value.set(i === 0 ? -2 : near - bandN, i === 0 ? -1 : near, fr - bandF, fr);
      });
      m.maxFar = far;
      if (m.impostor) {
        m.impostor.mat.userData.fade.uFadeNear.value = far;
        m.impostor.mat.userData.fade.uFadeBand.value = Math.max(3, far * 0.1);
      }
    }
    this.lastKey = '';
  }

  update(camera) {
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    const key = e.map((v) => v.toFixed(2)).join(',') + camera.fov;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const pl = frustumPlanes(this.frustum, this.planes);
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    for (const m of this.models) {
      const far = m.maxFar;
      for (const lod of m.lods) { lod.count = 0; if (lod.ns) lod.ns.count = 0; }
      const sd = Math.min(this.shadowDist || 45, CATS[m.cat].shadowDist ?? Infinity);
      const i0 = Math.floor((cx - far + 1200) / CELL), i1 = Math.floor((cx + far + 1200) / CELL);
      const j0 = Math.floor((cz - far + 1200) / CELL), j1 = Math.floor((cz + far + 1200) / CELL);
      const mats = m.mats, scl = m.scl, R = m.radius;
      const margin = CATS[m.cat].shadow ? 30 : 2;
      const sizeK2 = CATS[m.cat].sizeK ? CATS[m.cat].sizeK ** 2 : Infinity;
      const nl = m.lods.length;
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const cell = m.cells.get(i * 1000 + j);
          if (!cell) continue;
          const minx = i * CELL - 1200, minz = j * CELL - 1200;
          const ddx = Math.max(minx - cx, 0, cx - (minx + CELL));
          const ddz = Math.max(minz - cz, 0, cz - (minz + CELL));
          if (ddx * ddx + ddz * ddz > far * far) continue;
          for (let k = 0; k < cell.length; k++) {
            const idx = cell[k];
            const o = idx * 8;
            const x = mats[o], y = mats[o + 1], z = mats[o + 2];
            const dx = x - cx, dy = y - cy, dz = z - cz;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > far * far) continue;
            const r = R * scl[idx];
            if (d2 > r * r * sizeK2) continue;
            if (!sphereIn(pl, x, y + r * 0.5, z, r + margin)) continue;
            const d = Math.sqrt(d2);
            for (let l = 0; l < nl; l++) {
              const lod = m.lods[l];
              if (d >= lod.selNear && d < lod.selFar) {
                const tgt = lod.ns && d > sd ? lod.ns : lod;
                // shadow-only proxies (LOD1 inside the LOD0 range) are useless beyond the shadow distance
                if (tgt === lod.ns && l === 1 && d < m.lods[0].selFar) continue;
                const b = tgt.buf, cb = tgt.cbuf, c4 = tgt.count * 4;
                b[c4] = mats[o + 4]; b[c4 + 1] = mats[o + 5]; b[c4 + 2] = mats[o + 6]; b[c4 + 3] = mats[o + 7];
                cb[c4] = x; cb[c4 + 1] = y; cb[c4 + 2] = z; cb[c4 + 3] = mats[o + 3];
                tgt.count++;
              }
            }
          }
        }
      }
      for (const lod of m.lods) {
        for (const L of lod.ns ? [lod, lod.ns] : [lod]) {
          L.attr.clearUpdateRanges(); L.attr.addUpdateRange(0, Math.max(1, L.count) * 4); L.attr.needsUpdate = true;
          L.cattr.clearUpdateRanges(); L.cattr.addUpdateRange(0, Math.max(1, L.count) * 4); L.cattr.needsUpdate = true;
          for (const mesh of L.meshes) { mesh.geometry.instanceCount = L.count; mesh.visible = L.count > 0; }
        }
      }
    }
  }
}
