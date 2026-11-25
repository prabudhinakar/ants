'use strict';
// Ants world server. Five ants live here: they wander the main page and the nest, take about
// one word every 36 minutes each, and build a room with what they carry. The world keeps going
// when nobody is watching. State is saved in DATA_DIR (a separate folder/volume), so updating
// the code never wipes the nest.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = +process.env.PORT || 8080;
const TS = +process.env.TIME_SCALE || 1;                       // only for testing: 60 = a minute passes in a second
const MIN = 60000 / TS;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUB = process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public');
const PACE = +process.env.PACE_MS || 36 * 60 * 1000 / TS;      // average time between two words, per ant
const REGROW = +process.env.REGROW_MS || 15 * 60 * 1000 / TS;  // a taken word is replaced after this
const TRAIL_TTL = 10 * 60 * 1000;                              // walking trails fade
const SCENT_TTL = 60 * 60 * 1000;                              // scent marks fade
const KEEP_BACKUPS = 14;
const SAVE_FILE = path.join(DATA_DIR, 'state.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const WW = 1600, HH = 900, SPLIT = 800;
const PAGE = { x0: 50, x1: 755, y0: 40, y1: 880 };
const NEST = { x0: 850, x1: 1560, y0: 40, y1: 880 };
const PAGE_HOLE = { x: 735, y: 835 };
const NEST_HOLE = { x: 885, y: 835 };
const ROOM_R = 46;
const COLORS = ['#c8553d', '#d9a441', '#d98e9a', '#f6dfd2', '#a8643a'];   // inside the palette

const content = JSON.parse(fs.readFileSync(path.join(__dirname, 'content.json'), 'utf8'));
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

// ---------- the page: layout of the words ----------
const words = [];                                  // { x, y, w, size }
(function layout() {
  const CW = 0.52;
  let y = 110;
  const add = (str, size) => {
    let x = 60;
    for (const t of str.split(' ')) {
      const w = t.length * size * CW;
      if (x + w > 740) { x = 60; y += size * 1.55; }
      words.push({ x: Math.round(x), y: Math.round(y), w: Math.round(w), size });
      x += w + size * 0.32;
      words[words.length - 1].t0 = t;
    }
    y += size * 1.55;
  };
  add(content.title, 36); y += 6;
  for (const p of content.paragraphs) { add(p, 17); y += 12; }
})();
const N = words.length;

// ---------- state ----------
let S;   // { texts[], hiddenUntil[], dropped[], ants[], tunnels[], trails[], marks[] }

function freshState() {
  const now = Date.now();
  const st = {
    texts: words.map(w => w.t0), hiddenUntil: new Array(N).fill(0), dropped: [],
    ants: [], tunnels: [], trails: [], marks: [],
  };
  S = st;
  COLORS.forEach((color, k) => {
    const onPage = k < 3;
    const reg = onPage ? PAGE : NEST;
    const a = {
      id: k, color, space: onPage ? 'page' : 'nest', x: rnd(reg.x0 + 40, reg.x1 - 40), y: rnd(reg.y0 + 120, reg.y1 - 200),
      a: rnd(0, Math.PI * 2), room: null,
      nextTake: now + rnd(1, 8) * MIN, leaveAt: now + rnd(2, 6) * MIN,
    };
    // a small starting room, so the nest is not empty on day one
    const n = 2 + (k % 3);
    for (let j = 0; j < n; j++) addItem(a, st, pick(content.pool), true);
    st.ants.push(a);
  });
  return st;
}

function load() {
  try {
    S = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    if (!S.ants || S.texts.length !== N) throw new Error('state does not match the page');
    for (const a of S.ants) { a.mode = 'wander'; a.carry = null; a.target = null; a.cross = null; }
    console.log('state loaded');
  } catch (e) {
    if (e.code !== 'ENOENT') console.log('starting fresh:', e.message);
    S = freshState();
  }
  for (const a of S.ants) initRuntime(a);
}
function initRuntime(a) {
  a.mode = 'wander'; a.carry = null; a.target = null; a.cross = null; a.al = 1;
  a.turnV = 0; a.pauseUntil = 0; a.lastTrail = { x: a.x, y: a.y }; a.lastStamp = { x: a.x, y: a.y };
  a.slot = null; a.pendingWord = -1;
}

let version = 1, dirty = false;
function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const keep = S.ants.map(a => ({ id: a.id, color: a.color, space: a.space, x: a.x, y: a.y, a: a.a, room: a.room, nextTake: a.nextTake, leaveAt: a.leaveAt }));
    const out = { ...S, ants: keep };
    fs.writeFileSync(SAVE_FILE + '.tmp', JSON.stringify(out));
    fs.renameSync(SAVE_FILE + '.tmp', SAVE_FILE);
    dirty = false;
  } catch (e) { console.error('save failed', e.message); }
}
function dailyBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const f = path.join(BACKUP_DIR, 'state-' + new Date().toISOString().slice(0, 10) + '.json');
    if (!fs.existsSync(f) && fs.existsSync(SAVE_FILE)) fs.copyFileSync(SAVE_FILE, f);
    const all = fs.readdirSync(BACKUP_DIR).filter(n => n.startsWith('state-')).sort();
    for (const n of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(BACKUP_DIR, n));
  } catch (e) { console.error('backup failed', e.message); }
}

