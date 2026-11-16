import * as THREE from 'three/webgpu';
import {
  pass, mrt, output, normalView, diffuseColor, velocity, packNormalToRGB, unpackRGBToNormal, convertToTexture, sample, vec2, vec3, vec4,
  float, metalness, roughness, uniform, Fn, screenUV, dot, mix, smoothstep, length, pow, clamp, max, hash,
  blendColor, Loop,
} from 'three/tsl';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { taau } from 'three/addons/tsl/display/TAAUNode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { sceneDepth } from '../core/tsl.js';

export const postUniforms = {
  sunScreen: uniform(new THREE.Vector2(0.5, 0.5)),
  sunVisible: uniform(0),
  sunColor: uniform(new THREE.Color(1, 0.8, 0.6)),
  shaftStrength: uniform(0.6),
  saturation: uniform(1.1),
  contrast: uniform(1.06),
  warmth: uniform(0.0),
  vignette: uniform(0.55),
  grain: uniform(0.035),
  frame: uniform(0),
  aoStrength: uniform(1.0),
  night: uniform(0),
  // time-of-day grade
  lift: uniform(new THREE.Color(1.0, 1.0, 0.99)),
  gain: uniform(new THREE.Color(1.04, 1.0, 0.94)),
  halation: uniform(new THREE.Color(1.0, 0.55, 0.3)),
  giStrength: uniform(0.12), // SSGI bounce is strong in open scenes (sky is already in the IBL): keep it a subtle tint
};
const P = postUniforms;

export class Post {
  constructor(renderer, scene, camera, { ssgi: useGI = true, ssr: useSSR = true, fxScene = null, off = new Set(), renderScale = 1.0 } = {}) {
    this.off = off;
    this.renderScale = renderScale;
    this.renderer = renderer;
    this.scene = scene;
    this.fxScene = fxScene;
    this.camera = camera;
    this.pipeline = new THREE.RenderPipeline(renderer);
    this.exposure = 1;
    this.build(useGI, useSSR);
  }

