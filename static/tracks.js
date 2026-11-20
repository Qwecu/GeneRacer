// Track definitions and procedural (seeded) track geometry.
// 1 px = 0.25 m.  Two shapes:
//   sprint  - point to point, start on the left, finish on the right
//   circuit - closed loop driven for several laps; 'right' loops turn mostly
//             right (clockwise on screen), 'left' loops mostly left.
// Refuelling happens in pit lanes: side lanes separated from the road by an
// island, which you have to steer into and stop at the pumps.

const M_PER_PX = 0.25;
const PX_PER_KM = 4000;
const TRACK_DS = 20;          // target centreline sample spacing (px)
const START_S = 80;           // sprint start line position along the track (px)
const TRACK_VERSION = 2;      // bump when geometry changes, so old records/ghosts are ignored

const PIT = { ramp: 280, straight: 360, width: 76, island: 26 };
PIT.total = 2 * PIT.ramp + PIT.straight;

const BIOMES = {
  meadow: { label: 'meadow', ground: '#5f8d43', speck: '#6c9a4f', blob: '#3f6d2c', road: '#5a5a5a', edge: '#eeeeee' },
  forest: { label: 'forest', ground: '#3b5f32', speck: '#4a7040', blob: '#1f3d1b', road: '#55564f', edge: '#e8e8e8' },
  desert: { label: 'desert', ground: '#d6bd85', speck: '#c9ad72', blob: '#a88a55', road: '#6e6459', edge: '#f4ecd8' },
  snow:   { label: 'snow',   ground: '#e6ecf1', speck: '#d2dbe3', blob: '#56735f', road: '#747c86', edge: '#ffffff' },
};

// Darkness of the overlay; headlights cut through it.
const TIMES = {
  day:   { label: 'day',   dark: 0,    color: '0,0,0' },
  dusk:  { label: 'dusk',  dark: 0.78, color: '28,12,40' },
  night: { label: 'night', dark: 0.975, color: '2,4,14' },
};

// Grip multipliers use the car's genes: dry grip, and the tyre compound
// (wet_grip) for rain and snow.
const WEATHERS = {
  dry:  { label: 'dry',  grip: st => st.grip },
  rain: { label: 'rain', grip: st => st.grip * st.wet_grip },
  snow: { label: 'snow', grip: st => st.grip * st.wet_grip * 0.7 },
  fog:  { label: 'fog',  grip: st => st.grip * 0.95 },
};

const TRACKS = [
  { id: 'meadow',   name: 'Sunny Meadow',   shape: 'sprint',  seed: 11,  lengthKm: 3.6, width: 140, curviness: 0.0035, time: 'day',   weather: 'dry',  biome: 'meadow', fuelEveryKm: 0.8 },
  { id: 'valley',   name: 'Rain Valley',    shape: 'sprint',  seed: 27,  lengthKm: 3.8, width: 130, curviness: 0.0045, time: 'day',   weather: 'rain', biome: 'forest', fuelEveryKm: 0.75 },
  { id: 'midnight', name: 'Midnight Pass',  shape: 'sprint',  seed: 314, lengthKm: 3.6, width: 125, curviness: 0.005,  time: 'night', weather: 'dry',  biome: 'forest', fuelEveryKm: 0.8 },
  { id: 'storm',    name: 'Storm Night',    shape: 'sprint',  seed: 99,  lengthKm: 3.4, width: 130, curviness: 0.0045, time: 'night', weather: 'rain', biome: 'meadow', fuelEveryKm: 0.7 },
  { id: 'serpent',  name: 'Serpent Ridge',  shape: 'sprint',  seed: 5,   lengthKm: 3.2, width: 110, curviness: 0.0075, time: 'dusk',  weather: 'dry',  biome: 'desert', fuelEveryKm: 0.8 },
  { id: 'blizzard', name: 'Night Blizzard', shape: 'sprint',  seed: 2024, lengthKm: 3.0, width: 135, curviness: 0.004, time: 'night', weather: 'snow', biome: 'snow',   fuelEveryKm: 0.7 },
  { id: 'dunering', name: 'Dune Ring',      shape: 'circuit', dir: 'right', seed: 41, lapKm: 1.4, laps: 4, width: 130, wobble: 0.22, time: 'day',   weather: 'dry',  biome: 'desert', fuelPerLap: 2 },
  { id: 'lefthook', name: 'Left Hook Loop', shape: 'circuit', dir: 'left',  seed: 8,  lapKm: 1.6, laps: 3, width: 125, wobble: 0.28, time: 'dusk',  weather: 'dry',  biome: 'meadow', fuelPerLap: 2 },
  { id: 'fogbank',  name: 'Fog Bank',       shape: 'circuit', dir: 'right', seed: 63, lapKm: 1.2, laps: 4, width: 135, wobble: 0.18, time: 'day',   weather: 'fog',  biome: 'forest', fuelPerLap: 1 },
  { id: 'frost',    name: 'Frost Ring',     shape: 'circuit', dir: 'left',  seed: 12, lapKm: 1.5, laps: 3, width: 140, wobble: 0.2,  time: 'day',   weather: 'snow', biome: 'snow',   fuelPerLap: 2 },
  { id: 'nightring', name: 'Night Ring',    shape: 'circuit', dir: 'right', seed: 77, lapKm: 1.8, laps: 3, width: 130, wobble: 0.3,  time: 'night', weather: 'rain', biome: 'meadow', fuelPerLap: 2 },
  { id: 'longhaul', name: 'Long Haul',      shape: 'sprint',  seed: 777, lengthKm: 7.0, width: 140, curviness: 0.003,  time: 'dusk',  weather: 'dry',  biome: 'meadow', fuelEveryKm: 1.0 },
];

