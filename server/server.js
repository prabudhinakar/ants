'use strict';
// Ants world server.
// - Five resident bots live here. They move exactly like Nouria's ants (they follow an invisible
//   "mouse"), wander the page and the nest on their own, take about one word every 36 minutes each
//   and keep a room in the nest.
// - Every visitor has an ant in the browser; it reports its position here (POST /act) and everyone
//   receives all ants in a live stream (/events).
// - Portal B (Open Web) is served by a small proxy: /api/web and /img.
// State is saved in DATA_DIR (a separate volume): updating the code never wipes the nest.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = +process.env.PORT || 8080;
const TS = +process.env.TIME_SCALE || 1;                        // testing only: 60 = a minute passes in a second
const MIN = 60000 / TS;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUB = process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public');
const PACE = +process.env.PACE_MS || 36 * 60 * 1000 / TS;       // average time between two words, per bot
const REGROW = +process.env.REGROW_MS || 15 * 60 * 1000 / TS;   // a taken word is replaced after this
const TRAIL_TTL = 10 * 60 * 1000 / TS, SCENT_TTL = 60 * 60 * 1000 / TS, GHOST_TTL = 8 * 60 * 1000;
const YT_KEY = process.env.YT_KEY || '';
const KEEP_BACKUPS = 14;
const STATE_VERSION = 3;
const SAVE_FILE = path.join(DATA_DIR, 'state.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const W = 1400, H = 850;                                        // the page, the market and the screen
const NW = 4200, NH = 1700;                                     // the nest: about three screens wide, two high
const HOLE = { x: 1300, y: 770, r: 24 };                        // the way down from the page / market / open web
const PORTALS = {                                               // fixed doors in the nest
  A: { x: 260, y: 1460, r: 26, c: '#f6dfd2' },                  // main page (warm white)
  B: { x: 2100, y: 240, r: 26, c: '#5fb8a8' },                  // open web (cool blue-green)
  C: { x: 3920, y: 1440, r: 26, c: '#e0a040' },                 // marketplace (amber)
};
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

// ---------- text layout (shared by the main page and the open web) ----------
function layoutText(blocks, left, right, y0) {
  const out = []; let y = y0;
  for (const b of blocks) {
    let x = left; const space = tw(' ', b.size, b.bold);
    const items = b.links ? b.links : b.text.split(' ').map(t => ({ t }));
    for (const it of items) {
      const w = tw(it.t, b.size, b.bold);
      if (x + w > right) { x = left; y += b.size * 1.5; }
      const rec = { x: Math.round(x), y: Math.round(y), w: Math.round(w * 10) / 10, size: b.size, bold: !!b.bold, t0: it.t };
      if (it.q) rec.q = it.q;
      out.push(rec);
      x += w + space * (b.links ? 3 : 1);
    }
    y += b.size * 1.5 + (b.gap || 0);
  }
  return { words: out, endY: y };
}
const words = [];                                  // the main page: { x, y, w, size, bold, t0 }
let creditY = 0, pageHeight = 0;
(function () {
  const blocks = [{ text: content.title, size: 40, bold: true, gap: 8 }, ...content.paragraphs.map(p => ({ text: p, size: 21, gap: 14 }))];
  const r = layoutText(blocks, 90, 1010, 120);
  words.push(...r.words); creditY = Math.round(r.endY + 10); pageHeight = creditY + 60;
})();
const N = words.length;

// ---------- state ----------
let S;   // { v, texts[], hiddenUntil[], dropped[], bots[], tunnels[], trails[], marks[], vrooms{} }
const visitors = new Map();                        // id -> { id, s, p, x, y, a, k, look, last, lastTrail, inbox }
const ghosts = [];                                 // ants that left, resting for a while
const dug = new Map();                             // grid cell -> { ids:Set, lv }
let fresh = { tunnels: [], trails: [], marks: [] };
let fxq = [];                                      // short effects: pulses, flashes
let version = 1, dirty = false, roomPts = [];
const lastTaker = new Map();                       // word index -> { id, t }

function bump() { version++; dirty = true; rebuildRoomPts(); }
function allRooms() { return [...S.bots.filter(b => b.room).map(b => b.room), ...Object.values(S.vrooms).map(v => v.room)]; }
function rebuildRoomPts() { roomPts = []; for (const r of allRooms()) for (const it of r.items) roomPts.push(it); }
function inRoom(x, y) { for (const p of roomPts) if (Math.abs(p.x - x) < ROOM_R && Math.abs(p.y - y) < ROOM_R && dist(p.x, p.y, x, y) < ROOM_R) return true; return false; }

function dig(x, y, lvl, id) {                      // tunnels are never dug inside a room
  if (x < 0 || y < 0 || x > NW || y > NH || inRoom(x, y)) return;
  const key = Math.round(x / 4) + ',' + Math.round(y / 4);
  let c = dug.get(key);
  if (!c) { c = { ids: new Set(), lv: 0 }; dug.set(key, c); const s = [Math.round(x), Math.round(y), lvl || 0]; c.lv = lvl || 0; S.tunnels.push(s); fresh.tunnels.push(s); dirty = true; }
  if (id && !c.ids.has(id)) {                      // the more ants dig the same tunnel, the wider it gets
    c.ids.add(id);
    const lv = Math.min(2, Math.max(lvl || 0, c.ids.size - 1));
    if (lv > c.lv) { c.lv = lv; const s = [Math.round(x), Math.round(y), lv]; S.tunnels.push(s); fresh.tunnels.push(s); dirty = true; }
  }
  if (S.tunnels.length > 30000) S.tunnels.splice(0, 2000);
}
function digLine(x1, y1, x2, y2, lvl, id) {
  const n = Math.max(1, Math.ceil(dist(x1, y1, x2, y2) / 4));
  for (let i = 0; i <= n; i++) dig(x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n, lvl, id);
}
function addTrail(x, y, sp) { const t = [Math.round(x), Math.round(y), Date.now(), sp]; S.trails.push(t); fresh.trails.push(t); }

function newBot(k) {
  const web = k < 3, now = Date.now();
  return {
    id: 'bot' + k, color: COLORS[k], space: web ? 'web' : 'nest',
    x: web ? rnd(120, W - 120) : rnd(300, NW - 300), y: web ? rnd(120, 760) : rnd(200, NH - 300), angle: rnd(-Math.PI, Math.PI), step: 0,
    carry: null, ready: true, room: null,
    nextTake: now + rnd(1, 8) * MIN, leaveAt: now + rnd(2, 6) * MIN,
  };
}
function freshState() {
  S = { v: STATE_VERSION, texts: words.map(w => w.t0), hiddenUntil: new Array(N).fill(0), dropped: [], bots: [], tunnels: [], trails: [], marks: [], vrooms: {} };
  dug.clear();
  for (const k in PORTALS) {                       // a cavity around every door
    const p = PORTALS[k];
    for (let a = 0; a < 6.3; a += 0.5) for (const rr of [0, 18, 36]) dig(p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr, 1);
  }
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
    S.vrooms = S.vrooms || {}; S.trails = S.trails || []; S.marks = S.marks || [];
    dug.clear();
    for (const s of S.tunnels) {
      const key = Math.round(s[0] / 4) + ',' + Math.round(s[1] / 4), c = dug.get(key);
      if (!c) dug.set(key, { ids: new Set(), lv: s[2] || 0 }); else c.lv = Math.max(c.lv, s[2] || 0);
    }
    console.log('state loaded');
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.log('starting fresh:', e.message);
      try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); fs.copyFileSync(SAVE_FILE, path.join(BACKUP_DIR, 'state-before-reset-' + Date.now() + '.json')); } catch (_) {}
    }
    freshState();
  }
  for (const b of S.bots) { b.mode = 'wander'; b.carry = null; b.target = null; b.pauseUntil = 0; b.wi = -1; b.slot = null; b.ready = true; b.crossed = false; b.lastTrail = { x: b.x, y: b.y }; }
  rebuildRoomPts();
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
function roomCentre(self) {
  for (let i = 0; i < 120; i++) {
    const x = rnd(220, NW - 220), y = rnd(200, NH - 200);
    if (Object.values(PORTALS).some(p => dist(x, y, p.x, p.y) < 260)) continue;
    if (allRooms().some(r => r !== (self && self.room) && dist(x, y, r.cx, r.cy) < 320)) continue;
    return { x, y };
  }
  return { x: rnd(300, NW - 300), y: rnd(300, NH - 300) };
}
function nextSlot(b) {                             // the spot where the bot will drop its next word
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
  const first = S.dropped.length && Math.random() < 0.5 ? S.dropped.filter(d => typeof d === 'string') : content.pool;
  const second = first === content.pool ? S.dropped.filter(d => typeof d === 'string') : content.pool;
  const fit = first.filter(fits);
  if (fit.length) return pick(fit);
  const fit2 = second.filter(fits);
  return fit2.length ? pick(fit2) : w.t0;              // nothing fits: the original word grows back
}
function takeWord(i, who) {
  if (!(i >= 0 && i < N)) return null;
  if (S.hiddenUntil[i]) {                              // two ants reached the same word at nearly the same time
    const lt = lastTaker.get(i);
    if (lt && lt.id !== who && Date.now() - lt.t < 3000) fxq.push({ k: 'flash', s: 'web', x: words[i].x + words[i].w / 2, y: words[i].y });
    return null;
  }
  const text = S.texts[i];
  S.hiddenUntil[i] = Date.now() + REGROW; lastTaker.set(i, { id: who, t: Date.now() }); bump();
  return text;
}
function visibleWords() {
  const out = [];
  for (let i = 0; i < N; i++) if (!S.hiddenUntil[i] && S.texts[i].length >= 3 && S.texts[i].length <= 12) out.push(i);
  return out;
}
function dropped(t) { S.dropped.push(t); if (S.dropped.length > 60) S.dropped.shift(); }

