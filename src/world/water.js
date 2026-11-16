import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, attribute, positionWorld, cameraPosition, length, normalize, mix, smoothstep, fract,
  floor, sin, max, step, cameraViewMatrix, Loop,
} from 'three/tsl';
import { U, noise2, hash2 } from '../core/tsl.js';

// Peaty River Spey: flow-mapped ripples, rain rings, foam at the banks. Reflections come from SSR + sky IBL.
export function createWater(gltf, scene) {
  const flowA = attribute('_flow', 'vec3');
  const shoreA = attribute('_shore', 'float');
  const hgt = (p) => noise2(p.mul(0.9)).mul(0.5).add(noise2(p.mul(2.3).add(3.7)).mul(0.3)).add(noise2(p.mul(5.1).add(7.1)).mul(0.2));

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.04, metalness: 0.0 });
  const grad = Fn(() => {
    const flow = flowA.xz;
    const moving = length(flow).mul(4.0).clamp(0.0, 1.0);
    const p = positionWorld.xz;
    const t = U.time;
    const ph0 = fract(t.mul(0.12)), ph1 = fract(t.mul(0.12).add(0.5));
    const wgt = ph0.sub(0.5).abs().mul(2.0);
    const fl = flow.mul(2.0);
    const e = 0.06;
    const g = vec2(0).toVar();
    for (const k of [0, 1]) {
      const ph = k === 0 ? ph0 : ph1;
      const ww = k === 0 ? float(1).sub(wgt) : wgt;
      const q = p.sub(fl.mul(ph).mul(3.0)).add(k * 0.37);
      const h0 = hgt(q);
      g.addAssign(vec2(hgt(q.add(vec2(e, 0))).sub(h0), hgt(q.add(vec2(0, e))).sub(h0)).div(e).mul(ww));
    }
    const wq = p.mul(1.7).sub(U.windDir.mul(t.mul(1.2)));
    const w0 = noise2(wq);
    g.addAssign(vec2(noise2(wq.add(vec2(0.05, 0))).sub(w0), noise2(wq.add(vec2(0, 0.05))).sub(w0)).div(0.05)
      .mul(U.windStrength.mul(0.5).add(0.15)).mul(float(1).sub(moving.mul(0.5))));
    // rain rings
    const rp = p.mul(1.6);
    const ci = floor(rp);
    const cf = fract(rp).sub(0.5);
    Loop(2, ({ i }) => {
      const k = float(i);
      const h = hash2(ci.add(k.mul(7.31)));
      const tt = fract(t.mul(h.mul(0.6).add(0.8)).add(h));
      const off = vec2(hash2(ci.add(3.1).add(k)), hash2(ci.add(5.7).add(k))).sub(0.5);
      const d = cf.sub(off.mul(0.5));
      const r = length(d);
      const ring = sin(r.sub(tt.mul(0.5)).mul(45.0)).mul(smoothstep(0.0, 0.06, tt.mul(0.5).sub(r).add(0.06)))
        .mul(float(1).sub(tt)).mul(smoothstep(0.5, 0.2, r));
      g.addAssign(d.div(max(r, 0.001)).mul(ring).mul(U.rain).mul(3.0));
    });
    const camDist = length(cameraPosition.sub(positionWorld));
    const strength = mix(0.08, 0.16, moving).mul(mix(1.0, 0.25, smoothstep(15.0, 350.0, camDist)));
    return g.mul(strength);
  })();
  mat.normalNode = Fn(() => {
    const n = normalize(vec3(grad.x.negate(), 1.0, grad.y.negate()));
    return normalize(cameraViewMatrix.mul(vec4(n, 0.0)).xyz);
  })();
  mat.colorNode = Fn(() => {
    const shore = shoreA;
    const deep = vec3(0.02, 0.015, 0.007);
    const shallow = vec3(0.08, 0.065, 0.035);
    const p = positionWorld.xz;
    const fl = flowA.xz.mul(2.0);
    const moving = length(flowA.xz).mul(4.0).clamp(0.0, 1.0);
    const foamN = noise2(p.mul(3.0).sub(fl.mul(U.time).mul(2.0))).mul(noise2(p.mul(7.0).sub(fl.mul(U.time).mul(3.0))));
    const foam = smoothstep(0.82, 1.0, shore.add(foamN.mul(0.5))).mul(0.6).add(smoothstep(0.35, 0.6, foamN).mul(moving).mul(0.25));
    return vec4(mix(mix(deep, shallow, shore), vec3(0.75, 0.75, 0.72), foam.mul(0.5)), 1.0);
  })();
  mat.roughnessNode = Fn(() => mix(float(0.03), float(0.35), smoothstep(0.75, 1.0, shoreA)))();
  mat.emissiveNode = Fn(() => {
    // fantasy: faint glowing motes in the water at night
    const p = positionWorld.xz.mul(0.8);
    const gc = floor(p);
    const gh = hash2(gc.add(floor(U.time.mul(0.15).add(hash2(gc).mul(7.0)))));
    const glint = step(0.993, gh).mul(smoothstep(0.35, 0.0, length(fract(p).sub(0.5)))).mul(U.night).mul(U.fantasy);
    return vec3(0.2, 0.8, 1.0).mul(glint).mul(sin(U.time.mul(3.0).add(gh.mul(50.0))).mul(0.4).add(0.6)).mul(1.5);
  })();
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    if (!g.attributes._shore) g.setAttribute('_shore', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(0.2), 1));
    if (!g.attributes._flow) g.setAttribute('_flow', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3), 3));
    o.material = mat;
    o.receiveShadow = true;
    o.castShadow = false;
  });
  scene.add(gltf.scene);
  return null;
}