function recordKey(def) { return `${def.id}.v${TRACK_VERSION}`; }

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function smoothstep(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }

// ---------------------------------------------------------------------
// Random track generator
// ---------------------------------------------------------------------

const _RND_ADJ = ['Rusty', 'Howling', 'Crooked', 'Silent', 'Golden', 'Broken', 'Lonely', 'Wild', 'Frozen', 'Scarlet', 'Misty', 'Thunder'];
const _RND_NOUN = ['Canyon', 'Loop', 'Ridge', 'Hollow', 'Run', 'Bend', 'Flats', 'Ring', 'Pass', 'Marsh', 'Coast', 'Heights'];

// Turn whatever the player typed into a seed: a plain number is used as is,
// any other text is hashed (FNV-1a), so "banana" is always the same track.
function seedFromText(text) {
  const t = String(text).trim();
  if (/^\d{1,9}$/.test(t)) return Math.max(1, parseInt(t, 10));
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return 1 + ((h >>> 0) % 999999999);
}

// Everything about the track comes from the seed.  `opts` can override the
// shape, time of day and weather, and give the track a name.  Every random
// number is drawn in a fixed order, so overrides never change the rest.
function randomTrackDef(seed, opts = {}) {
  const r = mulberry32(seed * 7919 + 13);
  const pick = arr => arr[Math.floor(r() * arr.length)];
  const weighted = obj => {
    const total = Object.values(obj).reduce((a, b) => a + b, 0);
    let x = r() * total;
    for (const [k, w] of Object.entries(obj)) { x -= w; if (x <= 0) return k; }
    return Object.keys(obj)[0];
  };
  const rolled = {
    time: weighted({ day: 4, dusk: 2, night: 3 }),
    weather: weighted({ dry: 4, rain: 3, fog: 2, snow: 2 }),
    biome: pick(['meadow', 'forest', 'desert']),
    name: `${pick(_RND_ADJ)} ${pick(_RND_NOUN)}`,
    width: Math.round(110 + r() * 35),
    circuit: r() < 0.5,
    lapKm: +(1.0 + r() * 1.0).toFixed(1),
    dir: r() < 0.5 ? 'left' : 'right',
    laps: 2 + Math.floor(r() * 4),
    wobble: +(0.12 + r() * 0.2).toFixed(2),
    lengthKm: +(2.8 + r() * 2.6).toFixed(1),
    curviness: +(0.003 + r() * 0.0045).toFixed(4),
    fuelEveryKm: +(0.6 + r() * 0.45).toFixed(2),
  };
  const shape = opts.shape || (rolled.circuit ? 'circuit' : 'sprint');
  const time = opts.time || rolled.time;
  const weather = opts.weather || rolled.weather;
  const suffix = ['shape', 'time', 'weather'].filter(k => opts[k]).map(k => opts[k]).join('-');
  const def = {
    id: 'c' + seed + (suffix ? '-' + suffix : ''),
    name: (opts.name && String(opts.name).trim().slice(0, 40)) || rolled.name,
    custom: true, seed, seedText: opts.seedText || String(seed),
    width: rolled.width, time, weather, biome: weather === 'snow' ? 'snow' : rolled.biome, shape,
  };
  if (shape === 'circuit') {
    Object.assign(def, {
      dir: rolled.dir, lapKm: rolled.lapKm, laps: rolled.laps, wobble: rolled.wobble,
      fuelPerLap: rolled.lapKm > 1.4 ? 2 : 1,
    });
  } else {
    Object.assign(def, { lengthKm: rolled.lengthKm, curviness: rolled.curviness, fuelEveryKm: rolled.fuelEveryKm });
  }
  return def;
}

