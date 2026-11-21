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
  session: null,      // {admin, profile_id, name} of the logged-in account
  joined: {},         // profile id -> session token of players who joined a hotseat race
  hallOpen: new Set(),  // record keys whose full 100-place list is shown
};

function storedToken() { try { return localStorage.getItem('generacer-session') || ''; } catch (e) { return ''; } }
function storeToken(t) { try { t ? localStorage.setItem('generacer-session', t) : localStorage.removeItem('generacer-session'); } catch (e) { /* storage blocked */ } }

async function api(path, body) {
  const opts = { headers: { 'X-Session': storedToken() } };
  if (body !== undefined) {
    opts.method = 'POST';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json();
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// =====================================================================
// Login and registration
// =====================================================================

// Flashes the logo twice over the whole screen (login page, race start).
function flashLogo() {
  const el = document.getElementById('logo-flash');
  if (!el) return;
  el.classList.remove('flashing');
  void el.offsetWidth;   // restart the animation
  el.classList.add('flashing');
  el.onanimationend = () => el.classList.remove('flashing');
}

function showLogin() {
  storeToken('');
  state.session = null;
  state.joined = {};
  document.body.classList.add('logged-out');
  document.body.classList.remove('is-admin');
  document.getElementById('login-screen').classList.remove('hidden');
  flashLogo();
}

async function startSession() {
  const me = await api('/api/me');
  if (!me) return showLogin();
  state.session = me;
  document.body.classList.remove('logged-out');
  document.body.classList.toggle('is-admin', me.admin);
  document.getElementById('login-screen').classList.add('hidden');
  if (!me.admin) setProfile(me.profile_id);
  if (!me.admin && document.getElementById('tab-race').classList.contains('active')) showTab('garage');   // hotseat is admin only
  state.players = [{ profileId: null, carId: null }, { profileId: null, carId: null }];
  resetPlayerView();
  if (!me.admin) showTaunts(true);     // unread taunts pop up at once, whatever else is loading
  await loadAll();
}

function bindAuthForm(id, path) {
  const form = document.getElementById(id);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const err = form.querySelector('.form-error');
    err.textContent = '';
    const name = form.elements.name.value, password = form.elements.password.value;
    if (name === '' || password === '') { err.textContent = 'Type a username and a password.'; return; }
    try {
      const res = await api(path, { name, password });
      storeToken(res.token);
      form.reset();
      await startSession();
    } catch (e) { err.textContent = e.message; }
  };
}
bindAuthForm('login-form', '/api/login');
bindAuthForm('register-form', '/api/register');

document.getElementById('btn-logout').onclick = async () => {
  try { await api('/api/logout', { tokens: Object.values(state.joined) }); } catch (e) { /* already logged out */ }
  showLogin();
};

// A small modal form.  fields: [{name, label, type}]; resolves to {name: value} or null.
function askForm(title, fields) {
  const dlg = document.getElementById('form-dialog');
  dlg.querySelector('.fd-title').textContent = title;
  const box = dlg.querySelector('.fd-fields');
  box.innerHTML = '';
  for (const f of fields) {
    const label = document.createElement('label');
    label.textContent = f.label + ' ';
    const input = document.createElement('input');
    input.name = f.name; input.type = f.type || 'text'; input.value = f.value || '';
    input.autocomplete = f.type === 'password' ? 'new-password' : 'off';
    label.appendChild(input);
    box.appendChild(label);
  }
  const err = dlg.querySelector('.form-error');
  err.textContent = '';
  return new Promise(resolve => {
    const form = dlg.querySelector('form');
    form.onsubmit = (ev) => {
      if (ev.submitter && ev.submitter.value === 'cancel') return;
      const values = Object.fromEntries(fields.map(f => [f.name, form.elements[f.name].value]));
      if (fields.some(f => values[f.name] === '')) { ev.preventDefault(); err.textContent = 'Fields cannot be empty.'; }
      else form.dataset.values = JSON.stringify(values);
    };
    form.dataset.values = '';
    dlg.returnValue = '';
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' && form.dataset.values ? JSON.parse(form.dataset.values) : null);
    dlg.showModal();
  });
}

// =====================================================================
// Taunts: a player who is ahead of another on a track's hall of fame can
// leave them a message, which they read when they log in.
// =====================================================================

// Opens the taunt box.  unreadOnly: the login popup, which stays closed when
// there is nothing new.  The Taunts button lists everything received.
async function showTaunts(unreadOnly) {
  let taunts;
  try { taunts = await api('/api/taunts'); } catch (e) { return; }
  const fresh = taunts.filter(t => !t.read);
  const list = unreadOnly ? fresh : taunts;
  if (unreadOnly && !fresh.length) return;
  document.getElementById('taunt-title').textContent =
    'Taunts you have received';
  document.getElementById('taunt-list').innerHTML = list.length ? list.map(t => `
    <div class="taunt ${t.read ? '' : 'new'}">
      <div class="taunt-text">&ldquo;${esc(t.text)}&rdquo;</div>
      <div class="hint">${esc(t.from_name)} on ${esc(t.track_name)}, ${new Date(t.date * 1000).toLocaleString()}</div>
    </div>`).join('') : '<p class="hint">Nobody has taunted you yet.</p>';
  const dlg = document.getElementById('taunt-dialog');
  dlg.onclose = () => { if (fresh.length) api('/api/taunts/read', {}).catch(() => {}); };
  document.getElementById('taunt-close').onclick = () => dlg.close();
  if (!dlg.open) dlg.showModal();
}
document.getElementById('btn-taunts').onclick = () => showTaunts(false);

// =====================================================================
// Loading
// =====================================================================

async function loadAll() {
  const g = await api('/api/garage');
  state.cars = g.cars;
  state.maxCars = g.max_cars;
  state.profiles = await api('/api/profiles');
  if (!profileById(state.profileId)) setProfile(state.profiles[0]?.id || null);
  // hotseat rows: the first is the current player, the others different players in order
  state.players.forEach((p, i) => {
    if (profileById(p.profileId)) return;
    const used = state.players.map(q => q.profileId);
    p.profileId = i === 0 ? state.profileId
      : (state.profiles.find(q => !used.includes(q.id)) || state.profiles[0])?.id || null;
  });
  state.traitInfo = g.trait_info;
  state.records = await api('/api/records');
  state.tracks = await api('/api/tracks');
  state.news = await api('/api/news');
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

// Players this browser may drive for: yourself, players who joined with
// their password, and everyone for the admin.
function unlocked(profileId) {
  return state.session.admin || profileId === state.session.profile_id || !!state.joined[profileId];
}

function renderAll() {
  renderProfileBar();
  const noPlayer = !me();
  document.getElementById('no-player').classList.toggle('hidden', !noPlayer);
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('blocked', noPlayer));
  if (noPlayer) return;
  computePoints();
  renderGarage();
  renderRaceSetup();
  renderTrialSetup();
  renderRecords();
  renderNews();
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
  const admin = state.session.admin;
  const sel = document.getElementById('profile-select');
  sel.innerHTML = state.profiles.map(p =>
    `<option value="${p.id}" ${p.id === state.profileId ? 'selected' : ''}>${esc(p.name)} (${p.cars} cars${p.has_password ? '' : ', no password'})</option>`).join('');
  document.getElementById('profile-label').textContent = admin ? 'Admin, acting as' : me()?.name || '';
  document.getElementById('profile-swatch').style.background = me()?.color || '#888';
  for (const id of ['btn-profile-rename', 'btn-profile-password', 'btn-profile-delete']) {
    document.getElementById(id).disabled = !me();
  }
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
  const v = await askForm('New player', [{ name: 'name', label: 'Username' }, { name: 'password', label: 'Password', type: 'password' }]);
  if (!v) return;
  try {
    const p = await api('/api/profiles/create', v);
    setProfile(p.id);
    resetPlayerView();
    await loadAll();
  } catch (e) { alert(e.message); }
};

document.getElementById('btn-profile-rename').onclick = async () => {
  const v = await askForm(`Rename ${me().name}`, [{ name: 'name', label: 'New username', value: me().name }]);
  if (!v) return;
  try { await api('/api/profiles/rename', { id: state.profileId, name: v.name }); await loadAll(); } catch (e) { alert(e.message); }
};

document.getElementById('btn-profile-password').onclick = async () => {
  const v = await askForm(`New password for ${me().name}`, [{ name: 'password', label: 'Password', type: 'password' }]);
  if (!v) return;
  try { await api('/api/profiles/password', { id: state.profileId, password: v.password }); await loadAll(); alert('Password changed.'); }
  catch (e) { alert(e.message); }
};

document.getElementById('btn-admin-password').onclick = async () => {
  const v = await askForm('New admin password', [{ name: 'password', label: 'Password', type: 'password' }]);
  if (!v) return;
  try { await api('/api/admin/password', { password: v.password }); alert('Admin password changed.'); } catch (e) { alert(e.message); }
};

document.getElementById('btn-profile-delete').onclick = async () => {
  const p = me();
  const whose = state.session.admin ? `player ${p.name}` : 'your account';
  if (!confirm(`Delete ${whose} and all ${p.cars} cars? This cannot be undone.`)) return;
  try {
    await api('/api/profiles/delete', { id: p.id });
    if (!state.session.admin) return showLogin();
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
  const own = carsOf(state.profileId);
  const drivable = own.filter(c => !c.retired).length;     // retired cars do not count towards the limit
  const full = drivable >= state.maxCars;
  document.getElementById('garage-title').innerHTML =
    `${esc(me().name)}'s garage <span class="car-count${full ? ' full' : ''}">${drivable} / ${state.maxCars} drivable cars` +
    `${own.length > drivable ? ` + ${own.length - drivable} retired` : ''}</span>`;
  document.getElementById('btn-random').disabled = full;
  const hint = document.getElementById('garage-hint');
  hint.textContent = full
    ? `The garage is full. Delete drivable cars, or drive them until they retire, to make room.`
    : 'Tick two cars to breed them. Retired cars can still breed, but cannot race.';
  hint.classList.toggle('warn', full);
  const retired = own.filter(c => c.retired);
  const delRetired = document.getElementById('btn-delete-retired');
  delRetired.textContent = `Delete retired cars (${retired.length})`;
  delRetired.disabled = !retired.length;
  delRetired.onclick = async () => {
    if (!confirm(`Delete all ${retired.length} retired cars: ${retired.map(c => c.name).join(', ')}? This cannot be undone.`)) return;
    try { await api('/api/delete', { ids: retired.map(c => c.id) }); await loadAll(); } catch (e) { alert(e.message); }
  };
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
    const thumb = document.createElement('div');
    thumb.className = 'icon-wrap';
    thumb.appendChild(carThumbnail(car.looks));
    thumb.insertAdjacentHTML('beforeend', starHTML(car));
    card.appendChild(thumb);
    card.insertAdjacentHTML('beforeend', `<div class="card-trophies">${trophyBadges(car)}</div>`);
    const lifeLeft = Math.max(0, 1 - car.odometer_km / car.stats.lifespan_km);
    card.insertAdjacentHTML('beforeend', `
      <div class="name">${esc(car.name)}</div>
      <div class="meta">Gen ${car.generation} &middot; ${car.stats.power} kW &middot; ${car.stats.max_speed} km/h
        ${car.retired ? '<span class="badge retired">retired</span>' : ''}</div>
      <div class="meta">${car.odometer_km.toFixed(1)} / ${car.stats.lifespan_km} km</div>
      <div class="life-bar"><div style="width:${lifeLeft * 100}%"></div></div>`);
    const del = document.createElement('button');
    del.className = 'small card-delete';
    del.textContent = 'Delete';
    del.title = `Delete ${car.name}`;
    del.onclick = (ev) => { ev.stopPropagation(); deleteCar(car); };
    card.appendChild(del);
    card.onclick = () => { state.viewing = car.id; renderGarage(); };
    grid.appendChild(card);
  }
  const btn = document.getElementById('btn-breed');
  btn.textContent = `Breed selected (${state.breedPick.length}/2)`;
  btn.disabled = state.breedPick.length !== 2 || full;
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
  const detailThumb = el.querySelector('#detail-thumb');
  detailThumb.className = 'icon-wrap big';
  detailThumb.appendChild(carThumbnail(car.looks, 300, 170, 3.6));
  detailThumb.insertAdjacentHTML('beforeend', starHTML(car));
  el.querySelector('#btn-hear-engine').onclick = () => previewEngine(car.sound);
  el.querySelector('#btn-hear-gulp').onclick = () => previewGulp(car.sound);
  el.querySelector('#btn-rename').onclick = async () => {
    const name = prompt('New name', car.name);
    if (name) { await api('/api/rename', { id: car.id, name }); loadAll(); }
  };
  el.querySelector('#btn-delete').onclick = () => deleteCar(car);
}

async function deleteCar(car) {
  const t = trophiesOf(car), medals = t.gold.length + t.silver.length + t.bronze.length;
  const warn = medals || pointsOf(car).total
    ? ` Its hall of fame runs stay, but its ${pointsOf(car).total} stars and ${medals} trophies no longer count for you.` : '';
  if (!confirm(`Delete ${car.name}? This cannot be undone.${warn}`)) return;
  try {
    await api('/api/delete', { id: car.id });
    state.breedPick = state.breedPick.filter(id => id !== car.id);
    await loadAll();
  } catch (e) { alert(e.message); }
}

document.getElementById('btn-random').onclick = async () => {
  try {
    const car = await api('/api/random', { owner: state.profileId });
    state.viewing = car.id;
    loadAll();
  } catch (e) { alert(e.message); }
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
  if (state.session.admin) el.appendChild(tools);   // only the admin adds tracks
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
    const podium = hallOf(def).slice(0, 3);
    const label = def.unsaved ? 'Random: ' : '';
    const seedLine = def.custom ? `<div class="tmeta">Seed: <code>${esc(def.seedText || def.seed)}</code></div>` : '';
    card.innerHTML = `<div class="tname">${label}${esc(def.name)}</div>
      <div class="tmeta">${trackConditions(def)}</div>${seedLine}
      <div class="tmeta podium">${podium.length
        ? podium.map((e, i) => `<div class="holder"><span class="medal ${MEDALS[i][0]}">${i + 1}</span> ${holderHTML(e)}
            <span class="pod-car">${esc(e.car_name)}</span> &middot; ${e.finished ? fmtTime(e.time) : fmtKm(e.distance)}</div>`).join('')
        : 'No runs yet'}</div>`;
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
      if (state.session.admin) button('Save track', async () => {
        await saveTrack(def);
        state.randomDefs[which] = rollRandomDef();
        await loadAll();
        onPick(def.id);
      });
    } else if (def.custom) {
      // only the admin deletes tracks
      if (state.session.admin) button('Delete', async () => {
        if (!confirm(`Delete "${def.name}" and its record?`)) return;
        await api('/api/tracks/delete', { id: def.id, builtin: false });
        loadAll();
      });
    } else if (state.session.admin) {
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

  if (state.tracks.hidden.length && state.session.admin) {
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
  return `<span class="icon-wrap small"><img class="car-icon" src="${carIconURL(car.looks)}" alt="">${starHTML(car)}</span>
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
    if (unlocked(p.profileId)) {
      row.appendChild(carPicker(p.carId, id => { p.carId = id; renderRaceSetup(); }, cars));
    } else {
      // another player joins by typing their own password
      const join = document.createElement('form');
      join.className = 'join-form';
      join.innerHTML = `<input type="password" placeholder="${esc(prof.name)}'s password" autocomplete="off">
        <button class="small primary">Join</button><span class="form-error"></span>`;
      join.onsubmit = async (ev) => {
        ev.preventDefault();
        const password = join.querySelector('input').value;
        if (password === '') return;
        try {
          const res = await api('/api/login', { name: prof.name, password, join: true });
          state.joined[p.profileId] = res.token;
          renderRaceSetup();
        } catch (e) { join.querySelector('.form-error').textContent = e.message; }
      };
      row.appendChild(join);
    }
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
  const locked = state.players.find(p => !unlocked(p.profileId));
  if (locked) return alert(`${profileById(locked.profileId).name} has to join with their password first.`);
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
  let surpassed = [];     // players this run newly put below the car
  new RaceSession({
    trackDef: def, entries: [{ driver: player.name, car, color: player.color }], mode: 'trial', recordGhost: record,
    trialGhosts: pickGhosts(hall, player, car),
    onRunFinished: async (r) => {
      const res = await api('/api/record', {
        track: key, status: r.status, track_name: def.name,
        record: {
          finished: r.finished, time: r.time, distance: r.distance,
          driver: player.name, profile_id: player.id, car_name: car.name, car_id: car.id,
          looks: car.looks, ghost: r.ghost,
        },
      });
      surpassed = res.surpassed || [];
      if (res.rank === 1) return '<p class="big"><b>New number 1 on this track!</b></p>';
      if (res.rank) return `<p class="big"><b>Hall of fame: place ${res.rank}</b></p>` +
        (res.rank > 10 ? '<p class="hint">Only the top 10 keep a ghost.</p>' : '');
      if (res.best_rank) return `<p>Not better than ${esc(car.name)}'s earlier run, which stays at place ${res.best_rank}.</p>`;
      return '<p>Not in the top 100 this time.</p>';
    },
    // end screen: top 3, this car's place, and two places above and below it
    trialStandings: async () => {
      state.records = await api('/api/records');
      setTimeout(() => bindTauntBox(key, def.name), 0);
      return trialStandingsHTML(state.records[key] || [], player, car) + tauntBoxHTML(surpassed);
    },
    onExit: afterRace,
  }).start();
};

