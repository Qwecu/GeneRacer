// Race engine: physics, rendering, hotseat turn flow and time trials.
//
// Every car property used here comes from the genome (see traits.py):
//   power, weight, max_speed_px, back_power, steer_left/right, react_*,
//   grip, wet_grip, durability, light_range_px, tank, efficiency, drag,
//   lifespan_km.

const PLAYER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22'];
const CONTROLS = ['up', 'down', 'left', 'right'];
const KEYMAP = { arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
                 w: 'up', s: 'down', a: 'left', d: 'right' };   // arrows and WASD
// Separate genes for how fast each control reacts when pressed, and when released.
const DELAY_KEY = { up: 'react_forward', down: 'react_back', left: 'react_left', right: 'react_right' };
const RELEASE_KEY = { up: 'release_forward', down: 'release_back', left: 'release_left', right: 'release_right' };
// Drifting: tyres hold until the sideways slip passes DRIFT_START (px/s),
// then slide on the lower KINETIC share of their grip until the slip falls
// below DRIFT_END.  The gap between the two makes drifts last.
const DRIFT_START = 45;
const DRIFT_END = 15;
const KINETIC = 0.6;
const LAT_GRIP = 650;           // sideways grip (px/s²) per unit of tyre grip
const POWER_OVERSTEER = 0.9;    // rad/s of extra rotation from gas during a slide
// Walls: share of the impact speed the car bounces back with.
const WALL_BOUNCE = 0.55;
// Brakes stronger than this multiple of the tyres' traction lock the wheels.
const LOCK_LIMIT = 1.7;   // about 30% of random cars lock on a dry road, ~70% in rain

const PHYS_DT = 1 / 120;
const FUEL_KG_PER_L = 0.75;
const REFUEL_RATE = 14;          // L/s while stopped at the pumps
const REFUEL_MAX_SPEED = 45;     // px/s
const MAX_RUN_TIME = 900;        // s
const STALL_TIME = 40;           // s without new progress ends the run
const GHOST_INTERVAL = 0.1;      // s

function fmtTime(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}
function fmtKm(px) { return (px * M_PER_PX / 1000).toFixed(2) + ' km'; }

const STATUS_TEXT = {
  finished: 'Finished',
  fuel: 'Out of fuel',
  wrecked: 'Wrecked',
  worn: 'Worn out (lifespan reached)',
  gaveup: 'Gave up',
  stalled: 'Stalled',
  timeout: 'Time limit',
};

// Ranking used for both hotseat results and records: finishers by time, then by distance.
function compareRuns(a, b) {
  if (a.finished !== b.finished) return a.finished ? -1 : 1;
  if (a.finished) return a.time - b.time;
  return b.distance - a.distance;
}

// =====================================================================
// One car's run on a track
// =====================================================================

class CarRun {
  constructor(track, car) {
    this.track = track;
    this.car = car;
    this.st = car.stats;
    const p = trackPointAt(track, track.startS + (track.closed ? -40 : 0));
    this.x = p.x; this.y = p.y; this.a = p.h;
    this.vx = 0; this.vy = 0;
    this.fuel = this.st.tank;
    this.hp = this.st.durability;
    this.distPx = 0;
    const loc = locateOnTrack(track, p.x, p.y, Math.floor((track.startS + (track.closed ? -40 + track.length : 0)) / track.ds) % track.n);
    this.idx = loc.idx;
    this.prevS = loc.s;
    this.progress = track.closed ? -40 : 0;   // unwrapped distance along the race since the start line
    this.maxS = 0;
    this.time = 0;
    this.lastProgressTime = 0;
    this.stillTimer = 0;
    this.status = null;
    this.refueling = false;
    this.zone = 'main';                       // 'main' or index of the pit lane the car is in
    this.lastImpact = -1;
    this.raw = { up: false, down: false, left: false, right: false };
    this.eff = { up: false, down: false, left: false, right: false };
    this.queue = { up: [], down: [], left: [], right: [] };
    this.ghost = [];
    this.ghostTimer = 0;
    this.sliding = false;
    this.slide = 0;          // 0..1, how hard the tyres are sliding (sound, skid marks)
    this.skids = [];         // skid mark segments [x1, y1, x2, y2, strength]
    this.wallHit = 0;        // impact speed of the latest wall hit, read by the sound
  }

  setInput(ctrl, value) {
    if (this.raw[ctrl] === value) return;
    this.raw[ctrl] = value;
    this.queue[ctrl].push({ t: this.time, v: value });
  }

  get speed() { return Math.hypot(this.vx, this.vy); }
  get remainingLifeKm() { return this.st.lifespan_km - this.car.odometer_km - this.distPx * M_PER_PX / 1000; }
  get lap() { return Math.min(this.track.laps, Math.max(1, Math.floor(this.progress / this.track.lapLength) + 1)); }