// ---------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------

// Sprint: random walk of heading, with the heading clamped so x always
// increases (the road can never cross itself).  Planned pit sections are
// kept straight.
function sprintPoints(def, pitCentres) {
  const rnd = mulberry32(def.seed);
  const totalPx = def.lengthKm * PX_PER_KM;
  const n = Math.ceil(totalPx / TRACK_DS);
  const pts = [];
  let x = 0, y = 0, h = 0, curv = 0, target = 0, nextChange = 12;
  const MAXH = 1.25;
  const flatHalf = PIT.total / 2 + 140;
  for (let i = 0; i <= n; i++) {
    pts.push({ x, y });
    const s = i * TRACK_DS;
    const flat = i >= n - 12 || pitCentres.some(c => Math.abs(s - c) < flatHalf);
    if (i >= nextChange) {
      target = (rnd() * 2 - 1) * def.curviness;
      nextChange = i + 8 + Math.floor(rnd() * 30);
    }
    curv += ((flat ? 0 : target) - curv) * (flat ? 0.35 : 0.12);
    h += curv * TRACK_DS;
    if (h > MAXH) { h = MAXH; target = -Math.abs(target); }
    if (h < -MAXH) { h = -MAXH; target = Math.abs(target); }
    x += Math.cos(h) * TRACK_DS;
    y += Math.sin(h) * TRACK_DS;
  }
  return pts;
}

// Circuit: a star-shaped polar curve r(θ) = R(1 + Σ a_k sin(kθ + φ_k)),
// which cannot self-intersect.  Wobble is reduced until no corner is
// tighter than the road can take.
function circuitPoints(def, attempt = 0) {
  const rnd = mulberry32(def.seed);
  const harmonics = [];
  for (let k = 2; k <= 5; k++) harmonics.push({ k, a: (rnd() * 2 - 1) * def.wobble / (k - 0.8), p: rnd() * Math.PI * 2 });
  const scaleAmp = Math.pow(0.8, attempt);
  const raw = [];
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2;
    let r = 1;
    for (const hm of harmonics) r += hm.a * scaleAmp * Math.sin(hm.k * th + hm.p);
    raw.push({ x: Math.cos(th) * r, y: Math.sin(th) * r });
  }
  // scale so the perimeter matches the lap length
  let per = 0;
  for (let i = 0; i < N; i++) per += Math.hypot(raw[(i + 1) % N].x - raw[i].x, raw[(i + 1) % N].y - raw[i].y);
  const sc = def.lapKm * PX_PER_KM / per;
  let pts = raw.map(p => ({ x: p.x * sc, y: p.y * sc }));
  if (def.dir === 'left') pts.reverse();
  pts = resampleClosed(pts);
  const minR = def.width / 2 + 70;
  const { maxK } = curvatureStats(pts, true);
  if (maxK > 1 / minR && attempt < 12) return circuitPoints(def, attempt + 1);
  return pts;
}

function resampleClosed(raw) {
  const N = raw.length;
  const cum = [0];
  for (let i = 0; i < N; i++) cum.push(cum[i] + Math.hypot(raw[(i + 1) % N].x - raw[i].x, raw[(i + 1) % N].y - raw[i].y));
  const per = cum[N];
  const n = Math.round(per / TRACK_DS);
  const ds = per / n;
  const out = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = i * ds;
    while (cum[j + 1] < s) j++;
    const t = (s - cum[j]) / (cum[j + 1] - cum[j] || 1);
    const a = raw[j], b = raw[(j + 1) % N];
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

function curvatureStats(pts, closed) {
  const n = pts.length;
  const get = i => closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))];
  const head = [];
  for (let i = 0; i < n; i++) {
    const a = get(i - 1), b = get(i + 1);
    head.push(Math.atan2(b.y - a.y, b.x - a.x));
  }
  const kappa = [];
  let maxK = 0;
  for (let i = 0; i < n; i++) {
    const i0 = closed ? (i - 2 + n) % n : Math.max(0, i - 2), i1 = closed ? (i + 2) % n : Math.min(n - 1, i + 2);
    const dist = Math.hypot(get(i + 2).x - get(i - 2).x, get(i + 2).y - get(i - 2).y) || 1;
    const k = angleDiff(head[i1], head[i0]) / dist;
    kappa.push(k);
    maxK = Math.max(maxK, Math.abs(k));
  }
  return { head, kappa, maxK };
}

