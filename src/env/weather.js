// Weather state: smoothly blends towards a target preset; wetness and snow cover accumulate over time.
export const PRESETS = {
  clear: { label: 'Clear', icon: '☀', cloud: 0.12, dark: 0.0, rain: 0, snow: 0, fog: 0.04, wind: 0.25, storm: 0 },
  fair: { label: 'Fair', icon: '⛅', cloud: 0.45, dark: 0.1, rain: 0, snow: 0, fog: 0.08, wind: 0.45, storm: 0 },
  overcast: { label: 'Overcast', icon: '☁', cloud: 0.9, dark: 0.35, rain: 0, snow: 0, fog: 0.22, wind: 0.5, storm: 0 },
  rain: { label: 'Rain', icon: '🌧', cloud: 0.97, dark: 0.55, rain: 0.65, snow: 0, fog: 0.32, wind: 0.65, storm: 0 },
  storm: { label: 'Storm', icon: '⛈', cloud: 1.0, dark: 0.85, rain: 1.0, snow: 0, fog: 0.28, wind: 1.35, storm: 1 },
  haar: { label: 'Haar', icon: '🌫', cloud: 0.7, dark: 0.25, rain: 0, snow: 0, fog: 1.0, wind: 0.08, storm: 0 },
  snow: { label: 'Snow', icon: '❄', cloud: 0.92, dark: 0.3, rain: 0, snow: 1, fog: 0.4, wind: 0.3, storm: 0 },
};

const KEYS = ['cloud', 'dark', 'rain', 'snow', 'fog', 'wind', 'storm'];
// Highland weather: rain is common
const AUTO_WEIGHTS = { clear: 2, fair: 3, overcast: 3, rain: 3, storm: 1, haar: 1.2, snow: 0.8 };

export class Weather {
  constructor() {
    this.cur = { ...PRESETS.fair, windEff: PRESETS.fair.wind };
    this.target = { ...PRESETS.fair };
    this.preset = 'fair';
    this.wetness = 0;
    this.snowCover = 0;
    this.auto = false;
    this.autoTimer = 90;
    this.windOverride = null; // null = from preset
    this.transitionRate = 0.12;
    this.listeners = [];
  }
  set(name, instant = false) {
    this.preset = name;
    this.target = { ...PRESETS[name] };
    if (instant) {
      this.cur = { ...this.target, windEff: this.windOverride ?? this.target.wind };
      this.wetness = this.target.rain > 0 ? 0.85 : 0;
      this.snowCover = this.target.snow > 0 ? 0.9 : 0;
    }
    this.listeners.forEach((f) => f(name));
  }
  onChange(f) { this.listeners.push(f); }
  pickAuto() {
    let total = 0;
    for (const k in AUTO_WEIGHTS) if (k !== this.preset) total += AUTO_WEIGHTS[k];
    let r = Math.random() * total;
    for (const k in AUTO_WEIGHTS) {
      if (k === this.preset) continue;
      r -= AUTO_WEIGHTS[k];
      if (r <= 0) return k;
    }
    return 'fair';
  }
  update(dt, sunUp) {
    if (this.auto) {
      this.autoTimer -= dt;
      if (this.autoTimer <= 0) {
        this.autoTimer = 70 + Math.random() * 90;
        this.set(this.pickAuto());
      }
    }
    const k = 1 - Math.exp(-dt * this.transitionRate * 3);
    for (const key of KEYS) {
      // rain/snow fade in after clouds build up, fade out first
      let rate = k;
      if ((key === 'rain' || key === 'snow' || key === 'storm') && this.target[key] > this.cur[key]) {
        rate *= this.cur.cloud > 0.8 ? 1 : 0.15;
      }
      this.cur[key] += (this.target[key] - this.cur[key]) * rate;
    }
    if (this.windOverride !== null) this.cur.windEff = this.windOverride;
    else this.cur.windEff = this.cur.wind;
    // wetness: soaks in quickly, dries slowly (faster in sun and wind)
    const rain = this.cur.rain;
    if (rain > 0.05) this.wetness = Math.min(1, this.wetness + dt * rain * 0.06);
    else this.wetness = Math.max(0, this.wetness - dt * (0.004 + 0.01 * sunUp * (1 - this.cur.cloud) + 0.004 * this.cur.windEff));
    // snow cover builds while snowing, melts otherwise (rain melts it fast)
    const snow = this.cur.snow;
    if (snow > 0.05) this.snowCover = Math.min(1, this.snowCover + dt * snow * 0.035);
    else this.snowCover = Math.max(0, this.snowCover - dt * (0.003 + 0.012 * sunUp * (1 - this.cur.cloud) + 0.03 * rain));
  }
}
