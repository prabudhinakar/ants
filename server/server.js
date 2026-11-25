'use strict';
// Ants world server.
// - Five resident bots live here. They move exactly like Nouria's ants (they follow an invisible
//   "mouse"), wander the page and the nest on their own, take about one word every 36 minutes each
//   and keep a room in the nest.
// - Visitors get their own ant in the browser; it reports its position here (POST /act) and
//   everyone receives all ants in a live stream (/events).
// State is saved in DATA_DIR (a separate volume): updating the code never wipes the nest.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = +process.env.PORT || 8080;
const TS = +process.env.TIME_SCALE || 1;                        // testing only: 60 = a minute passes in a second
const MIN = 60000 / TS;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUB = process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public');
const PACE = +process.env.PACE_MS || 36 * 60 * 1000 / TS;       // average time between two words, per bot
const REGROW = +process.env.REGROW_MS || 15 * 60 * 1000 / TS;   // a taken word is replaced after this
const KEEP_BACKUPS = 14;
const STATE_VERSION = 2;
const SAVE_FILE = path.join(DATA_DIR, 'state.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const W = 1400, H = 850;                                        // one world, page or nest, as in Nouria's
const HOLE = { x: 1300, y: 770, r: 24 };
const ROOM_R = 38;
const COLORS = ['#c8553d', '#d9a441', '#d98e9a', '#f6dfd2', '#a8643a'];   // the palette; rooms take these
const MAX_VISITORS = 100, MAX_VROOMS = 40, MAX_ROOM_ITEMS = 80;

const content = JSON.parse(fs.readFileSync(path.join(__dirname, 'content.json'), 'utf8'));
const widths = JSON.parse(fs.readFileSync(path.join(__dirname, 'widths.json'), 'utf8'));   // Arial metrics
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function tw(str, size, bold) {
  const t = bold ? widths.bold : widths.regular; let w = 0;
  for (const ch of str) w += t[ch] || 556;
  return w * size / 1000;
}

// ---------- the page: layout of the words ----------
const words = [];                                  // { x, y, w, size, bold, t0 }
let creditY = 0, pageHeight = 0;
(function layout() {
  const LEFT = 90, RIGHT = 1010;
  let y = 120;
  const add = (str, size, bold) => {
    let x = LEFT; const space = tw(' ', size, bold);
    for (const t of str.split(' ')) {
      const w = tw(t, size, bold);
      if (x + w > RIGHT) { x = LEFT; y += size * 1.5; }
      words.push({ x: Math.round(x), y: Math.round(y), w: Math.round(w * 10) / 10, size, bold, t0: t });
      x += w + space;
    }
    y += size * 1.5;
  };
  add(content.title, 40, true); y += 8;
  for (const p of content.paragraphs) { add(p, 21, false); y += 14; }
  creditY = Math.round(y + 10);
  pageHeight = creditY + 60;
})();
const N = words.length;

// ---------- state ----------
let S;   // { v, texts[], hiddenUntil[], dropped[], bots[], tunnels[], vrooms{} }
const visitors = new Map();                        // id -> { id, s, x, y, a, k, last }
const dug = new Set();                             // grid cells already dug
let fresh = { tunnels: [] };
let version = 1, dirty = false;

function dig(x, y) {
  const key = Math.round(x / 4) + ',' + Math.round(y / 4);
  if (dug.has(key)) return;
  dug.add(key);
  const s = [Math.round(x), Math.round(y)];
  S.tunnels.push(s); fresh.tunnels.push(s); dirty = true;
}
function digLine(x1, y1, x2, y2) {
  const n = Math.max(1, Math.ceil(dist(x1, y1, x2, y2) / 4));
  for (let i = 0; i <= n; i++) dig(x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n);
}

function newBot(k) {
  const web = k < 3, now = Date.now();
  return {
    id: 'bot' + k, color: COLORS[k], space: web ? 'web' : 'nest',
    x: rnd(120, W - 120), y: rnd(120, web ? 760 : H - 140), angle: rnd(-Math.PI, Math.PI), step: 0,
    carry: null, ready: true, room: null,
    nextTake: now + rnd(1, 8) * MIN, leaveAt: now + rnd(2, 6) * MIN,
  };
}
function freshState() {
  S = { v: STATE_VERSION, texts: words.map(w => w.t0), hiddenUntil: new Array(N).fill(0), dropped: [], bots: [], tunnels: [], vrooms: {} };
  dug.clear();
  for (let a = 0; a < 7; a += 0.7) dig(HOLE.x + Math.cos(a) * 24, HOLE.y + Math.sin(a) * 24);   // a cavity around the hole
  dig(HOLE.x, HOLE.y);
  for (let k = 0; k < 5; k++) {
    const b = newBot(k); S.bots.push(b);
    const n = 2 + (k % 3);                         // a small starting room, so the nest is not empty on day one
    for (let j = 0; j < n; j++) { const p = nextSlot(b); b.room.items.push({ t: pick(content.pool), x: p.x, y: p.y }); }
  }
}
function load() {
  try {
    S = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    if (S.v !== STATE_VERSION || S.texts.length !== N) throw new Error('old state version');
    S.vrooms = S.vrooms || {};
    dug.clear();
    for (const s of S.tunnels) dug.add(Math.round(s[0] / 4) + ',' + Math.round(s[1] / 4));
    console.log('state loaded');
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.log('starting fresh:', e.message);
      try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); fs.copyFileSync(SAVE_FILE, path.join(BACKUP_DIR, 'state-before-reset-' + Date.now() + '.json')); } catch (_) {}
    }
    freshState();
  }
  for (const b of S.bots) { b.mode = 'wander'; b.carry = null; b.target = null; b.pauseUntil = 0; b.wi = -1; b.slot = null; b.ready = true; b.crossed = false; }
}
function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const keep = S.bots.map(b => ({ id: b.id, color: b.color, space: b.space, x: b.x, y: b.y, angle: b.angle, step: b.step, carry: null, ready: true, room: b.room, nextTake: b.nextTake, leaveAt: b.leaveAt }));
    fs.writeFileSync(SAVE_FILE + '.tmp', JSON.stringify({ ...S, bots: keep }));
    fs.renameSync(SAVE_FILE + '.tmp', SAVE_FILE);
    dirty = false;
  } catch (e) { console.error('save failed', e.message); }
}
function dailyBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const f = path.join(BACKUP_DIR, 'state-' + new Date().toISOString().slice(0, 10) + '.json');
    if (!fs.existsSync(f) && fs.existsSync(SAVE_FILE)) fs.copyFileSync(SAVE_FILE, f);
    const all = fs.readdirSync(BACKUP_DIR).filter(n => /^state-\d{4}-/.test(n)).sort();
    for (const n of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(BACKUP_DIR, n));
  } catch (e) { console.error('backup failed', e.message); }
}