// ---------- rooms ----------
function roomCentre(self) {
  for (let i = 0; i < 80; i++) {
    const x = rnd(NEST.x0 + 120, NEST.x1 - 120), y = rnd(NEST.y0 + 120, NEST.y1 - 140);
    if (dist(x, y, NEST_HOLE.x, NEST_HOLE.y) < 200) continue;
    if (S.ants.some(o => o !== self && o.room && dist(x, y, o.room.cx, o.room.cy) < 250)) continue;
    return { x, y };
  }
  return { x: rnd(NEST.x0 + 150, NEST.x1 - 150), y: rnd(NEST.y0 + 150, NEST.y1 - 150) };
}
// the spot where the next word will be stored
function nextSlot(a, st) {
  const S0 = st || S;
  if (!a.room) { const c = roomCentre(a); a.room = { cx: c.x, cy: c.y, items: [] }; }
  const r = a.room, n = r.items.length;
  const R = 26 + 26 * Math.sqrt(n + 1);
  let best = null;
  for (let i = 0; i < 40; i++) {
    const ang = rnd(0, Math.PI * 2), d = rnd(0, R);
    const p = { x: Math.round(r.cx + Math.cos(ang) * d), y: Math.round(r.cy + Math.sin(ang) * d) };
    const gap = r.items.reduce((m, it) => Math.min(m, Math.hypot((p.x - it.x) / 3.2, p.y - it.y)), 999);
    if (!best || gap > best.gap) best = { ...p, gap };
  }
  return best;
}
function addItem(a, st, text, silent) {
  const p = nextSlot(a, st);
  a.room.items.push({ t: text, x: p.x, y: p.y, r: +rnd(-0.35, 0.35).toFixed(2) });
  if (!silent) { S.dropped.push(text); if (S.dropped.length > 60) S.dropped.shift(); }
}

// ---------- words: taken, then replaced by another ----------
function replacementFor(i) {
  const cur = S.texts[i], len = words[i].t0.length;
  const useDropped = S.dropped.length && Math.random() < 0.5;
  const pool = (useDropped ? S.dropped : content.pool).filter(t => t !== cur && t.length <= len + 2 && t.length >= Math.max(2, len - 4));
  const any = (useDropped ? S.dropped : content.pool).filter(t => t !== cur);
  return pick(pool.length ? pool : any);
}
function visibleWords() {
  const out = [];
  for (let i = 0; i < N; i++) if (!S.hiddenUntil[i] && S.texts[i].length >= 3 && S.texts[i].length <= 12) out.push(i);
  return out;
}

// ---------- ant behaviour ----------
function angDiff(a, b) { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }
function region(a) { return a.space === 'page' ? PAGE : NEST; }
function holeOf(a) { return a.space === 'page' ? PAGE_HOLE : NEST_HOLE; }

function steerTo(a, tx, ty, dt, speed, turn) {
  const d = angDiff(a.a, Math.atan2(ty - a.y, tx - a.x));
  a.a += Math.max(-turn * dt, Math.min(turn * dt, d));
  a.x += Math.cos(a.a) * speed * dt; a.y += Math.sin(a.a) * speed * dt;
}
function wander(a, dt, now) {
  if (now < a.pauseUntil) return;
  if (Math.random() < dt * 0.04) { a.pauseUntil = now + rnd(2000, 7000); return; }   // a short rest
  a.turnV = Math.max(-0.9, Math.min(0.9, a.turnV * 0.97 + (Math.random() - 0.5) * 3 * dt));
  a.a += a.turnV * dt;
  const g = region(a), m = 60;
  if (a.x < g.x0 + m || a.x > g.x1 - m || a.y < g.y0 + m || a.y > g.y1 - m) {
    const d = angDiff(a.a, Math.atan2((g.y0 + g.y1) / 2 - a.y, (g.x0 + g.x1) / 2 - a.x));
    a.a += Math.max(-1.6 * dt, Math.min(1.6 * dt, d));
  }
  a.x += Math.cos(a.a) * 24 * dt; a.y += Math.sin(a.a) * 24 * dt;
}

