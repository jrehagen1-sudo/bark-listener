/**
 * Bark Meter demo on Cloudflare
 *
 *   /            app page: sign in, My log, Feedback, Admin (owner)
 *   /listener    the Listener page (index.html), wired to /api/rpc
 *   /api/...     JSON API (cookie sign-in)
 *   cron         every 5 min: two-way sync with the Google Sheet + Drive through Apps Script
 *
 * Secrets (Worker → Settings → Variables and Secrets):
 *   APPS_SCRIPT_URL   the Apps Script web app address (ends in /exec)
 *   APPS_SCRIPT_KEY   the Apps Script secret key (also the code that creates the owner account)
 */
import { Buffer } from 'node:buffer';

const TZ = 'America/Los_Angeles';
const SESSION_DAYS = 365;
const MAX_TESTERS = 60;
const CLIP_SYNC_START = Date.parse('2026-11-01T00:00:00Z');
const CLIPS_PER_RUN = 2;          // each direction, keeps each sync run small
const ROWS_PER_PUSH = 200;

const DEFAULT_SETTINGS = {
  threshold: 0.25, gapSeconds: 60, minBarks: 3, sustainedMinutes: 5, clipMinutes: 5,
  audioMinMinutes: 1, shortBurstWindowMinutes: 30, sessionGapMinutes: 30,
  incessantMinutes: 30, intermittentMinutes: 60, windowHours: 24, quietStart: 22, quietEnd: 7,
  preparedBy: '', monitoringLocation: '', subjectProperty: '', caseReference: '',
  ordinanceName: 'OC Animal Care barking ordinance', listenerUrl: ''
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, name TEXT, role TEXT, active INTEGER DEFAULT 1,
     created TEXT, last_login TEXT, pass TEXT, updated INTEGER DEFAULT 0, dirty INTEGER DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, email TEXT, expires INTEGER)`,
  `CREATE TABLE IF NOT EXISTS episodes (id TEXT PRIMARY KEY, user TEXT, start TEXT, end TEXT, duration_min REAL,
     bark_seconds REAL, density REAL, peak_conf REAL, avg_conf REAL, peak_db REAL, sustained INTEGER,
     clips_url TEXT, clip_count INTEGER DEFAULT 0, device TEXT, session_id TEXT, notes TEXT, bark_session TEXT,
     updated INTEGER DEFAULT 0, dirty INTEGER DEFAULT 1)`,
  `CREATE INDEX IF NOT EXISTS episodes_user_start ON episodes (user, start)`,
  `CREATE TABLE IF NOT EXISTS listen_sessions (id TEXT PRIMARY KEY, user TEXT, device TEXT, started TEXT,
     last_beat TEXT, stopped TEXT, status TEXT, updated INTEGER DEFAULT 0, dirty INTEGER DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, user TEXT, created TEXT, kind TEXT, message TEXT,
     page TEXT, status TEXT, reply TEXT, updated INTEGER DEFAULT 0, dirty INTEGER DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS clips (key TEXT PRIMARY KEY, user TEXT, episode_id TEXT, name TEXT, size INTEGER,
     mime TEXT, created TEXT, drive_id TEXT, in_r2 INTEGER DEFAULT 0, tries INTEGER DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS clips_drive ON clips (drive_id)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`
];

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

/* ================================================================ entry */

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p.startsWith('/api/')) {
        await ensureSchema(env);
        return await handleApi(req, env, ctx, url);
      }
      if (p === '/' || p === '/app') return asset(env, url, '/cf/app');
      if (p === '/listener') {
        await ensureSchema(env);
        const me = await currentUser(req, env);
        if (!me) return Response.redirect(url.origin + '/', 302);
        return asset(env, url, '/');
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return json({ ok: false, error: 'Server error: ' + (e && e.message || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env));
  }
};

async function asset(env, url, path) {
  const res = await env.ASSETS.fetch(new Request(new URL(path, url.origin)));
  const h = new Headers(res.headers);
  h.set('cache-control', 'no-cache');
  return new Response(res.body, { status: res.status, headers: h });
}

/* ================================================================ helpers */

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, headers)
  });
}
const okRes = (result, headers) => json({ ok: true, result }, 200, headers);
const errRes = (msg, status = 200) => json({ ok: false, error: msg }, status);

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function getCookie(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}
const nowIso = () => new Date().toISOString();
const round = (n, d) => { const p = Math.pow(10, d); return Math.round((Number(n) || 0) * p) / p; };
const normEmail = (e) => String(e || '').trim().toLowerCase();
const safeName = (s) => String(s || 'clip.mp3').replace(/[^\w.-]/g, '_').slice(0, 80);
const safeUser = (s) => String(s || '').replace(/[^\w@.+-]/g, '_').slice(0, 120);

function tzParts(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(d);
  const o = {};
  parts.forEach((p) => { o[p.type] = p.value; });
  return o;
}

async function getMeta(env, k, d = '') {
  const r = await env.DB.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first();
  return r ? r.v : d;
}
function setMetaStmt(env, k, v) {
  return env.DB.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, String(v));
}
const setMeta = (env, k, v) => setMetaStmt(env, k, v).run();

/* ================================================================ accounts */

async function currentUser(req, env) {
  const tok = getCookie(req, 'bm_s');
  if (!tok) return null;
  const th = await sha256hex(tok);
  return await env.DB.prepare(
    `SELECT u.email, u.name, u.role FROM auth_sessions s JOIN users u ON u.email = s.email
     WHERE s.token_hash = ? AND s.expires > ? AND u.active = 1`
  ).bind(th, Date.now()).first();
}

async function newSessionCookie(env, email) {
  const tok = randomHex(32);
  const exp = Date.now() + SESSION_DAYS * 86400000;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO auth_sessions (token_hash, email, expires) VALUES (?, ?, ?)').bind(await sha256hex(tok), email, exp),
    env.DB.prepare('DELETE FROM auth_sessions WHERE expires < ?').bind(Date.now())
  ]);
  return { 'set-cookie': `bm_s=${tok}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax` };
}

// The browser stretches the password (PBKDF2, salted with the email); the server stores a hash of that.
const passHash = (email, derived) => sha256hex(String(derived) + ':' + email);

async function signup(env, b) {
  const email = normEmail(b.email);
  const name = String(b.name || '').trim().slice(0, 60);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) return errRes('Enter a valid email address.');
  if (!/^[0-9a-f]{64}$/.test(String(b.pass || ''))) return errRes('Password problem. Reload the page and try again.');
  if (!name) return errRes('Enter your name.');

  const count = (await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n;
  let role;
  if (count === 0) {
    if (!env.APPS_SCRIPT_KEY) return errRes('Setup is not finished: add the APPS_SCRIPT_KEY secret in Cloudflare first.');
    if (!safeEqual(String(b.invite || '').trim(), env.APPS_SCRIPT_KEY)) return errRes('For the first (owner) account, the invite code is your Apps Script secret key.');
    role = 'owner';
  } else {
    const code = await getMeta(env, 'invite_code');
    if (!code || !safeEqual(String(b.invite || '').trim(), code)) return errRes('That invite code is not valid.');
    if (count >= MAX_TESTERS) return errRes('The tester list is full.');
    role = 'tester';
  }
  if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) {
    return errRes('An account with this email already exists. Sign in instead.');
  }
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO users (email, name, role, active, created, last_login, pass, updated, dirty) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 1)`
  ).bind(email, name, role, now, now, await passHash(email, b.pass), Date.now()).run();
  return okRes({ email, name, role }, await newSessionCookie(env, email));
}