const _trackCache = {};

function buildTrack(def) {
  if (_trackCache[def.id]) return _trackCache[def.id];
  const closed = def.shape === 'circuit';
  const hw = def.width / 2;

  // planned pit positions (sprint needs them before generating the road)
  let pitCentres = [];
  if (!closed) {
    const totalPx = def.lengthKm * PX_PER_KM;
    const spacing = def.fuelEveryKm * PX_PER_KM;
    for (let s = START_S + spacing; s < totalPx - 160 - PIT.total; s += spacing) pitCentres.push(s);
  }

  const pts = closed ? circuitPoints(def) : sprintPoints(def, pitCentres);
  const n = pts.length;
  const ds = closed
    ? pts.reduce((acc, p, i) => acc + Math.hypot(pts[(i + 1) % n].x - p.x, pts[(i + 1) % n].y - p.y), 0) / n
    : TRACK_DS;
  const length = closed ? n * ds : (n - 1) * ds;

  const { head, kappa } = curvatureStats(pts, closed);
  let rightTurn = 0, leftTurn = 0;
  for (const k of kappa) { if (k > 0) rightTurn += k; else leftTurn -= k; }

  const left = [], right = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const h = head[i];
    pts[i].h = h; pts[i].nx = -Math.sin(h); pts[i].ny = Math.cos(h);
    left.push({ x: pts[i].x - pts[i].nx * hw, y: pts[i].y - pts[i].ny * hw });
    right.push({ x: pts[i].x + pts[i].nx * hw, y: pts[i].y + pts[i].ny * hw });
    minX = Math.min(minX, pts[i].x); maxX = Math.max(maxX, pts[i].x);
    minY = Math.min(minY, pts[i].y); maxY = Math.max(maxY, pts[i].y);
  }

  const polyPath = (arr, close) => {
    const p = new Path2D();
    p.moveTo(arr[0].x, arr[0].y);
    for (let i = 1; i < arr.length; i++) p.lineTo(arr[i].x, arr[i].y);
    if (close) p.closePath();
    return p;
  };
  let road;
  if (closed) {
    road = polyPath(left, true);
    road.addPath(polyPath(right, true));
  } else {
    road = new Path2D();
    road.moveTo(left[0].x, left[0].y);
    for (const p of left) road.lineTo(p.x, p.y);
    for (let i = right.length - 1; i >= 0; i--) road.lineTo(right[i].x, right[i].y);
    road.closePath();
  }

  const startS = closed ? 0 : START_S;
  const finishS = closed ? 0 : length - 80;
  const lapLength = closed ? length : finishS - startS;
  const laps = closed ? def.laps : 1;

  const track = {
    def, closed, pts, n, ds, length, hw, left, right, road,
    center: polyPath(pts, closed), leftEdge: polyPath(left, closed), rightEdge: polyPath(right, closed),
    startS, finishS, lapLength, laps, raceLength: lapLength * laps,
    rightShare: rightTurn / ((rightTurn + leftTurn) || 1),
    bounds: { minX: minX - hw - 150, maxX: maxX + hw + 150, minY: minY - hw - 150, maxY: maxY + hw + 150 },
  };

  if (closed) {
    const perLap = def.fuelPerLap;
    for (let k = 0; k < perLap; k++) pitCentres.push(((k + 0.5) / perLap) * length);
  }
  track.pits = pitCentres.map((c, k) => placePit(track, kappa, c, k));
  _trackCache[def.id] = track;
  return track;
}

