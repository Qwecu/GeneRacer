// Genetic car sounds, synthesised with Web Audio.
//
// Each car's `sound` phenotype (traits.py) gives:
//   engine_hz  - base pitch of the engine
//   timbre     - 0..1: soft (triangle) -> buzzy (sawtooth) -> harsh (square), and filter brightness
//   cylinders  - 2..12: few cylinders = lumpy, throbbing; many = smooth
//   gulp_hz    - pitch of the gulps while refuelling
//   gulp_rate  - gulps per second
//
// The engine plays while the gas pedal is pressed (and quietly ticks over
// otherwise); the gulps play while the car is drinking fuel at the pumps.

const Sound = {
  ctx: null,
  muted: false,

  init() {
    try { this.muted = localStorage.getItem('generacer-muted') === '1'; } catch (e) { /* storage blocked */ }
  },

  // Must be called from a user gesture (a click or key press) the first time.
  context() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.8;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },

  toggleMute() {
    this.muted = !this.muted;
    try { localStorage.setItem('generacer-muted', this.muted ? '1' : '0'); } catch (e) { /* ignore */ }
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.05);
    return this.muted;
  },
};
Sound.init();

function timbreWave(t) { return t < 0.33 ? 'triangle' : t < 0.66 ? 'sawtooth' : 'square'; }

class CarSound {
  constructor(sound) {
    this.s = sound || { engine_hz: 80, timbre: 0.5, cylinders: 4, gulp_hz: 400, gulp_rate: 6 };
    this.ctx = Sound.context();
    this.nextGulp = 0;
    if (!this.ctx) return;
    const ctx = this.ctx, s = this.s;

    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(Sound.master);

    // Engine: main oscillator + sub-octave rumble, amplitude-pulsed at the
    // cylinder firing rate, then through a low-pass filter.
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 2 + 6 * s.timbre;
    this.filter.connect(this.out);

    this.pulse = ctx.createGain();
    this.pulse.gain.value = 0.6;
    this.pulse.connect(this.filter);

    this.osc = ctx.createOscillator();
    this.osc.type = timbreWave(s.timbre);
    this.osc.connect(this.pulse);

    this.sub = ctx.createOscillator();
    this.sub.type = 'sine';
    const subGain = ctx.createGain();
    subGain.gain.value = 0.7;
    this.sub.connect(subGain).connect(this.pulse);

    // firing pulses: fewer cylinders -> deeper modulation
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'square';
    this.lfoDepth = ctx.createGain();
    this.lfoDepth.gain.value = 0.45 * (1 - (s.cylinders - 2) / 12);
    this.lfo.connect(this.lfoDepth).connect(this.pulse.gain);

    this.setPitch(0, 0);
    this.osc.start(); this.sub.start(); this.lfo.start();
  }

  setPitch(speedFrac, throttle) {
    if (!this.ctx) return;
    const s = this.s, t = this.ctx.currentTime;
    const f = s.engine_hz * (0.8 + 2.2 * speedFrac + 0.15 * throttle);
    this.osc.frequency.setTargetAtTime(f, t, 0.06);
    this.sub.frequency.setTargetAtTime(f / 2, t, 0.06);
    this.lfo.frequency.setTargetAtTime(f * s.cylinders / 8, t, 0.06);
    const cutoff = (350 + 2200 * s.timbre) * (0.55 + 0.9 * throttle + 0.4 * speedFrac);
    this.filter.frequency.setTargetAtTime(cutoff, t, 0.08);
  }

  // throttle: 0/1 gas pedal, running: engine has fuel, refueling: drinking at the pumps
  update(speedFrac, throttle, running, refueling) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.setPitch(speedFrac, throttle);
    const vol = !running ? 0 : throttle ? 0.22 : 0.06;
    this.out.gain.setTargetAtTime(vol, t, throttle ? 0.04 : 0.15);
    if (refueling && t >= this.nextGulp) {
      this.gulp(t);
      this.nextGulp = t + (1 / this.s.gulp_rate) * (0.8 + Math.random() * 0.4);
    }
  }

  // One "glug": a short sine bubble sweeping upward.
  gulp(t) {
    const ctx = this.ctx, s = this.s;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const f = s.gulp_hz * (0.85 + Math.random() * 0.3);
    const dur = 0.05 + 0.25 / s.gulp_rate;
    o.type = 'sine';
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 1.7, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(Sound.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  stop() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, t, 0.05);
    for (const o of [this.osc, this.sub, this.lfo]) o.stop(t + 0.3);
    this.ctx = null;
  }
}

// Garage previews: rev the engine for ~1.6 s, or drink for ~1.2 s.
function previewEngine(sound) {
  const cs = new CarSound(sound);
  if (!cs.ctx) return;
  const start = performance.now();
  const tick = () => {
    const el = (performance.now() - start) / 1000;
    const throttle = el < 1.1 ? 1 : 0;
    const speed = el < 1.1 ? el / 1.1 : Math.max(0, 1 - (el - 1.1) * 2);
    cs.update(speed * 0.8, throttle, true, false);
    if (el < 1.6) requestAnimationFrame(tick); else cs.stop();
  };
  tick();
}

function previewGulp(sound) {
  const cs = new CarSound(sound);
  if (!cs.ctx) return;
  const start = performance.now();
  const tick = () => {
    const el = (performance.now() - start) / 1000;
    cs.update(0, 0, false, true);
    if (el < 1.2) requestAnimationFrame(tick); else cs.stop();
  };
  tick();
}