async function login(env, b) {
  const email = normEmail(b.email);
  const u = await env.DB.prepare('SELECT email, name, role, active, pass FROM users WHERE email = ?').bind(email).first();
  if (!u || !safeEqual(await passHash(email, b.pass), u.pass)) return errRes('Email or password is not right.');
  if (!u.active) return errRes('This account is turned off. Contact the Bark Meter owner.');
  await env.DB.prepare('UPDATE users SET last_login = ?, updated = ?, dirty = 1 WHERE email = ?').bind(nowIso(), Date.now(), email).run();
  return okRes({ email: u.email, name: u.name, role: u.role }, await newSessionCookie(env, email));
}

/* ================================================================ API */

async function handleApi(req, env, ctx, url) {
  const p = url.pathname;
  const method = req.method;
  let body = {};
  if (method === 'POST') {
    try { body = JSON.parse((await req.text()) || '{}'); } catch (e) { return errRes('Bad request', 400); }
  }

  if (p === '/api/signup' && method === 'POST') return signup(env, body);
  if (p === '/api/login' && method === 'POST') return login(env, body);
  if (p === '/api/logout' && method === 'POST') {
    const tok = getCookie(req, 'bm_s');
    if (tok) await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(await sha256hex(tok)).run();
    return okRes(true, { 'set-cookie': 'bm_s=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
  }
  if (p === '/api/rpc' && method === 'GET') return Response.redirect(url.origin + '/', 302); // listener's dashboard link

  const me = await currentUser(req, env);
  if (p === '/api/rpc' && method === 'POST') {
    if (!me) return errRes('Signed out. Open ' + url.origin + ' and sign in again.');
    return rpc(env, me, body);
  }
  if (!me) return errRes('Please sign in.', 401);
  const isOwner = me.role === 'owner';

  if (p === '/api/me') return okRes(me);
  if (p === '/api/episodes' && method === 'GET') {
    const who = isOwner && url.searchParams.get('user') ? normEmail(url.searchParams.get('user')) : me.email;
    const eps = (await env.DB.prepare('SELECT * FROM episodes WHERE user = ? ORDER BY start DESC LIMIT 100').bind(who).all()).results;
    const clips = (await env.DB.prepare('SELECT key, episode_id, name, size FROM clips WHERE user = ? AND in_r2 = 1 ORDER BY name').bind(who).all()).results;
    return okRes({ user: who, episodes: eps.map(epToObj), clips });
  }
  if (p === '/api/clip' && method === 'GET') return serveClip(req, env, me, url.searchParams.get('key'));
  if (p === '/api/feedback' && method === 'GET') {
    const q = isOwner
      ? env.DB.prepare('SELECT * FROM feedback ORDER BY created DESC LIMIT 300')
      : env.DB.prepare('SELECT * FROM feedback WHERE user = ? ORDER BY created DESC LIMIT 100').bind(me.email);
    return okRes((await q.all()).results.map(fbToObj));
  }
  if (p === '/api/feedback' && method === 'POST') {
    const msg = String(body.message || '').trim().slice(0, 4000);
    if (!msg) return errRes('Write a message first.');
    const kind = ['Bug', 'Feature idea', 'Question', 'Other'].includes(body.kind) ? body.kind : 'Other';
    const id = 'F' + Date.now().toString(36) + '-' + randomHex(2);
    await env.DB.prepare(
      `INSERT INTO feedback (id, user, created, kind, message, page, status, reply, updated, dirty) VALUES (?, ?, ?, ?, ?, ?, 'New', '', ?, 1)`
    ).bind(id, me.email, nowIso(), kind, msg, String(body.page || '').slice(0, 60), Date.now()).run();
    return okRes({ id });
  }

  if (!isOwner) return errRes('Owner only.', 403);
  if (p === '/api/admin' && method === 'GET') {
    const users = (await env.DB.prepare('SELECT email, name, role, active, created, last_login FROM users ORDER BY created').all()).results;
    const c = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM episodes) AS episodes, (SELECT COUNT(*) FROM clips WHERE in_r2 = 1) AS clips,
              (SELECT COUNT(*) FROM clips WHERE drive_id IS NULL AND in_r2 = 1) AS clips_waiting,
              (SELECT COUNT(*) FROM episodes WHERE dirty = 1) + (SELECT COUNT(*) FROM listen_sessions WHERE dirty = 1)
              + (SELECT COUNT(*) FROM feedback WHERE dirty = 1) + (SELECT COUNT(*) FROM users WHERE dirty = 1) AS rows_waiting`
    ).first();
    let sync = {};
    try { sync = JSON.parse(await getMeta(env, 'sync_status', '{}')); } catch (e) {}
    return okRes({
      users, counts: c, sync, inviteCode: await getMeta(env, 'invite_code'),
      secrets: { url: !!env.APPS_SCRIPT_URL, key: !!env.APPS_SCRIPT_KEY }
    });
  }
  if (p === '/api/admin/invite' && method === 'POST') {
    const code = String(body.code || '').trim();
    if (code.length < 6) return errRes('Use at least 6 characters.');
    await setMeta(env, 'invite_code', code.slice(0, 60));
    return okRes(true);
  }
  if (p === '/api/admin/user' && method === 'POST') {
    const email = normEmail(body.email);
    await env.DB.prepare(`UPDATE users SET active = ?, updated = ?, dirty = 1 WHERE email = ? AND role != 'owner'`)
      .bind(body.active ? 1 : 0, Date.now(), email).run();
    if (!body.active) await env.DB.prepare('DELETE FROM auth_sessions WHERE email = ?').bind(email).run();
    return okRes(true);
  }
  if (p === '/api/admin/feedback' && method === 'POST') {
    await env.DB.prepare('UPDATE feedback SET status = ?, reply = ?, updated = ?, dirty = 1 WHERE id = ?')
      .bind(String(body.status || 'New').slice(0, 30), String(body.reply || '').slice(0, 4000), Date.now(), String(body.id)).run();
    return okRes(true);
  }
  if (p === '/api/admin/sync' && method === 'POST') return okRes(await runSync(env));
  return errRes('Not found', 404);
}

async function serveClip(req, env, me, key) {
  const row = await env.DB.prepare('SELECT user, mime FROM clips WHERE key = ?').bind(String(key || '')).first();
  if (!row || (row.user !== me.email && me.role !== 'owner')) return new Response('Not found', { status: 404 });
  const obj = await env.CLIPS.get(key, { range: req.headers });
  if (!obj) return new Response('Not found', { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set('etag', obj.httpEtag);
  h.set('accept-ranges', 'bytes');
  h.set('content-type', row.mime || 'audio/mpeg');
  h.set('cache-control', 'private, max-age=3600');
  if (obj.range && req.headers.has('range')) {
    const r = obj.range;
    const off = r.suffix !== undefined ? obj.size - r.suffix : (r.offset || 0);
    const len = r.suffix !== undefined ? r.suffix : (r.length !== undefined ? r.length : obj.size - off);
    h.set('content-range', `bytes ${off}-${off + len - 1}/${obj.size}`);
    h.set('content-length', String(len));
    return new Response(obj.body, { status: 206, headers: h });
  }
  h.set('content-length', String(obj.size));
  return new Response(obj.body, { headers: h });
}

/* ================================================================ listener RPC
 * Same request/reply format as the Apps Script doPost, so the Listener page works unchanged. */

async function rpc(env, me, req) {
  try {
    let out;
    switch (req.action) {
      case 'settings': out = await settingsFor(env, me); break;
      case 'saveSettings': out = await saveSettingsFor(env, me, req.settings); break;
      case 'start': out = await startSession(env, me, req.device); break;
      case 'heartbeat': out = await touchSession(env, me, req.sessionId, false); break;
      case 'stop': out = await touchSession(env, me, req.sessionId, true); break;
      case 'episode': out = await logEpisode(env, me, req.episode); break;
      case 'clip': out = await saveClip(env, me, req.episodeId, req.fileName, req.data, req.mimeType); break;
      case 'ping': out = 'pong'; break;
      default: throw new Error('Unknown action: ' + req.action);
    }
    return okRes(out);
  } catch (e) {
    return errRes(String(e && e.message || e));
  }
}

function mergeSettings(base, s) {
  const out = Object.assign({}, base);
  Object.keys(DEFAULT_SETTINGS).forEach((k) => {
    if (s && s[k] !== undefined && s[k] !== null && s[k] !== '') {
      out[k] = typeof DEFAULT_SETTINGS[k] === 'number' ? Number(s[k]) : String(s[k]);
    }
  });
  return out;
}
async function ownerSettings(env) {
  let saved = {};
  try { saved = JSON.parse(await getMeta(env, 'settings', '{}')); } catch (e) {}
  return mergeSettings(DEFAULT_SETTINGS, saved);
}
async function settingsFor(env, me) {
  const base = await ownerSettings(env);
  if (me.role === 'owner') return base;
  let mine = {};
  try { mine = JSON.parse(await getMeta(env, 'settings:' + me.email, '{}')); } catch (e) {}
  return mergeSettings(base, mine);
}
async function saveSettingsFor(env, me, s) {
  if (me.role === 'owner') {
    const merged = mergeSettings(await ownerSettings(env), s);
    await env.DB.batch([setMetaStmt(env, 'settings', JSON.stringify(merged)), setMetaStmt(env, 'settings_dirty', '1')]);
    return merged;
  }
  const merged = mergeSettings(await settingsFor(env, me), s);
  await setMeta(env, 'settings:' + me.email, JSON.stringify(merged));
  return merged;
}

async function startSession(env, me, device) {
  const t = tzParts(new Date());
  const id = 'S' + t.year + t.month + t.day + '-' + t.hour + t.minute + t.second + '-' + Math.random().toString(36).slice(2, 5);
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO listen_sessions (id, user, device, started, last_beat, stopped, status, updated, dirty) VALUES (?, ?, ?, ?, ?, '', 'Running', ?, 1)`
  ).bind(id, me.email, String(device || 'Listener').slice(0, 60), now, now, Date.now()).run();
  return { sessionId: id, settings: await settingsFor(env, me) };
}

async function touchSession(env, me, id, stop) {
  const now = nowIso();
  const q = stop
    ? env.DB.prepare(`UPDATE listen_sessions SET last_beat = ?, stopped = ?, status = 'Stopped', updated = ?, dirty = 1 WHERE id = ? AND user = ?`).bind(now, now, Date.now(), String(id), me.email)
    : env.DB.prepare(`UPDATE listen_sessions SET last_beat = ?, updated = ?, dirty = 1 WHERE id = ? AND user = ?`).bind(now, Date.now(), String(id), me.email);
  await q.run();
  return true;
}

async function logEpisode(env, me, ep) {
  if (!ep || !/^E[\w-]+$/.test(String(ep.id))) throw new Error('Missing episode');
  if (await env.DB.prepare('SELECT 1 FROM episodes WHERE id = ?').bind(ep.id).first()) return { duplicate: true };
  const start = new Date(ep.start), end = new Date(ep.end);
  if (isNaN(start) || isNaN(end)) throw new Error('Bad episode times');
  const durMin = Math.max(0, (end - start) / 60000);
  const barkSec = Number(ep.barkSeconds) || 0;
  const density = durMin > 0 ? Math.min(100, (barkSec / (durMin * 60)) * 100) : 100;

  // Bark session: reuse the tag of the latest earlier burst if it ended within sessionGapMinutes.
  const gapMs = (Number((await settingsFor(env, me)).sessionGapMinutes) || 30) * 60000;
  const prev = await env.DB.prepare(
    'SELECT end, bark_session FROM episodes WHERE user = ? AND start <= ? ORDER BY end DESC LIMIT 1'
  ).bind(me.email, start.toISOString()).first();
  let tag;
  if (prev && prev.bark_session && start - new Date(prev.end) <= gapMs) tag = prev.bark_session;
  else { const t = tzParts(start); tag = `BS ${t.year}-${t.month}-${t.day} ${t.hour}:${t.minute}`; }

  await env.DB.prepare(
    `INSERT INTO episodes (id, user, start, end, duration_min, bark_seconds, density, peak_conf, avg_conf, peak_db,
       sustained, clips_url, clip_count, device, session_id, notes, bark_session, updated, dirty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, ?, ?, '', ?, ?, 1)`
  ).bind(ep.id, me.email, start.toISOString(), end.toISOString(), round(durMin, 2), barkSec, round(density, 1),
    round(ep.peakConf, 3), round(ep.avgConf, 3), round(ep.peakDb, 1), ep.sustained ? 1 : 0,
    String(ep.device || '').slice(0, 60), String(ep.sessionId || ''), tag, Date.now()).run();
  return { logged: true, barkSession: tag };
}

async function saveClip(env, me, episodeId, fileName, data, mimeType) {
  if (!/^E[\w-]+$/.test(String(episodeId))) throw new Error('Bad episode id');
  const bytes = Buffer.from(String(data || ''), 'base64');
  if (!bytes.length) throw new Error('Empty clip');
  if (bytes.length > 25 * 1024 * 1024) throw new Error('Clip too large');
  const name = safeName(fileName);
  const type = /^audio\//.test(String(mimeType)) ? String(mimeType).split(';')[0] : 'audio/mpeg';
  const key = `clips/${safeUser(me.email)}/${episodeId}/${name}`;
  await env.CLIPS.put(key, bytes, { httpMetadata: { contentType: type } });
  await env.DB.prepare(
    `INSERT INTO clips (key, user, episode_id, name, size, mime, created, in_r2) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET size = excluded.size, in_r2 = 1`
  ).bind(key, me.email, episodeId, name, bytes.length, type, nowIso()).run();
  return 'saved';
}

/* ================================================================ row <-> object
 * Objects use the same field names as the Apps Script sync code. */

const epToObj = (r) => ({
  id: r.id, user: r.user, start: r.start, end: r.end, durationMin: r.duration_min, barkSeconds: r.bark_seconds,
  density: r.density, peakConf: r.peak_conf, avgConf: r.avg_conf, peakDb: r.peak_db, sustained: !!r.sustained,
  clipsUrl: r.clips_url || '', clipCount: r.clip_count || 0, device: r.device || '', sessionId: r.session_id || '',
  notes: r.notes || '', barkSession: r.bark_session || '', updated: r.updated
});
const sesToObj = (r) => ({
  id: r.id, user: r.user, device: r.device || '', started: r.started || '', lastBeat: r.last_beat || '',
  stopped: r.stopped || '', status: r.status || '', updated: r.updated
});
const fbToObj = (r) => ({
  id: r.id, user: r.user, created: r.created, kind: r.kind, message: r.message, page: r.page || '',
  status: r.status || '', reply: r.reply || '', updated: r.updated
});
const userToObj = (r) => ({
  email: r.email, name: r.name, role: r.role, active: !!r.active, created: r.created || '',
  lastLogin: r.last_login || '', updated: r.updated
});
const num = (v) => (v === '' || v === null || v === undefined || isNaN(Number(v))) ? 0 : Number(v);
const str = (v) => (v === null || v === undefined) ? '' : String(v);

function upsertEpisode(env, o) {
  return env.DB.prepare(
    `INSERT INTO episodes (id, user, start, end, duration_min, bark_seconds, density, peak_conf, avg_conf, peak_db,
       sustained, clips_url, clip_count, device, session_id, notes, bark_session, updated, dirty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(id) DO UPDATE SET user = excluded.user, start = excluded.start, end = excluded.end,
       duration_min = excluded.duration_min, bark_seconds = excluded.bark_seconds, density = excluded.density,
       peak_conf = excluded.peak_conf, avg_conf = excluded.avg_conf, peak_db = excluded.peak_db,
       sustained = excluded.sustained, clips_url = excluded.clips_url, clip_count = excluded.clip_count,
       device = excluded.device, session_id = excluded.session_id, notes = excluded.notes,
       bark_session = excluded.bark_session, updated = excluded.updated, dirty = 0
     WHERE excluded.updated > episodes.updated`
  ).bind(str(o.id), str(o.user), str(o.start), str(o.end), num(o.durationMin), num(o.barkSeconds), num(o.density),
    num(o.peakConf), num(o.avgConf), num(o.peakDb), o.sustained ? 1 : 0, str(o.clipsUrl), num(o.clipCount),
    str(o.device), str(o.sessionId), str(o.notes), str(o.barkSession), num(o.updated));
}
function upsertSession(env, o) {
  return env.DB.prepare(
    `INSERT INTO listen_sessions (id, user, device, started, last_beat, stopped, status, updated, dirty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(id) DO UPDATE SET user = excluded.user, device = excluded.device, started = excluded.started,
       last_beat = excluded.last_beat, stopped = excluded.stopped, status = excluded.status,
       updated = excluded.updated, dirty = 0
     WHERE excluded.updated > listen_sessions.updated`
  ).bind(str(o.id), str(o.user), str(o.device), str(o.started), str(o.lastBeat), str(o.stopped), str(o.status), num(o.updated));
}
function upsertFeedback(env, o) {
  return env.DB.prepare(
    `INSERT INTO feedback (id, user, created, kind, message, page, status, reply, updated, dirty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, reply = excluded.reply, kind = excluded.kind,
       message = excluded.message, updated = excluded.updated, dirty = 0
     WHERE excluded.updated > feedback.updated`
  ).bind(str(o.id), normEmail(o.user), str(o.created), str(o.kind), str(o.message), str(o.page), str(o.status), str(o.reply), num(o.updated));
}
function updateUserFromSheet(env, o) {
  // Accounts are only created on Cloudflare. From the Sheet: name, and turning testers on/off.
  return env.DB.prepare(
    `UPDATE users SET name = ?, active = CASE WHEN role = 'owner' THEN 1 ELSE ? END, updated = ?, dirty = 0
     WHERE email = ? AND updated < ?`
  ).bind(str(o.name).slice(0, 60) || 'Tester', o.active ? 1 : 0, num(o.updated), normEmail(o.email), num(o.updated));
}

/* ================================================================ sync */

async function gas(env, action, payload) {
  const res = await fetch(env.APPS_SCRIPT_URL, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ key: env.APPS_SCRIPT_KEY, action }, payload || {}))
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error(`Apps Script ${action}: unexpected reply (HTTP ${res.status})`); }
  if (!j.ok) throw new Error(`Apps Script ${action}: ${j.error}`);
  return j.result;
}

