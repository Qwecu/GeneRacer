// Menus: garage (random / breed / inspect), race setup, time trial, records.

const state = {
  cars: [],
  traitInfo: [],
  records: {},
  breedPick: [],
  viewing: null,
  raceTrack: TRACKS[0].id,
  trialTrack: TRACKS[0].id,
  trialCar: null,
  randomDefs: { race: null, trial: null },
  tracks: { custom: [], hidden: [] },
  profiles: [],
  profileId: (() => { try { return localStorage.getItem('generacer-profile'); } catch (e) { return null; } })(),
  players: [{ profileId: null, carId: null }, { profileId: null, carId: null }],
};

async function api(path, body) {
  const opts = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  };
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function loadAll() {
  const g = await api('/api/garage');
  state.cars = g.cars;
  state.profiles = await api('/api/profiles');
  if (!profileById(state.profileId)) setProfile(state.profiles[0].id);
  // hotseat rows: default to different players, in order
  state.players.forEach((p, i) => {
    if (!profileById(p.profileId)) p.profileId = state.profiles[i % state.profiles.length].id;
  });
  state.traitInfo = g.trait_info;
  state.records = await api('/api/records');
  state.tracks = await api('/api/tracks');
  state.raceTrack = validSelection(state.raceTrack, 'race');
  state.trialTrack = validSelection(state.trialTrack, 'trial');
  state.breedPick = state.breedPick.filter(id => carById(id));
  if (state.viewing && !carById(state.viewing)) state.viewing = null;
  renderAll();
}

function carById(id) { return state.cars.find(c => c.id === id); }
function carsOf(profileId) { return state.cars.filter(c => c.owner === profileId); }
function raceableCarsOf(profileId) { return carsOf(profileId).filter(c => !c.retired); }
function profileById(id) { return state.profiles.find(p => p.id === id); }
function me() { return profileById(state.profileId); }

function setProfile(id) {
  state.profileId = id;
  try { localStorage.setItem('generacer-profile', id); } catch (e) { /* storage blocked */ }
}

function renderAll() {
  renderProfileBar();
  renderGarage();
  renderRaceSetup();
  renderTrialSetup();
  renderRecords();
}

// =====================================================================
// Tabs
// =====================================================================

function showTab(name) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
}
document.querySelectorAll('nav button').forEach(btn => {
  btn.onclick = () => { showTab(btn.dataset.tab); history.replaceState(null, '', '#' + btn.dataset.tab); };
});
if (document.getElementById('tab-' + location.hash.slice(1))) showTab(location.hash.slice(1));

// =====================================================================
// Player profiles
// =====================================================================

function renderProfileBar() {
  const sel = document.getElementById('profile-select');
  sel.innerHTML = state.profiles.map(p =>
    `<option value="${p.id}" ${p.id === state.profileId ? 'selected' : ''}>${esc(p.name)} (${p.cars} cars)</option>`).join('');
  document.getElementById('profile-swatch').style.background = me()?.color || '#888';
  document.getElementById('btn-profile-delete').disabled = state.profiles.length <= 1;
}

function resetPlayerView() {
  state.breedPick = [];
  state.viewing = null;
  state.trialCar = null;
}

document.getElementById('profile-select').onchange = (ev) => {
  setProfile(ev.target.value);
  resetPlayerView();
  renderAll();
};

document.getElementById('btn-profile-new').onclick = async () => {
  const name = prompt('Name of the new player:');
  if (!name || !name.trim()) return;
  try {
    const p = await api('/api/profiles/create', { name });
    setProfile(p.id);
    resetPlayerView();
    await loadAll();
  } catch (e) { alert(e.message); }
};

document.getElementById('btn-profile-rename').onclick = async () => {
  const name = prompt('New name:', me().name);
  if (!name || !name.trim()) return;
  try { await api('/api/profiles/rename', { id: state.profileId, name }); await loadAll(); } catch (e) { alert(e.message); }
};

