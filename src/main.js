import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { fog } from 'three/tsl';
import { U, fogColorNode, fogFactorNode } from './core/tsl.js';
import { Heightfield } from './core/heightfield.js';
import { Weather } from './env/weather.js';
import { Environment } from './env/environment.js';
import { buildStatic } from './world/world.js';
import { Post } from './fx/post.js';
import { CameraRig } from './controls.js';
import { Ambience } from './audio.js';
import { UI } from './ui/ui.js';
import { impostorShared } from './veg/impostor.js';

const A = import.meta.env.BASE_URL + 'assets/'; // relative, so the build works under any path (GitHub Pages: /laggan/)
const params = new URLSearchParams(location.search);
const OFF = new Set((params.get('no') || '').split(',').filter(Boolean)); // e.g. ?no=veg,grass,post
const statusEl = document.getElementById('loader-status');
const barEl = document.getElementById('bar-fill');
const setStatus = (s) => { statusEl.textContent = s; };

// ------------------------------------------------------------------ progress-tracked loading
const progress = { loaded: new Map(), total: new Map() };
function report(key, loaded) {
  progress.loaded.set(key, loaded);
  let l = 0, t = 0;
  for (const [k, v] of progress.total) { t += v; l += Math.min(progress.loaded.get(k) || 0, v); }
  if (t > 0) barEl.style.width = `${(65 * l) / t}%`;
}
async function fetchBuffer(url, sizeHint) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const total = +res.headers.get('content-length') || sizeHint || 1;
  progress.total.set(url, total);
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    report(url, got);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}
const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder); // GLBs are EXT_meshopt_compression (lossless, ~3x smaller)
async function loadGLB(url) {
  const buf = await fetchBuffer(A + url);
  return new Promise((res, rej) => gltfLoader.parse(buf, A, res, rej));
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

// ------------------------------------------------------------------ app
const T0 = performance.now();
class App {
  async init() {
    const canvas = document.getElementById('view');
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance', forceWebGL: params.has('webgl') });
    await renderer.init();
    this.isWebGPU = !!renderer.backend.isWebGPUBackend;
    const why = !window.isSecureContext ? 'page is not on a secure origin (open it via http://localhost:5173, not a network IP)'
      : !navigator.gpu ? 'this browser has WebGPU disabled' : 'no WebGPU adapter was available';
    const bk = document.getElementById('loader-backend');
    if (bk) {
      bk.textContent = this.isWebGPU ? 'Renderer: WebGPU' : `Renderer: WebGL2 fallback — ${why}. Shader compilation will take about a minute.`;
      bk.classList.toggle('warn', !this.isWebGPU);
    }
    if (!this.isWebGPU) console.warn('[laggan] WebGPU unavailable:', why);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = renderer;
    const scene = new THREE.Scene();
    scene.fogNode = fog(fogColorNode, fogFactorNode);
    this.scene = scene;
    this.fxScene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.3, 30000);
    camera.position.set(330, 22, 315);
    this.camera = camera;

    setStatus('Reading the map…');
    const [sceneInfo, manifest, lampsJson] = await Promise.all(
      ['scene.json', 'manifest.json', 'street_lamps.json'].map((f) => fetch(A + f).then((r) => r.json()))
    );
    const statics = ['terrain', 'backdrop', 'water', 'roads', 'buildings', 'surroundings', 'grass_patch'];
    setStatus('Fetching the village, the glen and every blade of grass…');
    const hfP = fetchBuffer(A + 'terrain_height_481x481.f32');
    const grassP = OFF.has('grass') ? Promise.resolve(null) : fetchBuffer(A + 'instances/grass.bin', 77466844);
    const staticP = pool(statics, 4, (f) => loadGLB(f + '.glb'));
    const vegNames = OFF.has('veg') ? [] : Object.keys(manifest.models);
    const vegP = pool(vegNames, 6, async (name) => {
      const m = manifest.models[name];
      const [gltf, inst] = await Promise.all([loadGLB(m.glb), fetchBuffer(A + m.instances)]);
      return { name, gltf, records: new Float32Array(inst), nodes: m.nodes };
    });
    const [hfBuf, grassBuf, staticArr, vegArr] = await Promise.all([hfP, grassP, staticP, vegP]);
    const gl = Object.fromEntries(statics.map((k, i) => [k, staticArr[i]]));
    barEl.style.width = '68%';

    const hf = new Heightfield(hfBuf);
    this.hf = hf;

    setStatus('Raising the houses…');
    await nextFrame();
    this.weather = new Weather();
    this.env = new Environment(renderer, scene, this.weather);
    buildStatic(gl, scene, hf);

    let waterUniforms = null;
    if (!OFF.has('water')) {
      const { createWater } = await import('./world/water.js');
      waterUniforms = createWater(gl.water, scene);
    }
    if (!OFF.has('lamps')) {
      const { Lamps } = await import('./world/lamps.js');
      this.lamps = new Lamps(scene, lampsJson.lamps, hf, this.fxScene);
    }
    this.riverPts = [];
    gl.water.scene.traverse((o) => {
      if (!o.isMesh) return;
      const p = o.geometry.attributes.position;
      for (let i = 0; i < p.count; i += 23) this.riverPts.push(new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)));
    });

    if (vegArr.length) {
      setStatus('Scattering woodland…');
      await nextFrame();
      if (!OFF.has('scatter')) {
        const { densify } = await import('./veg/scatter.js');
        const dens = params.has('density') ? +params.get('density') : 1;
        const dense = densify(vegArr, [gl.roads.scene, gl.water.scene, gl.buildings.scene, gl.surroundings.scene], hf, { density: dens, cats: params.has('scat') ? params.get('scat').split(',') : undefined });
        vegArr.splice(0, vegArr.length, ...dense);
      }
      setStatus('Planting the trees (baking impostors)…');
      const { Vegetation } = await import('./veg/vegetation.js');
      this.veg = new Vegetation(renderer, scene);
      for (let i = 0; i < vegArr.length; i++) {
        const v = vegArr[i];
        await this.veg.addModel(v.name, v.gltf, v.records, v.nodes);
        barEl.style.width = `${68 + (22 * (i + 1)) / vegArr.length}%`;
        if (i % 3 === 2) { setStatus(`Planting ${v.name.replace(/_LOD\d|_/g, ' ').trim()}…`); await nextFrame(); }
      }
    }
    if (grassBuf) {
      setStatus('Sowing the grass…');
      await nextFrame();
      const { Grass } = await import('./veg/grass.js');
      const gp = gl.grass_patch.scene;
      const geoOf = (o) => { let g = null; o.traverse((c) => { if (c.isMesh && !g) g = c.geometry; }); return g; };
      this.grass = new Grass(scene, geoOf(gp.getObjectByName('grass_patch__lod0')), geoOf(gp.getObjectByName('grass_patch__lod1')),
        new Float32Array(grassBuf), sceneInfo.instances.grass.tiles);
      this.grass.groundAt = (x, z) => hf.sample(x, z);
    }
    if (!OFF.has('fx')) {
      const { Particles } = await import('./fx/particles.js');
      this.particles = new Particles(this.fxScene, hf);
    }

    // the WebGL2 fallback compiles shaders far more slowly: skip the heaviest screen-space effects there
    const heavy = this.isWebGPU || params.has('full');
    this.post = OFF.has('post') ? null : new Post(renderer, scene, camera, { ssgi: heavy && !OFF.has('ssgi'), ssr: heavy && !OFF.has('ssr'), fxScene: this.fxScene, off: OFF });
    this.rig = new CameraRig(camera, canvas, hf);
    this.rig.orbit.target.set(170, -8, 150);
    this.audio = new Ambience();
    this.env.onLightning = (dir, dist) => {
      if (this.particles) this.particles.strike(camera, dir, dist, (x, z) => hf.sample(x, z));
      this.audio.thunder(dist / 343, Math.max(0.3, 1 - dist / 2200));
    };
    this.fantasy = 0.75;
    this.setFantasy(0.75);
    this.weather.set('fair', true);
    this.ui = new UI(this);
    this.quality = 'high';
    this.fpsCap = +(params.get('fps') ?? 60);
    this.applyQuality('high');

    setStatus('Compiling shaders…');
    const tcs = performance.now();
    const ticker = setInterval(() => setStatus(`Compiling shaders… ${((performance.now() - tcs) / 1000).toFixed(0)} s`), 500);
    barEl.style.width = '94%';
    await nextFrame();
    this.env.update(0.016, camera, this.rig.orbit.target);
    this.veg?.update(camera);
    this.grass?.update(camera);
    const tc = performance.now();
    // Force every mesh visible (with at least one instance) so all shader variants are built now,
    // not mid-walk when a LOD, grass ring, lamp halo or rain first appears.
    const restore = [];
    for (const sc of [scene, this.fxScene]) sc.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry;
      restore.push([o, o.visible, o.count, g.instanceCount]);
      o.visible = true;
      if (o.isInstancedMesh && o.count === 0) o.count = 1;
      if (g.isInstancedBufferGeometry && !g.instanceCount) g.instanceCount = 1;
    });
    try {
      if (this.post) await this.post.prewarm();
      else { await renderer.compileAsync(scene, camera); await renderer.compileAsync(this.fxScene, camera); }
      // render a couple of real frames so shadow-pass and post variants are built as well
      for (let i = 0; i < 2; i++) {
        if (this.post) this.post.render(); else renderer.render(scene, camera);
        await nextFrame();
      }
    } catch (e) { console.warn(e); }
    for (const [o, v, c, ic] of restore) {
      o.visible = v;
      if (o.isInstancedMesh) o.count = c;
      if (o.geometry.isInstancedBufferGeometry) o.geometry.instanceCount = ic;
    }
    if (this.veg) this.veg.lastKey = '';
    if (this.grass) this.grass.lastKey = '';
    const mats = new Set(); scene.traverse((o) => { if (o.material) mats.add(o.material); });
    clearInterval(ticker);
    setStatus('Preparing the first frame…');
    await nextFrame();
    console.log(`[timing] compileAsync ${(performance.now() - tc).toFixed(0)} ms, ${mats.size} materials, load ${(tc - T0).toFixed(0)} ms`);
    barEl.style.width = '100%';

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.clock = new THREE.Timer();
    document.getElementById('hud').classList.remove('hidden');
    document.getElementById('loader').classList.add('fade');
    setTimeout(() => document.getElementById('loader')?.remove(), 1500);
    this.windAngle = Math.atan2(U.windDir.value.y, U.windDir.value.x);
    this.firstFrameT = performance.now();
    renderer.setAnimationLoop(() => this.frame());
    window.app = this;
  }

  setFantasy(v) { this.fantasy = v; U.fantasy.value = v; }

  setQuality(q) {
    this.quality = q;
    this.applyQuality(q);
    this.resize();
  }
  applyQuality(q) {
    this.veg?.applyQuality(q);
    this.grass?.setQuality(q);
    this.post?.setQuality(q);
    const [size, far] = { low: [1024, 200], medium: [2048, 300], high: [2048, 400], ultra: [4096, 650] }[q];
    this.env.setShadowQuality(size, far);
    const pr = { low: 0.67, medium: 0.85, high: Math.min(window.devicePixelRatio, 1.25), ultra: Math.min(window.devicePixelRatio, 1.75) }[q];
    this.renderer.setPixelRatio(pr);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  autoQuality(dt) {
    this.aq = this.aq || { t: 0, frames: 0, grace: 6 };
    const aq = this.aq;
    if (aq.grace > 0) { aq.grace -= dt; return; }
    aq.t += dt; aq.frames++;
    if (aq.t < 3) return;
    const fps = aq.frames / aq.t;
    aq.t = 0; aq.frames = 0;
    const order = ['ultra', 'high', 'medium', 'low'];
    if (fps < 24 && !this.userQuality && this.quality !== 'low') {
      const next = order[order.indexOf(this.quality) + 1];
      this.setQuality(next);
      document.querySelectorAll('#quality button').forEach((b) => b.classList.toggle('on', b.dataset.v === next));
      aq.grace = 4;
    }
  }

  frame() {
    // frame cap (default 60 fps): a 144/240 Hz monitor would otherwise make the GPU render 2-4x as many frames
    const now = performance.now();
    if (this.fpsCap > 0 && now - (this.lastFrameT || 0) < 1000 / this.fpsCap - 1.5) return;
    this.lastFrameT = now;
    this.clock.update();
    const dt = Math.min(this.clock.getDelta(), 0.1);
    U.time.value += dt;
    const w = this.weather;
    w.update(dt, Math.max(0, this.env.sunDir.y));
    this.windAngle += (Math.sin(U.time.value * 0.031) * 0.5 + Math.sin(U.time.value * 0.007)) * dt * 0.05;
    U.windDir.value.set(Math.cos(this.windAngle), Math.sin(this.windAngle));
    U.windStrength.value = w.cur.windEff;
    U.wetness.value = w.wetness;
    U.snow.value = w.snowCover;
    U.rain.value = w.cur.rain;

    this.rig.update(dt);
    const cam = this.camera;
    if (this.rig.mode === 'walk') U.player.value.set(cam.position.x, cam.position.y - 1.7, cam.position.z);
    else U.player.value.set(0, -1e4, 0);
    this.env.update(dt, cam, this.rig.focus);
    this.env.sky.mesh.position.copy(cam.position);
    impostorShared.mainCam.value.copy(cam.position);
    this.veg?.update(cam);
    this.grass?.update(cam);
    this.lamps?.update(dt, cam, w);
    this.particles?.update(dt, w, this.lamps ? this.lamps.mean : 0, cam);
    this.riverT = (this.riverT || 0) - dt;
    if (this.riverT <= 0) {
      this.riverT = 1;
      let md = Infinity;
      for (const p of this.riverPts) md = Math.min(md, p.distanceToSquared(cam.position));
      this.riverProx = Math.max(0, 1 - Math.sqrt(md) / 120);
    }
    this.audio.update(dt, w, this.env, this.riverProx || 0);
    this.autoQuality(dt);
    if (this.post) {
      this.post.update(this.env, w, this.fantasy, dt, cam);
      this.post.render();
    } else {
      this.renderer.render(this.scene, cam);
      this.renderer.autoClear = false; this.renderer.render(this.fxScene, cam); this.renderer.autoClear = true;
    }
    this.ui.update(dt);
    if (this.firstFrameT) { console.log(`[timing] first frame ${(performance.now() - this.firstFrameT).toFixed(0)} ms`); this.firstFrameT = 0; }
  }
}

const app = new App();
app.init().catch((e) => {
  console.error(e);
  setStatus('Something went wrong: ' + e.message);
});