// ---------- rooms ----------
function allRooms() { return [...S.bots.filter(b => b.room).map(b => b.room), ...Object.values(S.vrooms).map(v => v.room)]; }
function roomCentre(self) {
  for (let i = 0; i < 80; i++) {
    const x = rnd(140, W - 140), y = rnd(120, H - 180);
    if (dist(x, y, HOLE.x, HOLE.y) < 200) continue;
    if (allRooms().some(r => r !== (self && self.room) && dist(x, y, r.cx, r.cy) < 230)) continue;
    return { x, y };
  }
  return { x: rnd(160, W - 160), y: rnd(140, H - 200) };
}
// the spot where the bot will drop its next word
function nextSlot(b) {
  if (!b.room) { const c = roomCentre(b); b.room = { cx: Math.round(c.x), cy: Math.round(c.y), items: [] }; }
  const r = b.room, n = r.items.length, R = 24 + 20 * Math.sqrt(n + 1);
  let best = null;
  for (let i = 0; i < 40; i++) {
    const ang = rnd(0, Math.PI * 2), d = rnd(0, R);
    const p = { x: Math.round(r.cx + Math.cos(ang) * d), y: Math.round(r.cy + Math.sin(ang) * d) };
    const gap = r.items.reduce((m, it) => Math.min(m, Math.hypot((p.x - it.x) / 3, p.y - it.y)), 999);
    if (!best || gap > best.gap) best = { ...p, gap };
  }
  return best;
}