document.getElementById('btn-profile-delete').onclick = async () => {
  const p = me();
  if (!confirm(`Delete player ${p.name} and all ${p.cars} of their cars? This cannot be undone.`)) return;
  try {
    await api('/api/profiles/delete', { id: p.id });
    state.profileId = null;
    resetPlayerView();
    await loadAll();
  } catch (e) { alert(e.message); }
};

// =====================================================================
// Garage
// =====================================================================

function renderGarage() {
  const grid = document.getElementById('car-grid');
  grid.innerHTML = '';
  document.getElementById('garage-title').textContent = `${me().name}'s garage`;
  const sorted = [...carsOf(state.profileId)].sort((a, b) => (a.retired - b.retired) || (b.generation - a.generation));
  for (const car of sorted) {
    const card = document.createElement('div');
    card.className = 'car-card' +
      (state.breedPick.includes(car.id) ? ' selected' : '') +
      (state.viewing === car.id ? ' viewing' : '') +
      (car.retired ? ' retired' : '');
    const pick = document.createElement('input');
    pick.type = 'checkbox'; pick.className = 'pick';
    pick.checked = state.breedPick.includes(car.id);
    pick.title = 'Select for breeding';
    pick.onclick = (ev) => { ev.stopPropagation(); toggleBreedPick(car.id); };
    card.appendChild(pick);
    card.appendChild(carThumbnail(car.looks));
    card.insertAdjacentHTML('beforeend', `<div class="card-trophies">${trophyBadges(car)}</div>`);
    const lifeLeft = Math.max(0, 1 - car.odometer_km / car.stats.lifespan_km);
    card.insertAdjacentHTML('beforeend', `
      <div class="name">${esc(car.name)}</div>
      <div class="meta">Gen ${car.generation} &middot; ${car.stats.power} kW &middot; ${car.stats.max_speed} km/h
        ${car.retired ? '<span class="badge retired">retired</span>' : ''}</div>
      <div class="meta">${car.odometer_km.toFixed(1)} / ${car.stats.lifespan_km} km</div>
      <div class="life-bar"><div style="width:${lifeLeft * 100}%"></div></div>`);
    card.onclick = () => { state.viewing = car.id; renderGarage(); };
    grid.appendChild(card);
  }
  const btn = document.getElementById('btn-breed');
  btn.textContent = `Breed selected (${state.breedPick.length}/2)`;
  btn.disabled = state.breedPick.length !== 2;
  renderDetail();
}

function toggleBreedPick(id) {
  const i = state.breedPick.indexOf(id);
  if (i >= 0) state.breedPick.splice(i, 1);
  else {
    state.breedPick.push(id);
    if (state.breedPick.length > 2) state.breedPick.shift();
  }
  renderGarage();
}

function statBar(info, value) {
  const f = Math.max(0, Math.min(1, (value - info.lo) / (info.hi - info.lo)));
  const goodness = info.higher_better ? f : 1 - f;
  const hue = info.higher_better === null ? 210 : Math.round(goodness * 120);
  return `<div class="stat-row"><span>${info.label}</span>
    <div class="stat-bar"><div style="width:${Math.max(3, f * 100)}%;background:hsl(${hue},55%,50%)"></div></div>
    <span class="stat-val">${value} ${info.unit}</span></div>`;
}

