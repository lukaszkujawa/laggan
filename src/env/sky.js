import * as THREE from 'three/webgpu';
import {
  Fn, uniform, float, vec2, vec3, vec4, positionWorld, cameraPosition, normalize, dot, max, pow, exp, mix,
  smoothstep, clamp, sin, abs, floor, fract, length, cross, sqrt, If, Loop, mx_fractal_noise_float,
} from 'three/tsl';
import { U, noise2, hash3 } from '../core/tsl.js';

export const skyUniforms = {
  uZen: uniform(new THREE.Color()),
  uHor: uniform(new THREE.Color()),
  uGlow: uniform(new THREE.Color()),
  uSunCol: uniform(new THREE.Color()),
  uSunDir: uniform(new THREE.Vector3(0, 1, 0)),
  uMoonDir: uniform(new THREE.Vector3(0, -1, 0)),
  uSunVis: uniform(1),
  uMoonVis: uniform(0),
  uCloud: uniform(0.3),
  uCloudDark: uniform(0),
  uCloudAmb: uniform(new THREE.Color()),
  uStars: uniform(0),
  uAurora: uniform(0),
  uGrey: uniform(0),
  uFogCol: uniform(new THREE.Color()),
  uHazeLow: uniform(0),
  uCloudOffset: uniform(new THREE.Vector2()),
};
const S = skyUniforms;

const fbm5 = (p) => mx_fractal_noise_float(vec3(p.x, p.y, float(3.1)), 5, 2.0, 0.5).mul(0.5).add(0.5);

const starField = Fn(([rd]) => {
  const col = vec3(0).toVar();
  for (const [sc, thr, gain, off] of [[260, 0.9975, 1.6, 0], [520, 0.996, 0.7, 17]]) {
    const p = rd.mul(sc);
    const c = floor(p);
    const h = hash3(c.add(off));
    If(h.greaterThan(thr), () => {
      const f = fract(p).sub(0.5);
      const jit = vec3(hash3(c.add(1.3)), hash3(c.add(2.7)), hash3(c.add(4.1))).sub(0.5);
      const d = length(f.sub(jit.mul(0.6)));
      const tw = sin(U.time.mul(h.mul(40.0).add(1.5)).add(h.mul(300.0))).mul(0.35).add(0.65);
      const b = smoothstep(0.22, 0.0, d).mul(tw).mul(gain);
      const tint = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.85, 0.7), hash3(c.add(9.0)));
      col.addAssign(tint.mul(b));
    });
  }
  const axis = normalize(vec3(0.35, 0.55, -0.75));
  const band = float(1).sub(abs(dot(rd, axis)));
  const mw = pow(band, 10.0).mul(fbm5(rd.xy.mul(6.0).add(rd.z.mul(3.0))).mul(0.6).add(0.4));
  col.addAssign(mix(vec3(0.25, 0.28, 0.45), vec3(0.45, 0.3, 0.6), U.fantasy.mul(0.6)).mul(mw).mul(0.18));
  return col;
});

const aurora = Fn(([rd]) => {
  const acc = vec3(0).toVar();
  If(rd.y.greaterThan(0.01), () => {
    Loop(14, ({ i }) => {
      const fi = float(i);
      const hgt = fi.mul(0.035).add(0.6);
      const p = rd.xz.div(rd.y).mul(hgt).add(vec2(U.time.mul(0.006), 0.0));
      const warp = noise2(p.mul(0.8).add(vec2(U.time.mul(0.02), 0.0))).mul(2.2);
      const n = noise2(vec2(p.x.mul(1.6).add(warp), p.y.mul(0.35).add(fi.mul(0.02))));
      const curtain = smoothstep(0.52, 0.95, n).mul(noise2(vec2(p.x.mul(9.0), U.time.mul(0.3))).mul(0.4).add(0.6));
      const c = mix(vec3(0.1, 1.0, 0.45), vec3(0.75, 0.25, 1.0), smoothstep(5.0, 13.0, fi));
      acc.addAssign(c.mul(curtain).mul(float(1).sub(fi.div(14.0))).mul(0.09));
    });
  });
  const north = smoothstep(0.25, -0.65, rd.z);
  return acc.mul(smoothstep(0.02, 0.22, rd.y)).mul(north);
});