// ---------- words: taken, then replaced by another ----------
function replacementFor(i) {
  const cur = S.texts[i], w = words[i];
  const fits = t => t !== cur && tw(t, w.size, w.bold) <= w.w * 1.15 + 6 && tw(t, w.size, w.bold) >= w.w * 0.4;
  const first = S.dropped.length && Math.random() < 0.5 ? S.dropped : content.pool;
  const second = first === content.pool ? S.dropped : content.pool;
  const fit = first.filter(fits);
  if (fit.length) return pick(fit);
  const fit2 = second.filter(fits);
  return fit2.length ? pick(fit2) : w.t0;              // nothing fits: the original word grows back
}
function takeWord(i) {
  if (!(i >= 0 && i < N) || S.hiddenUntil[i]) return null;
  const text = S.texts[i];
  S.hiddenUntil[i] = Date.now() + REGROW; version++; dirty = true;
  return text;
}
function visibleWords() {
  const out = [];
  for (let i = 0; i < N; i++) if (!S.hiddenUntil[i] && S.texts[i].length >= 3 && S.texts[i].length <= 12) out.push(i);
  return out;
}

// ---------- the bots: Nouria's ant, moved by an invisible mouse ----------
function head(b) { return { x: b.x + Math.cos(b.angle) * 8, y: b.y + Math.sin(b.angle) * 8 }; }
function followMouse(b, mx, my) {                  // the same rule as Nouria's Ant.update, once per frame
  const d = dist(b.x, b.y, mx, my);
  if (d > 3) {
    const target = Math.atan2(my - b.y, mx - b.x);
    b.angle += Math.atan2(Math.sin(target - b.angle), Math.cos(target - b.angle)) * 0.25;
    const speed = Math.min(d * 0.08, 3);
    b.x = clamp(b.x + Math.cos(b.angle) * speed, 10, W - 10);
    b.y = clamp(b.y + Math.sin(b.angle) * speed, 10, b.space === 'web' ? pageHeight : H - 10);
    b.step += speed * 0.5;
  }
  if (b.space === 'nest') dig(b.x, b.y);
  const dh = dist(b.x, b.y, HOLE.x, HOLE.y);       // pass through the hole
  if (dh > HOLE.r + 6) b.ready = true;
  if (b.ready && dh < HOLE.r) { b.space = b.space === 'web' ? 'nest' : 'web'; b.ready = false; b.crossed = true; }
}
function newTarget(b) {
  if (b.space === 'nest' && b.room && Math.random() < 0.7) return { x: clamp(b.room.cx + rnd(-150, 150), 30, W - 30), y: clamp(b.room.cy + rnd(-130, 130), 30, H - 30) };
  return { x: rnd(40, W - 40), y: rnd(40, b.space === 'web' ? Math.min(pageHeight - 40, 800) : H - 40) };
}
function botFrame(b, now) {
  switch (b.mode) {
    case 'wander': {
      if (b.space === 'web' && now >= b.nextTake) {
        const vis = visibleWords();
        if (vis.length) { b.wi = pick(vis); b.mode = 'toWord'; break; }
      }
      if (b.space === 'nest' && (now >= b.leaveAt || now >= b.nextTake)) { b.mode = 'toHole'; b.crossed = false; break; }
      if (now < b.pauseUntil) break;
      if (!b.target) b.target = newTarget(b);
      followMouse(b, b.target.x, b.target.y);
      if (dist(b.x, b.y, b.target.x, b.target.y) < 8) { b.target = null; b.pauseUntil = now + rnd(1000, 6000); }
      break;
    }
    case 'toWord': {
      const w = words[b.wi];
      if (S.hiddenUntil[b.wi]) { b.mode = 'wander'; b.nextTake = now + 5000; break; }      // somebody else took it
      followMouse(b, w.x + w.w / 2, w.y - w.size * 0.3);
      const h = head(b);
      if (h.x > w.x && h.x < w.x + w.w && h.y > w.y - w.size && h.y < w.y + 3) {
        const t = takeWord(b.wi);
        if (t) { b.carry = t; b.mode = 'toHole'; b.crossed = false; } else { b.mode = 'wander'; b.nextTake = now + 5000; }
      }
      break;
    }
    case 'toHole': {
      followMouse(b, HOLE.x, HOLE.y);
      if (b.crossed) {
        b.crossed = false;
        if (b.space === 'nest' && b.carry) { b.slot = nextSlot(b); b.mode = 'toRoom'; }
        else { b.mode = 'wander'; b.target = null; b.pauseUntil = 0; if (b.space === 'nest') b.leaveAt = now + rnd(3, 9) * MIN; }
      }
      break;
    }
    case 'toRoom': {
      followMouse(b, b.slot.x, b.slot.y);
      const h = head(b);
      if (dist(h.x, h.y, b.slot.x, b.slot.y) < 7 || dist(b.x, b.y, b.slot.x, b.slot.y) < 7) {
        b.room.items.push({ t: b.carry, x: b.slot.x, y: b.slot.y });
        S.dropped.push(b.carry); if (S.dropped.length > 60) S.dropped.shift();
        b.carry = null; b.slot = null; b.target = null;
        b.nextTake = now + PACE * rnd(0.6, 1.4); b.leaveAt = now + rnd(3, 9) * MIN;
        b.mode = 'wander'; version++; dirty = true;
      }
      break;
    }
  }
}

