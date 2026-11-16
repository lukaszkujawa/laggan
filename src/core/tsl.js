import * as THREE from 'three/webgpu';
import {
  Fn, uniform, float, vec2, vec3, vec4, mx_noise_float, mx_fractal_noise_float, smoothstep, sin, abs, max, exp,
  length, dot, pow, select, positionWorld, cameraPosition, clamp, mix, hash, floor, fract, normalize,
} from 'three/tsl';

// ------------------------------------------------------------------ global uniforms (written by JS each frame)
export const U = {
  time: uniform(0),
  windDir: uniform(new THREE.Vector2(0.8, 0.6).normalize()),
  windStrength: uniform(0.35),
  wetness: uniform(0),
  snow: uniform(0),
  rain: uniform(0),
  night: uniform(0),
  dark: uniform(0),
  fantasy: uniform(0.75),
  hour: uniform(12),
  flash: uniform(0),
  sunDir: uniform(new THREE.Vector3(0, 1, 0)), // main light (sun or moon) direction
  sunCol: uniform(new THREE.Color(1, 1, 1)), // main light radiance
  ambSky: uniform(new THREE.Color(0.4, 0.5, 0.6)),
  ambGround: uniform(new THREE.Color(0.15, 0.13, 0.1)),
  player: uniform(new THREE.Vector3(0, -1e4, 0)),
  lampOn: uniform(0),
  // fog
  fogDensity: uniform(0.0005),
  fogFalloff: uniform(0.03),
  fogBase: uniform(-24),
  fogHaze: uniform(0.00004),
  fogColor: uniform(new THREE.Color(0.6, 0.7, 0.8)),
  fogSunDir: uniform(new THREE.Vector3(0, 1, 0)),
  fogSunCol: uniform(new THREE.Color(1, 0.8, 0.6)),
  fogFarCol: uniform(new THREE.Color(0.45, 0.58, 0.8)), // aerial perspective tint for the far distance
  mist: uniform(0), // low drifting valley mist (dawn, dusk, night, haar)
  mistBase: uniform(-22),
  mistCol: uniform(new THREE.Color(0.7, 0.75, 0.8)),
};

// ------------------------------------------------------------------ noise helpers (0..1 range)
export const noise2 = (p) => mx_noise_float(vec3(p.x, p.y, float(0.37))).mul(0.5).add(0.5);
export const noise3 = (p) => mx_noise_float(p).mul(0.5).add(0.5);
export const fbm2 = (p, oct = 3) => mx_fractal_noise_float(vec3(p.x, p.y, float(1.7)), oct, 2.03, 0.5).mul(0.5).add(0.5);
// TSL hash() truncates its seed to uint: keep seeds positive and spread them out
export const hash2 = (p) => hash(p.x.add(4096.0).mul(127.1).add(p.y.add(4096.0).mul(311.7)));
export const hash3 = (p) => hash(p.x.add(4096.0).mul(127.1).add(p.y.add(4096.0).mul(311.7)).add(p.z.add(4096.0).mul(74.7)));

// ------------------------------------------------------------------ wind
// Gust field: travelling wave bands across the land (analytic, cheap enough for every vertex of every tree).
export const gustAt = Fn(([wp]) => {
  const dir = U.windDir;
  const along = dot(wp, dir), across = dot(wp, vec2(dir.y.negate(), dir.x));
  const speed = U.windStrength.mul(4.0).add(2.0);
  const a = sin(along.mul(0.021).sub(U.time.mul(speed).mul(0.021)).add(sin(across.mul(0.013)).mul(1.7)));
  const b = sin(along.mul(0.047).add(across.mul(0.031)).sub(U.time.mul(speed).mul(0.047)));
  return smoothstep(0.1, 0.95, a.mul(0.6).add(b.mul(0.4)).mul(0.5).add(0.5));
});

// offset (in fractions of the plant height) for a vertex with wind attribute w = (height, branch, phase)
export const windBend = Fn(([w, wp, phase]) => {
  const g = gustAt(wp);
  const s = U.windStrength.mul(g.mul(1.1).add(0.45));
  const t = U.time;
  const osc = sin(t.mul(s.mul(0.5).add(1.3)).add(phase)).mul(0.6).add(sin(t.mul(2.7).add(phase.mul(1.9))).mul(0.4));
  const lean0 = s.mul(osc.mul(0.45).add(0.55)).add(osc.mul(0.04));
  const lean = lean0.div(abs(lean0).mul(0.55).add(1.0));
  const h = w.x.mul(w.x);
  const d = vec3(U.windDir.x, 0.0, U.windDir.y);
  return d.mul(h.mul(lean)).sub(vec3(0.0, h.mul(lean).mul(lean).mul(0.45), 0.0));
});

export const windFlutter = Fn(([w, phase]) => {
  const s = U.windStrength.mul(1.0);
  return sin(U.time.mul(s.mul(9.0).add(6.0)).add(w.z.mul(6.2831)).add(phase)).mul(w.y).mul(s.add(0.15));
});

// ------------------------------------------------------------------ height fog, valley mist, aerial perspective
const mistAt = Fn(() => {
  const wp = positionWorld;
  const off = wp.sub(cameraPosition);
  const dist = length(off);
  // wisps drift with the wind and slowly evolve
  const q = wp.xz.mul(0.0075).add(U.windDir.mul(U.time.mul(0.012).mul(U.windStrength.add(0.3))));
  const wisps = smoothstep(0.35, 0.8, fbm2(q.add(vec2(U.time.mul(0.002), 0.0)), 3));
  const layer = smoothstep(U.mistBase.add(16.0), U.mistBase, wp.y).mul(smoothstep(U.mistBase.sub(6.0), U.mistBase.add(1.0), wp.y).mul(0.5).add(0.5));
  const reach = float(1).sub(exp(dist.mul(-0.006)));
  return U.mist.mul(layer).mul(wisps.mul(0.7).add(0.3)).mul(reach).clamp(0.0, 0.92);
});

