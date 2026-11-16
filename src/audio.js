// Synthesised ambience: wind, rain, thunder, a river murmur and the odd bird by day / owl at night.
export class Ambience {
  constructor() {
    this.ctx = null;
    this.enabled = false;
  }
  start() {
    if (this.ctx) { this.ctx.resume(); this.enabled = true; return; }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.6;
    this.master.connect(ctx.destination);
    const noise = (type = 'white', seconds = 4) => {
      const len = ctx.sampleRate * seconds;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        if (type === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true; src.start();
      return src;
    };
    // wind: brown noise through a wandering band-pass
    this.windF = ctx.createBiquadFilter(); this.windF.type = 'bandpass'; this.windF.Q.value = 0.8; this.windF.frequency.value = 400;
    this.windG = ctx.createGain(); this.windG.gain.value = 0;
    noise('brown').connect(this.windF).connect(this.windG).connect(this.master);
    // rain: white noise, high passed, plus a duller layer for heavy rain
    this.rainF = ctx.createBiquadFilter(); this.rainF.type = 'highpass'; this.rainF.frequency.value = 900;
    this.rainG = ctx.createGain(); this.rainG.gain.value = 0;
    noise('white').connect(this.rainF).connect(this.rainG).connect(this.master);
    this.rain2F = ctx.createBiquadFilter(); this.rain2F.type = 'lowpass'; this.rain2F.frequency.value = 600;
    this.rain2G = ctx.createGain(); this.rain2G.gain.value = 0;
    noise('brown').connect(this.rain2F).connect(this.rain2G).connect(this.master);
    // river
    this.riverF = ctx.createBiquadFilter(); this.riverF.type = 'bandpass'; this.riverF.frequency.value = 1200; this.riverF.Q.value = 0.5;
    this.riverG = ctx.createGain(); this.riverG.gain.value = 0;
    noise('white').connect(this.riverF).connect(this.riverG).connect(this.master);
    this.birdTimer = 2;
    this.enabled = true;
  }
  stop() { if (this.ctx) this.ctx.suspend(); this.enabled = false; }

  thunder(delay, power) {
    if (!this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const len = ctx.sampleRate * 5;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.03 * (Math.random() * 2 - 1)) / 1.03; d[i] = last * 6; }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 180 + power * 500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9 * power, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.25 * power, t + 1.0);
    g.gain.exponentialRampToValueAtTime(0.001, t + 4.8);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
  }

  chirp(night) {
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (night) {
      // tawny owl: two soft hoots
      o.type = 'sine';
      o.frequency.setValueAtTime(420, t); o.frequency.linearRampToValueAtTime(380, t + 0.5);
      o.frequency.setValueAtTime(430, t + 0.8); o.frequency.linearRampToValueAtTime(360, t + 1.6);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.05, t + 0.08); g.gain.linearRampToValueAtTime(0, t + 0.55);
      g.gain.linearRampToValueAtTime(0.05, t + 0.9); g.gain.linearRampToValueAtTime(0, t + 1.7);
    } else {
      o.type = 'sine';
      const base = 2800 + Math.random() * 1800;
      let tt = t;
      g.gain.setValueAtTime(0, t);
      const n = 3 + Math.floor(Math.random() * 5);
      for (let i = 0; i < n; i++) {
        o.frequency.setValueAtTime(base * (0.9 + Math.random() * 0.3), tt);
        o.frequency.exponentialRampToValueAtTime(base * (1.1 + Math.random() * 0.4), tt + 0.07);
        g.gain.setValueAtTime(0.02, tt); g.gain.linearRampToValueAtTime(0, tt + 0.08);
        tt += 0.1 + Math.random() * 0.06;
      }
    }
    if (pan) { pan.pan.value = Math.random() * 1.6 - 0.8; o.connect(g).connect(pan).connect(this.master); } else o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 2);
  }

  update(dt, weather, env, riverProximity) {
    if (!this.enabled || !this.ctx) return;
    const w = weather.cur;
    const t = this.ctx.currentTime;
    const gust = 0.5 + 0.5 * Math.sin(t * 0.3) * Math.sin(t * 0.13 + 1);
    this.windG.gain.setTargetAtTime(0.05 + 0.32 * w.windEff * (0.6 + 0.4 * gust), t, 0.5);
    this.windF.frequency.setTargetAtTime(250 + 500 * w.windEff * gust, t, 0.8);
    this.rainG.gain.setTargetAtTime(0.11 * w.rain, t, 0.5);
    this.rain2G.gain.setTargetAtTime(0.3 * w.rain * w.rain, t, 0.5);
    this.riverG.gain.setTargetAtTime(0.06 * riverProximity, t, 0.5);
    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      const night = env.night > 0.6;
      this.birdTimer = night ? 12 + Math.random() * 20 : 2 + Math.random() * 6;
      if (w.rain < 0.3 && w.windEff < 0.9) this.chirp(night);
    }
  }
}
