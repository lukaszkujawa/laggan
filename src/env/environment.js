import * as THREE from 'three/webgpu';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { U } from '../core/tsl.js';
import { createSky, skyUniforms, cloudShadowNode } from './sky.js';
import { sunDirection, moonDirection, skyPalette } from './celestial.js';

const tmpV = new THREE.Vector3();
const pal = { zen: new THREE.Color(), hor: new THREE.Color(), sun: new THREE.Color(), glow: new THREE.Color() };
const GREY = new THREE.Color();
const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

export class Environment {
  constructor(renderer, scene, weather) {
    this.renderer = renderer;
    this.scene = scene;
    this.weather = weather;
    this.hour = 16.8;
    this.day = 262;
    this.timeSpeed = 60; // in-game seconds per real second
    this.paused = false;
    this.sunDir = new THREE.Vector3();
    this.moonDir = new THREE.Vector3();
    this.flash = 0;
    this.nextFlash = 6;
    this.flashDir = new THREE.Vector3();
    this.onLightning = null;
    this.cloudOffset = new THREE.Vector2();
    this.sunElevation = 0;

    const sky = createSky();
    this.sky = sky;
    scene.add(sky.mesh);

    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.castShadow = true;
    light.shadow.mapSize.set(3072, 3072);
    light.shadow.camera.near = 1;
    light.shadow.camera.far = 3000;
    light.shadow.bias = -0.0002;
    light.shadow.normalBias = 0.05;
    light.shadow.radius = 2;
    scene.add(light, light.target);
    this.light = light;
    this.csm = new CSMShadowNode(light, { cascades: 3, maxFar: 500, mode: 'practical', lightMargin: 300 });
    this.csm.fade = true;
    // cascaded shadows x moving cloud shadows
    light.shadow.shadowNode = this.csm.mul(cloudShadowNode);

    // lightning fill light (no shadows)
    this.flashLight = new THREE.DirectionalLight(0xc8d4ff, 0);
    scene.add(this.flashLight, this.flashLight.target);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envRT = null;
    this.envTimer = 0;
    this.envDirty = true;
    this.lastEnvKey = '';
  }

  setShadowQuality(size, far) {
    // map size is fixed at startup (WebGPU shadow maps are not re-created); only the covered distance changes
    this.csm.maxFar = far;
    if (this.csm.camera) this.csm.updateFrustums();
  }