  step(dt) {
    if (this.status) return;
    const st = this.st, def = this.track.def, track = this.track;
    this.time += dt;

    // --- genetic reaction delays: pressing a key takes effect after the press
    //     delay, releasing it after the (separate) let-go delay ---
    for (const c of CONTROLS) {
      const q = this.queue[c];
      const delay = e => (e.v ? st[DELAY_KEY[c]] : (st[RELEASE_KEY[c]] ?? st[DELAY_KEY[c]])) / 1000;
      while (q.length && q[0].t + delay(q[0]) <= this.time) this.eff[c] = q.shift().v;
    }
    this.locked = false;

    const fx = Math.cos(this.a), fy = Math.sin(this.a);
    const rx = -fy, ry = fx;
    let vf = this.vx * fx + this.vy * fy;
    let vl = this.vx * rx + this.vy * ry;

    const gripFactor = WEATHERS[def.weather].grip(st);
    const traction = 520 * gripFactor;
    const mass = st.weight + this.fuel * FUEL_KG_PER_L;
    const damaged = this.hp / st.durability < 0.3;
    const vmax = st.max_speed_px * (damaged ? 0.85 : 1);
    const hasFuel = this.fuel > 0;
    const burn = 2.1 * (0.5 + 0.5 * st.power / 220) * Math.sqrt(mass / 1300) / st.efficiency;

    let driven = false;
    if (this.eff.up && hasFuel) {
      let eng = st.power * 950 / mass;
      if (vf > 0) eng *= Math.max(0, 1 - (vf / vmax) ** 2);
      vf += Math.min(eng, traction) * dt;
      this.fuel -= burn * dt;
      driven = true;
    }
    if (this.eff.down) {
      if (vf > 8) {
        // Brakes stronger than the tyres can hold lock the wheels: the car
        // slides, stops less well and barely steers.
        this.locked = st.back_power > traction * LOCK_LIMIT;
        const decel = this.locked ? traction * 0.85 : st.back_power;
        vf = Math.max(0, vf - decel * dt);
        driven = true;
      } else if (hasFuel) {
        const revMax = 0.3 * vmax;
        if (vf > -revMax) vf -= Math.min(st.back_power * 0.35, traction) * dt;
        this.fuel -= burn * 0.4 * dt;
        driven = true;
      }
    }
    // rolling resistance and air drag
    const resist = (22 + 0.0006 * st.drag * vf * vf) * dt;
    if (!driven || Math.abs(vf) > vmax) {
      if (Math.abs(vf) <= resist) vf = 0; else vf -= Math.sign(vf) * resist;
    }
    if (hasFuel) this.fuel -= 0.03 * dt;  // idle
    this.fuel = Math.max(0, this.fuel);

    // --- tyre grip and drifting ---
    const slip = Math.abs(vl);
    if (!this.sliding && slip > DRIFT_START) this.sliding = true;
    else if (this.sliding && slip < DRIFT_END) this.sliding = false;
    const gas = this.eff.up && hasFuel;
    let latGrip = LAT_GRIP * gripFactor;
    if (this.sliding) latGrip *= KINETIC * (gas ? 0.8 : 1);   // spinning wheels hold even less
    if (this.locked) latGrip *= 0.35;
    const maxLat = latGrip * dt;
    vl -= Math.max(-maxLat, Math.min(maxLat, vl));
    // Gas during a slide swings the tail further out (power oversteer).
    if (this.sliding && gas && vf > 30) {
      this.a -= Math.sign(vl) * POWER_OVERSTEER * Math.min(1, slip / 120) * dt;
    }
    this.slide = this.locked && Math.abs(vf) > 20 ? 1 : this.sliding ? Math.min(1, slip / 150) : 0;

    // steering: separate genes for left and right
    const steer = (this.eff.right ? 1 : 0) - (this.eff.left ? 1 : 0);
    if (steer !== 0) {
      const rate = (steer > 0 ? st.steer_right : st.steer_left) * Math.PI / 180;
      const spd = Math.abs(vf);
      const omega = steer * rate * Math.min(1, spd / 80) * Math.sign(vf) * (1 - 0.35 * Math.min(1, spd / vmax))
        * (this.locked ? 0.25 : 1);
      this.a += omega * dt;
    }

    this.vx = fx * vf + rx * vl;
    this.vy = fy * vf + ry * vl;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.distPx += Math.hypot(this.vx, this.vy) * dt;
    this.recordSkid(dt);

    // --- walls: the road, plus any pit lane that exists at this point ---
    const loc = locateOnTrack(track, this.x, this.y, this.idx);
    this.idx = loc.idx;
    const m = this.car.looks.width / 2 + 2;
    const intervals = [{ zone: 'main', lo: -track.hw + m, hi: track.hw - m }];
    let pitHere = null;
    track.pits.forEach((pit, i) => {
      const u = pitU(track, pit, loc.s);
      if (u === null) return;
      const c = pitCenterOffset(track, u) * pit.side;
      intervals.push({ zone: i, lo: c - PIT.width / 2 + m, hi: c + PIT.width / 2 - m, u });
    });
    const lat = loc.lateral;
    const inside = intervals.filter(iv => lat >= iv.lo && lat <= iv.hi);
    let current;
    if (inside.length) {
      current = inside.find(iv => iv.zone === this.zone) || inside[0];
    } else {
      current = intervals.find(iv => iv.zone === this.zone) ||
        intervals.reduce((b, iv) => Math.min(Math.abs(lat - iv.lo), Math.abs(lat - iv.hi)) <
                                   Math.min(Math.abs(lat - b.lo), Math.abs(lat - b.hi)) ? iv : b);
      const target = lat > current.hi ? current.hi : current.lo;
      const sg = lat > current.hi ? 1 : -1;
      const push = lat - target;
      this.x -= loc.nx * push;
      this.y -= loc.ny * push;
      const vn = (this.vx * loc.nx + this.vy * loc.ny) * sg;
      if (vn > 0) {
        // was the car driving nose-first or reversing into the wall?
        const fwd = this.vx * Math.cos(this.a) + this.vy * Math.sin(this.a);
        // bounce back off the wall
        this.vx -= loc.nx * sg * vn * (1 + WALL_BOUNCE);
        this.vy -= loc.ny * sg * vn * (1 + WALL_BOUNCE);
        // the hit swings the car towards running along the wall, in the
        // direction it is moving along it (nose first, or tail first if reversing)
        const tx = loc.ny, ty = -loc.nx;                       // wall direction = track direction
        const vt = this.vx * tx + this.vy * ty;
        if (Math.abs(vt) > 20) {
          const along = Math.atan2(ty * Math.sign(vt), tx * Math.sign(vt));
          const target = along + (fwd < 0 ? Math.PI : 0);
          this.a += angleDiff(target, this.a) * Math.min(0.5, vn / 400);
        }
        if (vn > 25) this.wallHit = Math.max(this.wallHit, vn);
        const dmg = Math.max(0, vn - 50) * 0.3;
        this.hp -= dmg;
        if (dmg > 0) this.lastImpact = this.time;
      }
      this.vx *= 0.995; this.vy *= 0.995;
    }
    this.zone = current.zone;
    if (current.zone !== 'main') pitHere = current;

    // back wall behind the start of a sprint
    if (!track.closed && loc.s < 20) {
      const p = trackPointAt(track, 20);
      const hx = Math.cos(p.h), hy = Math.sin(p.h);
      const back = (this.x - p.x) * hx + (this.y - p.y) * hy;
      if (back < 0) {
        this.x -= hx * back; this.y -= hy * back;
        const v = this.vx * hx + this.vy * hy;
        if (v < 0) { this.vx -= hx * v; this.vy -= hy * v; }
      }
    }

    // --- progress (unwrapped across laps) ---
    let delta = loc.s - this.prevS;
    if (track.closed) {
      if (delta > track.length / 2) delta -= track.length;
      if (delta < -track.length / 2) delta += track.length;
    }
    this.prevS = loc.s;
    this.progress += delta;
    const s = track.closed ? this.progress : loc.s - track.startS;
    if (s > this.maxS + 1) { this.maxS = s; this.lastProgressTime = this.time; }

    // --- pit lane refuelling: only on the straight part, by the pumps ---
    const atPumps = pitHere && pitHere.u >= PIT.ramp && pitHere.u <= PIT.ramp + PIT.straight;
    this.inPit = !!pitHere;
    this.refueling = atPumps && this.speed < REFUEL_MAX_SPEED && this.fuel < st.tank;
    if (this.refueling) this.fuel = Math.min(st.tank, this.fuel + REFUEL_RATE * dt);

    // --- ghost ---
    this.ghostTimer += dt;
    if (this.ghostTimer >= GHOST_INTERVAL) {
      this.ghostTimer -= GHOST_INTERVAL;
      this.ghost.push([Math.round(this.x), Math.round(this.y), Math.round(this.a * 100)]);
    }

    // --- end conditions ---
    if (s >= track.raceLength) return this.end('finished');
    if (this.hp <= 0) { this.hp = 0; return this.end('wrecked'); }
    if (this.remainingLifeKm <= 0) return this.end('worn');
    if (this.fuel <= 0 && this.speed < 4 && !atPumps) {
      this.stillTimer += dt;
      if (this.stillTimer > 1.5) return this.end('fuel');
    } else this.stillTimer = 0;
    if (this.time - this.lastProgressTime > STALL_TIME) return this.end('stalled');
    if (this.time > MAX_RUN_TIME) return this.end('timeout');
  }

