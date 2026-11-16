import * as THREE from 'three/webgpu';
import {
  Fn, uniform, float, vec2, vec3, vec4, attribute, positionGeometry, normalGeometry, cameraPosition, uv, texture,
  normalize, cross, length, atan, asin, clamp, floor, fract, mod, min, mix, smoothstep, select, frontFacing,
  transformNormalToView, positionPrevious, interleavedGradientNoise, screenCoordinate, distance, dot, max,
} from 'three/tsl';
import { U, saturate3, foliageVariety } from '../core/tsl.js';

export const AZ = 8; // azimuth frames
export const EL = 3; // elevation rings: 0, 30, 60 deg
const EL_STEP = Math.PI / 6;

export const impostorShared = { mainCam: uniform(new THREE.Vector3()), shadowDist: uniform(45) };

/**
 * Bake an impostor atlas (albedo + normal/AO) from a list of {geometry, material} parts.
 */
export function bakeImpostor(renderer, parts, { cell = 256, radial = 0.5 } = {}) {
  const scene = new THREE.Scene();
  const box = new THREE.Box3();
  for (const p of parts) { p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox); }
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const R = 0.5 * Math.sqrt(size.x * size.x * 0.5 + size.z * size.z * 0.5 + size.y * size.y) * 1.01;
  const uCenter = uniform(center.clone());
  const uExt = uniform(new THREE.Vector3(size.x * 0.5 + 1e-3, size.y * 0.5 + 1e-3, size.z * 0.5 + 1e-3));
  const albedoMats = [], normalMats = [], meshes = [];
  for (const p of parts) {
    const src = p.material;
    const map = p.geometry.attributes.uv ? src.map : null;
    const alphaTest = map && (src.alphaTest > 0 || src.transparent) ? Math.max(src.alphaTest, 0.4) : 0;
    const am = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    am.colorNode = map ? texture(map).mul(vec4(src.color, 1)) : vec4(src.color, 1);
    am.alphaTest = alphaTest;
    am.fog = false;
    const nm = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    const rad = src.userData.isLeaf ? radial : radial * 0.3;
    nm.colorNode = Fn(() => {
      const n = normalize(normalGeometry).toVar();
      n.assign(select(frontFacing, n, n.negate()));
      const rdir = normalize(positionGeometry.sub(uCenter).div(uExt));
      const nn = normalize(mix(n, rdir, rad));
      const rd = length(positionGeometry.sub(uCenter).div(uExt));
      const ao = mix(0.35, 1.0, smoothstep(0.15, 0.95, rd)).mul(mix(0.75, 1.0, clamp(positionGeometry.y.sub(uCenter.y).add(uExt.y).div(uExt.y.mul(2.0)), 0.0, 1.0)));
      return vec4(nn.mul(0.5).add(0.5), ao);
    })();
    if (map) nm.opacityNode = texture(map).a;
    nm.alphaTest = alphaTest;
    nm.fog = false;
    albedoMats.push(am); normalMats.push(nm);
    const m = new THREE.Mesh(p.geometry, am);
    meshes.push(m);
    scene.add(m);
  }

  const W = AZ * cell, H = EL * cell;
  const mk = () => new THREE.RenderTarget(W, H, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true,
  });
  const rtA = mk(), rtN = mk();
  const cam = new THREE.OrthographicCamera(-R, R, R, -R, 0.01, R * 6);
  const prevRT = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAuto = renderer.autoClear;
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 0);
  const dir = new THREE.Vector3();
  for (const [rt, mats] of [[rtA, albedoMats], [rtN, normalMats]]) {
    meshes.forEach((m, i) => (m.material = mats[i]));
    renderer.setRenderTarget(rt);
    rt.scissorTest = false;
    renderer.clear(true, true, true);
    rt.scissorTest = true;
    for (let e = 0; e < EL; e++) {
      for (let a = 0; a < AZ; a++) {
        const az = (a / AZ) * Math.PI * 2;
        const el = e * EL_STEP;
        dir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
        cam.position.copy(center).addScaledVector(dir, R * 3);
        cam.up.set(0, 1, 0);
        cam.lookAt(center);
        cam.updateMatrixWorld();
        rt.viewport.set(a * cell, e * cell, cell, cell);
        rt.scissor.set(a * cell, e * cell, cell, cell);
        renderer.setRenderTarget(rt);
        renderer.render(scene, cam);
      }
    }
    rt.scissorTest = false;
    rt.viewport.set(0, 0, W, H);
  }
  renderer.setRenderTarget(prevRT);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.autoClear = prevAuto;
  return { albedo: rtA.texture, normal: rtN.texture, center, radius: R, rts: [rtA, rtN] };
}

/**
 * Impostor material: billboards from per-instance attributes (iPos, iQuat, iScale), lit as full PBR surfaces.
 */