// ---------- the bots: Nouria's ant, moved by an invisible mouse ----------
function head(b) { return { x: b.x + Math.cos(b.angle) * 8, y: b.y + Math.sin(b.angle) * 8 }; }
function followMouse(b, mx, my) {                  // the same rule as Nouria's Ant.update, once per frame
  const nest = b.space === 'nest';
  const d = dist(b.x, b.y, mx, my);
  if (d > 3) {
    const target = Math.atan2(my - b.y, mx - b.x);
    b.angle += Math.atan2(Math.sin(target - b.angle), Math.cos(target - b.angle)) * 0.25;
    const speed = Math.min(d * 0.08, 3);
    b.x = clamp(b.x + Math.cos(b.angle) * speed, 10, (nest ? NW : W) - 10);
    b.y = clamp(b.y + Math.sin(b.angle) * speed, 10, nest ? NH - 10 : pageHeight);
    b.step += speed * 0.5;
  }
  if (nest) dig(b.x, b.y, 0, b.id);
  const door = nest ? PORTALS.A : HOLE;            // pass through the hole
  const dh = dist(b.x, b.y, door.x, door.y);
  if (dh > door.r + 6) b.ready = true;
  if (b.ready && dh < door.r) {
    b.ready = false; b.crossed = true;
    if (nest) { b.space = 'web'; b.x = HOLE.x; b.y = HOLE.y; } else { b.space = 'nest'; b.x = PORTALS.A.x; b.y = PORTALS.A.y; }
    b.lastTrail = { x: b.x, y: b.y };
  }
}
function newTarget(b) {
  if (b.space === 'nest' && b.room && Math.random() < 0.7) return { x: clamp(b.room.cx + rnd(-220, 220), 30, NW - 30), y: clamp(b.room.cy + rnd(-180, 180), 30, NH - 30) };
  if (b.space === 'nest') return { x: rnd(40, NW - 40), y: rnd(40, NH - 40) };
  return { x: rnd(40, W - 40), y: rnd(40, Math.min(pageHeight - 40, 800)) };
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
        const t = takeWord(b.wi, b.id);
        if (t) { b.carry = t; b.mode = 'toHole'; b.crossed = false; } else { b.mode = 'wander'; b.nextTake = now + 5000; }
      }
      break;
    }
    case 'toHole': {
      const door = b.space === 'nest' ? PORTALS.A : HOLE;
      followMouse(b, door.x, door.y);
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
        dropped(b.carry);
        b.carry = null; b.slot = null; b.target = null;
        b.nextTake = now + PACE * rnd(0.6, 1.4); b.leaveAt = now + rnd(3, 9) * MIN;
        b.mode = 'wander'; bump();
      }
      break;
    }
  }
}

