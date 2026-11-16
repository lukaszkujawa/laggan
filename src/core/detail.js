import {
  Fn, float, vec2, vec3, mix, smoothstep, step, clamp, abs, max, min, sin, cos, fract, floor, dot, cross, normalize,
  sign, positionWorld, positionView, cameraPosition, distance, faceDirection, mx_worley_noise_vec2, mx_cell_noise_float,
  normalWorld,
} from 'three/tsl';
import { U, noise2, fbm2 } from './tsl.js';

// ------------------------------------------------------------------ procedural bump from any height node
// (Mikkelsen's surface-gradient method, using screen-space derivatives of the height)
export const proceduralBump = (height, scale, baseNormal) => Fn(() => {
  const h = height.mul(scale);
  const dHdx = h.dFdx(), dHdy = h.dFdy();
  const sx = positionView.dFdx(), sy = positionView.dFdy();
  const N = baseNormal;
  const R1 = cross(sy, N), R2 = cross(N, sx);
  const det = dot(sx, R1).mul(faceDirection);
  const grad = sign(det).mul(R1.mul(dHdx).add(R2.mul(dHdy)));
  return normalize(abs(det).mul(N).sub(grad));
})();

// fades fine detail out with distance (it would only alias / shimmer)
export const detailFade = (near = 35, far = 90) => float(1).sub(smoothstep(near, far, distance(cameraPosition, positionWorld)));

// rotate a 2D point
const rot = (p, a) => vec2(p.x.mul(cos(a)).sub(p.y.mul(sin(a))), p.x.mul(sin(a)).add(p.y.mul(cos(a))));

// ------------------------------------------------------------------ ground: moss, pebbles, litter, mud
// villageMask: 0..1 where litter may appear (around houses and roads)
export function groundDetail() {
  const wp = positionWorld.xz;
  const fade = detailFade(30, 80);
  // moss: cushions in damp hollows and shade (larger patches + fine clumps)
  const mossField = fbm2(wp.mul(0.06).add(3.7)).mul(0.7).add(noise2(wp.mul(0.9)).mul(0.3));
  const moss = smoothstep(0.56, 0.7, mossField);
  const mossClump = noise2(wp.mul(6.0)).mul(0.5).add(noise2(wp.mul(17.0)).mul(0.5));
  // (no procedural pebbles: the export now places real scanned stones)
  // litter: rare small rotated rectangles (paper, crisp packets, cans) around the village
  const lc = wp.mul(0.45);
  const lcell = floor(lc);
  const lh = mx_cell_noise_float(vec3(lcell.x, lcell.y, 7.0));
  const local = rot(fract(lc).sub(0.5), lh.mul(40.0)).mul(vec2(9.0, 15.0));
  const village = smoothstep(80.0, 20.0, max(abs(positionWorld.x.sub(180.0)).sub(200.0), abs(positionWorld.z.sub(150.0)).sub(110.0)).max(0.0));
  const litterShape = step(abs(local.x), 0.5).mul(step(abs(local.y), 0.5));
  const litter = litterShape.mul(step(0.985, lh)).mul(village);
  const litterCol = mix(mix(vec3(0.82, 0.8, 0.74), vec3(0.6, 0.08, 0.06), step(0.5, fract(lh.mul(97.0)))),
    mix(vec3(0.12, 0.25, 0.55), vec3(0.65, 0.62, 0.58), step(0.5, fract(lh.mul(331.0)))), step(0.5, fract(lh.mul(17.0))));
  // muddy, trampled patches (darker, wetter)
  const mud = smoothstep(0.66, 0.8, fbm2(wp.mul(0.11).add(27.0))).mul(0.8);

  const color = (c) => {
    let o = mix(c, c.mul(vec3(0.55, 0.42, 0.3)), mud.mul(0.55));
    const mossCol = mix(vec3(0.07, 0.17, 0.02), vec3(0.2, 0.36, 0.04), mossClump);
    o = mix(o, mossCol, moss.mul(0.85).mul(float(1).sub(U.snow)));
    o = mix(o, litterCol, litter.mul(fade).mul(float(1).sub(U.snow)));
    return o;
  };
  const roughness = (r) => mix(r, 0.45, mud.mul(U.wetness));
  const height = mossClump.mul(moss).mul(0.3).mul(fade).add(litter.mul(0.15));
  return { color, roughness, height };
}

