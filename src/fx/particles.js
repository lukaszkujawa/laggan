import * as THREE from 'three/webgpu';
import {
  Fn, uniform, float, vec2, vec3, vec4, attribute, positionGeometry, cameraPosition, normalize, cross, length, mod,
  smoothstep, mix, sin, cos, exp, fract, abs, select, uv, hash, floor, step, max,
} from 'three/tsl';
import { U, noise2, depthFade } from '../core/tsl.js';

function quadInstanced(count) {
  const geo = new THREE.InstancedBufferGeometry();
  const base = new THREE.PlaneGeometry(1, 1);
  geo.index = base.index;
  geo.setAttribute('position', base.attributes.position);
  geo.setAttribute('uv', base.attributes.uv);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geo.instanceCount = 0;
  return geo;
}

const billboard = (wp, size) => {
  const toCam = normalize(cameraPosition.sub(wp));
  const side = normalize(cross(vec3(0, 1, 0), toCam));
  const up = cross(toCam, side);
  return wp.add(side.mul(positionGeometry.x).add(up.mul(positionGeometry.y)).mul(size));
};

export class Particles {
  constructor(scene, hf) {
    const H = hf.heightAt;
    const seed = attribute('aSeed', 'vec4');
    const wrap = (p, box) => cameraPosition.add(mod(p.sub(cameraPosition).add(box.mul(0.5)), box).sub(box.mul(0.5)));
    this.scene = scene;

    // ---------------- rain
    const rainBox = vec3(44, 26, 44);
    this.rainFall = uniform(11);
    this.lampOn = uniform(0);
    const rainPos = () => {
      const speed = this.rainFall.mul(seed.w.mul(0.3).add(0.85));
      const drift = U.windDir.mul(U.windStrength).mul(5.0);
      const p = seed.xyz.mul(rainBox).add(vec3(drift.x.mul(U.time), speed.mul(U.time).negate(), drift.y.mul(U.time)));
      return { wp: wrap(p, rainBox), vel: normalize(vec3(drift.x, speed.negate(), drift.y)) };
    };
    const rainMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    rainMat.fog = false;
    rainMat.positionNode = Fn(() => {
      const { wp, vel } = rainPos();
      const toCam = normalize(cameraPosition.sub(wp));
      const side = normalize(cross(vel, toCam));
      return wp.add(side.mul(positionGeometry.x).mul(0.01)).add(vel.mul(positionGeometry.y).mul(seed.w.mul(0.22).add(0.32)));
    })();
    const rainFade = Fn(() => {
      const { wp } = rainPos();
      const ground = H(wp.xz);
      return smoothstep(ground.sub(0.2), ground.add(0.6), wp.y).mul(float(1).sub(smoothstep(15.0, 22.0, length(wp.xz.sub(cameraPosition.xz)))));
    })();
    rainMat.colorNode = Fn(() => {
      const light = U.ambSky.mul(1.4).add(U.sunCol.mul(0.12)).add(vec3(1.0, 0.65, 0.35).mul(this.lampOn).mul(0.04)).add(vec3(0.8, 0.85, 1.0).mul(U.flash).mul(2.0));
      const x = abs(uv().x.sub(0.5)).mul(2.0);
      const a = float(1).sub(x).mul(smoothstep(0.0, 0.3, uv().y)).mul(smoothstep(1.0, 0.6, uv().y)).mul(0.3).mul(rainFade);
      return vec4(light.mul(0.8), a);
    })();
    this.rainMax = 40000;
    this.rainGeo = quadInstanced(this.rainMax);
    this.rain = new THREE.Mesh(this.rainGeo, rainMat);

    // ---------------- snow
    const snowBox = vec3(50, 30, 50);
    const snowPos = () => {
      const speed = seed.w.mul(0.3).add(0.85).mul(1.1);
      const drift = U.windDir.mul(U.windStrength).mul(3.0);
      const p = seed.xyz.mul(snowBox).add(vec3(drift.x.mul(U.time), speed.mul(U.time).negate(), drift.y.mul(U.time))).toVar();
      p.x.addAssign(sin(U.time.mul(seed.w.add(0.6)).add(seed.w.mul(40.0))).mul(0.8));
      p.z.addAssign(cos(U.time.mul(seed.x.add(0.5)).add(seed.y.mul(40.0))).mul(0.8));
      return wrap(p, snowBox);
    };
    const snowMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    snowMat.fog = false;
    snowMat.positionNode = Fn(() => billboard(snowPos(), seed.w.mul(0.04).add(0.06)))();
    snowMat.colorNode = Fn(() => {
      const wp = snowPos();
      const ground = H(wp.xz);
      const fade = smoothstep(ground.sub(0.2), ground.add(0.4), wp.y).mul(float(1).sub(smoothstep(18.0, 25.0, length(wp.xz.sub(cameraPosition.xz)))));
      const r = length(uv().sub(0.5)).mul(2.0);
      const light = U.ambSky.mul(2.0).add(U.sunCol.mul(0.3));
      return vec4(light, smoothstep(1.0, 0.2, r).mul(fade).mul(0.9));
    })();
    this.snowMax = 26000;
    this.snowGeo = quadInstanced(this.snowMax);
    this.snow = new THREE.Mesh(this.snowGeo, snowMat);

    // ---------------- splashes
    const splashMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    splashMat.fog = false;
    const splashT = Fn(() => fract(U.time.div(seed.w.mul(0.4).add(0.5)).add(seed.z.mul(10.0))))();
    const splashXZ = Fn(() => {
      const cycle = floor(U.time.div(seed.w.mul(0.4).add(0.5)).add(seed.z.mul(10.0)));
      const rnd = vec2(hash(cycle.mul(131.0).add(seed.x.mul(9973.0)).mul(97.0)), hash(cycle.mul(71.0).add(seed.y.mul(7919.0)).mul(89.0))).sub(0.5);
      return cameraPosition.xz.add(rnd.mul(30.0));
    })();
    splashMat.positionNode = Fn(() => {
      const xz = splashXZ;
      const y = H(xz).add(0.03);
      const s = splashT.mul(0.22).add(0.06);
      return vec3(xz.x.add(positionGeometry.x.mul(s)), y, xz.y.sub(positionGeometry.y.mul(s)));
    })();
    splashMat.colorNode = Fn(() => {
      const r = length(uv().sub(0.5)).mul(2.0);
      const ring = smoothstep(0.15, 0.0, abs(r.sub(0.8))).mul(float(1).sub(splashT));
      return vec4(U.ambSky.mul(1.6).add(U.sunCol.mul(0.1)), ring.mul(0.5));
    })();
    this.splashMax = 1200;
    this.splashGeo = quadInstanced(this.splashMax);
    this.splash = new THREE.Mesh(this.splashGeo, splashMat);

    // ---------------- fireflies / pollen / leaves share one wandering-mote motion
    const motes = (mode) => {
      const box = mode === 0 ? vec3(90, 10, 90) : mode === 1 ? vec3(70, 10, 70) : vec3(60, 10, 60);
      const pos = () => {
        const t = U.time.mul(mode === 0 ? 0.12 : 0.25);
        const wander = vec3(noise2(vec2(t.add(seed.x.mul(50.0)), seed.y.mul(20.0))).sub(0.5),
          noise2(vec2(seed.z.mul(30.0), t.mul(1.3).add(seed.w.mul(10.0)))).sub(0.5),
          noise2(vec2(t.mul(0.9).add(seed.w.mul(70.0)), seed.x.mul(5.0))).sub(0.5)).mul(vec3(10.0, 2.0, 10.0));
        const p = seed.xyz.mul(box).add(wander).toVar();
        if (mode > 0) p.xz.addAssign(U.windDir.mul(U.time).mul(U.windStrength.mul(mode === 2 ? 6.0 : 3.0).add(0.6)));
        const wp = wrap(p, box).toVar();
        const ground = H(wp.xz);
        let hover;
        if (mode === 0) hover = seed.w.mul(seed.w).mul(2.5).add(0.3);
        else if (mode === 1) hover = seed.w.mul(4.0).add(0.5);
        else hover = fract(seed.w.sub(U.time.mul(0.05).mul(seed.x.add(0.5)))).mul(7.0).add(0.1);
        wp.y.assign(ground.add(hover).add(wander.y.mul(0.4)));
        return wp;
      };
      const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: mode === 2 ? THREE.NormalBlending : THREE.AdditiveBlending });
      mat.fog = false;
      const blink = mode === 0 ? sin(U.time.mul(seed.y.mul(2.5).add(1.5)).add(seed.x.mul(60.0))).mul(0.5).add(0.5).pow(6.0) : float(1);
      mat.positionNode = Fn(() => {
        const wp = pos();
        if (mode === 2) {
          const ang = U.time.mul(seed.z.mul(5.0).add(2.0)).add(seed.x.mul(30.0));
          const qx = positionGeometry.x.mul(cos(ang)).sub(positionGeometry.y.mul(sin(ang)));
          const qy = positionGeometry.x.mul(sin(ang)).add(positionGeometry.y.mul(cos(ang))).mul(abs(sin(ang.mul(0.7))).mul(0.55).add(0.45));
          const toCam = normalize(cameraPosition.sub(wp));
          const side = normalize(cross(vec3(0, 1, 0), toCam));
          const up = cross(toCam, side);
          return wp.add(side.mul(qx).add(up.mul(qy)).mul(seed.y.mul(0.04).add(0.07)));
        }
        return billboard(wp, mode === 0 ? blink.mul(0.05).add(0.09) : float(0.035));
      })();
      mat.colorNode = Fn(() => {
        const wp = pos();
        const fade = float(1).sub(smoothstep(box.x.mul(0.32), box.x.mul(0.5), length(wp.xz.sub(cameraPosition.xz))));
        const r = length(uv().sub(0.5)).mul(2.0);
        if (mode === 2) {
          const lc = select(seed.w.greaterThan(0.8), vec3(0.7, 0.2, 0.05), mix(vec3(0.55, 0.32, 0.06), vec3(0.25, 0.4, 0.08), seed.w));
          return vec4(lc.mul(U.sunCol.mul(0.35).add(U.ambSky.mul(1.2))), smoothstep(1.0, 0.7, r).mul(fade));
        }
        const a = exp(r.mul(r).mul(-5.0)).mul(fade);
        if (mode === 1) return vec4(U.sunCol.mul(0.35).add(U.ambSky.mul(0.8)).mul(vec3(1.0, 0.97, 0.85)).mul(1.5).mul(a), a);
        const c = select(seed.w.greaterThan(0.9), vec3(0.6, 0.45, 1.0), mix(vec3(0.75, 1.0, 0.25), vec3(0.3, 1.0, 0.85), seed.w));
        return vec4(c.mul(5.0).mul(blink).mul(a), a);
      })();
      return mat;
    };
    this.fireMax = 1400; this.fireGeo = quadInstanced(this.fireMax); this.fire = new THREE.Mesh(this.fireGeo, motes(0));
    this.pollenMax = 1600; this.pollenGeo = quadInstanced(this.pollenMax); this.pollen = new THREE.Mesh(this.pollenGeo, motes(1));
    this.leafMax = 900; this.leafGeo = quadInstanced(this.leafMax); this.leaves = new THREE.Mesh(this.leafGeo, motes(2));

    const names = ['rain', 'snow', 'splash', 'fire', 'pollen', 'leaves'];
    for (const k of names) {
      const m = this[k];
      // soft particles: fade against the scene depth (FX are rendered in a separate pass)
      const base = m.material.colorNode;
      m.material.colorNode = vec4(base.rgb, base.a.mul(depthFade(k === 'splash' ? 0.05 : 0.4)));
      if (m.material.blending === THREE.AdditiveBlending) m.material.colorNode = vec4(base.rgb.mul(depthFade(0.4)), base.a);
      m.name = k;
      m.frustumCulled = false;
      m.renderOrder = 20;
      scene.add(m);
    }
    this.bolts = [];
  }

  update(dt, weather, lampOn) {
    const w = weather.cur;
    this.rainGeo.instanceCount = Math.floor(this.rainMax * Math.min(1, w.rain * 1.05));
    this.rainFall.value = 10 + 4 * w.storm;
    this.lampOn.value = lampOn;
    this.snowGeo.instanceCount = Math.floor(this.snowMax * Math.min(1, w.snow * 1.05));
    this.splashGeo.instanceCount = Math.floor(this.splashMax * w.rain);
    const night = U.night.value, fant = U.fantasy.value;
    const calm = (1 - Math.min(1, w.rain * 2)) * (1 - w.snow) * (1 - Math.min(1, Math.max(0, w.windEff - 0.6)));
    this.fireGeo.instanceCount = 0; // fireflies removed
    this.pollenGeo.instanceCount = Math.floor(this.pollenMax * (1 - night) * calm * (0.3 + 0.7 * fant) * (1 - w.cloud * 0.5));
    this.leafGeo.instanceCount = Math.floor(this.leafMax * Math.min(1, Math.max(0, (w.windEff - 0.45) * 1.4)) * (1 - w.snow));
    for (const k of ['rain', 'snow', 'splash', 'fire', 'pollen', 'leaves']) this[k].visible = this[k].geometry.instanceCount > 0;
    for (const b of this.bolts) {
      b.life -= dt;
      b.mesh.material.opacity = Math.max(0, b.life / b.max) * (Math.random() < 0.3 ? 0.4 : 1);
      if (b.life <= 0) { this.scene.remove(b.mesh); b.mesh.geometry.dispose(); b.mesh.material.dispose(); }
    }
    this.bolts = this.bolts.filter((b) => b.life > 0);
  }

  strike(camera, dir, dist, groundAt) {
    const c = camera.position;
    const hx = c.x + dir.x * dist, hz = c.z + dir.z * dist;
    const gy = groundAt(hx, hz);
    const top = new THREE.Vector3(hx + (Math.random() - 0.5) * 200, gy + 900, hz + (Math.random() - 0.5) * 200);
    const bottom = new THREE.Vector3(hx, gy, hz);
    const pts = [];
    const segs = 28;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const p = top.clone().lerp(bottom, t);
      if (i > 0 && i < segs) { p.x += (Math.random() - 0.5) * 60 * (1 - t * 0.5); p.z += (Math.random() - 0.5) * 60 * (1 - t * 0.5); }
      pts.push(p);
    }
    const branches = [pts];
    for (let b = 0; b < 3; b++) {
      const start = 3 + Math.floor(Math.random() * 15);
      const br = [pts[start].clone()];
      for (let i = 1; i < 8; i++) br.push(br[i - 1].clone().add(new THREE.Vector3((Math.random() - 0.5) * 70, -30 - Math.random() * 40, (Math.random() - 0.5) * 70)));
      branches.push(br);
    }
    const positions = [];
    const toCam = new THREE.Vector3().subVectors(c, bottom).normalize();
    for (const [bi, br] of branches.entries()) {
      const width = bi === 0 ? 4.5 : 2;
      for (let i = 0; i < br.length - 1; i++) {
        const a = br[i], b2 = br[i + 1];
        const d = new THREE.Vector3().subVectors(b2, a).normalize();
        const side = new THREE.Vector3().crossVectors(d, toCam).normalize().multiplyScalar(width);
        const a1 = a.clone().add(side), a2 = a.clone().sub(side), b1 = b2.clone().add(side), bb2 = b2.clone().sub(side);
        positions.push(a1.x, a1.y, a1.z, a2.x, a2.y, a2.z, b1.x, b1.y, b1.z, b1.x, b1.y, b1.z, a2.x, a2.y, a2.z, bb2.x, bb2.y, bb2.z);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(6, 6.5, 9), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    mat.fog = false;
    mat.colorNode = vec4(vec3(6, 6.5, 9).mul(depthFade(5.0)), 1.0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.bolts.push({ mesh, life: 0.35, max: 0.35 });
  }
}
