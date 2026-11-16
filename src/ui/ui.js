import { PRESETS } from '../env/weather.js';

const $ = (id) => document.getElementById(id);

function phaseName(h, sunEl) {
  if (sunEl > 6) return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  if (sunEl > -1) return h < 12 ? 'sunrise' : 'sunset';
  if (sunEl > -7) return h < 12 ? 'dawn twilight' : 'dusk';
  if (sunEl > -13) return 'gloaming';
  return 'night';
}

export class UI {
  constructor(app) {
    this.app = app;
    const { env, weather, rig } = app;
    const time = $('time');
    time.addEventListener('input', () => { env.hour = parseFloat(time.value); env.envDirty = true; });
    this.time = time;
    $('play').addEventListener('click', () => this.togglePlay());
    this.segment('speed', (v) => { env.timeSpeed = parseFloat(v); });
    document.querySelectorAll('.presets [data-hour]').forEach((b) => b.addEventListener('click', () => {
      env.hour = parseFloat(b.dataset.hour); env.envDirty = true;
    }));
    // weather chips
    const wbox = $('weather');
    for (const [k, p] of Object.entries(PRESETS)) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.dataset.v = k;
      b.innerHTML = `<span class="ico">${p.icon}</span>${p.label}`;
      b.addEventListener('click', () => { weather.set(k); $('auto-weather').checked = false; weather.auto = false; });
      wbox.appendChild(b);
    }
    weather.onChange((name) => wbox.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === name)));
    wbox.querySelector(`[data-v="${weather.preset}"]`)?.classList.add('on');
    $('auto-weather').addEventListener('change', (e) => { weather.auto = e.target.checked; weather.autoTimer = 5; });
    const wind = $('wind'), windAuto = $('wind-auto');
    wind.addEventListener('input', () => { windAuto.checked = false; weather.windOverride = parseFloat(wind.value); });
    windAuto.addEventListener('change', () => { weather.windOverride = windAuto.checked ? null : parseFloat(wind.value); });
    this.wind = wind; this.windAuto = windAuto;
    $('fantasy').value = app.fantasy;
    $('fantasy').addEventListener('input', (e) => app.setFantasy(parseFloat(e.target.value)));
    this.segment('quality', (v) => { app.userQuality = true; app.setQuality(v); });
    this.segment('cam', (v) => rig.setMode(v));
    this.segment('fpscap', (v) => { app.fpsCap = +v; });
    document.querySelectorAll('#fpscap button').forEach((b) => b.classList.toggle('on', +b.dataset.v === app.fpsCap));
    rig.onModeChange((m) => {
      document.querySelectorAll('#cam button').forEach((b) => b.classList.toggle('on', b.dataset.v === m));
      $('cam-hint').textContent = {
        orbit: 'Drag to orbit · right-drag to pan · scroll to zoom · WASD to move',
        walk: 'Double-click to capture mouse · WASD walk · Shift run · Space jump · Esc release',
        fly: 'Double-click to capture mouse · WASD + Q/E · Shift for speed',
        tour: 'Sit back — a slow drift through the village',
      }[m];
    });
    $('sound').addEventListener('click', (e) => {
      if (app.audio.enabled) { app.audio.stop(); e.currentTarget.classList.remove('on'); e.currentTarget.textContent = '🔈 Sound'; }
      else { app.audio.start(); e.currentTarget.classList.add('on'); e.currentTarget.textContent = '🔊 Sound'; }
    });
    const hide = () => { $('panel').classList.add('hidden'); $('show-panel').classList.remove('hidden'); };
    const show = () => { $('panel').classList.remove('hidden'); $('show-panel').classList.add('hidden'); };
    $('collapse').addEventListener('click', hide);
    $('show-panel').addEventListener('click', show);
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      const keys = Object.keys(PRESETS);
      if (e.code.startsWith('Digit')) {
        const i = parseInt(e.code.slice(5), 10) - 1;
        if (keys[i]) { weather.set(keys[i]); weather.auto = false; $('auto-weather').checked = false; }
      }
      if (e.code === 'KeyH') ($('panel').classList.contains('hidden') ? show : hide)();
      if (e.code === 'KeyT') this.togglePlay();
      if (e.code === 'BracketRight') { env.hour = (env.hour + 0.5) % 24; }
      if (e.code === 'BracketLeft') { env.hour = (env.hour + 23.5) % 24; }
      if (e.code === 'KeyC') {
        const modes = ['orbit', 'walk', 'fly', 'tour'];
        rig.setMode(modes[(modes.indexOf(rig.mode) + 1) % modes.length]);
      }
    });
    this.statT = 0;
    this.frames = 0;
  }

  segment(id, fn) {
    const el = $(id);
    el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      fn(b.dataset.v);
    }));
  }

  togglePlay() {
    const env = this.app.env;
    env.paused = !env.paused;
    $('play').textContent = env.paused ? '▶' : '❚❚';
    $('play').classList.toggle('on', env.paused);
  }

  update(dt) {
    const { env, weather } = this.app;
    const h = env.hour;
    const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
    $('clock').textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    $('phase').textContent = phaseName(h, env.sunElevation) + ' · ' + PRESETS[weather.preset].label.toLowerCase();
    if (document.activeElement !== this.time) this.time.value = h.toFixed(2);
    if (this.windAuto.checked && document.activeElement !== this.wind) this.wind.value = weather.cur.windEff.toFixed(2);
    this.frames++;
    this.statT += dt;
    if (this.statT > 0.5) {
      const fps = this.frames / this.statT;
      this.frames = 0; this.statT = 0;
      const info = this.app.renderer.info;
      $('stats').textContent = `${fps.toFixed(0)} fps · ${(info.render.triangles / 1e6).toFixed(1)}M tris · ${this.app.isWebGPU ? 'WebGPU' : 'WebGL2'}`;
    }
  }
}