// Choose the exact spot and side for a pit lane near `centre`, so that the
// road never bends towards the pit side more tightly than the lane allows.
function placePit(track, kappa, centre, k) {
  const outer = track.hw + PIT.island + PIT.width + 40;
  let best = null;
  for (let c = centre - 320; c <= centre + 320; c += 40) {
    for (const side of [1, -1]) {
      let bad = 0;
      for (let s = c - PIT.total / 2; s <= c + PIT.total / 2; s += track.ds) {
        const i = wrapIndex(track, Math.round(s / track.ds));
        if (i < 0) { bad = Infinity; break; }
        bad = Math.max(bad, kappa[i] * side);
      }
      const score = bad + Math.abs(c - centre) * 1e-6 + (side === (k % 2 ? -1 : 1) ? 0 : 1e-7);
      if (!best || score < best.score) best = { score, c, side };
    }
  }
  const s0 = best.c - PIT.total / 2;
  const pit = { s0, s1: s0 + PIT.total, s: best.c, side: best.side, tight: best.score > 1 / outer };
  buildPitGeometry(track, pit);
  return pit;
}

function wrapIndex(track, i) {
  if (track.closed) return ((i % track.n) + track.n) % track.n;
  return i >= 0 && i < track.n ? i : -1;
}

// Lateral position of the pit lane centre, u = distance since the pit start.
// The squared easing keeps the lane joined to the road for most of each
// ramp, so the entry and exit are wide enough to hit at speed.
function pitCenterOffset(track, u) {
  const c0 = track.hw - PIT.width / 2;
  const cF = track.hw + PIT.island + PIT.width / 2;
  const ease = t => smoothstep(t) ** 2;
  if (u < PIT.ramp) return c0 + (cF - c0) * ease(u / PIT.ramp);
  if (u > PIT.ramp + PIT.straight) return c0 + (cF - c0) * ease((PIT.total - u) / PIT.ramp);
  return cF;
}

function buildPitGeometry(track, pit) {
  const inner = [], outer = [], islandEdge = [];
  const sg = pit.side;
  for (let u = 0; u <= PIT.total; u += 10) {
    const p = trackPointAt(track, pit.s0 + u);
    const c = pitCenterOffset(track, u);
    inner.push({ x: p.x + p.nx * sg * (c - PIT.width / 2), y: p.y + p.ny * sg * (c - PIT.width / 2), u });
    outer.push({ x: p.x + p.nx * sg * (c + PIT.width / 2), y: p.y + p.ny * sg * (c + PIT.width / 2) });
  }
  const band = new Path2D();
  band.moveTo(inner[0].x, inner[0].y);
  for (const p of inner) band.lineTo(p.x, p.y);
  for (let i = outer.length - 1; i >= 0; i--) band.lineTo(outer[i].x, outer[i].y);
  band.closePath();
  const outerLine = new Path2D();
  outer.forEach((p, i) => i ? outerLine.lineTo(p.x, p.y) : outerLine.moveTo(p.x, p.y));
  // island edge: only where the lane is separated from the road
  const innerLine = new Path2D();
  let drawing = false;
  for (const p of inner) {
    const c = pitCenterOffset(track, p.u);
    if (c - PIT.width / 2 > track.hw + 2) {
      if (!drawing) { innerLine.moveTo(p.x, p.y); drawing = true; } else innerLine.lineTo(p.x, p.y);
    } else drawing = false;
  }
  // refuel zone (the straight part)
  const zone = new Path2D();
  const zi = inner.filter(p => p.u >= PIT.ramp && p.u <= PIT.ramp + PIT.straight);
  const zo = outer.filter((_, i) => inner[i].u >= PIT.ramp && inner[i].u <= PIT.ramp + PIT.straight);
  zone.moveTo(zi[0].x, zi[0].y);
  for (const p of zi) zone.lineTo(p.x, p.y);
  for (let i = zo.length - 1; i >= 0; i--) zone.lineTo(zo[i].x, zo[i].y);
  zone.closePath();
  const mid = trackPointAt(track, pit.s);
  const off = (track.hw + PIT.island + PIT.width + 48) * sg;
  pit.geom = { band, outerLine, innerLine, zone, building: { x: mid.x + mid.nx * off, y: mid.y + mid.ny * off, h: mid.h } };
}

// u within the pit window, or null.
function pitU(track, pit, s) {
  let u = s - pit.s0;
  if (track.closed) u = ((u % track.length) + track.length) % track.length;
  return u >= 0 && u <= PIT.total ? u : null;
}

