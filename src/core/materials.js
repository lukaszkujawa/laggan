import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, mix, smoothstep, clamp, max, normalWorld, positionWorld, materialColor, materialRoughness,
  sin, length, floor, fract, normalize, cameraViewMatrix, texture, normalMap, normalView, Loop, If, uv,
} from 'three/tsl';
import { U, noise2, fbm2, hash2 } from './tsl.js';

const COPY_KEYS = [
  'name', 'color', 'map', 'normalMap', 'normalScale', 'roughness', 'metalness', 'roughnessMap', 'metalnessMap',
  'emissive', 'emissiveMap', 'emissiveIntensity', 'alphaTest', 'transparent', 'opacity', 'side', 'vertexColors',
  'aoMap', 'aoMapIntensity', 'alphaMap', 'depthWrite', 'depthTest', 'envMapIntensity',
];

// Convert a classic material (from GLTFLoader) into a node material we can extend.
export function toNodeMaterial(src, Klass = THREE.MeshStandardNodeMaterial) {
  const m = new Klass();
  for (const k of COPY_KEYS) {
    if (src[k] === undefined || m[k] === undefined) continue;
    const v = src[k];
    if (v && v.isColor) m[k].copy(v);
    else if (v && v.isVector2) m[k].copy(v);
    else m[k] = v;
  }
  m.userData = { ...src.userData };
  return m;
}

// ------------------------------------------------------------------ weather on surfaces
// returns { color(c) -> c', roughness(r) -> r', puddle } helpers bound to world position
export function weatherLayer({ porosity = 0.4, snow = 1.0, puddles = false, wetGloss = 0.2 } = {}) {
  const up = clamp(normalWorld.y, 0.0, 1.0);
  const wet = U.wetness.mul(mix(0.45, 1.0, smoothstep(0.2, 0.9, up)));
  let puddle = float(0);
  if (puddles) {
    const pn = fbm2(positionWorld.xz.mul(0.11)).mul(0.75).add(noise2(positionWorld.xz.mul(0.9)).mul(0.25));
    const thr = float(1).sub(U.wetness.mul(0.36));
    puddle = smoothstep(thr, thr.add(0.06), pn).mul(smoothstep(0.92, 0.99, up)).mul(float(1).sub(U.snow));
  }
  let snowAmt = float(0);
  if (snow > 0) {
    const sn = noise2(positionWorld.xz.mul(0.6)).mul(0.5).add(noise2(positionWorld.xz.mul(3.1)).mul(0.5));
    const cover = smoothstep(0.25, 0.7, up.add(sn.sub(0.5).mul(0.45)).sub(float(1).sub(U.snow).mul(0.9)));
    snowAmt = cover.mul(U.snow).mul(snow);
  }
  const color = (c) => {
    let o = c.mul(mix(1.0, 1.0 - porosity, wet));
    if (puddles) o = mix(o, o.mul(0.35).add(vec3(0.01, 0.012, 0.015)), puddle);
    if (snow > 0) {
      const sn = noise2(positionWorld.xz.mul(3.1));
      o = mix(o, vec3(0.86, 0.89, 0.95).mul(sn.mul(0.08).add(0.92)), snowAmt);
    }
    return o;
  };
  const roughness = (r) => {
    let o = mix(r, float(wetGloss), wet.mul(0.8));
    if (puddles) o = mix(o, 0.03, puddle);
    if (snow > 0) o = mix(o, 0.55, snowAmt);
    return o;
  };
  return { color, roughness, puddle, snowAmt, wet };
}

// rain ripple normal (view space) for puddles
export const rippleNormal = Fn(([baseN, puddle]) => {
  const rp = positionWorld.xz.mul(2.2);
  const ci = floor(rp);
  const cf = fract(rp).sub(0.5);
  const rn = vec2(0).toVar();
  Loop(2, ({ i }) => {
    const k = float(i);
    const h = hash2(ci.add(k.mul(7.31)));
    const tt = fract(U.time.mul(h.mul(0.5).add(0.7)).add(h));
    const off = vec2(hash2(ci.add(3.1).add(k)), hash2(ci.add(5.7).add(k))).sub(0.5);
    const d = cf.sub(off.mul(0.5));
    const r = length(d);
    const ring = sin(r.sub(tt.mul(0.6)).mul(40.0)).mul(smoothstep(0.0, 0.08, tt.mul(0.6).sub(r).add(0.08)))
      .mul(float(1).sub(tt)).mul(smoothstep(0.5, 0.2, r));
    rn.addAssign(d.div(max(r, 0.001)).mul(ring));
  });
  const wn = normalize(vec3(rn.x.mul(U.rain).mul(0.6), 1.0, rn.y.mul(U.rain).mul(0.6)));
  const vn = normalize(cameraViewMatrix.mul(vec4(wn, 0.0)).xyz);
  return normalize(mix(baseN, vn, puddle));
});

// default (possibly normal-mapped) view normal of a material
export function baseNormal(mat) {
  if (mat.normalMap) return normalMap(texture(mat.normalMap), vec2(mat.normalScale ? mat.normalScale.x : 1, mat.normalScale ? mat.normalScale.y : 1));
  return normalView;
}

export { materialColor, materialRoughness };
