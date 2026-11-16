import * as THREE from 'three/webgpu';
import {
  Fn, float, vec3, vec4, attribute, positionGeometry, cameraPosition, normalize, cross, length, exp, mix, smoothstep,
  dot, abs, pow, clamp, positionWorld, normalWorld, uniform,
} from 'three/tsl';
import { U, noise2, fogFactorNode, depthFade, lampData, lampCount, MAX_LAMPS } from '../core/tsl.js';

// Street lamps: emissive lantern glass (world.js), glow halos, misty light cones and a pool of
// real point lights that follows the camera to the nearest lanterns.
export class Lamps {
  constructor(scene, lampList, heightfield, fxScene = scene) {
    const lamps = [];
    for (const p of lampList) {
      if (lamps.some((q) => Math.hypot(q.x - p[0], q.y - p[1], q.z - p[2]) < 0.6)) continue;
      lamps.push(new THREE.Vector3(p[0], p[1], p[2]));
    }
    this.lamps = lamps.map((pos, i) => ({
      pos, on: 0, v: 0,
      threshold: 0.35 + Math.random() * 0.18,
      flicker: i === 3,
      ground: heightfield.sample(pos.x, pos.z),
    }));
    const n = this.lamps.length;
    // ---- halos (billboards)
    const hgeo = new THREE.InstancedBufferGeometry();
    const plane = new THREE.PlaneGeometry(1, 1);
    hgeo.index = plane.index;
    hgeo.setAttribute('position', plane.attributes.position);
    const posArr = new Float32Array(n * 3);
    this.lamps.forEach((l, i) => l.pos.toArray(posArr, i * 3));
    hgeo.setAttribute('iPos', new THREE.InstancedBufferAttribute(posArr, 3));
    this.onAttr = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
   
    hgeo.setAttribute('iOn', this.onAttr);
    hgeo.instanceCount = n;
    const iPos = attribute('iPos', 'vec3');
    const iOn = attribute('iOn', 'float');
    const hmat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    hmat.fog = false;
    hmat.positionNode = Fn(() => {
      const toCam = normalize(cameraPosition.sub(iPos));
      const right = normalize(cross(vec3(0, 1, 0), toCam));
      const up = cross(toCam, right);
      return iPos.add(right.mul(positionGeometry.x).add(up.mul(positionGeometry.y)).mul(2.6)).add(toCam.mul(0.4));
    })();
    hmat.colorNode = Fn(() => {
      const r = length(positionGeometry.xy).mul(2.0);
      const core = exp(r.mul(r).mul(-18.0));
      const halo = exp(r.mul(-4.0)).mul(U.fogDensity.mul(60.0).add(U.rain.mul(0.5)).add(0.35));
      const col = mix(vec3(1.0, 0.18, 0.04), vec3(1.0, 0.52, 0.2), smoothstep(0.2, 1.0, iOn));
      const f = float(1).sub(fogFactorNode.mul(0.8));
      return vec4(col.mul(core.mul(1.6).add(halo.mul(0.45))).mul(iOn).mul(f).mul(depthFade(0.5)), 1.0);
    })();
    this.halos = new THREE.Mesh(hgeo, hmat);
    this.halos.frustumCulled = false;
    this.halos.renderOrder = 10;
    // ---- misty light cones
    const cgeo = new THREE.CylinderGeometry(0.15, 2.6, 1, 24, 1, true);
    this.coneOn = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
   
    cgeo.setAttribute('iOn', this.coneOn);
    this.mist = uniform(0.3);
    const cmat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    cmat.fog = false;
    cmat.colorNode = Fn(() => {
      const V = normalize(cameraPosition.sub(positionWorld));
      const rim = pow(abs(dot(normalize(normalWorld), V)), 1.5);
      const fall = pow(clamp(positionGeometry.y.add(0.5), 0.0, 1.0), 1.6);
      const dust = noise2(positionWorld.xz.mul(2.0).add(vec3(0, U.time.mul(0.6), 0).xy).add(positionWorld.y)).mul(0.25).add(0.75);
      return vec4(vec3(1.0, 0.55, 0.24).mul(rim).mul(fall).mul(dust).mul(attribute('iOn', 'float')).mul(this.mist).mul(0.1).mul(depthFade(0.8)), 1.0);
    })();
    this.cones = new THREE.InstancedMesh(cgeo, cmat, n);
    const m = new THREE.Matrix4();
    this.lamps.forEach((l, i) => {
      const h = Math.max(1, l.pos.y - l.ground - 0.15);
      m.compose(new THREE.Vector3(l.pos.x, l.pos.y - 0.15 - h / 2, l.pos.z), new THREE.Quaternion(), new THREE.Vector3(1, h, 1));
      this.cones.setMatrixAt(i, m);
    });
    this.cones.frustumCulled = false;
    this.cones.renderOrder = 11;
    fxScene.add(this.halos, this.cones);
    // ---- point light pool (fixed count: changing the light count recompiles shaders)
    this.pool = [];
    for (let i = 0; i < 4; i++) {
      const pl = new THREE.PointLight(0xffb070, 0, 30, 2);
      pl.castShadow = false;
      scene.add(pl);
      this.pool.push(pl);
    }
    this.poolTimer = 0;
    this.mean = 0;
  }

  update(dt, camera, weather) {
    const dark = U.dark.value;
    let sum = 0;
    for (const l of this.lamps) {
      const target = dark > l.threshold ? 1 : 0;
      l.on += (target - l.on) * Math.min(1, dt * (target > l.on ? 0.35 : 2.0));
      let v = l.on;
      if (l.flicker && v > 0.5) v *= Math.random() < 0.06 ? 0.15 : 1;
      l.v = v;
      sum += v;
    }
    this.mean = sum / this.lamps.length;
    this.lamps.forEach((l, i) => {
      this.onAttr.array[i] = l.v; this.coneOn.array[i] = l.v;
      if (i < MAX_LAMPS) lampData.array[i].set(l.pos.x, l.pos.y, l.pos.z, l.v);
    });
    lampCount.value = this.mean > 0.001 ? Math.min(this.lamps.length, MAX_LAMPS) : 0;
    this.onAttr.needsUpdate = true; this.coneOn.needsUpdate = true;
    U.lampOn.value = this.mean;
    this.halos.visible = this.cones.visible = this.mean > 0.001;
    this.mist.value = 0.18 + weather.cur.fog * 1.1 + weather.cur.rain * 0.5 + weather.cur.snow * 0.5;
    this.poolTimer -= dt;
    if (this.poolTimer <= 0) {
      this.poolTimer = 0.25;
      const cp = camera.position;
      this.assigned = this.lamps.filter((l) => l.v > 0.01).sort((a, b) => a.pos.distanceToSquared(cp) - b.pos.distanceToSquared(cp)).slice(0, this.pool.length);
    }
    this.pool.forEach((pl, i) => {
      const l = this.assigned && this.assigned[i];
      if (!l) { pl.intensity = 0; return; }
      pl.position.copy(l.pos).y -= 0.3;
      pl.intensity = 16 * l.v;
      pl.color.setRGB(1.0, 0.38 + 0.1 * l.v, 0.1 + 0.05 * l.v);
    });
  }
}