// Time trial end screen: after a run that put other players below this car
// for the first time, offer one message to all of them.
function tauntBoxHTML(surpassed) {
  if (!surpassed.length) return '';
  return `<div id="taunt-box" class="taunt-box">
    <p><b>Below you now: ${surpassed.map(p => esc(p.name)).join(', ')}.</b> Taunt ${surpassed.length === 1 ? "them" : "them all"}?</p>
    <input id="taunt-input" maxlength="140" placeholder="Your message (up to 140 characters)" autocomplete="off">
    <button class="primary" id="taunt-send">Send taunt</button>
    <p class="hint" id="taunt-status">They read it when they log in.</p></div>`;
}

function bindTauntBox(track, trackName) {
  const box = document.getElementById('taunt-box');
  if (!box) return;
  const input = document.getElementById('taunt-input'), status = document.getElementById('taunt-status');
  input.onkeydown = ev => { ev.stopPropagation(); if (ev.key === 'Enter') document.getElementById('taunt-send').click(); };
  document.getElementById('taunt-send').onclick = async () => {
    const text = input.value.trim();
    if (!text) { status.textContent = 'Type a message first.'; return; }
    try {
      await api('/api/taunt', { track, track_name: trackName, text });
      box.innerHTML = '<p><b>Taunt sent.</b> They read it when they log in.</p>';
    } catch (e) { status.textContent = e.message; }
  };
}