let syncRunning = false;
async function runSync(env) {
  await ensureSchema(env);
  const st = { at: new Date().toISOString(), ok: false, pushed: 0, pulled: 0, clipsUp: 0, clipsDown: 0 };
  if (syncRunning) { st.error = 'A sync is already running.'; return st; }
  syncRunning = true;
  try {
    if (!env.APPS_SCRIPT_URL || !env.APPS_SCRIPT_KEY) throw new Error('Add the APPS_SCRIPT_URL and APPS_SCRIPT_KEY secrets in Cloudflare.');
    const owner = await env.DB.prepare(`SELECT email FROM users WHERE role = 'owner' LIMIT 1`).first();
    if (!owner) throw new Error('Create the owner account first.');
    const ownerEmail = owner.email;

    await pushRows(env, ownerEmail, st);
    await pullRows(env, ownerEmail, st);
    await clipsUp(env, ownerEmail, st);
    await clipsDown(env, ownerEmail, st);
    st.ok = true;
  } catch (e) {
    st.error = String(e && e.message || e);
  } finally {
    syncRunning = false;
    st.ms = Date.now() - Date.parse(st.at);
    try { await setMeta(env, 'sync_status', JSON.stringify(st)); } catch (e) {}
  }
  return st;
}

// 1. Cloudflare → Sheet: every row changed here since the last push.
async function pushRows(env, ownerEmail, st) {
  const lim = ROWS_PER_PUSH;
  const [eps, ses, fb, us] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM episodes WHERE dirty = 1 LIMIT ?').bind(lim),
    env.DB.prepare('SELECT * FROM listen_sessions WHERE dirty = 1 LIMIT ?').bind(lim),
    env.DB.prepare('SELECT * FROM feedback WHERE dirty = 1 LIMIT ?').bind(lim),
    env.DB.prepare('SELECT * FROM users WHERE dirty = 1 LIMIT ?').bind(lim)
  ]);
  const rows = {
    episodes: eps.results.map(epToObj), sessions: ses.results.map(sesToObj),
    feedback: fb.results.map(fbToObj), users: us.results.map(userToObj)
  };
  const settingsDirty = (await getMeta(env, 'settings_dirty')) === '1';
  const total = rows.episodes.length + rows.sessions.length + rows.feedback.length + rows.users.length;
  if (!total && !settingsDirty) return;

  const payload = { ownerEmail, rows };
  if (settingsDirty) payload.settings = await ownerSettings(env);
  await gas(env, 'syncPush', payload);

  // Clear the flag only if the row didn't change again while we were pushing.
  const clear = [];
  rows.episodes.forEach((o) => clear.push(env.DB.prepare('UPDATE episodes SET dirty = 0 WHERE id = ? AND updated = ?').bind(o.id, o.updated)));
  rows.sessions.forEach((o) => clear.push(env.DB.prepare('UPDATE listen_sessions SET dirty = 0 WHERE id = ? AND updated = ?').bind(o.id, o.updated)));
  rows.feedback.forEach((o) => clear.push(env.DB.prepare('UPDATE feedback SET dirty = 0 WHERE id = ? AND updated = ?').bind(o.id, o.updated)));
  rows.users.forEach((o) => clear.push(env.DB.prepare('UPDATE users SET dirty = 0 WHERE email = ? AND updated = ?').bind(o.email, o.updated)));
  if (settingsDirty) clear.push(setMetaStmt(env, 'settings_dirty', '0'));
  if (clear.length) await env.DB.batch(clear);
  st.pushed = total;
}