function renderDetail() {
  const el = document.getElementById('car-detail');
  const car = carById(state.viewing);
  if (!car) {
    el.className = 'car-detail empty';
    el.textContent = 'Select a car to see its stats and genes.';
    return;
  }
  el.className = 'car-detail';
  const parents = car.parents.length ? `Child of ${esc(car.parents[0])} &times; ${esc(car.parents[1])}` : 'Randomly generated';
  const geneRows = car.genotype.map(g => {
    const w1 = g.mode === 'dominant' ? g.a1[0] >= g.a2[0] : g.mode === 'high' ? g.a1[1] >= g.a2[1] : g.mode === 'low' ? g.a1[1] <= g.a2[1] : null;
    const cls1 = w1 === true ? 'win' : '', cls2 = w1 === false ? 'win' : '';
    return `<tr title="${esc(g.desc)}"><td>${g.index}</td><td>${esc(g.name)}<div class="mode">${g.mode}</div></td>
      <td class="num ${cls1}">${g.a1[1]}<span class="mode"> d${g.a1[0]}</span></td>
      <td class="num ${cls2}">${g.a2[1]}<span class="mode"> d${g.a2[0]}</span></td>
      <td class="num">${g.expressed}</td></tr>`;
  }).join('');
  el.innerHTML = `
    <h2><span id="detail-name">${esc(car.name)}</span>
      <button class="small" id="btn-rename">Rename</button>
      <button class="small" id="btn-delete">Delete</button></h2>
    <div class="hint">Generation ${car.generation} &middot; ${parents}<br>
      ${car.races} runs &middot; odometer ${car.odometer_km.toFixed(2)} of ${car.stats.lifespan_km} km
      ${car.retired ? '&middot; <b>retired</b>' : ''}</div>
    <div id="detail-thumb"></div>
    ${trophyListHTML(car)}
    <div class="toolbar sound-row">
      <button class="small" id="btn-hear-engine">Hear engine</button>
      <button class="small" id="btn-hear-gulp">Hear refuelling</button>
      <span class="hint">${car.sound.cylinders} cylinders &middot; ${car.sound.timbre < 0.33 ? 'soft' : car.sound.timbre < 0.66 ? 'buzzy' : 'harsh'} engine</span>
    </div>
    ${state.traitInfo.map(info => statBar(info, car.stats[info.key])).join('')}
    <h3>Genotype</h3>
    <div class="hint">Two alleles per gene: value and dominance (d). Highlighted = expressed allele. "avg" genes blend both.</div>
    <table class="genes"><tr><th>#</th><th>Gene</th><th>Allele 1</th><th>Allele 2</th><th>Shown</th></tr>${geneRows}</table>`;
  el.querySelector('#detail-thumb').appendChild(carThumbnail(car.looks, 300, 170, 3.6));
  el.querySelector('#btn-hear-engine').onclick = () => previewEngine(car.sound);
  el.querySelector('#btn-hear-gulp').onclick = () => previewGulp(car.sound);
  el.querySelector('#btn-rename').onclick = async () => {
    const name = prompt('New name', car.name);
    if (name) { await api('/api/rename', { id: car.id, name }); loadAll(); }
  };
  el.querySelector('#btn-delete').onclick = async () => {
    if (confirm(`Scrap ${car.name}? This cannot be undone.`)) {
      await api('/api/delete', { id: car.id });
      loadAll();
    }
  };
}

document.getElementById('btn-random').onclick = async () => {
  const car = await api('/api/random', { owner: state.profileId });
  state.viewing = car.id;
  loadAll();
};

document.getElementById('btn-breed').onclick = async () => {
  if (state.breedPick.length !== 2) return;
  try {
    const child = await api('/api/breed', { a: state.breedPick[0], b: state.breedPick[1], owner: state.profileId });
    state.viewing = child.id;
    loadAll();
  } catch (e) { alert(e.message); }
};

// =====================================================================
// Track pickers: built-in tracks, saved custom (seed) tracks, and one
// unsaved random track per setup screen
// =====================================================================

function newRandomSeed() { return 1 + Math.floor(Math.random() * 999999); }
function rollRandomDef() { const d = randomTrackDef(newRandomSeed()); d.unsaved = true; return d; }
state.randomDefs.race = rollRandomDef();
state.randomDefs.trial = rollRandomDef();

function visibleTracks() {
  return [...TRACKS.filter(t => !state.tracks.hidden.includes(t.id)), ...state.tracks.custom];
}

function findDef(id) {
  return visibleTracks().find(t => t.id === id) ||
    [state.randomDefs.race, state.randomDefs.trial].find(d => d && d.id === id) ||
    visibleTracks()[0] || state.randomDefs.race;
}