  build(useGI, useSSR) {
    const { scene, camera } = this;
    const scenePass = pass(scene, camera);
    scenePass.setMRT(mrt({
      output,
      diffuseColor,
      normal: vec4(packNormalToRGB(normalView), roughness), // roughness packed in alpha (fits 32-byte MRT limit)
      velocity,
    }));
    const color = scenePass.getTextureNode('output');
    const diffuse = scenePass.getTextureNode('diffuseColor');
    const depth = scenePass.getTextureNode('depth');
    const normalTex = scenePass.getTextureNode('normal');
    const vel = scenePass.getTextureNode('velocity');
    scenePass.getTexture('diffuseColor').type = THREE.UnsignedByteType;
    scenePass.getTexture('normal').type = THREE.UnsignedByteType;
    const sceneNormal = sample((u) => unpackRGBToNormal(normalTex.sample(u).xyz));
    this.scenePass = scenePass;
    // temporal upscaling: the scene renders at a lower internal resolution, TAAU reconstructs full resolution
    scenePass.setResolutionScale(this.renderScale);
    sceneDepth.value = scenePass.getTexture('depth');
    // FX pass (no G-buffer writes, depth-tested in-shader against the scene depth)
    let fx = vec3(0);
    if (this.fxScene) {
      const fxPass = pass(this.fxScene, camera);
      fx = fxPass.getTextureNode('output').rgb;
      this.fxPass = fxPass;
    }

    let lit = color;
    if (useGI) {
      const gi = ssgi(color, depth, sceneNormal, camera);
      gi.sliceCount.value = 2;
      gi.stepCount.value = 10;
      gi.radius.value = 6;
      gi.giIntensity.value = 0.25;
      gi.aoIntensity.value = 1.0;
      gi.thickness.value = 1.5;
      gi.resolutionScale = 0.5; // half-res GI: denoised by the temporal filter, ~4x cheaper
      this.gi = gi;
      lit = vec4(color.rgb.mul(mix(float(1), gi.a, P.aoStrength)).add(diffuse.rgb.mul(gi.rgb).mul(P.giStrength)), color.a);
    }
    if (useSSR) {
      const r = ssr(convertToTexture(lit), depth, sceneNormal, { metalnessNode: float(0), roughnessNode: normalTex.a, reflectNonMetals: true, camera });
      r.maxDistance.value = 120;
      r.thickness.value = 0.6;
      r.quality.value = 0.5;
      this.ssr = r;
      // reflection rgb is already fresnel/distance weighted (alpha = hit distance): add it, scaled by smoothness
      const smooth = pow(float(1).sub(normalTex.a), 3.0);
      lit = vec4(lit.rgb.add(r.rgb.mul(smooth)), lit.a);
    }
    let aa0;
    if (this.off.has('traa')) aa0 = lit;
    else {
      const litTex = convertToTexture(lit);
      litTex.setResolutionScale(this.renderScale);
      this.litTex = litTex;
      aa0 = taau(litTex, depth, vel, camera);
    }
    this.traa = aa0;
    const aa = vec4(aa0.rgb.add(fx), 1.0);
    // crepuscular rays: radial blur of the bright sky towards the sun
    const shafts = Fn(() => {
      const acc = vec3(0).toVar();
      const dir = P.sunScreen.sub(screenUV);
      const jitter = hash(screenUV.x.mul(1931.0).add(screenUV.y.mul(7283.0)).add(P.frame.mul(17.0)).mul(4096.0));
      const decay = float(1).toVar();
      Loop(24, ({ i }) => {
        const t = float(i).add(jitter).div(24.0);
        const suv = screenUV.add(dir.mul(t.mul(0.9)));
        const d = depth.sample(suv).r;
        const sky = smoothstep(0.9999, 1.0, d);
        acc.addAssign(color.sample(suv).rgb.mul(sky).mul(decay));
        decay.mulAssign(0.93);
      });
      const falloff = clamp(float(1).sub(length(dir).mul(1.3)), 0.0, 1.0);
      return acc.div(24.0).mul(falloff).mul(P.sunVisible).mul(P.shaftStrength).mul(P.sunColor);
    })();
    const shaftsN = this.off.has('shafts') ? vec3(0) : shafts;
    const focused = aa;
    const bl = bloom(focused, 0.35, 0.55, 0.9);
    this.bloom = bl;
    const graded = Fn(() => {
      // halation: the bloom picks up a warm film-like fringe
      const c = focused.rgb.add(bl.rgb.mul(mix(vec3(1.0), P.halation, 0.35))).add(shaftsN).toVar();
      const l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // lift (shadow tint) and gain (highlight tint) follow the time of day and weather
      const shadowsTint = mix(vec3(1.0), P.lift, smoothstep(0.3, 0.0, l));
      const highTint = mix(vec3(1.0), P.gain, smoothstep(0.25, 1.4, l));
      c.mulAssign(shadowsTint.mul(highTint));
      c.assign(mix(vec3(l), c, P.saturation));
      // selective vibrance for foliage: greens get richer and slightly warmer (away from grey-olive)
      const greenness = smoothstep(0.0, 0.06, c.g.sub(max(c.r, c.b))).mul(float(1).sub(P.night));
      const lush = mix(vec3(l), c, 1.25).mul(vec3(1.02, 1.02, 0.9));
      c.assign(mix(c, lush, greenness.mul(0.35)));
      // moonlit night: dark tones drift to a cool blue (Purkinje shift); lamps and windows stay warm
      const isSky = smoothstep(0.9999, 1.0, depth.sample(screenUV).r);
      const warmLit = smoothstep(0.01, 0.08, c.r.sub(c.b)); // lamp- and window-lit areas keep their warmth
      const nightShift = P.night.mul(smoothstep(0.6, 0.0, l)).mul(0.45).mul(float(1).sub(isSky)).mul(float(1).sub(warmLit));
      c.assign(mix(c, vec3(l).mul(vec3(0.55, 0.72, 1.15)), nightShift));
      c.assign(pow(max(c, 0.0).div(0.18), vec3(P.contrast)).mul(0.18));
      const v = smoothstep(0.95, 0.25, length(screenUV.sub(0.5)).mul(1.25));
      c.mulAssign(mix(float(1).sub(P.vignette), float(1), v));
      const g = hash(screenUV.x.mul(4096.0).add(screenUV.y.mul(8192.0).mul(4096.0)).add(P.frame.mul(65536.0))).sub(0.5);
      c.addAssign(c.mul(g).mul(P.grain).add(g.mul(0.0015)));
      return vec4(c, 1.0);
    })();
    this.pipeline.outputNode = graded;
    this.pipeline.needsUpdate = true;
  }