export function createImpostorMaterial(bake, { fadeNear, fadeBand, flipY = false, autumn = 0 }) {
  const uFadeNear = uniform(fadeNear);
  const uFadeBand = uniform(fadeBand);
  const C = bake.center, R = bake.radius;
  const iPos = attribute('iPos', 'vec3');
  const iQuat = attribute('iQuat', 'vec4');
  const iScale = attribute('iScale', 'vec3');
  const qrot = (q, v) => v.add(cross(q.xyz, cross(q.xyz, v).add(v.mul(q.w))).mul(2.0));
  const s = iScale.y;
  const wc = iPos.add(qrot(iQuat, vec3(C.x, C.y, C.z).mul(s)));

  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
  mat.positionNode = Fn(() => {
    const toCam = normalize(cameraPosition.sub(wc));
    const right = normalize(cross(vec3(0, 1, 0), toCam));
    const upv = cross(toCam, right);
    const size = float(R).mul(s);
    const p = wc.add(right.mul(positionGeometry.x).add(upv.mul(positionGeometry.y)).mul(size.mul(2.0))).add(toCam.mul(size.mul(0.25)));
    positionPrevious.assign(p);
    return p;
  })();
  // frame selection in model space (per fragment, so no varyings are needed)
  const frames = () => {
    const toCam = normalize(cameraPosition.sub(wc));
    const qi = vec4(iQuat.xyz.negate(), iQuat.w);
    const lv = qrot(qi, toCam);
    const az0 = atan(lv.x, lv.z);
    const az = select(az0.lessThan(0.0), az0.add(6.2831853), az0);
    const el = asin(clamp(lv.y, 0.0, 1.0));
    const fa = az.div(6.2831853).mul(AZ);
    const fe = clamp(el.div(EL_STEP), 0.0, EL - 1);
    const a0 = floor(fa), wa = fa.sub(a0);
    const e0 = floor(fe), we = fe.sub(e0);
    return { a0: mod(a0, AZ), a1: mod(a0.add(1.0), AZ), e0, e1: min(e0.add(1.0), EL - 1), wa, we };
  };
  // WebGPU render targets have a top-left origin: frame rows and texel rows run downwards
  const fuv = flipY
    ? (a, e) => { const q = clamp(uv(), 0.002, 0.998); return vec2(a.add(q.x).div(AZ), e.add(float(1).sub(q.y)).div(EL)); }
    : (a, e) => vec2(a, e).add(clamp(uv(), 0.002, 0.998)).div(vec2(AZ, EL));
  const tA = texture(bake.albedo), tN = texture(bake.normal);
  const sample4 = (t, f) => {
    const w00 = float(1).sub(f.wa).mul(float(1).sub(f.we)), w10 = f.wa.mul(float(1).sub(f.we));
    const w01 = float(1).sub(f.wa).mul(f.we), w11 = f.wa.mul(f.we);
    return t.sample(fuv(f.a0, f.e0)).mul(w00).add(t.sample(fuv(f.a1, f.e0)).mul(w10))
      .add(t.sample(fuv(f.a0, f.e1)).mul(w01)).add(t.sample(fuv(f.a1, f.e1)).mul(w11));
  };
  const F = frames();
  const albedoA = sample4(tA, F);
  const normalAO = sample4(tN, F);
  const seed = fract(dot(iPos.xz, vec2(0.123, 0.789)));
  mat.colorNode = Fn(() => {
    const cov = albedoA.a;
    const alb = albedoA.rgb.div(max(cov, 0.05)).toVar();
    // same per-plant variety as the meshes; only on green (leafy) texels
    const leafy = smoothstep(0.0, 0.04, alb.g.sub(alb.r));
    alb.assign(foliageVariety(alb, seed, float(autumn), leafy));
    alb.assign(saturate3(alb, U.fantasy.mul(0.18).add(1.0)));
    const nAO = normalAO.div(max(cov, 0.05));
    const ny = nAO.y.mul(2.0).sub(1.0);
    alb.assign(mix(alb, vec3(0.85, 0.88, 0.94), U.snow.mul(smoothstep(0.2, 0.8, ny)).mul(0.85)));
    alb.mulAssign(mix(1.0, 0.72, U.wetness.mul(0.6)));
    alb.mulAssign(nAO.a);
    return vec4(alb, cov);
  })();
  mat.alphaTest = 0.4;
  mat.normalNode = Fn(() => {
    const nAO = normalAO.div(max(albedoA.a, 0.05));
    const nl = nAO.xyz.mul(2.0).sub(1.0);
    return transformNormalToView(normalize(qrot(iQuat, nl)));
  })();
  mat.roughness = 0.85;
  mat.metalness = 0;
  const dMain = distance(impostorShared.mainCam, wc);
  mat.maskNode = Fn(() => {
    const fadeIn = smoothstep(uFadeNear.sub(uFadeBand), uFadeNear, dMain);
    return float(1).sub(interleavedGradientNoise(screenCoordinate.xy)).lessThan(fadeIn);
  })();
  // beyond the mesh-shadow distance the billboard (facing the light in the shadow pass) casts the tree's shadow
  mat.maskShadowNode = dMain.greaterThan(impostorShared.shadowDist);
  mat.userData.fade = { uFadeNear, uFadeBand };
  return mat;
}