  update(dt, camera, focus) {
    const w = this.weather.cur;
    if (!this.paused) this.hour = (this.hour + (dt * this.timeSpeed) / 3600 + 24) % 24;
    U.hour.value = this.hour;

    sunDirection(this.hour, this.day, this.sunDir);
    moonDirection(this.hour, this.day, this.moonDir);
    const sunEl = Math.asin(this.sunDir.y) * 180 / Math.PI;
    this.sunElevation = sunEl;
    skyPalette(sunEl, pal);
    this.sunColor = pal.sun;

    const cloud = w.cloud, dark = w.dark, fog = w.fog;
    const day = smooth(-6, 8, sunEl); // 0 night .. 1 day
    const night = 1 - smooth(-14, -2, sunEl);
    U.night.value = night;

    // overcast greying of the sky
    const lum = 0.3 * pal.hor.r + 0.55 * pal.hor.g + 0.15 * pal.hor.b;
    GREY.setRGB(lum, lum * 1.02, lum * 1.06).multiplyScalar(1 - dark * 0.55);
    const greyAmt = smooth(0.55, 1.0, cloud);
    const su = skyUniforms;
    su.uZen.value.copy(pal.zen).lerp(GREY, greyAmt * 0.85).multiplyScalar(1 - dark * 0.45 * greyAmt);
    su.uHor.value.copy(pal.hor).lerp(GREY, greyAmt * 0.8);
    su.uGlow.value.copy(pal.glow).multiplyScalar(1 - greyAmt * 0.7);
    su.uSunDir.value.copy(this.sunDir);
    su.uMoonDir.value.copy(this.moonDir);
    su.uSunCol.value.copy(pal.sun);
    su.uSunVis.value = smooth(-3, 1, sunEl);
    su.uMoonVis.value = smooth(-0.05, 0.08, this.moonDir.y) * (1 - day * 0.85);
    su.uCloud.value = cloud;
    su.uCloudDark.value = dark;
    su.uStars.value = night;
    su.uAurora.value = night * (U.fantasy.value * 0.75 + 0.25) * (1 - cloud);
    su.uGrey.value = greyAmt;
    // ambient colour used for cloud undersides
    su.uCloudAmb.value.copy(pal.zen).lerp(pal.hor, 0.6).lerp(GREY, greyAmt).multiplyScalar(0.8 + 0.4 * day);
    su.uCloudAmb.value.r += 0.02 * night; su.uCloudAmb.value.g += 0.025 * night; su.uCloudAmb.value.b += 0.04 * night;
    // cloud drift with the wind
    const ws = 0.004 + 0.012 * (w.windEff || 0);
    this.cloudOffset.x += U.windDir.value.x * ws * dt;
    this.cloudOffset.y += U.windDir.value.y * ws * dt;
    su.uCloudOffset.value.copy(this.cloudOffset);

    // ---------------- main directional light: sun by day, moon by night
    const sunI = 3.4 * smooth(-1.5, 6, sunEl) * (1 - 0.82 * smooth(0.5, 1.0, cloud)) * (1 - 0.4 * fog);
    const moonUp = smooth(-0.02, 0.12, this.moonDir.y);
    const moonI = 0.22 * moonUp * (1 - 0.85 * smooth(0.5, 1.0, cloud)) * (1 - day);
    const useSun = sunI >= moonI;
    const L = this.light;
    const dir = useSun ? this.sunDir : this.moonDir;
    if (useSun) L.color.copy(pal.sun).lerp(GREY.clone().set(1, 1, 1), greyAmt * 0.4);
    else L.color.setRGB(0.45, 0.58, 1.0);
    L.intensity = Math.max(sunI, moonI);
    U.sunDir.value.copy(dir);
    U.sunCol.value.copy(L.color).multiplyScalar(L.intensity);
    // CSM handles cascade fitting & texel snapping; we only set the direction
    const lightDir = dir.clone();
    if (lightDir.y < 0.06) { lightDir.y = 0.06; lightDir.normalize(); }
    L.position.copy(focus).addScaledVector(lightDir, 500);
    L.target.position.copy(focus);
    L.updateMatrixWorld();
    L.target.updateMatrixWorld();

    // ---------------- staggered cascade updates: near every frame, middle every 2nd, far every 4th
    this.shadowFrame = (this.shadowFrame || 0) + 1;
    const cl = this.csm.lights || [];
    cl.forEach((l, i) => {
      l.shadow.autoUpdate = false;
      const every = i === 0 ? 1 : i === 1 ? 2 : 4;
      if ((this.shadowFrame + i) % every === 0 || this.forceShadows) l.shadow.needsUpdate = true;
    });
    this.forceShadows = false;

    // ---------------- ambient (for custom shaders) & IBL strength
    const ambSky = new THREE.Color().copy(su.uZen.value).lerp(su.uHor.value, 0.5);
    ambSky.multiplyScalar(1.0);
    ambSky.r += 0.010 * night; ambSky.g += 0.014 * night; ambSky.b += 0.03 * night; // moonlit floor
    U.ambSky.value.copy(ambSky);
    U.ambGround.value.copy(ambSky).multiplyScalar(0.35).lerp(new THREE.Color(0.05, 0.045, 0.03), 0.3 * day);
    this.sky.groundMat.color.copy(U.ambGround.value).multiplyScalar(0.8);
    // twilight & night: the eye adapts, lift the sky light a little
    const twilight = smooth(-12, -2, sunEl) * (1 - smooth(-2, 8, sunEl));
    this.scene.environmentIntensity = (1.0 + 1.1 * twilight + 0.5 * night) * (1 - 0.45 * dark);
    this.twilight = twilight;
    this.night = night;

    // ---------------- fog: horizon colour, height fog density from weather
    const fogCol = new THREE.Color().copy(su.uHor.value).lerp(su.uZen.value, 0.15);
    // add a little sun-tint to the fog by day
    fogCol.lerp(pal.glow, 0.08 * day * (1 - greyAmt));
    // desaturate a little so distant hills read as aerial perspective, not paint
    const fLum = 0.3 * fogCol.r + 0.55 * fogCol.g + 0.15 * fogCol.b;
    fogCol.lerp(new THREE.Color(fLum * 0.85, fLum * 0.95, fLum * 1.15), 0.35);
    if (night > 0) fogCol.lerp(new THREE.Color(0.012, 0.016, 0.03), night * 0.4);
    fogCol.multiplyScalar(1 - 0.55 * dark * greyAmt);
    U.fogColor.value.copy(fogCol);
    su.uFogCol.value.copy(fogCol);
    su.uHazeLow.value = Math.min(1, fog * 1.2);
    // haar hugs the strath: dense near the valley floor (~-20 m), thinning quickly with height
    U.fogDensity.value = 0.00015 + 0.0085 * fog * fog + 0.0012 * w.rain + 0.0022 * w.snow;
    U.fogFalloff.value = 0.03 + 0.012 * fog;
    U.fogBase.value = -24 + 10 * fog;
    U.fogHaze.value = 0.00002 + 0.00008 * cloud * cloud + 0.00018 * w.rain + 0.0006 * fog * fog;
    U.fogSunDir.value.copy(this.sunDir);
    // aerial perspective tint follows the sky zenith, valley mist thickens around dawn, dusk and at night
    U.fogFarCol.value.copy(su.uZen.value).lerp(su.uHor.value, 0.35);
    const hr = this.hour;
    const dawnDusk = Math.max(Math.exp(-((hr - 6.6) ** 2) / 2.5), Math.exp(-((hr - 19.4) ** 2) / 3.0));
    const mistTarget = Math.min(1, (0.15 + 0.55 * dawnDusk + 0.3 * night) * (1 - 0.7 * Math.min(1, w.windEff)) + 0.6 * fog) * (1 - 0.6 * w.rain);
    this.mist = this.mist === undefined ? mistTarget : this.mist + (mistTarget - this.mist) * Math.min(1, dt * 0.2);
    U.mist.value = this.mist;
    U.mistCol.value.copy(fogCol).multiplyScalar(1.15).lerp(new THREE.Color(1, 0.9, 0.8), 0.12 * day);
    if (night > 0.5) U.mistCol.value.lerp(new THREE.Color(0.05, 0.07, 0.12), 0.5);
    U.fogSunCol.value.copy(pal.glow).multiplyScalar(0.35 * su.uSunVis.value * (1 - greyAmt * 0.8));

    // ---------------- darkness metric for artificial lights
    const darkness = 1 - smooth(-4, 10, sunEl) * (1 - 0.5 * dark);
    U.dark.value = Math.min(1, darkness);

    // ---------------- lightning
    this.flash = Math.max(0, this.flash - dt * 6);
    if (w.storm > 0.5) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) {
        this.nextFlash = 3 + Math.random() * 11;
        this.flash = 1;
        this.flashCount = Math.random() < 0.6 ? 2 : 1;
        const a = Math.random() * Math.PI * 2;
        this.flashDir.set(Math.cos(a), 0.6 + Math.random() * 0.4, Math.sin(a)).normalize();
        if (this.onLightning) this.onLightning(this.flashDir, 300 + Math.random() * 1500);
      }
      if (this.flashCount > 1 && this.flash < 0.4 && this.flash > 0.3) { this.flash = 0.9; this.flashCount--; }
    }
    const fl = this.flash > 0 ? this.flash * (0.6 + 0.4 * Math.random()) : 0;
    U.flash.value = fl;
    this.flashLight.intensity = fl * 4;
    this.flashLight.position.copy(focus).addScaledVector(this.flashDir, 500);
    this.flashLight.target.position.copy(focus);
    this.flashLight.target.updateMatrixWorld();

    // ---------------- image based lighting from the sky, refreshed periodically
    this.envTimer -= dt;
    const key = [sunEl.toFixed(1), cloud.toFixed(2), fog.toFixed(2), dark.toFixed(2)].join('|');
    if ((this.envTimer <= 0 && key !== this.lastEnvKey) || this.envDirty) {
      this.envTimer = 0.4;
      this.lastEnvKey = key;
      this.envDirty = false;
      // re-render into the same target: a new environment texture would force every material to rebuild
      this.envRT = this.pmrem.fromScene(this.sky.envScene, 0.04, 0.1, 500, { size: 256, renderTarget: this.envRT });
      if (this.scene.environment !== this.envRT.texture) this.scene.environment = this.envRT.texture;
    }
  }
}