// Keep the selection valid after tracks are deleted.
function validSelection(id, which) {
  const all = [...visibleTracks(), state.randomDefs[which]];
  return all.some(t => t.id === id) ? id : all[0].id;
}

async function saveTrack(def) {
  const clean = { ...def };
  delete clean.unsaved;
  await api('/api/tracks/save', { track: clean });
}

function trackToolsHTML() {
  const opt = (pairs) => pairs.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  return `<div class="track-tools">
    <input class="tt-seed" placeholder="Seed: any number or word" maxlength="40">
    <input class="tt-name" placeholder="Name (optional)" maxlength="40">
    <select class="tt-shape">${opt([['', 'Shape from seed'], ['sprint', 'Sprint'], ['circuit', 'Circuit']])}</select>
    <select class="tt-time">${opt([['', 'Time from seed'], ['day', 'Day'], ['dusk', 'Dusk'], ['night', 'Night']])}</select>
    <select class="tt-weather">${opt([['', 'Weather from seed'], ['dry', 'Dry'], ['rain', 'Rain'], ['fog', 'Fog'], ['snow', 'Snow']])}</select>
    <button class="primary small tt-create">Create and save track</button>
  </div>`;
}

function renderTrackList(containerId, which, selectedId, onPick) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';

  // custom track form
  const tools = document.createElement('div');
  tools.innerHTML = trackToolsHTML();
  el.appendChild(tools);
  tools.querySelector('.tt-create').onclick = async () => {
    const seedText = tools.querySelector('.tt-seed').value.trim();
    if (!seedText) return alert('Type a seed first: any number or word.');
    const def = randomTrackDef(seedFromText(seedText), {
      seedText,
      name: tools.querySelector('.tt-name').value,
      shape: tools.querySelector('.tt-shape').value || undefined,
      time: tools.querySelector('.tt-time').value || undefined,
      weather: tools.querySelector('.tt-weather').value || undefined,
    });
    await saveTrack(def);
    await loadAll();
    onPick(def.id);
  };

  const list = document.createElement('div');
  list.className = 'track-list';
  el.appendChild(list);

  for (const def of [...visibleTracks(), state.randomDefs[which]]) {
    const card = document.createElement('div');
    card.className = 'track-card' + (def.id === selectedId ? ' selected' : '') + (def.unsaved ? ' random' : '');
    const rec = hallOf(def)[0];
    const label = def.unsaved ? 'Random: ' : '';
    const seedLine = def.custom ? `<div class="tmeta">Seed: <code>${esc(def.seedText || def.seed)}</code></div>` : '';
    card.innerHTML = `<div class="tname">${label}${esc(def.name)}</div>
      <div class="tmeta">${trackConditions(def)}</div>${seedLine}
      <div class="tmeta holder">${rec ? `<span class="crown">#1</span> ${holderHTML(rec)} &middot; ${recordText(rec)}` : 'No number 1 yet'}</div>`;
    card.appendChild(trackThumbnail(def));
    const buttons = document.createElement('div');
    buttons.className = 'track-buttons';
    const button = (text, fn, cls = 'small') => {
      const b = document.createElement('button');
      b.className = cls; b.textContent = text;
      b.onclick = (ev) => { ev.stopPropagation(); fn(); };
      buttons.appendChild(b);
    };
    if (def.unsaved) {
      button('New random track', () => { state.randomDefs[which] = rollRandomDef(); onPick(state.randomDefs[which].id); });
      button('Save track', async () => {
        await saveTrack(def);
        state.randomDefs[which] = rollRandomDef();
        await loadAll();
        onPick(def.id);
      });
    } else if (def.custom) {
      button('Delete', async () => {
        if (!confirm(`Delete "${def.name}" and its record?`)) return;
        await api('/api/tracks/delete', { id: def.id, builtin: false });
        loadAll();
      });
    } else {
      button('Delete', async () => {
        if (!confirm(`Remove the built-in track "${def.name}"? You can restore built-in tracks later.`)) return;
        await api('/api/tracks/delete', { id: def.id, builtin: true });
        loadAll();
      });
    }
    card.appendChild(buttons);
    card.onclick = () => onPick(def.id);
    list.appendChild(card);
  }

  if (state.tracks.hidden.length) {
    const restore = document.createElement('button');
    restore.className = 'small restore-tracks';
    restore.textContent = `Restore ${state.tracks.hidden.length} removed built-in track${state.tracks.hidden.length > 1 ? 's' : ''}`;
    restore.onclick = async () => { await api('/api/tracks/restore', {}); loadAll(); };
    el.appendChild(restore);
  }
}