// ---------- visitors ----------
function colorFor(id) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; }
function handleAct(m) {
  const id = typeof m.id === 'string' ? m.id.slice(0, 16).replace(/[^\w-]/g, '') : '';
  if (!id) return { ok: false };
  const now = Date.now();
  let v = visitors.get(id);
  const num = (x, a, b) => typeof x === 'number' && isFinite(x) ? clamp(x, a, b) : null;
  if (m.kind === 'pos') {
    const x = num(m.x, 0, W), y = num(m.y, 0, pageHeight + 50), a = num(m.a, -10, 10);
    if (x === null || y === null || a === null || (m.s !== 'web' && m.s !== 'nest')) return { ok: false };
    if (!v) { if (visitors.size >= MAX_VISITORS) return { ok: false }; v = { id }; visitors.set(id, v); }
    if (m.s === 'nest' && v.s === 'nest' && dist(v.x, v.y, x, y) < 90) digLine(v.x, v.y, x, y);
    else if (m.s === 'nest') dig(x, y);
    Object.assign(v, { s: m.s, x, y, a, k: typeof m.k === 'string' ? m.k.slice(0, 24) : null, last: now });
    return { ok: true };
  }
  if (!v) return { ok: false };
  if (m.kind === 'take') {
    const t = takeWord(m.i | 0);
    return t ? { ok: true, text: t } : { ok: false };
  }
  if (m.kind === 'drop') {
    const x = num(m.x, 0, W), y = num(m.y, 0, H);
    const text = typeof m.text === 'string' ? m.text.slice(0, 24) : '';
    if (x === null || y === null || !text) return { ok: false };
    let vr = S.vrooms[id];
    if (!vr) {
      const keys = Object.keys(S.vrooms);
      if (keys.length >= MAX_VROOMS) delete S.vrooms[keys.sort((p, q) => S.vrooms[p].last - S.vrooms[q].last)[0]];
      vr = S.vrooms[id] = { c: colorFor(id), last: now, room: { cx: Math.round(x), cy: Math.round(y), items: [] } };
    }
    vr.last = now;
    vr.room.items.push({ t: text, x: Math.round(x), y: Math.round(y) });
    if (vr.room.items.length > MAX_ROOM_ITEMS) vr.room.items.shift();
    S.dropped.push(text); if (S.dropped.length > 60) S.dropped.shift();
    version++; dirty = true;
    return { ok: true };
  }
  return { ok: false };
}