  // Rear-wheel skid marks while drifting or with locked wheels.
  recordSkid(dt) {
    this.skidTimer = (this.skidTimer || 0) + dt;
    const L = this.car.looks.length, W = this.car.looks.width;
    const fx = Math.cos(this.a), fy = Math.sin(this.a);
    const wheels = [-1, 1].map(s => [this.x - fx * L * 0.3 - fy * s * W * 0.42, this.y - fy * L * 0.3 + fx * s * W * 0.42]);
    if (this.slide <= 0.15) { this.lastWheels = null; return; }      // not sliding: no marks
    if (!this.lastWheels) { this.lastWheels = wheels; this.skidTimer = 0; return; }
    if (this.skidTimer < 1 / 60) return;                             // one segment per 1/60 s
    for (let i = 0; i < 2; i++) {
      this.skids.push([this.lastWheels[i][0], this.lastWheels[i][1], wheels[i][0], wheels[i][1], this.slide]);
    }
    if (this.skids.length > 4000) this.skids.splice(0, this.skids.length - 4000);
    this.lastWheels = wheels;
    this.skidTimer = 0;
  }

  end(status) {
    if (this.status) return;
    this.status = status;
    if (status === 'finished') this.maxS = this.track.raceLength;
  }

  result() {
    return {
      status: this.status,
      finished: this.status === 'finished',
      time: this.time,
      distance: this.maxS,
      km: this.distPx * M_PER_PX / 1000,
    };
  }
}

// =====================================================================
// Ghost playback
// =====================================================================

function ghostPose(ghost, t) {
  if (!ghost || !ghost.length) return null;
  const f = t / GHOST_INTERVAL;
  const i = Math.floor(f);
  if (i >= ghost.length - 1) {
    const g = ghost[ghost.length - 1];
    return { x: g[0], y: g[1], a: g[2] / 100, done: true };
  }
  const a = ghost[Math.max(0, i)], b = ghost[i + 1], k = f - i;
  return { x: a[0] + (b[0] - a[0]) * k, y: a[1] + (b[1] - a[1]) * k, a: a[2] / 100 + angleDiff(b[2] / 100, a[2] / 100) * k };
}

// =====================================================================
// Race session: hotseat (several entries) or time trial (one entry)
// =====================================================================