// =====================================================================
// Car picker: a dropdown that shows each car's icon next to its name
// =====================================================================

function carLabelHTML(car) {
  return `<img class="car-icon" src="${carIconURL(car.looks)}" alt="">
    <span class="cp-text"><span><b>${esc(car.name)}</b> ${trophyBadges(car)}</span>
    <span class="cp-meta">gen ${car.generation} &middot; ${car.stats.power} kW &middot; ${car.stats.max_speed} km/h &middot;
      ${Math.max(0, car.stats.lifespan_km - car.odometer_km).toFixed(1)} km left</span></span>`;
}

function carPicker(selectedId, onChange, cars) {
  const wrap = document.createElement('div');
  wrap.className = 'car-picker';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'car-picker-btn';
  const car = carById(selectedId);
  btn.innerHTML = car ? carLabelHTML(car) + '<span class="cp-caret">&#9662;</span>' : 'No raceable cars: breed or generate one in the garage';
  const list = document.createElement('div');
  list.className = 'car-picker-list hidden';
  for (const c of cars) {
    const item = document.createElement('div');
    item.className = 'car-picker-item' + (c.id === selectedId ? ' current' : '');
    item.innerHTML = carLabelHTML(c);
    item.onclick = (ev) => { ev.stopPropagation(); list.classList.add('hidden'); onChange(c.id); };
    list.appendChild(item);
  }
  btn.onclick = (ev) => {
    ev.stopPropagation();
    document.querySelectorAll('.car-picker-list').forEach(l => { if (l !== list) l.classList.add('hidden'); });
    list.classList.toggle('hidden');
  };
  wrap.append(btn, list);
  return wrap;
}

document.addEventListener('click', () => document.querySelectorAll('.car-picker-list').forEach(l => l.classList.add('hidden')));

// =====================================================================
// Hotseat race setup
// =====================================================================

function renderRaceSetup() {
  renderTrackList('race-tracks', 'race', state.raceTrack, id => { state.raceTrack = id; renderRaceSetup(); });
  const list = document.getElementById('player-list');
  list.innerHTML = '';
  state.players.forEach((p, i) => {
    const prof = profileById(p.profileId);
    const cars = raceableCarsOf(p.profileId);
    const car = carById(p.carId);
    if (!car || car.retired || car.owner !== p.profileId) {
      // default: this player's first car not already taken by an earlier row
      const taken = state.players.slice(0, i).map(q => q.carId);
      p.carId = (cars.find(c => !taken.includes(c.id)) || cars[0])?.id || null;
    }
    const row = document.createElement('div');
    row.className = 'player-row';
    row.innerHTML = `<span class="swatch" style="background:${prof.color}"></span>
      <select class="player-select">${state.profiles.map(q =>
        `<option value="${q.id}" ${q.id === p.profileId ? 'selected' : ''}>${esc(q.name)}</option>`).join('')}</select>`;
    row.querySelector('select').onchange = (ev) => { p.profileId = ev.target.value; p.carId = null; renderRaceSetup(); };
    row.appendChild(carPicker(p.carId, id => { p.carId = id; renderRaceSetup(); }, cars));
    if (state.players.length > 1) {
      const rm = document.createElement('button');
      rm.className = 'small'; rm.textContent = 'Remove';
      rm.onclick = () => { state.players.splice(i, 1); renderRaceSetup(); };
      row.appendChild(rm);
    }
    list.appendChild(row);
  });
  document.getElementById('btn-add-player').disabled = state.players.length >= PLAYER_COLORS.length;
}