// ---------- the loop ----------
const clients = new Set();
let last = Date.now(), lastBroadcast = 0;

function tick() {
  const now = Date.now(), dt = Math.min(0.25, (now - last) / 1000); last = now;
  for (let i = 0; i < N; i++) {                    // taken long enough ago: a different word grows there
    if (S.hiddenUntil[i] && S.hiddenUntil[i] <= now) { S.texts[i] = replacementFor(i); S.hiddenUntil[i] = 0; version++; dirty = true; }
  }
  const frames = Math.max(1, Math.round(dt * 60));
  for (const b of S.bots) {
    for (let f = 0; f < frames; f++) botFrame(b, now);
    for (const o of S.bots) {                      // ants do not overlap: a bot gives way to a close ant in its space
      if (o === b || o.space !== b.space) continue;
      const d = dist(b.x, b.y, o.x, o.y);
      if (d < 16 && d > 0.01) { b.x += (b.x - o.x) / d * 0.8; b.y += (b.y - o.y) / d * 0.8; }
    }
  }
  for (const [id, v] of visitors) if (now - v.last > 6000) visitors.delete(id);
  if (now - lastBroadcast >= 95) { lastBroadcast = now; broadcast(); }
}

function antViews() {
  const out = S.bots.map(b => ({ id: b.id, s: b.space, x: +b.x.toFixed(1), y: +b.y.toFixed(1), a: +b.angle.toFixed(3), k: b.carry }));
  for (const v of visitors.values()) out.push({ id: v.id, s: v.s, x: v.x, y: v.y, a: v.a, k: v.k });
  return out;
}
function worldView() {
  const rooms = [];
  for (const b of S.bots) if (b.room) rooms.push({ c: b.color, room: b.room });
  for (const v of Object.values(S.vrooms)) rooms.push({ c: v.c, room: v.room });
  return { v: version, texts: S.texts, hidden: S.hiddenUntil.map(x => x ? 1 : 0), rooms };
}
function initMsg() {
  return { W, H, hole: HOLE, pageHeight, creditY, words, credit: content.credit, roomR: ROOM_R, tunnels: S.tunnels };
}
let lastSentVersion = 0;
function send(res, event, data) { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); }
function broadcast() {
  if (!clients.size) { fresh = { tunnels: [] }; return; }
  const msg = { ants: antViews(), nt: fresh.tunnels };
  fresh = { tunnels: [] };
  const w = version !== lastSentVersion ? worldView() : null;
  lastSentVersion = version;
  for (const res of clients) { if (w) send(res, 'world', w); send(res, 'tick', msg); }
}

// ---------- http ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    send(res, 'init', initMsg());
    send(res, 'world', worldView());
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/act' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      let out = { ok: false };
      try { out = handleAct(JSON.parse(body)); } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (url.pathname === '/snapshot') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ init: initMsg(), world: worldView(), tick: { ants: antViews(), nt: [] } })); return;
  }
  if (url.pathname === '/health') { res.writeHead(200); res.end('ok'); return; }
  const f = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUB, f));
  if (!file.startsWith(PUB)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

load(); save(); dailyBackup();
setInterval(tick, 50);
setInterval(() => { if (dirty) save(); }, 15000);
setInterval(() => { for (const r of clients) r.write(': keep-alive\n\n'); }, 20000);
setInterval(dailyBackup, 6 * 3600 * 1000);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { save(); process.exit(0); });
server.listen(PORT, () => console.log('ants on', PORT, 'data in', DATA_DIR));