const baseFog = Fn(() => {
  const off = positionWorld.sub(cameraPosition);
  const dist = length(off);
  const rd = off.div(max(dist, 1e-4));
  const b = U.fogFalloff;
  const h0 = cameraPosition.y.sub(U.fogBase);
  const ry = select(abs(rd.y).lessThan(0.001), float(0.001), rd.y);
  const amt = U.fogDensity.mul(exp(h0.mul(b).negate())).mul(float(1).sub(exp(dist.mul(ry).mul(b).negate()))).div(ry.mul(b))
    .add(dist.mul(U.fogHaze));
  return float(1).sub(exp(max(amt, 0.0).negate()));
});

export const fogFactorNode = Fn(() => {
  const f = baseFog();
  const m = mistAt();
  return float(1).sub(float(1).sub(f).mul(float(1).sub(m)));
})();

export const fogColorNode = Fn(() => {
  const off = positionWorld.sub(cameraPosition);
  const dist = length(off);
  const rd = off.div(max(dist, 1e-4));
  const sunAmt = pow(max(dot(rd, U.fogSunDir), 0.0), 6.0);
  // distance: the haze turns cooler/bluer (aerial perspective), except towards the sun
  const far = smoothstep(250.0, 4000.0, dist).mul(float(1).sub(sunAmt));
  const col = mix(U.fogColor, U.fogFarCol, far.mul(0.6)).add(U.fogSunCol.mul(sunAmt));
  // valley mist picks up the sun/moon and lamp glow
  const f = baseFog();
  const m = mistAt();
  const mistShare = m.div(max(m.add(f), 1e-3));
  return mix(col, U.mistCol.add(U.fogSunCol.mul(sunAmt.mul(1.5))), mistShare);
})();

// apply fog manually (for materials that bypass scene fog)
export const applyFog = (col) => mix(col, fogColorNode, fogFactorNode);

// Per-plant colour variety: warm olive <-> cool blue-green, brightness, and a share of early-autumn plants
// (gold / rust). `leafWeight` limits the effect to foliage (e.g. greenness of impostor texels).
export const foliageVariety = (col, seed, autumn, leafWeight = float(1)) => {
  const h1 = fract(seed.mul(17.31)), h2 = fract(seed.mul(43.17)), h3 = fract(seed.mul(91.73));
  // fresh variety: golden-lime <-> deep emerald (no grey-blue)
  const hue = mix(col.mul(vec3(1.12, 1.08, 0.7)), col.mul(vec3(0.85, 1.08, 0.82)), h1);
  const lum = dot(col, vec3(0.3, 0.59, 0.11));
  const gold = vec3(lum.mul(2.5), lum.mul(1.95), lum.mul(0.45));
  const rust = vec3(lum.mul(2.6), lum.mul(1.15), lum.mul(0.38));
  const isAutumn = smoothstep(float(1).sub(autumn), float(1).sub(autumn).add(0.015), h2);
  // autumn trees turn gradually: a mix of green and colour across the canopy
  const turned = mix(gold, rust, h3).mul(mix(0.7, 1.0, h1));
  const c = mix(hue, turned, isAutumn.mul(0.85));
  return mix(col, c.mul(h3.mul(0.2).add(0.92)), leafWeight);
};

// ------------------------------------------------------------------ street-lamp light pools
// Every lantern lights the ground and walls around it with a soft warm pool (analytic, all lamps at once).
import { uniformArray, Loop as TLoop, normalWorld as nW } from 'three/tsl';
export const MAX_LAMPS = 24;
export const lampData = uniformArray(Array.from({ length: MAX_LAMPS }, () => new THREE.Vector4(0, -1e4, 0, 0)), 'vec4');
export const lampCount = uniform(0);
export const lampWarm = uniform(new THREE.Color(1.0, 0.4, 0.09));
export const lampPool = Fn(([albedo]) => {
  const acc = float(0).toVar();
  const wp = positionWorld;
  TLoop({ start: 0, end: lampCount, type: 'int' }, ({ i }) => {
    const L = lampData.element(i);
    const d = L.xyz.sub(wp);
    const dist = length(d);
    const h = max(L.y.sub(wp.y), 0.5);
    // lantern light: soft inverse-square falloff with a gentle edge, facing term so walls light from the lamp side
    const ndl = max(dot(nW, d.div(max(dist, 0.001))), 0.0).mul(0.75).add(0.25);
    const fall = h.mul(h).div(dist.mul(dist).add(2.0)).mul(smoothstep(22.0, 4.0, dist));
    acc.addAssign(L.w.mul(fall).mul(ndl));
  });
  return albedo.mul(lampWarm).mul(acc).mul(7.0);
});

export const saturate3 = (c, amount) => {
  const l = dot(c, vec3(0.3, 0.59, 0.11));
  return mix(vec3(l), c, amount);
};

// ------------------------------------------------------------------ soft-particle depth test for the FX pass
// FX (halos, light cones, rain, motes) render in their own pass and are occluded against the scene depth.
import { texture, screenUV, perspectiveDepthToViewZ, positionView, cameraNear, cameraFar } from 'three/tsl';
export const sceneDepth = texture(new THREE.DepthTexture(1, 1));
export const depthFade = (softness = 1.0) => {
  const sceneZ = perspectiveDepthToViewZ(sceneDepth.sample(screenUV).r, cameraNear, cameraFar);
  return positionView.z.sub(sceneZ).div(softness).clamp(0.0, 1.0);
};

export { clamp, floor, fract };