// ---------- visitors ----------
const SPACES = ['web', 'nest', 'B', 'C'];
function colorFor(id) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; }
const isHex = c => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
function cleanLook(l) {
  if (!l || typeof l !== 'object') return null;
  return { t: ['scout', 'carrier', 'digger'].includes(l.t) ? l.t : null, c: isHex(l.c) ? l.c : null, sz: clamp(+l.sz || 1, 0.6, 1.8), gl: l.gl ? 1 : 0, st: l.st ? 1 : 0, pt: ['stripes', 'dots'].includes(l.pt) ? l.pt : null };
}
function cleanItem(it) {                           // what an ant can carry and store: a word, a cut-out word or a cut picture
  if (typeof it === 'string') return it ? { t: it.slice(0, 40) } : null;
  if (!it || typeof it !== 'object') return null;
  if (typeof it.img === 'string' && it.img.startsWith('data:image/jpeg;base64,') && it.img.length < 20000) return { img: it.img };
  if (typeof it.t === 'string' && it.t) { const o = { t: it.t.slice(0, 40) }; if (isHex(it.bg)) { o.bg = it.bg; o.bw = clamp(+it.bw || 2, 1, 6); } return o; }
  return null;
}
function viewCarry(k) { if (!k) return null; if (typeof k === 'string') return k; if (k.img) return { img: 1 }; return k.t ? { t: k.t, bg: k.bg, bw: k.bw } : null; }