// Point on the centreline at arclength s, with its normal and heading.
function trackPointAt(track, s) {
  const n = track.n;
  let f = s / track.ds;
  if (track.closed) f = ((f % n) + n) % n;
  else f = Math.max(0, Math.min(n - 1.001, f));
  const i = Math.floor(f), t = f - i;
  const a = track.pts[i], b = track.pts[track.closed ? (i + 1) % n : i + 1];
  const h = Math.atan2(b.y - a.y, b.x - a.x);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, nx: -Math.sin(h), ny: Math.cos(h), h };
}

// Nearest centreline segment to (x, y), searching around the previous index.
// lateral > 0 means right of the centreline (along the normal).
function locateOnTrack(track, x, y, hint) {
  const pts = track.pts, n = track.n;
  let best = null;
  for (let o = -25; o <= 25; o++) {
    let i = hint + o;
    if (track.closed) i = ((i % n) + n) % n;
    else if (i < 0 || i > n - 2) continue;
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    let t = ((x - a.x) * dx + (y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + dx * t, py = a.y + dy * t;
    const d2 = (x - px) ** 2 + (y - py) ** 2;
    if (!best || d2 < best.d2) {
      const len = Math.sqrt(len2), nx = -dy / len, ny = dx / len;
      best = { d2, idx: i, s: (i + t) * track.ds, nx, ny, lateral: (x - a.x) * nx + (y - a.y) * ny };
    }
  }
  return best;
}

// ---------------------------------------------------------------------
// Descriptions and thumbnails
// ---------------------------------------------------------------------

function trackConditions(def) {
  const t = buildTrack(def);
  const cond = [TIMES[def.time].label, WEATHERS[def.weather].label, BIOMES[def.biome].label]
    .filter((v, i, a) => a.indexOf(v) === i).join(' · ');
  const pitKm = (t.closed ? t.length / t.pits.length : def.fuelEveryKm * PX_PER_KM) / PX_PER_KM;
  if (t.closed) {
    return `${def.laps} × ${def.lapKm} km circuit, ${def.dir}-handed · ${cond} · pit every ~${pitKm.toFixed(1)} km`;
  }
  const rs = Math.round(t.rightShare * 100);
  const bias = rs >= 55 ? `${rs}% right turns` : rs <= 45 ? `${100 - rs}% left turns` : 'balanced turns';
  return `${def.lengthKm} km sprint · ${cond} · pit every ~${pitKm.toFixed(1)} km · ${bias}`;
}

function trackThumbnail(def, w = 200, h = 70) {
  const t = buildTrack(def);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const bio = BIOMES[def.biome];
  ctx.fillStyle = bio.ground;
  ctx.fillRect(0, 0, w, h);
  const b = t.bounds;
  const sc = Math.min((w - 10) / (b.maxX - b.minX), (h - 10) / (b.maxY - b.minY));
  const ox = (w - (b.maxX - b.minX) * sc) / 2 - b.minX * sc;
  const oy = (h - (b.maxY - b.minY) * sc) / 2 - b.minY * sc;
  ctx.strokeStyle = bio.road;
  ctx.lineWidth = 3;
  ctx.beginPath();
  t.pts.forEach((p, i) => i ? ctx.lineTo(p.x * sc + ox, p.y * sc + oy) : ctx.moveTo(p.x * sc + ox, p.y * sc + oy));
  if (t.closed) ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = '#f5c518';
  for (const pit of t.pits) {
    const p = trackPointAt(t, pit.s);
    ctx.beginPath(); ctx.arc(p.x * sc + ox, p.y * sc + oy, 3, 0, Math.PI * 2); ctx.fill();
  }
  // darkness / weather tint
  const tm = TIMES[def.time];
  if (tm.dark) { ctx.fillStyle = `rgba(${tm.color},${tm.dark * 0.7})`; ctx.fillRect(0, 0, w, h); }
  if (def.weather === 'fog') { ctx.fillStyle = 'rgba(210,215,220,0.45)'; ctx.fillRect(0, 0, w, h); }
  if (def.weather === 'rain' || def.weather === 'snow') {
    ctx.strokeStyle = def.weather === 'rain' ? 'rgba(180,200,240,0.6)' : 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1;
    const r = mulberry32(def.seed);
    ctx.beginPath();
    for (let i = 0; i < 40; i++) {
      const x = r() * w, y = r() * h;
      ctx.moveTo(x, y); ctx.lineTo(x + (def.weather === 'rain' ? 2 : 1), y + (def.weather === 'rain' ? -6 : -1));
    }
    ctx.stroke();
  }
  return c;
}