const clouds = Fn(([rd, sd]) => {
  const res = vec4(0).toVar();
  If(rd.y.greaterThan(0.0), () => {
    const t = float(1).div(rd.y.add(0.06));
    const uvc = rd.xz.mul(t).mul(0.45).add(S.uCloudOffset);
    const warp = vec2(fbm5(uvc.mul(0.7).add(3.3)), fbm5(uvc.mul(0.7).add(7.9))).sub(0.5);
    const q = uvc.add(warp.mul(0.9));
    const d = fbm5(q).mul(0.8).add(fbm5(q.mul(3.1).add(1.7)).mul(0.2));
    const cov = S.uCloud;
    const lo = float(1).sub(cov.mul(1.02)).sub(0.06);
    const c = smoothstep(lo, lo.add(0.22).add(cov.mul(0.25)), d);
    const toSun = normalize(S.uSunDir.xz.add(0.0001)).mul(0.07);
    const q2 = q.add(toSun);
    const d2 = fbm5(q2).mul(0.8).add(fbm5(q2.mul(3.1).add(1.7)).mul(0.2));
    const lit = clamp(d.sub(d2).mul(4.0).add(0.6), 0.0, 1.0);
    const thick = smoothstep(lo, lo.add(0.6), d);
    const litCol = S.uSunCol.mul(0.85).add(S.uCloudAmb.mul(0.9));
    const darkCol = S.uCloudAmb.mul(mix(0.62, 0.25, S.uCloudDark));
    const col = mix(darkCol, litCol, lit.mul(float(1).sub(thick.mul(0.45))).mul(float(1).sub(S.uCloudDark.mul(0.75)))).toVar();
    col.addAssign(S.uSunCol.mul(pow(max(sd, 0.0), 6.0)).mul(float(1).sub(c)).mul(2.0).mul(S.uSunVis));
    col.addAssign(vec3(0.75, 0.8, 1.0).mul(U.flash).mul(2.5).mul(d.mul(0.6).add(0.4)));
    const fade = smoothstep(0.0, 0.2, rd.y);
    res.assign(vec4(col, c.mul(mix(0.55, 1.0, fade)).mul(smoothstep(0.0, 0.03, rd.y))));
  });
  return res;
});

// Shadows of the sky clouds on the landscape: project each point towards the sun onto the cloud layer and
// sample the same (domain-warped) cloud field the sky uses, so shadows match the visible clouds.
export const cloudShadowNode = Fn(() => {
  const H = float(2000.0);
  const sd = S.uSunDir;
  const sy = sd.y.max(0.08);
  const q = positionWorld.xz.add(sd.xz.div(sy).mul(H.sub(positionWorld.y)));
  const uvc = q.mul(0.45).div(H).add(S.uCloudOffset);
  const warp = vec2(fbm5(uvc.mul(0.7).add(3.3)), fbm5(uvc.mul(0.7).add(7.9))).sub(0.5);
  const d = fbm5(uvc.add(warp.mul(0.9)));
  const lo = float(1).sub(S.uCloud.mul(1.02)).sub(0.06);
  const c = smoothstep(lo, lo.add(0.3).add(S.uCloud.mul(0.25)), d);
  // under full overcast the sun is already dimmed globally: fade the pattern out
  const patchy = float(1).sub(smoothstep(0.75, 1.0, S.uCloud));
  return float(1).sub(c.mul(0.82).mul(patchy));
})();