// 2. Sheet → Cloudflare: rows added or edited in the Sheet (including the GitHub demo's rows).
async function pullRows(env, ownerEmail, st) {
  const since = Number(await getMeta(env, 'pull_since', '0')) || 0;
  const r = await gas(env, 'syncPull', { since, ownerEmail });
  const stmts = [];
  let n = 0;
  const users = new Set((await env.DB.prepare('SELECT email FROM users').all()).results.map((u) => u.email));
  (r.rows.episodes || []).forEach((o) => { if (o.id && o.user) stmts.push(upsertEpisode(env, o)); });
  (r.rows.sessions || []).forEach((o) => { if (o.id && o.user) stmts.push(upsertSession(env, o)); });
  (r.rows.feedback || []).forEach((o) => { if (o.id && users.has(normEmail(o.user))) stmts.push(upsertFeedback(env, o)); });
  (r.rows.users || []).forEach((o) => { if (o.email) stmts.push(updateUserFromSheet(env, o)); });
  n = stmts.length;
  if (r.settings && (await getMeta(env, 'settings_dirty')) !== '1') {
    stmts.push(setMetaStmt(env, 'settings', JSON.stringify(mergeSettings(DEFAULT_SETTINGS, r.settings))));
  }
  stmts.push(setMetaStmt(env, 'pull_since', r.now));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  st.pulled = n;
}

