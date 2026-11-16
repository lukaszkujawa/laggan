import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Camera rig with four modes: orbit, walk (first person on the terrain), fly, tour (cinematic).
export class CameraRig {
  constructor(camera, dom, heightfield) {
    this.camera = camera;
    this.dom = dom;
    this.hf = heightfield;
    this.mode = 'orbit';
    this.orbit = new OrbitControls(camera, dom);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.06;
    this.orbit.maxPolarAngle = Math.PI * 0.495;
    this.orbit.minDistance = 4;
    this.orbit.maxDistance = 1400;
    this.orbit.screenSpacePanning = false;
    this.keys = new Set();
    this.yaw = 0; this.pitch = 0;
    this.vel = new THREE.Vector3();
    this.vy = 0;
    this.focus = new THREE.Vector3();
    this.tourT = 0;
    this.listeners = [];
    window.addEventListener('keydown', (e) => { if (e.target.tagName !== 'INPUT') this.keys.add(e.code); });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    dom.addEventListener('mousemove', (e) => {
      if (this.mode === 'orbit' || this.mode === 'tour') return;
      if (document.pointerLockElement === dom || (e.buttons & 1)) {
        this.yaw -= e.movementX * 0.0022;
        this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0022, -1.45, 1.45);
      }
    });
    dom.addEventListener('dblclick', () => { if (this.mode === 'walk' || this.mode === 'fly') dom.requestPointerLock?.(); });
    // tour path through the village (x, z, height above ground)
    const P = [
      [-60, 230, 45], [40, 205, 12], [95, 160, 4], [150, 128, 3], [230, 150, 5], [300, 175, 6],
      [345, 205, 4], [300, 260, 18], [240, 280, 9], [150, 260, 22], [60, 120, 14], [0, 60, 30], [-80, 140, 60],
    ];
    this.tourPts = P.map(([x, z, h]) => new THREE.Vector3(x, h, z));
    this.tourCurve = new THREE.CatmullRomCurve3(this.tourPts, true, 'centripetal');
  }

  onModeChange(f) { this.listeners.push(f); }

  setMode(mode) {
    if (mode === this.mode) return;
    const cam = this.camera;
    if (document.pointerLockElement) document.exitPointerLock();
    this.mode = mode;
    this.orbit.enabled = mode === 'orbit';
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    if (mode === 'walk') {
      cam.position.y = this.hf.sample(cam.position.x, cam.position.z) + 1.7;
      this.pitch = 0;
    }
    if (mode === 'orbit') {
      const t = cam.position.clone().addScaledVector(dir, 60);
      t.y = this.hf.sample(t.x, t.z);
      this.orbit.target.copy(t);
    }
    if (mode === 'tour') this.tourT = this.nearestTourT(cam.position);
    this.listeners.forEach((f) => f(mode));
  }

  nearestTourT(p) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < 200; i++) {
      const q = this.tourCurve.getPointAt(i / 200);
      q.y += this.hf.sample(q.x, q.z);
      const d = q.distanceToSquared(p);
      if (d < bd) { bd = d; best = i / 200; }
    }
    return best;
  }

  update(dt) {
    const cam = this.camera;
    const k = this.keys;
    const ground = (x, z) => this.hf.sample(x, z);
    if (this.mode === 'orbit') {
      // WASD pans the orbit target
      const f = new THREE.Vector3(); cam.getWorldDirection(f); f.y = 0; f.normalize();
      const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0));
      const dist = cam.position.distanceTo(this.orbit.target);
      const sp = (k.has('ShiftLeft') ? 3 : 1) * Math.max(10, dist * 0.6) * dt;
      const mv = new THREE.Vector3();
      if (k.has('KeyW')) mv.add(f); if (k.has('KeyS')) mv.sub(f);
      if (k.has('KeyD')) mv.add(r); if (k.has('KeyA')) mv.sub(r);
      if (mv.lengthSq() > 0) {
        mv.normalize().multiplyScalar(sp);
        cam.position.add(mv); this.orbit.target.add(mv);
        this.orbit.target.y += (ground(this.orbit.target.x, this.orbit.target.z) - this.orbit.target.y) * 0.2;
      }
      this.orbit.update();
      const g = ground(cam.position.x, cam.position.z) + 1.2;
      if (cam.position.y < g) cam.position.y = g;
      this.focus.copy(this.orbit.target);
    } else if (this.mode === 'walk' || this.mode === 'fly') {
      const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const mv = new THREE.Vector3();
      if (k.has('KeyW') || k.has('ArrowUp')) mv.add(fwd);
      if (k.has('KeyS') || k.has('ArrowDown')) mv.sub(fwd);
      if (k.has('KeyD') || k.has('ArrowRight')) mv.add(right);
      if (k.has('KeyA') || k.has('ArrowLeft')) mv.sub(right);
      const fly = this.mode === 'fly';
      const speed = fly ? (k.has('ShiftLeft') ? 120 : 30) : (k.has('ShiftLeft') ? 7 : 2.6);
      if (mv.lengthSq() > 0) mv.normalize();
      if (fly) {
        const look = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
        const m2 = new THREE.Vector3();
        if (k.has('KeyW')) m2.add(look); if (k.has('KeyS')) m2.sub(look);
        if (k.has('KeyD')) m2.add(right); if (k.has('KeyA')) m2.sub(right);
        if (k.has('KeyE') || k.has('Space')) m2.y += 1; if (k.has('KeyQ')) m2.y -= 1;
        if (m2.lengthSq() > 0) m2.normalize();
        this.vel.lerp(m2.multiplyScalar(speed), Math.min(1, dt * 4));
        cam.position.addScaledVector(this.vel, dt);
        const g = ground(cam.position.x, cam.position.z) + 1.5;
        if (cam.position.y < g) cam.position.y = g;
      } else {
        this.vel.lerp(mv.multiplyScalar(speed), Math.min(1, dt * 8));
        cam.position.addScaledVector(this.vel, dt);
        const g = ground(cam.position.x, cam.position.z) + 1.7;
        if (k.has('Space') && cam.position.y <= g + 0.01) this.vy = 4.2;
        this.vy -= 9.81 * dt;
        cam.position.y += this.vy * dt;
        if (cam.position.y < g) { cam.position.y = g; this.vy = 0; }
        // head bob
        const sp = this.vel.length();
        this.bob = (this.bob || 0) + dt * sp * 2.2;
        cam.position.y += Math.sin(this.bob) * 0.025 * Math.min(1, sp / 3);
      }
      const e = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
      cam.quaternion.setFromEuler(e);
      this.focus.copy(cam.position).addScaledVector(fwd, 40);
    } else if (this.mode === 'tour') {
      this.tourT = (this.tourT + dt * 0.0045) % 1;
      const p = this.tourCurve.getPointAt(this.tourT);
      const ahead = this.tourCurve.getPointAt((this.tourT + 0.025) % 1);
      p.y += ground(p.x, p.z);
      ahead.y += ground(ahead.x, ahead.z) - 2;
      cam.position.lerp(p, Math.min(1, dt * 2));
      const m = new THREE.Matrix4().lookAt(cam.position, ahead, new THREE.Vector3(0, 1, 0));
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      cam.quaternion.slerp(q, Math.min(1, dt * 1.5));
      this.focus.copy(ahead);
    }
  }
}
