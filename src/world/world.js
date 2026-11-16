import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  Fn, float, vec2, vec3, vec4, mix, smoothstep, step, clamp, sin, abs, fract, texture, uv, attribute, positionWorld,
  normalWorld, materialColor, materialRoughness, dot, If, select, pow,
} from 'three/tsl';
import { U, noise2, fbm2, saturate3, lampPool } from '../core/tsl.js';
import { toNodeMaterial, weatherLayer, rippleNormal, baseNormal } from '../core/materials.js';
import { groundDetail, roadDetail, wallWear, proceduralBump } from '../core/detail.js';
import { normalView, diffuseColor } from 'three/tsl';

let HEIGHT_AT = null; // TSL terrain-height function (set by buildStatic)

// ------------------------------------------------------------------ helpers
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function strHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Assign a per-window random id to glass geometry by clustering connected triangles.
function addWindowIds(geo, seed, kind) {
  const pos = geo.attributes.position;
  const idx = geo.index ? geo.index.array : null;
  const triCount = idx ? idx.length / 3 : pos.count / 3;
  const vi = (t, k) => (idx ? idx[t * 3 + k] : t * 3 + k);
  const parent = new Int32Array(pos.count).map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const keyMap = new Map();
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * 50)},${Math.round(pos.getY(i) * 50)},${Math.round(pos.getZ(i) * 50)}`;
    const o = keyMap.get(k);
    if (o === undefined) keyMap.set(k, i); else uni(i, o);
  }
  for (let t = 0; t < triCount; t++) { uni(vi(t, 0), vi(t, 1)); uni(vi(t, 1), vi(t, 2)); }
  const boxes = new Map();
  for (let i = 0; i < pos.count; i++) {
    const r = find(i);
    let b = boxes.get(r);
    if (!b) { b = new THREE.Box3(); boxes.set(r, b); }
    b.expandByPoint(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
  }
  const roots = [...boxes.keys()];
  const cp = new Map(roots.map((r) => [r, r]));
  const f2 = (r) => { while (cp.get(r) !== r) r = cp.get(r); return r; };
  for (let i = 0; i < roots.length; i++) {
    const bi = boxes.get(roots[i]).clone().expandByScalar(0.13);
    for (let j = i + 1; j < roots.length; j++) {
      if (bi.intersectsBox(boxes.get(roots[j]).clone().expandByScalar(0.13))) {
        const a = f2(roots[i]), b = f2(roots[j]);
        if (a !== b) cp.set(a, b);
      }
    }
  }
  const rnd = mulberry(seed);
  const ids = new Map();
  const arr = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const c = f2(find(i));
    let v = ids.get(c);
    if (v === undefined) { v = rnd(); ids.set(c, v); }
    arr[i * 2] = v;
    arr[i * 2 + 1] = kind;
  }
  geo.setAttribute('aWin', new THREE.BufferAttribute(arr, 2));
}

const KIND_BY_STYLE = { dwelling: 1.0, store: 0.85, hall: 0.6, church: 0.55, steading: 0.5, shed: 0.0 };

// Bake world transforms and merge meshes sharing a material + attribute layout
function mergeByMaterial(root, { onGeometry } = {}) {
  root.updateMatrixWorld(true);
  const groups = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mat = o.material;
    const geo = o.geometry.clone();
    geo.applyMatrix4(o.matrixWorld);
    if (onGeometry) onGeometry(geo, o, mat);
    const sig = mat.uuid + '|' + Object.keys(geo.attributes).sort().join(',') + '|' + (geo.index ? 'i' : 'n');
    let g = groups.get(sig);
    if (!g) { g = { mat, geos: [] }; groups.set(sig, g); }
    g.geos.push(geo);
  });
  const out = [];
  for (const { mat, geos } of groups.values()) {
    for (const gg of geos) for (const k of Object.keys(gg.morphAttributes)) delete gg.morphAttributes[k];
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!merged) {
      console.warn('merge failed', mat.name);
      for (const gg of geos) { const m = new THREE.Mesh(gg, mat); m.name = mat.name; out.push(m); }
      continue;
    }
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    const m = new THREE.Mesh(merged, mat);
    m.name = mat.name;
    out.push(m);
  }
  return out;
}

// ------------------------------------------------------------------ material recipes
// each window keeps its own evening / morning schedule (aWin = random id, building kind)
const windowEmissive = Fn(() => {
  const win = attribute('aWin', 'vec2');
  const id = win.x, kind = win.y;
  const h1 = fract(id.mul(17.13)), h2 = fract(id.mul(31.71)), h3 = fract(id.mul(57.29)), h4 = fract(id.mul(91.37));
  const hr = U.hour;
  const hh = select(hr.lessThan(6.0), hr.add(24.0), hr);
  const eveOn = h1.mul(4.0).add(15.5);
  const eveOff = h2.mul(4.5).add(21.0);
  const on = float(0).toVar();
  If(hh.greaterThan(eveOn).and(hh.lessThan(eveOff)), () => { on.assign(1.0); });
  If(h3.lessThan(0.55).and(hr.greaterThan(h4.mul(1.5).add(5.8))).and(hr.lessThan(h4.mul(1.2).add(7.8))), () => { on.assign(1.0); });
  If(h4.greaterThan(0.93).and(hr.greaterThan(1.5)).and(hr.lessThan(5.0)), () => { on.assign(1.0); });
  If(h1.greaterThan(0.82), () => { on.assign(0.0); });
  on.mulAssign(step(0.001, kind).mul(step(h2.mul(0.999), kind)));
  // colour temperature varies per window: candle-orange 2200K .. halogen 3500K, a few cooler LED rooms
  const warm = mix(vec3(1.0, 0.42, 0.13), vec3(1.0, 0.74, 0.48), h3).toVar();
  warm.assign(mix(warm, vec3(0.95, 0.88, 0.8), step(0.86, fract(id.mul(7.77))).mul(0.6)));
  const tv = step(0.9, h4).mul(step(19.0, hh)).mul(step(0.99, kind));
  const flick = sin(U.time.mul(9.0).add(id.mul(50.0))).mul(sin(U.time.mul(2.3))).mul(0.25).add(0.75);
  warm.assign(mix(warm, vec3(0.45, 0.6, 1.0).mul(flick), tv));
  const curtain = noise2(positionWorld.xy.mul(2.0).add(positionWorld.zz)).mul(0.25).add(0.75);
  const vis = smoothstep(0.15, 0.7, U.dark);
  // brightness varies per room (lamps, curtains, distance from the window)
  const bright = mix(0.45, 1.25, fract(id.mul(23.9)));
  return warm.mul(on).mul(vis).mul(curtain).mul(bright).mul(1.35);
});

function recipeFor(mat, mesh) {
  const n = mat.name || '';
  const geo = mesh.geometry;
  if (n === 'Terrain') return 'terrain';
  if (n === 'G_LampGlass' || n === 'G_LampGlobe') return 'lamp';
  if (/Glass/.test(n)) return 'glass';
  // painted road markings are decals on the tarmac: same treatment as the road surface
  if (/^Road_/.test(n) || n === 'G_RoadPaint') return 'road';
  if (geo.attributes._var) return 'timber';
  if (mat.alphaTest > 0 || mat.transparent) return 'foliage';
  return 'generic';
}

function terrainMaterial(src) {
  const m = toNodeMaterial(src);
  m.side = THREE.FrontSide;
  const map = src.map;
  const w = weatherLayer({ porosity: 0.35, snow: 1.0, wetGloss: 0.35 });
  const g = groundDetail();
  m.colorNode = Fn(() => {
    const wp = positionWorld.xz;
    const c = vec3(1).toVar();
    if (map) {
      const uvb = uv().mul(vec2(map.repeat.x, map.repeat.y)).add(vec2(map.offset.x, map.offset.y));
      const t1 = texture(map, uvb).rgb;
      const uv2 = vec2(uvb.x.mul(0.8).sub(uvb.y.mul(0.6)), uvb.x.mul(0.6).add(uvb.y.mul(0.8))).mul(0.37).add(0.13);
      const t2 = texture(map, uv2).rgb;
      c.assign(mix(t1, t2, smoothstep(0.3, 0.7, noise2(wp.mul(0.045)))));
    }
    const macro = fbm2(wp.mul(0.0045));
    c.mulAssign(macro.mul(0.4).add(0.8));
    c.mulAssign(noise2(wp.mul(0.21)).mul(0.16).add(0.92));
    const hue = fbm2(wp.mul(0.0021).add(11.0));
    c.mulAssign(mix(vec3(0.82, 1.06, 0.72), vec3(1.12, 1.0, 0.78), smoothstep(0.3, 0.75, hue)));
    const heath = smoothstep(0.62, 0.8, fbm2(wp.mul(0.012).add(4.0))).mul(smoothstep(-5.0, 40.0, positionWorld.y));
    c.assign(mix(c, c.mul(vec3(1.25, 0.82, 1.05)), heath.mul(0.55)));
    // lusher meadow greens (less olive)
    c.mulAssign(vec3(0.96, 1.1, 0.8));
    c.assign(saturate3(c, U.fantasy.mul(0.22).add(1.05)));
    return w.color(g.color(c));
  })();
  m.roughnessNode = w.roughness(g.roughness(materialRoughness));
  m.normalNode = proceduralBump(g.height, 0.06, normalView);
  m.emissiveNode = lampPool(diffuseColor.rgb);
  return m;
}

function applyRecipe(mesh, recipe) {
  const src = mesh.material;
  const name = src.name || '';
  mesh.receiveShadow = true;
  mesh.castShadow = recipe !== 'road' && recipe !== 'terrain';
  for (const k of ['map', 'normalMap', 'roughnessMap']) if (src[k]) src[k].anisotropy = 16;
  const roofy = /Slate|Tin|Lead|Tile|Felt|Roof/.test(name);
  const stone = /Stone|Harl|Dressed|Dyke|Granite|Concrete|Brick|Dash|Sett|Kerb|Pave|Paving|Grave|Gravel/.test(name);
  const timber = /Wood|Timber|Fence|Post|Board|Picket|Joinery/.test(name);
  let m;
  switch (recipe) {
    case 'terrain':
      m = terrainMaterial(src);
      break;
    case 'road': {
      m = toNodeMaterial(src);
      const w = weatherLayer({ porosity: 0.3, snow: 0.85, puddles: true, wetGloss: 0.1 });
      const rd = roadDetail();
      m.colorNode = vec4(w.color(rd.color(materialColor.rgb)), materialColor.a);
      m.roughnessNode = w.roughness(rd.roughness(materialRoughness));
      m.normalNode = rippleNormal(proceduralBump(rd.height, 0.04, baseNormal(m)), w.puddle);
      m.emissiveNode = lampPool(diffuseColor.rgb);
      m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2;
      m.depthWrite = false;
      mesh.renderOrder = 1;
      break;
    }
    case 'glass': {
      m = toNodeMaterial(src);
      m.roughness = 0.04; m.metalness = 0.2;
      m.color.setRGB(0.02, 0.025, 0.03);
      m.emissiveNode = windowEmissive();
      m.roughnessNode = mix(float(0.04), float(0.02), U.wetness);
      mesh.castShadow = false;
      break;
    }
    case 'lamp': {
      m = toNodeMaterial(src);
      m.emissiveNode = vec3(1.0, 0.52, 0.2).mul(U.lampOn).mul(3.2);
      // globe lanterns arrive as alpha-blended glass: render them as solid glowing glass instead
      m.transparent = false; m.alphaTest = 0; m.opacity = 1; m.depthWrite = true;
      mesh.castShadow = false;
      break;
    }
    case 'timber': {
      m = toNodeMaterial(src);
      const w = weatherLayer({ porosity: 0.45, snow: 0.8, wetGloss: 0.35 });
      const wear = wallWear(HEIGHT_AT);
      m.colorNode = Fn(() => {
        const v = attribute('_var', 'vec3');
        const c = materialColor.rgb.mul(v.x.mul(0.5).add(0.72)).toVar();
        const l = dot(c, vec3(0.33));
        c.assign(mix(c, vec3(l).mul(vec3(1.0, 0.98, 0.95)), float(0.35).mul(float(1).sub(v.z)).mul(fract(v.x.mul(7.3)))));
        c.assign(mix(c, c.mul(vec3(1.15, 1.0, 0.8)), v.z.mul(0.5)));
        const foot = pow(clamp(float(1).sub(v.y), 0.0, 1.0), 5.0);
        const moss = foot.mul(noise2(positionWorld.xz.mul(8.0).add(positionWorld.y.mul(3.0))).mul(0.5).add(0.5));
        c.assign(mix(c, vec3(0.08, 0.12, 0.04), moss.mul(0.7)));
        return vec4(w.color(wear.color(c)), materialColor.a);
      })();
      m.roughnessNode = w.roughness(materialRoughness);
      m.emissiveNode = lampPool(diffuseColor.rgb);
      break;
    }
    case 'foliage': {
      m = toNodeMaterial(src);
      const w = weatherLayer({ porosity: 0.3, snow: 0.7, wetGloss: 0.3 });
      m.side = THREE.DoubleSide;
      m.colorNode = vec4(w.color(materialColor.rgb), materialColor.a);
      m.roughnessNode = w.roughness(materialRoughness);
      break;
    }
    default: {
      m = toNodeMaterial(src);
      const w = weatherLayer({
        porosity: stone ? 0.45 : timber ? 0.4 : roofy ? 0.25 : 0.3,
        snow: roofy ? 1.25 : 0.9,
        wetGloss: roofy ? 0.08 : stone ? 0.3 : 0.2,
      });
      const wear = wallWear(HEIGHT_AT, { roof: roofy, stone });
      m.colorNode = Fn(() => vec4(w.color(wear.color(materialColor.rgb)), materialColor.a))();
      m.emissiveNode = lampPool(diffuseColor.rgb);
      m.roughnessNode = w.roughness(wear.roughness(materialRoughness));
    }
  }
  mesh.material = m;
}

// ------------------------------------------------------------------ public
export function buildStatic(gltfs, scene, hf) {
  HEIGHT_AT = hf.heightAt;
  gltfs.terrain.scene.traverse((o) => { if (o.isMesh) applyRecipe(o, 'terrain'); });
  scene.add(gltfs.terrain.scene);
  gltfs.backdrop.scene.traverse((o) => {
    if (!o.isMesh) return;
    const m = toNodeMaterial(o.material);
    m.roughness = 1;
    const w = weatherLayer({ porosity: 0.2, snow: 1.3 });
    m.colorNode = Fn(() => {
      const c = materialColor.rgb.mul(vec3(0.55, 0.6, 0.45)).mul(fbm2(positionWorld.xz.mul(0.0015)).mul(0.5).add(0.75)).toVar();
      const hs = smoothstep(250.0, 700.0, positionWorld.y.add(noise2(positionWorld.xz.mul(0.004)).mul(120.0)));
      c.assign(mix(c, c.mul(vec3(1.15, 0.9, 1.0)), hs.mul(0.5)));
      return w.color(c);
    })();
    o.material = m;
    o.receiveShadow = false;
  });
  scene.add(gltfs.backdrop.scene);

  gltfs.roads.scene.traverse((o) => {
    if (!o.isMesh) return;
    applyRecipe(o, /^Road_/.test(o.material.name) ? 'road' : recipeFor(o.material, o));
  });
  scene.add(gltfs.roads.scene);

  const buildingInfo = [];
  gltfs.buildings.scene.traverse((o) => {
    if (o.userData && o.userData.osm_id) buildingInfo.push({ name: o.name, ...o.userData, position: o.position.clone() });
  });
  const findBuilding = (obj) => { let p = obj; while (p && !(p.userData && p.userData.style)) p = p.parent; return p; };
  const bMeshes = mergeByMaterial(gltfs.buildings.scene, {
    onGeometry: (geo, o, mat) => {
      if (/Glass/.test(mat.name)) {
        const b = findBuilding(o);
        const style = b ? b.userData.style : (mat.name.startsWith('SH_') ? 'dwelling' : 'shed');
        addWindowIds(geo, strHash(b ? b.name : o.name), KIND_BY_STYLE[style] ?? 0.3);
      }
    },
  });
  const sMeshes = mergeByMaterial(gltfs.surroundings.scene, {
    onGeometry: (geo, o, mat) => { if (/Glass/.test(mat.name) && !/^G_Lamp/.test(mat.name)) addWindowIds(geo, strHash(o.name), 0.4); },
  });
  const group = new THREE.Group();
  group.name = 'village';
  for (const m of [...bMeshes, ...sMeshes]) {
    applyRecipe(m, recipeFor(m.material, m));
    group.add(m);
  }
  scene.add(group);
  return { buildingInfo, group };
}