function handleAct(m) {
  const id = typeof m.id === 'string' ? m.id.slice(0, 16).replace(/[^\w-]/g, '') : '';
  if (!id) return { ok: false };
  const now = Date.now();
  let v = visitors.get(id);
  const num = (x, a, b) => typeof x === 'number' && isFinite(x) ? clamp(x, a, b) : null;
  if (m.kind === 'pos') {
    const nest = m.s === 'nest';
    const x = num(m.x, 0, nest ? NW : W), y = num(m.y, 0, nest ? NH : pageHeight + 3000), a = num(m.a, -10, 10);
    if (x === null || y === null || a === null || !SPACES.includes(m.s)) return { ok: false };
    if (!v) { if (visitors.size >= MAX_VISITORS) return { ok: false }; v = { id, inbox: [], lastTrail: { x, y } }; visitors.set(id, v); }
    const look = cleanLook(m.look);
    const lvl = look && look.t === 'digger' ? 2 : 0;
    if (nest && v.s === 'nest' && dist(v.x, v.y, x, y) < 90) digLine(v.x, v.y, x, y, lvl, id);
    else if (nest) dig(x, y, lvl, id);
    if ((m.s === 'web' || nest) && dist(v.lastTrail.x, v.lastTrail.y, x, y) > 26) { addTrail(x, y, nest ? 1 : 0); v.lastTrail = { x, y }; }
    const gone = v.s && v.s !== m.s;
    Object.assign(v, { s: m.s, p: typeof m.p === 'string' ? m.p.slice(0, 20) : '', x, y, a, k: viewCarry(cleanItem(m.k && m.k.length !== undefined && typeof m.k !== 'string' ? m.k[0] : m.k)), kn: Array.isArray(m.k) ? m.k.length : (m.k ? 1 : 0), look, last: now });
    if (v.look && v.look.c && S.vrooms[id] && S.vrooms[id].c !== v.look.c) { S.vrooms[id].c = v.look.c; bump(); }
    const inbox = v.inbox; v.inbox = [];
    return { ok: true, inbox };
  }
  if (!v) return { ok: false };
  if (m.kind === 'take') {
    const t = takeWord(m.i | 0, id);
    return t ? { ok: true, text: t } : { ok: false };
  }
  if (m.kind === 'drop') {
    const x = num(m.x, 0, NW), y = num(m.y, 0, NH), item = cleanItem(m.item);
    if (x === null || y === null || !item) return { ok: false };
    let vr = S.vrooms[id];
    if (!vr) {
      const keys = Object.keys(S.vrooms);
      if (keys.length >= MAX_VROOMS) delete S.vrooms[keys.sort((p, q) => S.vrooms[p].last - S.vrooms[q].last)[0]];
      vr = S.vrooms[id] = { c: (v.look && v.look.c) || colorFor(id), last: now, room: { cx: Math.round(x), cy: Math.round(y), items: [] } };
    }
    vr.last = now;
    vr.room.items.push({ ...item, x: Math.round(x), y: Math.round(y) });
    if (vr.room.items.length > MAX_ROOM_ITEMS) vr.room.items.shift();
    if (item.t) dropped(item.t);
    bump();
    return { ok: true };
  }
  if (m.kind === 'eat') {                          // an ant eats a word it stored itself
    const vr = S.vrooms[id], x = num(m.x, 0, NW), y = num(m.y, 0, NH);
    if (!vr || x === null || y === null) return { ok: false };
    let bi = -1, bd = 26;
    vr.room.items.forEach((it, i) => { const d = dist(it.x, it.y, x, y); if (d < bd) { bd = d; bi = i; } });
    if (bi < 0) return { ok: false };
    vr.room.items.splice(bi, 1);
    if (!vr.room.items.length) delete S.vrooms[id];
    bump();
    return { ok: true };
  }
  if (m.kind === 'mark') {                         // a scent mark: stays one hour
    const x = num(m.x, 0, m.s === 'nest' ? NW : W), y = num(m.y, 0, m.s === 'nest' ? NH : pageHeight);
    if (x === null || y === null || (m.s !== 'web' && m.s !== 'nest')) return { ok: false };
    const mk = [Math.round(x), Math.round(y), now, m.s === 'nest' ? 1 : 0, (v.look && v.look.c) || (m.s === 'nest' ? '#c99a86' : '#7a2e12')];
    S.marks.push(mk); fresh.marks.push(mk); dirty = true;
    if (S.marks.length > 2000) S.marks.shift();
    return { ok: true };
  }
  if (m.kind === 'pulse') {                        // a call that nearby ants can see
    if (!SPACES.includes(m.s)) return { ok: false };
    fxq.push({ k: 'pulse', s: m.s, p: v.p || '', x: v.x, y: v.y });
    return { ok: true };
  }
  if (m.kind === 'give') {                         // pass the word you carry to another visitor
    const to = visitors.get(String(m.to || '')), item = cleanItem(m.item);
    if (!to || !item || to.id === id || to.s !== v.s || dist(to.x, to.y, v.x, v.y) > 80) return { ok: false };
    to.inbox.push(item);
    fxq.push({ k: 'flash', s: v.s, p: v.p || '', x: to.x, y: to.y });
    return { ok: true };
  }
  return { ok: false };
}