document.getElementById('btn-add-player').onclick = () => {
  const used = state.players.map(p => p.profileId);
  const next = state.profiles.find(p => !used.includes(p.id)) || state.profiles[0];
  state.players.push({ profileId: next.id, carId: null });
  renderRaceSetup();
};

document.getElementById('btn-start-race').onclick = () => {
  const entries = state.players.map(p => {
    const prof = profileById(p.profileId);
    return { driver: prof.name, color: prof.color, car: carById(p.carId) };
  });
  const missing = entries.find(e => !e.car);
  if (missing) return alert(`${missing.driver} has no car that can race. Generate or breed one in their garage.`);
  const def = findDef(state.raceTrack);
  new RaceSession({ trackDef: def, entries, mode: 'hotseat', recordGhost: null, onExit: afterRace }).start();
};

// =====================================================================
// Time trial
// =====================================================================

function renderTrialSetup() {
  renderTrackList('trial-tracks', 'trial', state.trialTrack, id => { state.trialTrack = id; renderTrialSetup(); });
  const cars = raceableCarsOf(state.profileId);
  const cur = carById(state.trialCar);
  if (!cur || cur.retired || cur.owner !== state.profileId) state.trialCar = cars[0]?.id || null;
  const drv = document.getElementById('trial-driver');
  drv.textContent = me().name;
  drv.style.borderLeftColor = me().color;
  const el = document.getElementById('trial-car');
  el.innerHTML = '';
  el.appendChild(carPicker(state.trialCar, id => { state.trialCar = id; renderTrialSetup(); }, cars));
}

document.getElementById('btn-start-trial').onclick = async () => {
  const car = carById(state.trialCar);
  if (!car || car.retired) return alert('Pick a car that is not retired.');
  const def = findDef(state.trialTrack);
  const key = recordKey(def);
  const hall = await api('/api/hall/' + encodeURIComponent(key));
  const record = hall[0] ? { ...hall[0], driver: holderName(hall[0]) } : null;
  const player = me();
  new RaceSession({
    trackDef: def, entries: [{ driver: player.name, car, color: player.color }], mode: 'trial', recordGhost: record,
    trialGhosts: pickGhosts(hall, player, car),
    onRunFinished: async (r) => {
      const res = await api('/api/record', {
        track: key,
        record: {
          finished: r.finished, time: r.time, distance: r.distance,
          driver: player.name, profile_id: player.id, car_name: car.name, car_id: car.id,
          looks: car.looks, ghost: r.ghost,
        },
      });
      if (res.rank === 1) return '<p class="big"><b>New number 1 on this track!</b></p>';
      if (res.rank) return `<p class="big"><b>Hall of fame: place ${res.rank}</b></p>`;
      if (res.best_rank) return `<p>Not better than ${esc(car.name)}'s earlier run, which stays at place ${res.best_rank}.</p>`;
      return '<p>Not in the top ten this time.</p>';
    },
    onExit: afterRace,
  }).start();
};

// Which hall of fame ghosts drive along, from the "Ghosts" choice.
// "My best" is this player's entry with the car they are driving now.
function pickGhosts(hall, player, car) {
  const mode = state.ghostMode;
  const mineIdx = hall.findIndex(e => e.profile_id === player.id && e.car_id === car.id);
  let idx = [];
  if (mode === 'first') idx = [0];
  else if (mode === 'top10') idx = hall.map((_, i) => i);
  else if (mode === 'top3') idx = [0, 1, 2];
  if ((mode === 'top3' || mode === 'mine') && mineIdx >= 0 && !idx.includes(mineIdx)) idx.push(mineIdx);
  return idx.filter(i => i < hall.length && hall[i].ghost).map(i => {
    const e = hall[i];
    const p = profileById(e.profile_id);
    return {
      g: e.ghost, looks: e.looks,
      label: i === mineIdx ? `your best (#${i + 1})` : `#${i + 1} ${holderName(e)}`,
      color: p ? p.color : '#cccccc',
    };
  });
}