class RaceSession {
  /**
   * opts: { trackDef, entries: [{driver, car}], mode: 'hotseat'|'trial',
   *         recordGhost: the track's number 1 {looks, driver, car_name, ...} | null (for the start screen),
   *         trialGhosts: [{g: ghost, looks, label, color}] drawn during a time trial,
   *         onExit(results) }
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.track = buildTrack(this.trackDef);
    this.biome = BIOMES[this.trackDef.biome];
    this.screen = document.getElementById('race-screen');
    this.canvas = document.getElementById('race-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.overlay = document.getElementById('race-overlay');
    this.layer = document.createElement('canvas');   // darkness / fog layer
    this.turn = 0;
    this.results = [];
    this.run = null;
    this.phase = 'ready';
    this.cam = null;
    this.particles = [];
    this.raf = null;
    this._onKey = this.onKey.bind(this);
  }

  colorOf(i) { return this.entries[i].color || PLAYER_COLORS[i % PLAYER_COLORS.length]; }

  start() {
    this.screen.classList.remove('hidden');
    flashLogo();
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKey);
    this.prepareTurn();
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(t => this.frame(t));
  }

  close() {
    this.stopSound();
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('keyup', this._onKey);
    this.screen.classList.add('hidden');
    this.overlay.classList.add('hidden');
  }

  // ---------- flow ----------

  prepareTurn() {
    const e = this.entries[this.turn];
    this.run = new CarRun(this.track, e.car);
    this.cam = null;
    this.phase = 'ready';
    const st = e.car.stats;
    const color = this.colorOf(this.turn);
    const who = this.mode === 'hotseat'
      ? `<div class="big"><b style="color:${color}">Player ${this.turn + 1}: ${esc(e.driver)}</b></div>` : '';
    const rec = this.recordGhost
      ? `<p>Number 1 to beat: <b>${recordText(this.recordGhost)}</b> by ${esc(this.recordGhost.driver)} (${esc(this.recordGhost.car_name)})</p>` : '';
    this.showOverlay(`
      <h2>${esc(this.trackDef.name)}</h2>
      ${who}
      <p><img class="car-icon" src="${carIconURL(e.car.looks)}"> <b>${esc(e.car.name)}</b> &middot; tank ${st.tank} L &middot; ${st.durability} HP &middot;
         ${Math.max(0, st.lifespan_km - e.car.odometer_km).toFixed(1)} km of life left</p>
      <p class="hint">${trackConditions(this.trackDef)}.<br>
        Refuel by steering into a pit lane and stopping at the yellow pumps.</p>
      ${rec}
      <p><b>Press Space to start</b> &nbsp; <button class="small" id="btn-quit-race">Quit</button></p>`);
    document.getElementById('btn-quit-race').onclick = () => this.exit();
  }

  beginCountdown() {
    this.hideOverlay();
    this.stopSound();
    this.sound = new CarSound(this.entries[this.turn].car.sound);   // started from a key press, so audio is allowed
    this.phase = 'countdown';
    this.countdown = 3;
  }

  stopSound() {
    if (this.sound) { this.sound.stop(); this.sound = null; }
  }

  updateSound() {
    if (!this.sound) return;
    const run = this.run;
    const running = this.phase === 'countdown' || (this.phase === 'running' && run.fuel > 0);
    const throttle = this.phase === 'running' && run.eff.up && run.fuel > 0 ? 1 : 0;
    this.sound.update(Math.min(1, run.speed / run.st.max_speed_px), throttle, running, run.refueling,
      this.phase === 'running' ? run.slide : 0);
    if (run.wallHit) { this.sound.thump(Math.min(1, run.wallHit / 300)); run.wallHit = 0; }
  }

  finishTurn() {
    this.stopSound();
    const e = this.entries[this.turn];
    const r = this.run.result();
    r.driver = e.driver; r.car = e.car; r.ghost = this.run.ghost; r.turn = this.turn;
    this.results.push(r);
    this.phase = 'runover';
    const last = this.turn === this.entries.length - 1;
    const line = r.finished ? `Time <b>${fmtTime(r.time)}</b>` : `Got <b>${fmtKm(r.distance)}</b> of ${fmtKm(this.track.raceLength)}`;
    let extra = '';
    // Time trials hand the run to the owner (app.js), which submits it to the
    // hall of fame and returns a line of HTML to show here.
    if (this.onRunFinished) extra = '<div id="run-extra" class="hint">Checking the hall of fame...</div>';
    this.showOverlay(`
      <h2>${STATUS_TEXT[r.status]}</h2>
      <p class="big">${line}</p>
      <p>Distance driven: ${r.km.toFixed(2)} km</p>
      ${extra}
      <p><b>Press Space to ${last ? 'see results' : 'continue to the next player'}</b></p>`);
    if (this.onRunFinished) {
      this.runSaved = this.onRunFinished(r);   // the end screen waits for this before reading the hall of fame
      this.runSaved
        .then(html => { const el = document.getElementById('run-extra'); if (el) el.outerHTML = html; })
        .catch(() => { const el = document.getElementById('run-extra'); if (el) el.textContent = 'Could not reach the hall of fame.'; });
    }
  }

  nextTurn() {
    if (this.turn < this.entries.length - 1) {
      this.turn++;
      this.prepareTurn();
    } else {
      this.showResults();
    }
  }

  showResults() {
    this.phase = 'results';
    const ranked = [...this.results].sort(compareRuns);
    const rows = ranked.map((r, i) => `
      <tr><td>${i + 1}.</td><td style="color:${this.colorOf(r.turn)}"><b>${esc(r.driver)}</b></td>
      <td><img class="car-icon" src="${carIconURL(r.car.looks)}"> ${esc(r.car.name)}</td><td>${STATUS_TEXT[r.status]}</td>
      <td>${r.finished ? fmtTime(r.time) : fmtKm(r.distance)}</td></tr>`).join('');
    const winner = ranked[0];
    const how = winner.finished ? 'fastest to the finish' : 'nobody finished, furthest distance wins';
    const trial = this.mode !== 'hotseat' && this.trialStandings;
    const table = trial ? '<div id="trial-standings" class="hint">Loading the hall of fame...</div>'
      : `<table class="results"><tr><th></th><th>Driver</th><th>Car</th><th>Result</th><th></th></tr>${rows}</table>`;
    this.showOverlay(`
      <h2>${this.mode === 'hotseat' ? `${esc(winner.driver)} wins!` : 'Time trial over'}</h2>
      ${this.mode === 'hotseat' ? `<p class="hint">${how}</p>` : ''}
      ${table}
      <p><button class="primary" id="btn-race-done">Back to menu</button></p>`);
    document.getElementById('btn-race-done').onclick = () => this.exit();
    if (trial) {
      const fill = html => { const el = document.getElementById('trial-standings'); if (el) el.outerHTML = html; };
      Promise.resolve(this.runSaved).catch(() => {}).then(() => this.trialStandings()).then(fill).catch(() => fill('<p class="hint">Could not reach the hall of fame.</p>'));
    }
  }

  exit() {
    this.close();
    if (this.onExit) this.onExit(this.results);
  }

  showOverlay(html) { this.overlay.innerHTML = html; this.overlay.classList.remove('hidden'); }
  hideOverlay() { this.overlay.classList.add('hidden'); }

  onKey(ev) {
    const down = ev.type === 'keydown';
    const key = ev.key.toLowerCase(), dir = KEYMAP[key];
    if (dir) {
      ev.preventDefault();
      // a direction stays on while any of its keys (say W and the up arrow) is held
      const held = this._held || (this._held = {});
      const set = held[dir] || (held[dir] = new Set());
      if (down) set.add(key); else set.delete(key);
      if (this.run) this.run.setInput(dir, set.size > 0);
      return;
    }
    if (!down) return;
    if (ev.key === ' ' || ev.key === 'Enter') {
      ev.preventDefault();
      if (this.phase === 'ready') this.beginCountdown();
      else if (this.phase === 'runover') this.nextTurn();
    } else if (ev.key === 'm' || ev.key === 'M') {
      Sound.toggleMute();
    } else if (ev.key === 'Escape') {
      if (this.phase === 'running') { this.run.end('gaveup'); this.finishTurn(); }
    }
  }

  // ---------- main loop ----------

  frame(now) {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) this.phase = 'running';
    } else if (this.phase === 'running') {
      this.acc = (this.acc || 0) + dt;
      while (this.acc >= PHYS_DT) {
        this.run.step(PHYS_DT);
        this.acc -= PHYS_DT;
        if (this.run.status) break;
      }
      if (this.run.status) { this.acc = 0; this.finishTurn(); }
    }
    this.updateSound();
    this.render(dt);
    this.raf = requestAnimationFrame(t => this.frame(t));
  }

  // ---------- rendering ----------

  render(dt) {
    const canvas = this.canvas, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    if (this.layer.width !== pw || this.layer.height !== ph) { this.layer.width = pw; this.layer.height = ph; }

    const run = this.run, def = this.trackDef, track = this.track, bio = this.biome;
    const zoom = Math.max(0.75, Math.min(1.4, Math.min(W, H) / 750));

    // camera with a little look-ahead
    const tx = run.x + run.vx * 0.45, ty = run.y + run.vy * 0.45;
    if (!this.cam) this.cam = { x: tx, y: ty };
    const k = Math.min(1, dt * 5);
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;

    const worldTransform = (c) => {
      c.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * (W / 2 - this.cam.x * zoom), dpr * (H / 2 - this.cam.y * zoom));
    };

    // ground
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = bio.ground;
    ctx.fillRect(0, 0, W, H);
    worldTransform(ctx);
    this.drawScenery(ctx, W / zoom, H / zoom);

    // road
    const wet = def.weather === 'rain' || def.weather === 'snow';
    ctx.fillStyle = bio.road;
    ctx.fill(track.road, 'evenodd');
    if (wet) { ctx.fillStyle = def.weather === 'rain' ? 'rgba(40,60,90,0.25)' : 'rgba(230,240,250,0.25)'; ctx.fill(track.road, 'evenodd'); }
    ctx.strokeStyle = bio.edge; ctx.lineWidth = 3;
    ctx.stroke(track.leftEdge); ctx.stroke(track.rightEdge);
    ctx.setLineDash([30, 30]); ctx.strokeStyle = 'rgba(240,210,80,0.7)'; ctx.lineWidth = 2;
    ctx.stroke(track.center); ctx.setLineDash([]);
    if (def.weather === 'rain') this.drawPuddles(ctx);

    // pit lanes
    for (const pit of track.pits) this.drawPit(ctx, pit);

    // start, finish, km markers
    if (track.closed) {
      this.drawFinish(ctx, track.startS);
    } else {
      this.drawLineAcross(ctx, track.startS, '#fff', 6);
      this.drawFinish(ctx, track.finishS);
      ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = 'bold 16px system-ui'; ctx.textAlign = 'center';
      for (let km = 1; km * PX_PER_KM < track.raceLength; km++) {
        const p = trackPointAt(track, track.startS + km * PX_PER_KM);
        ctx.fillText(`${km} km`, p.x - p.nx * (track.hw + 22), p.y - p.ny * (track.hw + 22) + 5);
      }
    }

    // skid marks
    ctx.lineCap = 'round';
    ctx.lineWidth = 3;
    for (const [x1, y1, x2, y2, s] of run.skids) {
      ctx.strokeStyle = `rgba(20,20,20,${0.15 + 0.35 * s})`;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }

    // ghosts
    const t = run.time;
    const ghosts = [];
    for (const gh of this.trialGhosts || []) ghosts.push(gh);
    if (this.mode === 'hotseat') for (const r of this.results) ghosts.push({ g: r.ghost, looks: r.car.looks, label: r.driver, color: this.colorOf(r.turn) });
    const ghostPoses = [];
    ghosts.forEach((gh, row) => {
      const p = ghostPose(gh.g, t);
      if (!p || !gh.looks || !gh.looks.width) return;
      ghostPoses.push({ ...p, color: gh.color });
      drawCar(ctx, gh.looks, p.x, p.y, p.a, 1, { alpha: 0.35, ghost: true, label: gh.label, labelColor: gh.color, labelRow: row });
    });

    // the car
    drawCar(ctx, run.car.looks, run.x, run.y, run.a, 1, { damage: 1 - run.hp / run.st.durability, steerKeys: run.raw });
    if (run.lastImpact >= 0 && run.time - run.lastImpact < 0.25) {
      ctx.fillStyle = 'rgba(255,200,80,0.7)';
      ctx.beginPath(); ctx.arc(run.x, run.y, 18, 0, Math.PI * 2); ctx.fill();
    }

    if (def.weather === 'fog') this.drawFog(ctx, worldTransform);
    if (TIMES[def.time].dark > 0) this.drawDarkness(ctx, worldTransform);
    if (def.weather === 'rain' || def.weather === 'snow') this.drawPrecipitation(ctx, W, H, dpr, dt, def.weather);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    this.drawHud(ctx, W, H, ghostPoses);
    if (this.phase === 'countdown') {
      ctx.fillStyle = 'white'; ctx.font = 'bold 120px system-ui'; ctx.textAlign = 'center';
      ctx.strokeStyle = 'black'; ctx.lineWidth = 6;
      const n = String(Math.ceil(this.countdown));
      ctx.strokeText(n, W / 2, H / 2 - 60); ctx.fillText(n, W / 2, H / 2 - 60);
    }
  }

  drawScenery(ctx, vw, vh) {
    // deterministic trees / rocks and ground specks on a grid around the camera
    const cell = 90, bio = this.biome;
    const x0 = Math.floor((this.cam.x - vw / 2) / cell) - 1, x1 = Math.ceil((this.cam.x + vw / 2) / cell) + 1;
    const y0 = Math.floor((this.cam.y - vh / 2) / cell) - 1, y1 = Math.ceil((this.cam.y + vh / 2) / cell) + 1;
    const density = this.trackDef.biome === 'forest' ? 0.5 : this.trackDef.biome === 'desert' ? 0.12 : 0.25;
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        let h = (gx * 73856093) ^ (gy * 19349663);
        h = (h ^ (h >>> 13)) * 1274126177;
        const r1 = ((h >>> 0) % 1000) / 1000, r2 = ((h >>> 10) % 1000) / 1000;
        const px = gx * cell + r1 * cell, py = gy * cell + r2 * cell;
        if (r1 < density) {
          ctx.fillStyle = bio.blob;
          ctx.beginPath(); ctx.arc(px, py, 10 + r2 * 14, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.fillStyle = bio.speck;
          ctx.fillRect(px, py, 3, 3);
        }
      }
    }
  }

  drawPuddles(ctx) {
    const rnd = mulberry32(this.trackDef.seed + 1);
    ctx.fillStyle = 'rgba(120,150,190,0.22)';
    for (let s = 300; s < this.track.length; s += 180 + rnd() * 300) {
      const p = trackPointAt(this.track, s);
      const off = (rnd() * 2 - 1) * this.track.hw * 0.6;
      ctx.beginPath();
      ctx.ellipse(p.x + p.nx * off, p.y + p.ny * off, 18 + rnd() * 25, 8 + rnd() * 10, p.h, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawLineAcross(ctx, s, color, width) {
    const p = trackPointAt(this.track, s), hw = this.track.hw;
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(p.x - p.nx * hw, p.y - p.ny * hw);
    ctx.lineTo(p.x + p.nx * hw, p.y + p.ny * hw);
    ctx.stroke();
  }

  drawFinish(ctx, s) {
    const p = trackPointAt(this.track, s), hw = this.track.hw;
    const n = 10, sq = (2 * hw) / n;
    ctx.save();
    ctx.translate(p.x, p.y); ctx.rotate(p.h);
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < n; i++) {
        ctx.fillStyle = (i + row) % 2 ? '#111' : '#fff';
        ctx.fillRect(row * sq - sq, -hw + i * sq, sq, sq);
      }
    }
    ctx.restore();
  }

  drawPit(ctx, pit) {
    const g = pit.geom, bio = this.biome;
    ctx.fillStyle = bio.road;
    ctx.fill(g.band);
    const w = this.trackDef.weather;
    if (w === 'rain' || w === 'snow') { ctx.fillStyle = w === 'rain' ? 'rgba(40,60,90,0.25)' : 'rgba(230,240,250,0.25)'; ctx.fill(g.band); }
    ctx.fillStyle = 'rgba(245,197,24,0.35)';
    ctx.fill(g.zone);
    ctx.strokeStyle = bio.edge; ctx.lineWidth = 3;
    ctx.stroke(g.outerLine);
    ctx.strokeStyle = '#f5c518'; ctx.lineWidth = 3;
    ctx.stroke(g.innerLine);
    // building with pumps
    const b = g.building;
    ctx.save();
    ctx.translate(b.x, b.y); ctx.rotate(b.h);
    ctx.fillStyle = '#c8b27a'; ctx.fillRect(-90, -24, 180, 48);
    ctx.fillStyle = '#d2452c'; ctx.fillRect(-90, -24, 180, 10);
    ctx.fillStyle = '#222'; ctx.font = 'bold 16px system-ui'; ctx.textAlign = 'center';
    ctx.rotate(Math.abs(angleDiff(b.h, 0)) > Math.PI / 2 ? Math.PI : 0);
    ctx.fillText('FUEL', 0, 7);
    ctx.restore();
    // pumps along the zone
    for (let u = PIT.ramp + 60; u <= PIT.ramp + PIT.straight - 60; u += 120) {
      const p = trackPointAt(this.track, pit.s0 + u);
      const off = (this.track.hw + PIT.island + PIT.width + 8) * pit.side;
      ctx.fillStyle = '#d2452c';
      ctx.fillRect(p.x + p.nx * off - 5, p.y + p.ny * off - 5, 10, 10);
    }
  }

  // Darkness: a dark layer with holes cut by the headlights and street lights.
  drawDarkness(ctx, worldTransform) {
    const tm = TIMES[this.trackDef.time];
    const d = this.layer, dc = d.getContext('2d');
    const run = this.run, st = run.st, tr = this.track;
    dc.setTransform(1, 0, 0, 1, 0, 0);
    dc.globalCompositeOperation = 'source-over';
    dc.clearRect(0, 0, d.width, d.height);
    dc.fillStyle = `rgba(${tm.color},${tm.dark})`;
    dc.fillRect(0, 0, d.width, d.height);
    dc.globalCompositeOperation = 'destination-out';
    worldTransform(dc);

    const R = st.light_range_px;
    const fx = run.x + Math.cos(run.a) * run.car.looks.length / 2;
    const fy = run.y + Math.sin(run.a) * run.car.looks.length / 2;
    this.cut(dc, fx, fy, R, run.a - 0.42, run.a + 0.42);
    this.cut(dc, run.x, run.y, 42);
    for (const pit of tr.pits) this.cut(dc, pit.geom.building.x, pit.geom.building.y, 220);
    const fp = trackPointAt(tr, tr.closed ? tr.startS : tr.finishS);
    this.cut(dc, fp.x, fp.y, 180);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(d, 0, 0);

    // tinted beam
    worldTransform(ctx);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, R);
    g.addColorStop(0, `hsla(${run.car.looks.light_hue}, 80%, 60%, 0.16)`);
    g.addColorStop(1, `hsla(${run.car.looks.light_hue}, 80%, 60%, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(fx, fy); ctx.arc(fx, fy, R, run.a - 0.42, run.a + 0.42); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // Fog: a pale layer; you see a short way around the car, and headlights help a little.
  drawFog(ctx, worldTransform) {
    const d = this.layer, dc = d.getContext('2d');
    const run = this.run;
    dc.setTransform(1, 0, 0, 1, 0, 0);
    dc.globalCompositeOperation = 'source-over';
    dc.clearRect(0, 0, d.width, d.height);
    dc.fillStyle = 'rgba(208,212,218,0.96)';
    dc.fillRect(0, 0, d.width, d.height);
    dc.globalCompositeOperation = 'destination-out';
    worldTransform(dc);
    this.cut(dc, run.x, run.y, 150);
    const fx = run.x + Math.cos(run.a) * 20, fy = run.y + Math.sin(run.a) * 20;
    this.cut(dc, fx, fy, 120 + run.st.light_range_px * 0.4, run.a - 0.35, run.a + 0.35);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(d, 0, 0);
  }

  cut(dc, x, y, r, a0, a1) {
    const g = dc.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(0.65, 'rgba(0,0,0,0.85)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    dc.fillStyle = g;
    dc.beginPath();
    if (a0 === undefined) dc.arc(x, y, r, 0, Math.PI * 2);
    else { dc.moveTo(x, y); dc.arc(x, y, r, a0, a1); dc.closePath(); }
    dc.fill();
  }

  drawPrecipitation(ctx, W, H, dpr, dt, kind) {
    const snow = kind === 'snow';
    if (!this.particles.length) {
      for (let i = 0; i < (snow ? 220 : 170); i++) {
        this.particles.push({ x: Math.random() * W, y: Math.random() * H, v: snow ? 50 + Math.random() * 70 : 600 + Math.random() * 400, p: Math.random() * 6 });
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    if (snow) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (const r of this.particles) {
        r.y += r.v * dt; r.p += dt * 2; r.x += Math.sin(r.p) * 20 * dt;
        if (r.y > H) { r.y -= H; r.x = Math.random() * W; }
        ctx.fillRect(r.x, r.y, 2.5, 2.5);
      }
    } else {
      ctx.strokeStyle = 'rgba(190,210,240,0.4)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (const r of this.particles) {
        r.y += r.v * dt; r.x -= r.v * 0.15 * dt;
        if (r.y > H) { r.y -= H; r.x = Math.random() * W; }
        if (r.x < 0) r.x += W;
        ctx.moveTo(r.x, r.y); ctx.lineTo(r.x + 3, r.y - 16);
      }
      ctx.stroke();
    }
  }

  drawHud(ctx, W, H, ghostPoses) {
    const run = this.run, st = run.st, e = this.entries[this.turn], track = this.track;
    const color = this.colorOf(this.turn);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    roundRect(ctx, 12, 12, 270, 206, 10); ctx.fill();
    ctx.textAlign = 'left';
    ctx.fillStyle = color; ctx.font = 'bold 15px system-ui';
    ctx.fillText(`${e.driver} — ${e.car.name}`, 24, 34);
    ctx.fillStyle = 'white'; ctx.font = 'bold 30px system-ui';
    ctx.fillText(`${Math.round(run.speed * 0.9)} km/h`, 24, 70);
    ctx.font = '14px system-ui';
    ctx.fillText(`Time ${fmtTime(run.time)}`, 170, 64);
    if (track.closed) { ctx.font = 'bold 14px system-ui'; ctx.fillText(`Lap ${run.lap}/${track.laps}`, 170, 82); }

    const bar = (y, label, frac, col, text) => {
      ctx.fillStyle = '#ccc'; ctx.font = '12px system-ui'; ctx.fillText(label, 24, y + 9);
      ctx.fillStyle = '#333'; ctx.fillRect(80, y, 150, 10);
      ctx.fillStyle = col; ctx.fillRect(80, y, 150 * Math.max(0, Math.min(1, frac)), 10);
      ctx.fillStyle = '#ccc'; ctx.fillText(text, 236, y + 9);
    };
    const fuelFrac = run.fuel / st.tank;
    bar(96, 'Fuel', fuelFrac, fuelFrac < 0.2 ? '#e74c3c' : '#f5c518', `${run.fuel.toFixed(0)} L`);
    bar(116, 'Body', run.hp / st.durability, run.hp / st.durability < 0.3 ? '#e74c3c' : '#2ecc71', `${Math.ceil(run.hp)}`);
    bar(136, 'Progress', run.maxS / track.raceLength, '#3498db', `${Math.round(100 * run.maxS / track.raceLength)}%`);
    const life = run.remainingLifeKm;
    bar(156, 'Life', life / st.lifespan_km, life < 2 ? '#e74c3c' : '#9b59b6', `${life.toFixed(1)}`);
    ctx.fillStyle = '#ccc'; ctx.font = '12px system-ui';
    ctx.fillText(`${fmtKm(run.maxS)} of ${fmtKm(track.raceLength)}`, 24, 186);
    const next = this.nextPitDistance();
    if (next !== null) ctx.fillText(`Next pit lane in ${fmtKm(next)}`, 24, 204);

    if (run.refueling) this.banner(ctx, W, 'REFUELING', '#f5c518');
    else if (run.fuel <= 0) this.banner(ctx, W, 'OUT OF FUEL', '#e74c3c');
    else if (run.inPit) this.banner(ctx, W, 'PIT LANE - stop at the pumps', '#f5c518');
    else if (run.locked) this.banner(ctx, W, 'WHEELS LOCKED', '#e74c3c');
    else if (fuelFrac < 0.15) this.banner(ctx, W, 'LOW FUEL', '#e67e22');

    this.drawMinimap(ctx, W, H, ghostPoses);
  }

  nextPitDistance() {
    const tr = this.track, run = this.run;
    const here = tr.closed ? ((run.prevS % tr.length) + tr.length) % tr.length : run.prevS;
    let best = null;
    for (const pit of tr.pits) {
      let d = pit.s0 - here;
      if (tr.closed) d = ((d % tr.length) + tr.length) % tr.length;
      if (d >= 0 && (best === null || d < best)) best = d;
    }
    return best;
  }

  banner(ctx, W, text, color) {
    ctx.font = 'bold 24px system-ui'; ctx.textAlign = 'center';
    const w = ctx.measureText(text).width + 40;
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(W / 2 - w / 2, 16, w, 40);
    ctx.fillStyle = color; ctx.fillText(text, W / 2, 45);
    ctx.textAlign = 'left';
  }

  drawMinimap(ctx, W, H, ghostPoses) {
    const tr = this.track, b = tr.bounds;
    const mw = Math.min(tr.closed ? 200 : 320, W * 0.3), mh = tr.closed ? 160 : 110;
    const x0 = W - mw - 12, y0 = 12;
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; roundRect(ctx, x0, y0, mw, mh, 10); ctx.fill();
    const sc = Math.min((mw - 16) / (b.maxX - b.minX), (mh - 16) / (b.maxY - b.minY));
    const ox = x0 + (mw - (b.maxX - b.minX) * sc) / 2 - b.minX * sc;
    const oy = y0 + (mh - (b.maxY - b.minY) * sc) / 2 - b.minY * sc;
    ctx.strokeStyle = '#bbb'; ctx.lineWidth = 2; ctx.beginPath();
    tr.pts.forEach((p, i) => i ? ctx.lineTo(p.x * sc + ox, p.y * sc + oy) : ctx.moveTo(p.x * sc + ox, p.y * sc + oy));
    if (tr.closed) ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = '#f5c518';
    for (const pit of tr.pits) { const p = trackPointAt(tr, pit.s); ctx.fillRect(p.x * sc + ox - 3, p.y * sc + oy - 3, 6, 6); }
    for (const p of ghostPoses) {
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = p.color || '#fff';
      ctx.beginPath(); ctx.arc(p.x * sc + ox, p.y * sc + oy, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.colorOf(this.turn);
    ctx.beginPath(); ctx.arc(this.run.x * sc + ox, this.run.y * sc + oy, 4.5, 0, Math.PI * 2); ctx.fill();
  }
}

function recordText(r) {
  return r.finished ? fmtTime(r.time) : `${fmtKm(r.distance)} (not finished)`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