// ------------------------------------------------------------------ roads: cracks, repair patches, stains, edge moss
export function roadDetail() {
  const wp = positionWorld.xz;
  const fade = detailFade(40, 110);
  const w = mx_worley_noise_vec2(vec3(wp.x.mul(0.55), wp.y.mul(0.55), 0.0), 1.0);
  const crackLine = smoothstep(0.045, 0.0, w.y.sub(w.x)).mul(smoothstep(0.45, 0.65, noise2(wp.mul(0.07))));
  // tar repair patches on a skewed grid
  const pg = rot(wp, 0.6).mul(vec2(0.22, 0.12));
  const ph = mx_cell_noise_float(vec3(floor(pg.x), floor(pg.y), 3.0));
  const pf = fract(pg).sub(0.5).abs();
  const patch = step(0.88, ph).mul(step(pf.x, 0.38)).mul(step(pf.y, 0.32));
  const stain = smoothstep(0.62, 0.8, fbm2(wp.mul(0.25).add(5.0)));
  const grit = noise2(wp.mul(9.0));
  const color = (c) => {
    let o = c.mul(grit.mul(0.16).add(0.92));
    o = mix(o, o.mul(0.62), patch);
    o = mix(o, o.mul(vec3(0.6, 0.58, 0.55)), stain.mul(0.5));
    o = mix(o, vec3(0.05, 0.07, 0.03), crackLine.mul(fade));
    return o;
  };
  const roughness = (r) => mix(mix(r, 0.75, patch), 0.35, stain.mul(0.4));
  const height = crackLine.negate().mul(fade).add(patch.mul(0.2)).add(grit.mul(0.15).mul(fade));
  return { color, roughness, height };
}

// ------------------------------------------------------------------ buildings & timber: weathering
// heightAt: TSL function xz -> terrain height (for dirt splash at the foot of walls)
export function wallWear(heightAt, { roof = false, stone = false } = {}) {
  const wp = positionWorld;
  const up = clamp(normalWorld.y, 0.0, 1.0);
  const macro = fbm2(vec2(wp.x.add(wp.z), wp.y).mul(0.15));
  const blotch = noise2(vec2(wp.x.add(wp.z.mul(0.7)), wp.y.mul(1.3)).mul(0.9));
  const aboveGround = wp.y.sub(heightAt(wp.xz));
  const foot = smoothstep(1.4, 0.0, aboveGround).mul(float(1).sub(up));
  const streak = noise2(vec2(wp.x.add(wp.z).mul(4.0), wp.y.mul(0.15))).mul(noise2(vec2(wp.x.sub(wp.z).mul(1.7), wp.y.mul(0.08))));
  // moss & lichen: on roofs (more on gentle slopes), and green algae at the foot of walls
  const mossPatch = smoothstep(0.55, 0.75, fbm2(vec2(wp.x, wp.z).mul(0.6).add(wp.y.mul(0.3))));
  const color = (c) => {
    let o = c.mul(macro.mul(0.3).add(0.85)).mul(blotch.mul(0.14).add(0.93));
    o = o.mul(float(1).sub(streak.mul(0.22).mul(float(1).sub(up))));
    o = mix(o, o.mul(vec3(0.45, 0.47, 0.36)), foot.mul(0.7));
    if (roof) {
      // roofs: only the gentle tone variation above (no moss / lichen overlays)
    } else if (stone) {
      o = mix(o, vec3(0.12, 0.18, 0.06), mossPatch.mul(foot).mul(0.6));
    }
    return o;
  };
  const roughness = (r) => r.mul(macro.mul(0.2).add(0.9));
  return { color, roughness };
}