function addMark(a, kind) {
  S.marks.push([Math.round(a.x), Math.round(a.y), Date.now(), a.space === 'page' ? 0 : 1, a.id]);
  fresh.marks.push(S.marks[S.marks.length - 1]);
}

function stepAnt(a, dt, now) {
  const g = region(a);
  switch (a.mode) {
    case 'wander': {
      if (a.space === 'page' && now >= a.nextTake) {
        const vis = visibleWords();
        if (vis.length) {
          const i = pick(vis), w = words[i];
          a.pendingWord = i; a.target = { x: w.x + w.w / 2, y: w.y - w.size * 0.3 }; a.mode = 'toWord'; break;
        }
      }
      if (a.space === 'nest' && (now >= a.leaveAt || now >= a.nextTake)) { a.mode = 'toHole'; a.after = 'up'; break; }
      wander(a, dt, now); break;
    }
    case 'toWord': {
      steerTo(a, a.target.x, a.target.y, dt, 58, 3.2);
      if (dist(a.x, a.y, a.target.x, a.target.y) < 7) {
        const i = a.pendingWord;
        if (S.hiddenUntil[i]) { a.mode = 'wander'; a.nextTake = now + 5000; break; }    // somebody else took it
        a.carry = S.texts[i]; S.hiddenUntil[i] = now + REGROW; a.pendingWord = -1;
        addMark(a); version++; dirty = true;
        a.mode = 'toHole'; a.after = 'down';
      }
      break;
    }
    case 'toHole': {
      const h = holeOf(a);
      steerTo(a, h.x, h.y, dt, a.carry ? 52 : 46, 3);
      if (dist(a.x, a.y, h.x, h.y) < 8) { a.mode = 'cross'; a.cross = { start: now, moved: false, up: a.space === 'nest' }; }
      break;
    }
    case 'cross': {
      const p = (now - a.cross.start) / 1500;
      if (p < 0.5) { a.al = 1 - 2 * p; }
      else {
        if (!a.cross.moved) {
          a.cross.moved = true;
          if (a.cross.up) { a.space = 'page'; a.x = PAGE_HOLE.x; a.y = PAGE_HOLE.y; a.a = rnd(Math.PI, Math.PI * 1.5); }
          else { a.space = 'nest'; a.x = NEST_HOLE.x; a.y = NEST_HOLE.y; a.a = rnd(-0.5, 0.5); }
          a.lastTrail = { x: a.x, y: a.y }; a.lastStamp = { x: a.x, y: a.y };
          if (!a.cross.up && a.carry) a.slot = nextSlot(a);
          if (!a.cross.up) a.slot = a.carry ? a.slot : null;
        }
        a.al = Math.min(1, 2 * p - 1);
      }
      if (p >= 1) {
        a.al = 1; a.cross = null;
        if (a.space === 'nest' && a.carry) { a.mode = 'toRoom'; a.target = a.slot; }
        else { a.mode = 'wander'; if (a.space === 'nest') a.leaveAt = now + rnd(3, 9) * MIN; }
      }
      break;
    }
    case 'toRoom': {
      steerTo(a, a.target.x, a.target.y, dt, 50, 3);
      if (dist(a.x, a.y, a.target.x, a.target.y) < 7) {
        a.room.items.push({ t: a.carry, x: a.target.x, y: a.target.y, r: +rnd(-0.35, 0.35).toFixed(2) });
        S.dropped.push(a.carry); if (S.dropped.length > 60) S.dropped.shift();
        a.carry = null; a.slot = null; a.target = null;
        a.nextTake = now + PACE * rnd(0.6, 1.4); a.leaveAt = now + rnd(3, 9) * MIN;
        a.mode = 'wander'; version++; dirty = true;
      }
      break;
    }
  }
}

// ---------- the loop ----------
let fresh = { tunnels: [], trails: [], marks: [] };
const clients = new Set();
let last = Date.now();