// 3. Clips saved on Cloudflare (R2) → Google Drive.
async function clipsUp(env, ownerEmail, st) {
  const rows = (await env.DB.prepare(
    'SELECT * FROM clips WHERE drive_id IS NULL AND in_r2 = 1 AND tries < 6 ORDER BY created LIMIT ?'
  ).bind(CLIPS_PER_RUN).all()).results;
  for (const c of rows) {
    try {
      const obj = await env.CLIPS.get(c.key);
      if (!obj) { await env.DB.prepare('UPDATE clips SET in_r2 = 0 WHERE key = ?').bind(c.key).run(); continue; }
      const data = Buffer.from(await obj.arrayBuffer()).toString('base64');
      const res = await gas(env, 'syncClipUp', {
        user: c.user, owner: c.user === ownerEmail, episodeId: c.episode_id, name: c.name, mime: c.mime, data
      });
      await env.DB.prepare('UPDATE clips SET drive_id = ? WHERE key = ?').bind(res.fileId, c.key).run();
      st.clipsUp++;
    } catch (e) {
      await env.DB.prepare('UPDATE clips SET tries = tries + 1 WHERE key = ?').bind(c.key).run();
      st.clipError = String(e.message || e);
    }
  }
}

// 4. Clips saved in Google Drive (e.g. by the GitHub demo) → Cloudflare R2.
async function clipsDown(env, ownerEmail, st) {
  const since = Number(await getMeta(env, 'clip_since', '0')) || CLIP_SYNC_START;
  const list = await gas(env, 'syncClipList', { since: since - 3600000 });
  const known = new Set((await env.DB.prepare('SELECT drive_id FROM clips WHERE drive_id IS NOT NULL').all()).results.map((r) => r.drive_id));
  const users = new Set((await env.DB.prepare('SELECT email FROM users').all()).results.map((u) => u.email));
  const todo = (list.files || []).filter((f) => {
    if (known.has(f.id)) return false;
    f.owner = f.user === '' ? ownerEmail : normEmail(f.user);
    return users.has(f.owner) && /^E[\w-]+$/.test(String(f.episodeId));
  });
  for (const f of todo.slice(0, CLIPS_PER_RUN)) {
    const name = safeName(f.name);
    const key = `clips/${safeUser(f.owner)}/${f.episodeId}/${name}`;
    const existing = await env.DB.prepare('SELECT key FROM clips WHERE key = ?').bind(key).first();
    if (!existing) {
      const g = await gas(env, 'syncClipGet', { fileId: f.id });
      const bytes = Buffer.from(g.data, 'base64');
      const type = String(g.mime || f.mime || 'audio/mpeg').split(';')[0];
      await env.CLIPS.put(key, bytes, { httpMetadata: { contentType: type } });
      await env.DB.prepare(
        `INSERT INTO clips (key, user, episode_id, name, size, mime, created, drive_id, in_r2) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
      ).bind(key, f.owner, f.episodeId, name, bytes.length, type, str(f.created) || nowIso(), f.id).run();
      st.clipsDown++;
    } else {
      await env.DB.prepare('UPDATE clips SET drive_id = ? WHERE key = ?').bind(f.id, key).run();
    }
  }
  if (todo.length <= CLIPS_PER_RUN) await setMeta(env, 'clip_since', list.now);
  st.clipsDriveWaiting = Math.max(0, todo.length - CLIPS_PER_RUN);
}