// ---------- the open web (portal B): a proxy that brings back text and pictures ----------
const UA = 'AntsPlayingTheWeb/1.0 (university class prototype)';
const BLOCK = /\b(porn\w*|xxx|sex\w*|nude\w*|nsfw|erotic\w*|fetish\w*|gore|rape\w*|hentai|onlyfans|escort\w*|genital\w*|incest|bdsm|masturbat\w*|nazi\w*|suicide|torture|beheading|molest\w*)\b/i;
const IMG_HOSTS = [/^upload\.wikimedia\.org$/, /\.staticflickr\.com$/, /^i\.ytimg\.com$/, /^d2w9rnfcy7mm78\.cloudfront\.net$/];
let inflight = 0;
async function getText(url, accept) {
  if (inflight > 8) throw new Error('busy');
  inflight++;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept || 'application/json' }, signal: AbortSignal.timeout(8000), redirect: 'follow' });
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.text();
  } finally { inflight--; }
}
const getJSON = async (url) => JSON.parse(await getText(url));
const enc = encodeURIComponent;
async function imageInfos(titles, host) {          // file titles -> picture addresses (about 520 px wide)
  if (!titles.length) return [];
  const d = await getJSON(`https://${host}/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|mime&iiurlwidth=520&titles=${enc(titles.join('|'))}`);
  return Object.values((d.query && d.query.pages) || {}).map(p => p.imageinfo && p.imageinfo[0]).filter(i => i && /^image\/(jpeg|png)$/.test(i.mime) && i.thumburl && i.thumbwidth > 140 && i.thumbheight > 100)
    .map(i => ({ url: i.thumburl, w: i.thumbwidth, h: i.thumbheight }));
}
async function wikipedia(q) {
  let title = q;
  if (!q) title = (await getJSON('https://en.wikipedia.org/api/rest_v1/page/random/summary')).title;
  else {
    const s = await getJSON(`https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=1&format=json&srsearch=${enc(q)}`);
    title = s.query.search[0] && s.query.search[0].title;
    if (!title) throw new Error('nothing found');
  }
  const d = await getJSON(`https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1&titles=${enc(title)}&prop=extracts|pageimages|links|images&exlimit=1&explaintext=1&exsectionformat=plain&exchars=2400&piprop=thumbnail&pithumbsize=520&pllimit=80&plnamespace=0&imlimit=30`);
  const page = Object.values(d.query.pages)[0];
  if (!page || !page.extract) throw new Error('empty');
  const files = (page.images || []).map(i => i.title).filter(t => /\.(jpe?g|png)$/i.test(t) && !/(icon|logo|flag|symbol|map|diagram|commons|wiki)/i.test(t)).slice(0, 5);
  const imgs = [];
  if (page.thumbnail) imgs.push({ url: page.thumbnail.source, w: page.thumbnail.width, h: page.thumbnail.height });
  try { imgs.push(...await imageInfos(files.slice(0, 4), 'en.wikipedia.org')); } catch (_) {}
  const text = page.extract.split(/\n+/).map(s => s.trim()).filter(s => s.length > 40).slice(0, 4);
  const links = (page.links || []).map(l => l.title).filter(t => t.length < 30 && !/^(List|Index|Outline|Category|Help|Portal)/.test(t));
  return { title: page.title, text, links, imgs };
}
async function commons(q) {
  const gen = q ? `generator=search&gsrnamespace=6&gsrlimit=6&gsrsearch=${enc(q + ' filetype:bitmap')}` : 'generator=random&grnnamespace=6&grnlimit=8';
  const d = await getJSON(`https://commons.wikimedia.org/w/api.php?action=query&format=json&${gen}&prop=imageinfo&iiprop=url|mime&iiurlwidth=520`);
  return Object.values((d.query && d.query.pages) || {}).map(p => p.imageinfo && p.imageinfo[0]).filter(i => i && /^image\/(jpeg|png)$/.test(i.mime) && i.thumburl && i.thumbwidth > 140 && i.thumbheight > 100)
    .map(i => ({ url: i.thumburl, w: i.thumbwidth, h: i.thumbheight }));
}
async function flickr(q) {
  let t = await getText(`https://www.flickr.com/services/feeds/photos_public.gne?format=json&nojsoncallback=1&tags=${enc(q.replace(/\s+/g, ','))}`);
  t = t.replace(/\\'/g, "'");
  const d = JSON.parse(t);
  return (d.items || []).filter(i => !BLOCK.test((i.title || '') + ' ' + (i.tags || ''))).slice(0, 4)
    .map(i => ({ url: i.media.m.replace('_m.jpg', '_z.jpg'), w: 640, h: 480 }));
}
async function arena(q) {
  if (!q) return [];
  const d = await getJSON(`https://api.are.na/v2/search/blocks?q=${enc(q)}&per=8`);
  return (d.blocks || []).filter(b => b.image && b.image.display && b.image.display.url).slice(0, 3).map(b => ({ url: b.image.display.url, w: 500, h: 400 }));
}
async function youtube(q) {
  if (!YT_KEY || !q) return [];
  const d = await getJSON(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=3&safeSearch=strict&q=${enc(q)}&key=${YT_KEY}`);
  return (d.items || []).map(i => ({ url: i.snippet.thumbnails.medium.url, w: 320, h: 180 }));
}
const pageCache = new Map();
async function buildPage(qIn) {
  const q = String(qIn || '').trim().slice(0, 80);
  if (BLOCK.test(q)) throw new Error('closed');
  const ck = q.toLowerCase();
  const hit = !q ? null : pageCache.get(ck);
  if (hit && Date.now() - hit.t < 10 * 60000) return hit.page;
  let wiki = null;
  try { wiki = await wikipedia(q); } catch (_) {}
  if (wiki && (BLOCK.test(wiki.title) || BLOCK.test(wiki.text.join(' ')))) throw new Error('closed');
  const extra = (await Promise.allSettled([q ? commons(q) : commons(''), q ? flickr(q) : [], q ? arena(q) : [], youtube(q)])).flatMap(r => r.status === 'fulfilled' ? r.value : []);
  const imgs = [...(wiki ? wiki.imgs : []), ...extra].filter(i => { try { const h = new URL(i.url).hostname; return IMG_HOSTS.some(re => re.test(h)); } catch (_) { return false; } });
  const seen = new Set(); const pics = [];
  for (const i of imgs) { if (!seen.has(i.url)) { seen.add(i.url); pics.push(i); } if (pics.length >= 5) break; }
  if (!wiki && !pics.length) throw new Error('closed');
  const title = wiki ? wiki.title : (q || 'Images');
  const links = wiki ? wiki.links.sort(() => Math.random() - 0.5).slice(0, 5) : [];
  const blocks = [{ text: title, size: 36, bold: true, gap: 8 }, ...(wiki ? wiki.text : []).map(t => ({ text: t, size: 19, gap: 12 }))];
  if (links.length) blocks.push({ text: '', links: links.map(l => ({ t: l, q: l })), size: 19, gap: 0 });
  const lay = layoutText(blocks, 90, 800, 110);
  let y = 100; const images = [];
  for (const p of pics) {
    const w = 380, h = Math.round(p.h * w / p.w);
    images.push({ u: "/img?u=" + enc(p.url), x: 870, y, w, h }); y += h + 24;
  }
  const page = { key: Math.abs([...title].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)).toString(36), title, words: lay.words, images, pageHeight: Math.max(lay.endY + 120, y + 60) };
  if (q) pageCache.set(ck, { t: Date.now(), page }); if (pageCache.size > 60) pageCache.delete(pageCache.keys().next().value);
  return page;
}
const imgCache = new Map();
function proxyImage(u, res) {
  let url; try { url = new URL(u); } catch (_) { res.writeHead(400); res.end(); return; }
  if (url.protocol !== 'https:' || !IMG_HOSTS.some(re => re.test(url.hostname))) { res.writeHead(403); res.end(); return; }
  const c = imgCache.get(u);
  if (c) { res.writeHead(200, { 'Content-Type': c.type, 'Cache-Control': 'public, max-age=3600' }); res.end(c.buf); return; }
  https.get(url, { headers: { 'User-Agent': UA }, timeout: 8000 }, up => {
    if (up.statusCode !== 200 || !/^image\/(jpeg|png)/.test(up.headers['content-type'] || '')) { res.writeHead(502); res.end(); up.resume(); return; }
    const chunks = []; let size = 0;
    up.on('data', d => { size += d.length; if (size > 4e6) { up.destroy(); } else chunks.push(d); });
    up.on('end', () => {
      if (size > 4e6) { res.writeHead(502); res.end(); return; }
      const buf = Buffer.concat(chunks), type = up.headers['content-type'];
      imgCache.set(u, { buf, type }); if (imgCache.size > 80) imgCache.delete(imgCache.keys().next().value);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' }); res.end(buf);
    });
    up.on('error', () => { try { res.writeHead(502); res.end(); } catch (_) {} });
  }).on('error', () => { try { res.writeHead(502); res.end(); } catch (_) {} }).on('timeout', function () { this.destroy(); });
}

// ---------- the loop ----------
const clients = new Set();
let last = Date.now(), lastBroadcast = 0;

function tick() {
  const now = Date.now(), dt = Math.min(0.25, (now - last) / 1000); last = now;
  for (let i = 0; i < N; i++) {                    // taken long enough ago: a different word grows there
    if (S.hiddenUntil[i] && S.hiddenUntil[i] <= now) { S.texts[i] = replacementFor(i); S.hiddenUntil[i] = 0; bump(); }
  }
  const frames = Math.max(1, Math.round(dt * 60));
  for (const b of S.bots) {
    for (let f = 0; f < frames; f++) botFrame(b, now);
    for (const o of S.bots) {                      // ants do not overlap: a bot gives way to a close ant in its space
      if (o === b || o.space !== b.space) continue;
      const d = dist(b.x, b.y, o.x, o.y);
      if (d < 16 && d > 0.01) { b.x += (b.x - o.x) / d * 0.8; b.y += (b.y - o.y) / d * 0.8; }
    }
    if (dist(b.x, b.y, b.lastTrail.x, b.lastTrail.y) > 26) { addTrail(b.x, b.y, b.space === 'nest' ? 1 : 0); b.lastTrail = { x: b.x, y: b.y }; }
  }
  for (const [id, v] of visitors) if (now - v.last > 6000) {   // an ant that left stays a while as a faded shape
    ghosts.push({ id: 'g' + id + now, s: v.s, p: v.p, x: v.x, y: v.y, a: v.a, until: now + GHOST_TTL });
    visitors.delete(id);
  }
  while (ghosts.length && ghosts[0].until < now) ghosts.shift();
  while (S.trails.length && S.trails[0][2] < now - TRAIL_TTL) S.trails.shift();
  while (S.marks.length && S.marks[0][2] < now - SCENT_TTL) S.marks.shift();
  if (now - lastBroadcast >= 95) { lastBroadcast = now; broadcast(); }
}

function antViews() {
  const out = S.bots.map(b => ({ id: b.id, s: b.space, x: +b.x.toFixed(1), y: +b.y.toFixed(1), a: +b.angle.toFixed(3), k: b.carry }));
  for (const v of visitors.values()) out.push({ id: v.id, s: v.s, p: v.p, x: v.x, y: v.y, a: v.a, k: v.k, l: v.look });
  for (const g of ghosts) out.push({ id: g.id, s: g.s, p: g.p, x: g.x, y: g.y, a: g.a, g: 1 });
  return out;
}
function worldView() {
  const rooms = [];
  for (const b of S.bots) if (b.room) rooms.push({ o: b.id, c: b.color, room: b.room });
  for (const [id, v] of Object.entries(S.vrooms)) rooms.push({ o: id, c: v.c, room: v.room });
  return { v: version, texts: S.texts, hidden: S.hiddenUntil.map(x => x ? 1 : 0), rooms };
}
function initMsg() {
  return { W, H, NW, NH, hole: HOLE, portals: PORTALS, pageHeight, creditY, words, credit: content.credit, roomR: ROOM_R,
    trailTtl: TRAIL_TTL, scentTtl: SCENT_TTL, tunnels: S.tunnels, trails: S.trails, marks: S.marks, t: Date.now() };
}
let lastSentVersion = 0;
function send(res, event, data) { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); }
function broadcast() {
  if (!clients.size) { fresh = { tunnels: [], trails: [], marks: [] }; fxq = []; return; }
  const msg = { t: Date.now(), ants: antViews(), nt: fresh.tunnels, ntr: fresh.trails, nm: fresh.marks, fx: fxq };
  fresh = { tunnels: [], trails: [], marks: [] }; fxq = [];
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
    req.on('data', c => { body += c; if (body.length > 30000) req.destroy(); });
    req.on('end', () => {
      let out = { ok: false };
      try { out = handleAct(JSON.parse(body)); } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (url.pathname === '/api/web') {
    buildPage(url.searchParams.get('q')).then(p => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(p));
    }).catch(() => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"closed":true}'); });
    return;
  }
  if (url.pathname === '/img') { proxyImage(url.searchParams.get('u') || '', res); return; }
  if (url.pathname === '/snapshot') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ init: initMsg(), world: worldView(), tick: { t: Date.now(), ants: antViews(), nt: [], ntr: [], nm: [], fx: [] } })); return;
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