  setQuality(q) {
    const scale = { low: 0.6, medium: 0.8, high: 1.0, ultra: 1.0 }[q];
    this.renderScale = scale;
    this.scenePass.setResolutionScale(scale);
    if (this.litTex) this.litTex.setResolutionScale(scale);
    if (this.gi) {
      const s = { low: [1, 6], medium: [1, 10], high: [2, 10], ultra: [3, 14] }[q];
      this.gi.sliceCount.value = s[0];
      this.gi.stepCount.value = s[1];
    }
  }

  update(env, weather, fantasy, dt, camera) {
    const night = env.night || 0;
    const target = 1.0 + night * 1.3 + (env.twilight || 0) * 0.7 + weather.cur.dark * 0.1;
    this.exposure += (target - this.exposure) * Math.min(1, dt * 1.5);
    this.renderer.toneMappingExposure = this.exposure;
    P.saturation.value = 1.04 + 0.12 * fantasy - weather.cur.dark * 0.2 - weather.cur.fog * 0.12;
    P.frame.value = (P.frame.value + 1) % 1024;
    P.night.value = night;
    const sp = env.sunDir.clone().multiplyScalar(10000).add(camera.position).project(camera);
    P.sunScreen.value.set(sp.x * 0.5 + 0.5, 1 - (sp.y * 0.5 + 0.5));
    const facing = sp.z < 1 ? 1 : 0;
    const onScreen = Math.max(0, 1 - Math.max(Math.abs(sp.x), Math.abs(sp.y)) * 0.6);
    P.sunVisible.value = facing * onScreen * Math.max(0, Math.min(1, env.sunElevation / 3 + 0.3)) * (1 - weather.cur.cloud * 0.7);
    if (env.sunColor) P.sunColor.value.copy(env.sunColor);
    P.shaftStrength.value = 0.35 + 0.5 * fantasy + weather.cur.fog * 0.6 + (env.golden || 0) * 0.5;
    // ---- time-of-day grade
    const el = env.sunElevation, w = weather.cur;
    const golden = Math.max(0, 1 - Math.abs(el - 5) / 9) * (1 - w.cloud * 0.8);
    const blue = Math.max(0, 1 - Math.abs(el + 5) / 5);
    env.golden = golden;
    const lift = new THREE.Color(1.0, 1.0, 0.99);
    const gain = new THREE.Color(1.03, 1.0, 0.95);
    lift.lerp(new THREE.Color(0.93, 0.98, 1.08), golden).lerp(new THREE.Color(0.9, 0.97, 1.12), blue).lerp(new THREE.Color(0.98, 1.0, 1.02), w.cloud * 0.6);
    gain.lerp(new THREE.Color(1.1, 0.98, 0.82), golden).lerp(new THREE.Color(1.0, 0.94, 1.06), blue).lerp(new THREE.Color(1.0, 1.0, 1.0), w.cloud * 0.7);
    P.lift.value.lerp(lift, Math.min(1, dt * 2));
    P.gain.value.lerp(gain, Math.min(1, dt * 2));
    P.contrast.value = 1.06 + golden * 0.06 - w.fog * 0.06 - w.cloud * 0.03;
    P.vignette.value = 0.45 + night * 0.1;
  }

  // compile every material exactly as the scene / FX passes will render them (MRT + render target),
  // so the first frame does not stall on hundreds of synchronous shader compiles
  async prewarm() {
    await this.scenePass.compileAsync(this.renderer);
    if (this.fxPass) await this.fxPass.compileAsync(this.renderer);
  }

  render() { this.pipeline.render(); }
}