function tick() {
  const now = Date.now(), dt = Math.min(0.25, (now - last) / 1000); last = now;

  // words that were taken long enough ago are replaced by a different word
  for (let i = 0; i < N; i++) {
    if (S.hiddenUntil[i] && S.hiddenUntil[i] <= now) { S.texts[i] = replacementFor(i); S.hiddenUntil[i] = 0; version++; dirty = true; }
  }

  for (const a of S.ants) {
    const px = a.x, py = a.y;
    stepAnt(a, dt, now);
    if (a.mode === 'cross') continue;
    // ants do not overlap: they push each other softly apart
    for (const o of S.ants) {
      if (o === a || o.space !== a.space || o.mode === 'cross') continue;
      const d = dist(a.x, a.y, o.x, o.y);
      if (d < 30 && d > 0.01) { const k = (30 - d) * 0.25; a.x += (a.x - o.x) / d * k; a.y += (a.y - o.y) / d * k; a.a += angDiff(a.a, Math.atan2(a.y - o.y, a.x - o.x)) * 0.05; }
    }
    // walking trails (10 min) and dug tunnels (stay)
    if (dist(a.x, a.y, a.lastTrail.x, a.lastTrail.y) > 26) {
      const t = [Math.round(a.x), Math.round(a.y), now, a.space === 'page' ? 0 : 1, a.id];
      S.trails.push(t); fresh.trails.push(t); a.lastTrail = { x: a.x, y: a.y };
    }
    if (a.space === 'nest' && dist(a.x, a.y, a.lastStamp.x, a.lastStamp.y) > 13) {
      const s = [Math.round(a.x), Math.round(a.y)];
      S.tunnels.push(s); fresh.tunnels.push(s); a.lastStamp = { x: a.x, y: a.y }; dirty = true;
    }
  }
  if (S.tunnels.length > 9000) S.tunnels.splice(0, S.tunnels.length - 9000);
  const cutT = now - TRAIL_TTL, cutM = now - SCENT_TTL;
  while (S.trails.length && S.trails[0][2] < cutT) S.trails.shift();
  while (S.marks.length && S.marks[0][2] < cutM) S.marks.shift();

  broadcast(now);
}

function antView(a) {
  return { id: a.id, c: a.color, s: a.space === 'page' ? 0 : 1, x: +a.x.toFixed(1), y: +a.y.toFixed(1), a: +a.a.toFixed(2), al: +a.al.toFixed(2), k: a.carry, p: a.mode === 'wander' && Date.now() < a.pauseUntil ? 1 : 0 };
}
function worldView() {
  return { v: version, texts: S.texts, hidden: S.hiddenUntil.map(x => x ? 1 : 0), rooms: S.ants.map(a => ({ id: a.id, c: a.color, room: a.room })) };
}
let lastSentVersion = 0;
function send(res, event, data) { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); }
function broadcast(now) {
  if (!clients.size) { fresh = { tunnels: [], trails: [], marks: [] }; return; }
  const tickMsg = { t: now, ants: S.ants.map(antView), nt: fresh.tunnels, nr: fresh.trails, nm: fresh.marks };
  fresh = { tunnels: [], trails: [], marks: [] };
  const w = version !== lastSentVersion ? worldView() : null;
  lastSentVersion = version;
  for (const res of clients) { if (w) send(res, 'world', w); send(res, 'tick', tickMsg); }
}

// ---------- http ----------
function initMsg() {
  return { t: Date.now(), W: WW, H: HH, split: SPLIT, words, credit: content.credit, pageHole: PAGE_HOLE, nestHole: NEST_HOLE, roomR: ROOM_R,
    trailTtl: TRAIL_TTL, scentTtl: SCENT_TTL, tunnels: S.tunnels, trails: S.trails, marks: S.marks };
}
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
  if (url.pathname === '/snapshot') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ init: initMsg(), world: worldView(), tick: { t: Date.now(), ants: S.ants.map(antView), nt: [], nr: [], nm: [] } })); return;
  }
  if (url.pathname === '/health') { res.writeHead(200); res.end('ok'); return; }
  let f = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUB, f));
  if (!file.startsWith(PUB)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

load(); save(); dailyBackup();
setInterval(tick, 100);
setInterval(() => { if (dirty) save(); }, 15000);
setInterval(() => { for (const r of clients) r.write(': keep-alive\n\n'); }, 20000);
setInterval(dailyBackup, 6 * 3600 * 1000);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { save(); process.exit(0); });
server.listen(PORT, () => console.log('ants on', PORT, 'data in', DATA_DIR));
