import * as THREE from 'three';

const LAT = THREE.MathUtils.degToRad(57.03); // Laggan, Badenoch
const D2R = Math.PI / 180;

// Solar position. hour: local solar time 0..24. Returns direction TO the body in glTF axes
// (x east, y up, z south).
function bodyDir(hour, decl, out) {
  const H = (hour - 12) * 15 * D2R;
  const sinEl = Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(H);
  const el = Math.asin(THREE.MathUtils.clamp(sinEl, -1, 1));
  // azimuth measured from south, positive towards west
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(LAT) - Math.tan(decl) * Math.cos(LAT));
  const ce = Math.cos(el);
  out.set(-Math.sin(az) * ce, Math.sin(el), Math.cos(az) * ce);
  return out;
}

export function sunDirection(hour, dayOfYear, out = new THREE.Vector3()) {
  const decl = -23.44 * D2R * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10));
  return bodyDir(hour, decl, out);
}

// The moon: roughly opposite the sun with a phase offset (waxing gibbous), higher declination swing
export function moonDirection(hour, dayOfYear, out = new THREE.Vector3()) {
  const decl = 23.44 * D2R * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10)) * 0.9 + 4 * D2R;
  return bodyDir((hour + 12 - 2.5 + 24) % 24, decl, out);
}

// ------------------------------------------------------------------ sky palette by sun elevation
const K = (el, zen, hor, sun, glow) => ({ el, zen: new THREE.Color(zen), hor: new THREE.Color(hor), sun: new THREE.Color(sun), glow: new THREE.Color(glow) });
const PALETTE = [
  K(-20, 0x010309, 0x060b18, 0x000000, 0x000000),
  K(-11, 0x040a1c, 0x101a36, 0x000000, 0x1a1530),
  K(-5, 0x0c1838, 0x3a3a62, 0x000000, 0x8a4a5a),
  K(-1, 0x1e3264, 0x8a6a6a, 0x60201a, 0xe8803a),
  K(3, 0x3a63a0, 0xe6a060, 0xff8a3a, 0xffb050),
  K(9, 0x4677b8, 0xead0a0, 0xffb874, 0xffd090),
  K(20, 0x3a6cbc, 0xbcd2e6, 0xffe2c0, 0xfff0d8),
  K(45, 0x2c60b8, 0xa6c6ea, 0xfff4e8, 0xffffff),
  K(90, 0x2558b0, 0x9ec0e8, 0xfffaf2, 0xffffff),
];

export function skyPalette(sunElDeg, out) {
  let i = 0;
  while (i < PALETTE.length - 2 && sunElDeg > PALETTE[i + 1].el) i++;
  const a = PALETTE[i], b = PALETTE[i + 1];
  const t = THREE.MathUtils.clamp((sunElDeg - a.el) / (b.el - a.el), 0, 1);
  const s = t * t * (3 - 2 * t);
  out.zen.copy(a.zen).lerp(b.zen, s);
  out.hor.copy(a.hor).lerp(b.hor, s);
  out.sun.copy(a.sun).lerp(b.sun, s);
  out.glow.copy(a.glow).lerp(b.glow, s);
  return out;
}
