import * as THREE from 'three/webgpu';
import { Fn, texture, vec2 } from 'three/tsl';

// 481 x 481 grid, 5 m spacing, rows south->north, cols west->east. glTF: x east, z = -north.
export class Heightfield {
  constructor(buffer) {
    this.n = 481;
    this.spacing = 5;
    this.half = 1200;
    this.data = new Float32Array(buffer);
    const tex = new THREE.DataTexture(this.data, this.n, this.n, THREE.RedFormat, THREE.FloatType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.texture = tex;
    const tnode = texture(tex);
    // TSL: world xz -> terrain height
    this.heightAt = Fn(([xz]) => {
      const u = xz.x.add(1200.0).div(2400.0);
      const v = xz.y.negate().add(1200.0).div(2400.0);
      const uv = vec2(u, v).mul(480.0 / 481.0).add(0.5 / 481.0);
      return tnode.sample(uv).r;
    });
  }
  sample(x, z) {
    const n = this.n;
    const fx = (x + this.half) / this.spacing;
    const fy = (-z + this.half) / this.spacing;
    const cx = Math.min(Math.max(fx, 0), n - 1.001);
    const cy = Math.min(Math.max(fy, 0), n - 1.001);
    const ix = Math.floor(cx), iy = Math.floor(cy);
    const tx = cx - ix, ty = cy - iy;
    const d = this.data;
    const h00 = d[iy * n + ix], h10 = d[iy * n + ix + 1];
    const h01 = d[(iy + 1) * n + ix], h11 = d[(iy + 1) * n + ix + 1];
    if (tx >= ty) return h00 + (h10 - h00) * tx + (h11 - h10) * ty;
    return h00 + (h11 - h01) * tx + (h01 - h00) * ty;
  }
}