// Hall of fame excerpt for the time trial end screen: the top 3, the player's
// car, and the two places above and below it. Gaps are shown as "...".
function trialStandingsHTML(hall, player, car) {
  const mine = hall.findIndex(e => e.profile_id === player.id && e.car_id === car.id);
  const show = new Set([0, 1, 2].filter(i => i < hall.length));
  if (mine >= 0) for (let i = mine - 2; i <= mine + 2; i++) if (i >= 0 && i < hall.length) show.add(i);
  const idx = [...show].sort((a, b) => a - b);
  let rows = '', prev = -1;
  for (const i of idx) {
    if (prev >= 0 && i > prev + 1) rows += '<tr class="gap"><td colspan="4">...</td></tr>';
    const e = hall[i];
    rows += `<tr class="${i === mine ? 'mine' : ''}"><td>${i + 1}.</td><td>${holderHTML(e)}</td>
      <td>${e.looks && e.looks.width ? `<img class="car-icon" src="${carIconURL(e.looks)}"> ` : ''}${esc(e.car_name)}</td>
      <td>${e.finished ? fmtTime(e.time) : fmtKm(e.distance)}</td></tr>`;
    prev = i;
  }
  if (!rows) return '<p class="hint">No runs on this track yet.</p>';
  const note = mine < 0 ? `<p class="hint">${esc(car.name)} is not in the top ${hall.length >= 100 ? 100 : hall.length} yet.</p>` : '';
  return `<table class="results"><tr><th></th><th>Driver</th><th>Car</th><th></th></tr>${rows}</table>${note}`;
}