const ghostSelect = document.getElementById('ghost-mode');
state.ghostMode = (() => { try { return localStorage.getItem('generacer-ghosts') || 'top3'; } catch (e) { return 'top3'; } })();
ghostSelect.value = state.ghostMode;
ghostSelect.onchange = () => {
  state.ghostMode = ghostSelect.value;
  try { localStorage.setItem('generacer-ghosts', state.ghostMode); } catch (e) { /* storage blocked */ }
};

// Odometers advance by the distance each car actually drove.
async function afterRace(results) {
  const entries = results.map(r => ({ id: r.car.id, km: r.km }));
  if (entries.length) await api('/api/drive', { entries });
  await loadAll();
}

// =====================================================================
// Hall of fame (shared by all players)
// =====================================================================

function hallOf(def) { return state.records[recordKey(def)] || []; }

// =====================================================================
// Trophies: a car holds gold / silver / bronze for every visible track
// where it is currently 1st / 2nd / 3rd in the hall of fame.
// =====================================================================

const MEDALS = [['gold', 'Gold'], ['silver', 'Silver'], ['bronze', 'Bronze']];

function trophiesOf(car) {
  const t = { gold: [], silver: [], bronze: [] };
  for (const def of visibleTracks()) {
    hallOf(def).slice(0, 3).forEach((e, i) => {
      if (e.car_id === car.id) t[MEDALS[i][0]].push(def.name);
    });
  }
  return t;
}

function trophyBadges(car) {
  const t = trophiesOf(car);
  return MEDALS.filter(([k]) => t[k].length).map(([k, label]) =>
    `<span class="medal ${k}" title="${label}: ${esc(t[k].join(', '))}">${t[k].length}</span>`).join('');
}

function trophyListHTML(car) {
  const t = trophiesOf(car);
  const rows = MEDALS.flatMap(([k, label]) => t[k].map(name =>
    `<div class="trophy-row"><span class="medal ${k}">${label[0]}</span> ${label} on ${esc(name)}</div>`));
  return rows.length ? `<div class="trophy-list">${rows.join('')}</div>` : '';
}

// Entries remember the player's id, so renamed players show their new name;
// runs by deleted players keep the name they had.
function holderName(e) { return profileById(e.profile_id)?.name || e.driver; }
function holderHTML(e) {
  const p = profileById(e.profile_id);
  return `<span class="swatch small" style="background:${p ? p.color : '#bbb'}"></span><b>${esc(holderName(e))}</b>`;
}

function renderRecords() {
  const blocks = visibleTracks().map(def => {
    const hall = hallOf(def);
    const rows = hall.map((e, i) => `
      <tr class="${e.profile_id === state.profileId ? 'mine' : ''}">
        <td class="rank">${i === 0 ? '<span class="crown">#1</span>' : i + 1}</td>
        <td>${holderHTML(e)}</td>
        <td>${e.looks && e.looks.width ? `<img class="car-icon" src="${carIconURL(e.looks)}"> ` : ''}${esc(e.car_name)}</td>
        <td>${recordText(e)}</td>
        <td class="hint">${new Date(e.date * 1000).toLocaleDateString()}</td></tr>`).join('');
    return `<div class="hall-track">
      <h3>${esc(def.name)}</h3><div class="hint">${trackConditions(def)}</div>
      ${hall.length ? `<table class="records">${rows}</table>` : '<p class="hint">No runs yet.</p>'}
    </div>`;
  }).join('');
  document.getElementById('records-table').innerHTML = `<div class="hall">${blocks}</div>`;
}

loadAll();
