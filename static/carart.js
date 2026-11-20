// Top-down car drawing from the "looks" phenotype.  The car faces +x.

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function carBodyColor(looks) {
  return `hsl(${looks.hue}, ${looks.sat}%, ${looks.light}%)`;
}

function drawCar(ctx, looks, x, y, angle, scale = 1, opts = {}) {
  const L = looks.length, W = looks.width;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(scale, scale);
  if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha;

  // shadow
  if (!opts.ghost) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    roundRect(ctx, -L / 2 + 2, -W / 2 + 3, L, W, W * 0.35);
    ctx.fill();
  }

  // wheels
  const wl = 7 * looks.wheel, ww = 3.6 * looks.wheel;
  ctx.fillStyle = '#1b1b1b';
  for (const fx of [L * 0.28, -L * 0.3]) {
    for (const sy of [-1, 1]) {
      const wx = fx - wl / 2, wy = sy * (W / 2 + ww * 0.05) - ww / 2;
      roundRect(ctx, wx, wy, wl, ww, 1.2);
      ctx.fill();
    }
  }

  // body
  const body = carBodyColor(looks);
  ctx.fillStyle = body;
  roundRect(ctx, -L / 2, -W / 2, L, W, W * 0.35);
  ctx.fill();
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = `hsl(${looks.hue}, ${looks.sat}%, ${Math.max(8, looks.light - 25)}%)`;
  ctx.stroke();

  // stripes
  if (looks.stripe > 0) {
    ctx.save();
    roundRect(ctx, -L / 2, -W / 2, L, W, W * 0.35);
    ctx.clip();
    const sl = looks.light > 52 ? 22 : 86;
    ctx.fillStyle = `hsl(${looks.stripe_hue}, 75%, ${sl}%)`;
    const sw = W * 0.14;
    if (looks.stripe === 1) {
      ctx.fillRect(-L / 2, -sw, L, sw * 2);
    } else if (looks.stripe === 2) {
      ctx.fillRect(-L / 2, -sw * 2.2, L, sw);
      ctx.fillRect(-L / 2, sw * 1.2, L, sw);
    } else {
      ctx.fillRect(-L / 2, -W / 2, L, sw * 0.9);
      ctx.fillRect(-L / 2, W / 2 - sw * 0.9, L, sw * 0.9);
    }
    ctx.restore();
  }

  // cabin / glass
  ctx.fillStyle = 'rgba(25,35,50,0.85)';
  if (looks.cabin === 0) {
    ctx.beginPath();
    ctx.ellipse(-L * 0.02, 0, L * 0.18, W * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (looks.cabin === 1) {
    roundRect(ctx, -L * 0.28, -W * 0.3, L * 0.5, W * 0.6, W * 0.2);
    ctx.fill();
  } else {
    roundRect(ctx, -L * 0.05, -W * 0.33, L * 0.2, W * 0.66, 2);
    ctx.fill();
  }
  // windscreen highlight
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fillRect(L * 0.06, -W * 0.22, L * 0.03, W * 0.44);

  // spoiler
  if (looks.spoiler > 0) {
    const sd = 2 + 3 * looks.spoiler;
    ctx.fillStyle = `hsl(${looks.hue}, ${looks.sat}%, ${Math.max(8, looks.light - 18)}%)`;
    roundRect(ctx, -L / 2 - sd * 0.4, -W * 0.56, sd, W * 1.12, 1);
    ctx.fill();
  }

  // headlights
  ctx.fillStyle = `hsl(${looks.light_hue}, 90%, 80%)`;
  for (const sy of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(L / 2 - 2, sy * W * 0.3, 1.4, 2.2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // tail lights
  ctx.fillStyle = '#c0201a';
  for (const sy of [-1, 1]) ctx.fillRect(-L / 2 + 0.5, sy * W * 0.3 - 1.5, 1.6, 3);

  // damage smoke marks
  if (opts.damage && opts.damage > 0.4) {
    ctx.fillStyle = `rgba(30,30,30,${Math.min(0.6, opts.damage - 0.3)})`;
    ctx.beginPath();
    ctx.arc(L * 0.25, -W * 0.15, W * 0.2, 0, Math.PI * 2);
    ctx.arc(-L * 0.1, W * 0.2, W * 0.15, 0, Math.PI * 2);
    ctx.fill();
  }

  if (opts.label) {
    ctx.rotate(-angle);
    ctx.globalAlpha = 0.9;
    ctx.font = 'bold 11px system-ui';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    const ly = -L * 0.75 - (opts.labelRow || 0) * 13;   // ghosts in a bunch get one label line each
    ctx.strokeText(opts.label, 0, ly);
    ctx.fillStyle = opts.labelColor || 'white';
    ctx.fillText(opts.label, 0, ly);
  }
  ctx.restore();
}

// Draws a car pointing up into a small canvas (garage cards, detail view).
function carThumbnail(looks, w = 150, h = 110, scale = 2.0, angle = -Math.PI / 2 + 0.35) {
  const c = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  c.width = w * dpr; c.height = h * dpr;
  c.style.width = w + 'px'; c.style.height = h + 'px';
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  drawCar(ctx, looks, w / 2, h / 2, angle, scale);
  return c;
}

// Small side-on icon as a data URL, for <img> tags in menus and overlays.
const _iconCache = new Map();
function carIconURL(looks) {
  const key = JSON.stringify(looks);
  if (!_iconCache.has(key)) _iconCache.set(key, carThumbnail(looks, 60, 30, 1.05, 0).toDataURL());
  return _iconCache.get(key);
}