function skyColorNode(isEnv) {
  return Fn(() => {
    const rd = normalize(positionWorld.sub(cameraPosition));
    const y = rd.y;
    const hy = max(y, 0.0);
    const sd = dot(rd, S.uSunDir);
    const col = mix(S.uHor, S.uZen, pow(smoothstep(-0.02, 1.0, hy), 0.45)).toVar();
    const glowA = pow(clamp(sd.mul(0.5).add(0.5), 0.0, 1.0), 5.0).mul(exp(hy.mul(-5.0)));
    col.addAssign(S.uGlow.mul(glowA).mul(0.9).mul(float(1).sub(S.uCloud.mul(0.55))));
    const clearSky = float(1).sub(smoothstep(0.35, 0.95, S.uCloud));
    if (!isEnv) {
      If(S.uStars.greaterThan(0.001), () => {
        col.addAssign(starField(rd).mul(S.uStars).mul(clearSky).mul(smoothstep(-0.05, 0.2, y)));
      });
      If(S.uAurora.greaterThan(0.001), () => {
        col.addAssign(aurora(rd).mul(S.uAurora).mul(clearSky));
      });
      const md = dot(rd, S.uMoonDir);
      If(md.greaterThan(0.999).and(S.uMoonVis.greaterThan(0.0)), () => {
        const mx = normalize(cross(S.uMoonDir, vec3(0, 1, 0)));
        const my = cross(mx, S.uMoonDir);
        const q = vec2(dot(rd, mx), dot(rd, my)).div(0.0105);
        const r2 = dot(q, q);
        If(r2.lessThan(1.0), () => {
          const n = normalize(mx.mul(q.x).add(my.mul(q.y)).add(S.uMoonDir.mul(sqrt(float(1).sub(r2)))));
          const ld = normalize(S.uSunDir.sub(S.uMoonDir.mul(dot(S.uSunDir, S.uMoonDir).mul(0.2))).add(mx.mul(0.45)));
          const ph = smoothstep(-0.1, 0.25, dot(n, ld));
          const mare = fbm5(q.mul(2.5).add(3.0)).mul(0.25).add(0.75);
          const edge = smoothstep(1.0, 0.94, r2);
          col.assign(mix(col, vec3(1.0, 0.97, 0.9).mul(mare).mul(ph.mul(1.6).add(0.04)), edge.mul(S.uMoonVis)));
        });
      });
      col.addAssign(vec3(0.5, 0.6, 0.85).mul(pow(max(md, 0.0), 120.0)).mul(0.12).mul(S.uMoonVis));
      const disc = smoothstep(0.99985, 0.99993, sd);
      const sunClear = float(1).sub(smoothstep(0.55, 1.0, S.uCloud));
      col.addAssign(S.uSunCol.mul(disc).mul(40.0).mul(S.uSunVis).mul(sunClear));
    }
    col.addAssign(S.uSunCol.mul(pow(max(sd, 0.0), 220.0).mul(1.3).add(pow(max(sd, 0.0), 10.0).mul(0.18)))
      .mul(S.uSunVis).mul(float(1).sub(S.uCloud.mul(0.75))));
    const cl = clouds(rd, sd);
    col.assign(mix(col, cl.rgb, cl.a));
    const grey = vec3(dot(col, vec3(0.3, 0.5, 0.2)));
    col.assign(mix(col, grey.mul(vec3(0.95, 0.98, 1.04)), S.uGrey.mul(0.6)));
    const hz = exp(hy.mul(mix(9.0, 3.0, S.uHazeLow)).negate());
    col.assign(mix(col, S.uFogCol, clamp(hz.mul(S.uHazeLow.mul(0.65).add(0.35)), 0.0, 1.0)));
    col.assign(mix(col, S.uFogCol.mul(0.85), smoothstep(0.0, -0.08, y)));
    return col;
  })();
}

function makeMat(isEnv) {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false });
  m.colorNode = skyColorNode(isEnv);
  m.fog = false;
  return m;
}

export function createSky() {
  const geo = new THREE.SphereGeometry(1, 64, 32);
  const mesh = new THREE.Mesh(geo, makeMat(false));
  mesh.scale.setScalar(15000);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  mesh.name = 'sky';
  const envScene = new THREE.Scene();
  const envMesh = new THREE.Mesh(geo, makeMat(true));
  envMesh.scale.setScalar(100);
  envScene.add(envMesh);
  const groundMat = new THREE.MeshBasicNodeMaterial({ color: 0x000000, side: THREE.BackSide });
  groundMat.fog = false;
  const ground = new THREE.Mesh(new THREE.SphereGeometry(90, 32, 16, 0, Math.PI * 2, Math.PI / 2 + 0.02, Math.PI / 2), groundMat);
  envScene.add(ground);
  return { mesh, envScene, groundMat };
}