// Which hall of fame ghosts drive along, from the "Ghosts" choice.
// "My best" is this player's entry with the car they are driving now.
function pickGhosts(hall, player, car) {
  const mode = state.ghostMode;
  const mineIdx = hall.findIndex(e => e.profile_id === player.id && e.car_id === car.id);
  let idx = [];
  if (mode === 'first') idx = [0];
  else if (mode === 'top10') idx = hall.slice(0, 10).map((_, i) => i);
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
  if (entries.length) await api('/api/drive', { entries, tokens: Object.values(state.joined) });
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

// =====================================================================
// Points: on every visible track a car scores one point for each hall of
// fame place below its own, e.g. 5th of 6 places = 1 point.
// =====================================================================

function computePoints() {
  const pts = new Map();     // car id -> {total, parts: [[track name, points]]}
  for (const def of visibleTracks()) {
    const hall = hallOf(def);
    hall.forEach((e, i) => {
      const p = hall.length - (i + 1);
      if (!pts.has(e.car_id)) pts.set(e.car_id, { total: 0, parts: [] });
      const c = pts.get(e.car_id);
      c.total += p;
      c.parts.push([def.name, p]);
    });
  }
  state.points = pts;
}

function pointsOf(car) { return (state.points && state.points.get(car.id)) || { total: 0, parts: [] }; }

function starHTML(car) {
  const p = pointsOf(car);
  if (!p.total) return '';
  const title = `${p.total} point${p.total === 1 ? '' : 's'}` +
    (p.parts.length ? ': ' + p.parts.map(([n, v]) => `${n} ${v}`).join(', ') : ' (no hall of fame places yet)');
  const digits = String(p.total).length;
  const size = digits <= 1 ? 10 : digits === 2 ? 9 : digits === 3 ? 7 : 5.5;
  return `<span class="star" title="${esc(title)}"><svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 1.2l3.1 6.9 7.5.8-5.6 5.1 1.6 7.4L12 17.6l-6.6 3.8 1.6-7.4-5.6-5.1 7.5-.8z"/>
    <text x="12" y="15.6" text-anchor="middle" font-size="${size}">${p.total}</text></svg></span>`;
}

// Entries remember the player's id, so renamed players show their new name;
// runs by deleted players keep the name they had.
function holderName(e) { return profileById(e.profile_id)?.name || e.driver; }
function holderHTML(e) {
  const p = profileById(e.profile_id);
  return `<span class="swatch small" style="background:${p ? p.color : '#bbb'}"></span><b>${esc(holderName(e))}</b>`;
}

// Rank numbers where equal points share a place: 1, 2, 2, 4.
function sharedRanks(list) {
  return list.map((x, i) => i > 0 && x.points === list[i - 1].points ? null : i + 1)
    .map((r, i, a) => { while (r === null) r = a[--i]; return r; });
}

// Best cars by stars, and players by the stars of all their cars.
function standingsHTML() {
  const cars = state.cars.map(c => ({ car: c, points: pointsOf(c).total }))
    .filter(x => x.points > 0)
    .sort((a, b) => b.points - a.points || a.car.name.localeCompare(b.car.name));
  const players = state.profiles.map(p => {
    const own = carsOf(p.id).map(c => pointsOf(c).total);
    return { p, points: own.reduce((s, v) => s + v, 0), scoring: own.filter(v => v > 0).length };
  }).sort((a, b) => b.points - a.points || a.p.name.localeCompare(b.p.name));

  const open = state.hallOpen.has('cars');
  const carRanks = sharedRanks(cars);
  const carRows = cars.slice(0, open ? cars.length : 20).map((x, i) => {
    const owner = profileById(x.car.owner);
    return `<tr class="${x.car.owner === state.profileId ? 'mine' : ''}">
      <td class="rank">${carRanks[i]}</td>
      <td><span class="icon-wrap small"><img class="car-icon" src="${carIconURL(x.car.looks)}" alt="">${starHTML(x.car)}</span>
        <b>${esc(x.car.name)}</b> ${trophyBadges(x.car)}${x.car.retired ? ' <span class="badge retired">retired</span>' : ''}</td>
      <td><span class="swatch small" style="background:${owner ? owner.color : '#bbb'}"></span>${owner ? esc(owner.name) : ''}</td>
      <td class="pts">${x.points}</td></tr>`;
  }).join('');
  const playerRanks = sharedRanks(players);
  const playerRows = players.map((x, i) => `
    <tr class="${x.p.id === state.profileId ? 'mine' : ''}">
      <td class="rank">${playerRanks[i]}</td>
      <td><span class="swatch small" style="background:${x.p.color}"></span><b>${esc(x.p.name)}</b></td>
      <td class="hint">${x.scoring} of ${x.p.cars} cars scoring</td>
      <td class="pts">${x.points}</td></tr>`).join('');

  return `<div class="standings">
    <div class="hall-track">
      <h3>Best cars</h3><div class="hint">Stars: one for every hall of fame place below the car, on all tracks.</div>
      ${cars.length ? `<table class="records">${carRows}</table>` : '<p class="hint">No car has stars yet.</p>'}
      ${cars.length > 20 ? `<button class="small hall-toggle" data-key="cars">${open ? 'Show top 20' : `Show all ${cars.length}`}</button>` : ''}
    </div>
    <div class="hall-track">
      <h3>Best players</h3><div class="hint">The stars of all the player's cars added up.</div>
      <table class="records">${playerRows}</table>
    </div>
  </div>`;
}

function renderRecords() {
  const blocks = visibleTracks().map(def => {
    const key = recordKey(def);
    const hall = hallOf(def);
    const open = state.hallOpen.has(key);
    // top 10, plus the current player's own places further down
    const shown = hall.map((e, i) => [e, i]).filter(([e, i]) => open || i < 10 || e.profile_id === state.profileId);
    const rows = shown.map(([e, i], n) => `
      ${n > 0 && shown[n - 1][1] !== i - 1 ? '<tr class="gap"><td colspan="5">&hellip;</td></tr>' : ''}
      <tr class="${e.profile_id === state.profileId ? 'mine' : ''}">
        <td class="rank">${i === 0 ? '<span class="crown">#1</span>' : i + 1}</td>
        <td>${holderHTML(e)}</td>
        <td>${e.looks && e.looks.width ? `<img class="car-icon" src="${carIconURL(e.looks)}"> ` : ''}${esc(e.car_name)}</td>
        <td>${recordText(e)}</td>
        <td class="hint">${new Date(e.date * 1000).toLocaleDateString()}</td></tr>`).join('');
    return `<div class="hall-track">
      <h3>${esc(def.name)}</h3><div class="hint">${trackConditions(def)}</div>
      ${hall.length ? `<table class="records">${rows}</table>` : '<p class="hint">No runs yet.</p>'}
      ${hall.length > 10 ? `<button class="small hall-toggle" data-key="${esc(key)}">${open ? 'Show top 10' : `Show all ${hall.length}`}</button>` : ''}
    </div>`;
  }).join('');
  const el = document.getElementById('records-table');
  el.innerHTML = standingsHTML() + `<h3 class="hall-heading">Tracks</h3><div class="hall">${blocks}</div>`;
  el.querySelectorAll('.hall-toggle').forEach(b => b.onclick = () => {
    const k = b.dataset.key;
    if (state.hallOpen.has(k)) state.hallOpen.delete(k); else state.hallOpen.add(k);
    renderRecords();
  });
}

// =====================================================================
// News: one post per time trial run that changed hall of fame positions
// =====================================================================

// Background by result, in order of precedence.
function newsClass(n) {
  if (n.rank === 1) return 'gold';
  if (n.rank === 2) return 'silver';
  if (n.rank === 3) return 'bronze';
  if (n.status === 'wrecked') return 'crash';
  if (n.status === 'fuel') return 'fuel';
  return '';
}

// Medal icon for a new 1st, 2nd or 3rd place.
function medalIconHTML(rank) {
  const c = { 1: ['#ffe066', '#c9a227', 'Gold'], 2: ['#f2f2f2', '#8d96a0', 'Silver'], 3: ['#f0b07a', '#a8693a', 'Bronze'] }[rank];
  if (!c) return '';
  return `<svg class="news-medal" viewBox="0 0 32 40" width="32" height="40" role="img" aria-label="${c[2]} medal">
    <title>${c[2]} medal</title>
    <path d="M8 0h6l4 14h-6z" fill="#c0392b"/><path d="M24 0h-6l-4 14h6z" fill="#2c6fbb"/>
    <circle cx="16" cy="26" r="12" fill="${c[0]}" stroke="${c[1]}" stroke-width="2.5"/>
    <circle cx="16" cy="26" r="8" fill="none" stroke="${c[1]}" stroke-width="1" opacity="0.7"/>
    <text x="16" y="31" text-anchor="middle" font-size="14" font-weight="700" font-family="sans-serif" fill="${c[1]}">${rank}</text></svg>`;
}

function renderNews() {
  const el = document.getElementById('news-list');
  if (!el) return;
  const news = state.news || [];
  el.innerHTML = news.length ? news.map(n => {
    const result = n.finished ? `finished in ${fmtTime(n.time)}` :
      n.status === 'wrecked' ? `crashed after ${fmtKm(n.distance)}` :
      n.status === 'fuel' ? `ran out of fuel after ${fmtKm(n.distance)}` : `got ${fmtKm(n.distance)}`;
    const place = !n.old_rank ? `into place ${n.rank}` : n.old_rank === n.rank ? `a better run, still place ${n.rank}` : `up from place ${n.old_rank} to place ${n.rank}`;
    const passed = n.passed.length ? ` Passed ${n.passed.map(esc).join(', ')}.` : '';
    const taunt = n.taunt ? `<div class="news-taunt">&ldquo;${esc(n.taunt.text)}&rdquo; <span class="hint">to ${n.taunt.to.map(esc).join(', ')}</span></div>` : '';
    return `<div class="news ${newsClass(n)}">
      ${medalIconHTML(n.rank)}
      <div class="news-body"><div><b>${esc(n.driver)}</b> with ${esc(n.car_name)} on <b>${esc(n.track_name || n.track)}</b> ${result}, ${place}.${passed}</div>
      ${taunt}<div class="hint">${new Date(n.date * 1000).toLocaleString()}</div></div></div>`;
  }).join('') : '<p class="hint">No news yet.</p>';
}

startSession();
