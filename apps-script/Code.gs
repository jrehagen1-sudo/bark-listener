/**
 * Bark Monitor — Google Apps Script back end + dashboard
 *
 *   GET  .../exec?key=SECRET   -> Dashboard website + PDF report
 *   POST .../exec              -> API used by the Listener page (hosted on GitHub Pages)
 *
 * Every request must carry the secret key. Run setup() once from the editor:
 * it creates the Sheet, the Drive folder and the key, and prints your links.
 */

const APP_NAME = 'Bark Monitor';
const SHEET_EPISODES = 'Episodes';
const SHEET_SESSIONS = 'Sessions';

const EPISODE_HEADERS = [
  'Episode ID', 'Start', 'End', 'Duration (min)', 'Bark seconds',
  'Bark density (%)', 'Peak confidence', 'Avg confidence', 'Peak level (dBFS)',
  'Sustained', 'Clips folder', 'Clip count', 'Device', 'Session ID', 'Notes', 'Bark session'
];
const SESSION_HEADERS = [
  'Session ID', 'Device', 'Started', 'Last heartbeat', 'Stopped', 'Status'
];

const DEFAULT_SETTINGS = {
  threshold: 0.25,          // minimum YAMNet score counted as a bark
  gapSeconds: 60,           // silence that ends an episode
  minBarks: 3,              // bark-seconds needed before a cluster is logged
  sustainedMinutes: 5,      // episodes this long are "sustained"
  clipMinutes: 5,           // keep first N and last N minutes of audio
  audioMinMinutes: 1,       // keep audio for episodes at least this long
  shortBurstWindowMinutes: 30, // also keep shorter bursts if barking returns within this time (0 = off)
  sessionGapMinutes: 30,    // bursts closer together than this belong to the same bark session
  incessantMinutes: 30,     // ordinance: continuous barking limit
  intermittentMinutes: 60,  // ordinance: total barking limit within the window
  windowHours: 24,          // ordinance: rolling window
  quietStart: 22,           // quiet hours start (24h clock)
  quietEnd: 7,              // quiet hours end
  preparedBy: '',
  monitoringLocation: '',
  subjectProperty: '',
  caseReference: '',
  ordinanceName: 'OC Animal Care barking ordinance',
  listenerUrl: ''           // GitHub Pages address of the Listener page
};

/* ------------------------------------------------------------------ setup */

/** Run once from the editor. Prints the key and your links in the Execution log. */
function setup() {
  const s = getStore_();
  const key = getKey_();
  const url = ScriptApp.getService().getUrl();
  Logger.log('Sheet:      ' + s.ss.getUrl());
  Logger.log('Clips:      ' + s.folder.getUrl());
  Logger.log('Secret key: ' + key);
  if (url) Logger.log('Dashboard:  ' + url + '?key=' + key);
  else Logger.log('Dashboard:  deploy the web app first, then run setup() again to see this link.');
}

/** Run only if the key leaks: makes a new key (update your bookmarks and Listener link). */
function resetKey() {
  PropertiesService.getScriptProperties().deleteProperty('API_KEY');
  setup();
}

function getKey_() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('API_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    props.setProperty('API_KEY', key);
  }
  return key;
}

function checkKey_(key) {
  if (!key || String(key) !== getKey_()) throw new Error('Wrong or missing key');
}

/* ------------------------------------------------------------------ web */

function doGet(e) {
  const key = e && e.parameter && e.parameter.key;
  if (!key || key !== getKey_()) {
    return HtmlService.createHtmlOutput(
      '<div style="font:16px system-ui;padding:24px;max-width:480px">' +
      '<h2>Bark Monitor</h2><p>This page needs your secret key. Open the dashboard link printed by ' +
      '<b>setup()</b> in the Apps Script editor.</p></div>')
      .setTitle(APP_NAME).addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  const store = getStore_();
  const t = HtmlService.createTemplateFromFile('Dashboard');
  t.appUrl = ScriptApp.getService().getUrl();
  t.apiKey = key;
  t.sheetUrl = store.ss.getUrl();
  t.folderUrl = store.folder.getUrl();
  return t.evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** API for the Listener page. Body: JSON {key, action, ...}. Returns JSON. */
function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkKey_(req.key);
    switch (req.action) {
      case 'settings':  out = getSettings_(); break;
      case 'saveSettings': out = saveSettings_(req.settings); break;
      case 'start':     out = startSession_(req.device); break;
      case 'heartbeat': out = heartbeat_(req.sessionId); break;
      case 'stop':      out = stopSession_(req.sessionId); break;
      case 'episode':   out = logEpisode_(req.episode); break;
      case 'clip':      out = saveClip_(req.episodeId, req.fileName, req.data, req.mimeType); break;
      case 'ping':      out = 'pong'; break;
      // Two-way sync with the Cloudflare demo (called by the Cloudflare Worker every 5 minutes).
      case 'syncPull':     out = syncPull_(Number(req.since) || 0, String(req.ownerEmail || '')); break;
      case 'syncPush':     out = syncPush_(req); break;
      case 'syncClipList': out = syncClipList_(Number(req.since) || 0); break;
      case 'syncClipGet':  out = syncClipGet_(req.fileId); break;
      case 'syncClipUp':   out = syncClipUp_(req); break;
      default: throw new Error('Unknown action: ' + req.action);
    }
    out = { ok: true, result: out };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* Functions the dashboard calls through google.script.run (key required). */
function getDashboardData(key) { checkKey_(key); return getDashboardData_(); }
function saveSettings(key, s) { checkKey_(key); return saveSettings_(s); }
function listWebmClips(key) { checkKey_(key); return listWebmClips_(); }
function getClipData(key, fileId) { checkKey_(key); return getClipData_(fileId); }
function saveMp3Copy(key, fileId, base64) { checkKey_(key); return saveMp3Copy_(fileId, base64); }
function listAudioClips(key) { checkKey_(key); return listAudioClips_(); }
function trashClips(key, ids) { checkKey_(key); return trashClips_(ids); }

/* ------------------------------------------------------------------ storage */

function getStore_() {
  const props = PropertiesService.getScriptProperties();
  let ss = null, folder = null;

  const ssId = props.getProperty('SHEET_ID');
  if (ssId) { try { ss = SpreadsheetApp.openById(ssId); } catch (err) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('Bark Monitor Log');
    ss.setSpreadsheetTimeZone(Session.getScriptTimeZone());
    props.setProperty('SHEET_ID', ss.getId());
  }
  ensureSheet_(ss, SHEET_EPISODES, EPISODE_HEADERS);
  ensureSheet_(ss, SHEET_SESSIONS, SESSION_HEADERS);
  const blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1) ss.deleteSheet(blank);

  const folderId = props.getProperty('FOLDER_ID');
  if (folderId) { try { folder = DriveApp.getFolderById(folderId); } catch (err) { folder = null; } }
  if (!folder) {
    folder = DriveApp.createFolder('Bark Monitor Clips');
    props.setProperty('FOLDER_ID', folder.getId());
  }
  return { ss: ss, folder: folder };
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#1f2a37').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ----------------------------------------------------------------- settings */

function getSettings_() {
  const raw = PropertiesService.getScriptProperties().getProperty('SETTINGS');
  const saved = raw ? JSON.parse(raw) : {};
  return Object.assign({}, DEFAULT_SETTINGS, saved);
}

function saveSettings_(s) {
  const merged = Object.assign({}, getSettings_());
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    if (s && s[k] !== undefined && s[k] !== null) {
      merged[k] = typeof DEFAULT_SETTINGS[k] === 'number' ? Number(s[k]) : String(s[k]);
    }
  });
  PropertiesService.getScriptProperties().setProperty('SETTINGS', JSON.stringify(merged));
  return merged;
}

/* ----------------------------------------------------------------- sessions */

function startSession_(device) {
  return withLock_(function () {
    const sh = getStore_().ss.getSheetByName(SHEET_SESSIONS);
    const id = 'S' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') +
      '-' + Math.random().toString(36).slice(2, 5);
    const now = new Date();
    sh.appendRow([id, String(device || 'Listener').slice(0, 60), now, now, '', 'Running']);
    return { sessionId: id, settings: getSettings_() };
  });
}

function heartbeat_(sessionId) {
  return withLock_(function () {
    const sh = getStore_().ss.getSheetByName(SHEET_SESSIONS);
    const row = findRow_(sh, sessionId);
    if (row) sh.getRange(row, 4).setValue(new Date());
    return true;
  });
}

function stopSession_(sessionId) {
  return withLock_(function () {
    const sh = getStore_().ss.getSheetByName(SHEET_SESSIONS);
    const row = findRow_(sh, sessionId);
    if (row) {
      const now = new Date();
      sh.getRange(row, 4, 1, 3).setValues([[now, now, 'Stopped']]);
    }
    return true;
  });
}

function findRow_(sh, id) {
  const last = sh.getLastRow();
  if (last < 2 || !id) return 0;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return 0;
}

/* ----------------------------------------------------------------- episodes */

/**
 * ep = {id, start, end (ISO strings), barkSeconds, peakConf, avgConf, peakDb,
 *       sustained (bool), device, sessionId}
 */
function logEpisode_(ep) {
  if (!ep || !ep.id) throw new Error('Missing episode');
  return withLock_(function () {
    const sh = getStore_().ss.getSheetByName(SHEET_EPISODES);
    if (findRow_(sh, ep.id)) return { duplicate: true };
    const start = new Date(ep.start), end = new Date(ep.end);
    const durMin = Math.max(0, (end - start) / 60000);
    const barkSec = Number(ep.barkSeconds) || 0;
    const density = durMin > 0 ? Math.min(100, (barkSec / (durMin * 60)) * 100) : 100;
    const tag = barkSessionTag_(sh, start);
    sh.appendRow([
      String(ep.id), start, end, round_(durMin, 2), barkSec,
      round_(density, 1), round_(ep.peakConf, 3), round_(ep.avgConf, 3),
      round_(ep.peakDb, 1), ep.sustained ? 'Yes' : 'No',
      '', 0, String(ep.device || '').slice(0, 60), String(ep.sessionId || ''), '', tag
    ]);
    return { logged: true, barkSession: tag };
  });
}

/**
 * Bark session tag for a burst starting at `start`: the tag of the latest earlier burst
 * if it ended within sessionGapMinutes, otherwise a new tag named after this start time.
 */
function barkSessionTag_(sh, start) {
  const col = EPISODE_HEADERS.length;
  if (sh.getRange(1, col).getValue() !== 'Bark session') {
    sh.getRange(1, col).setValue('Bark session').setFontWeight('bold').setBackground('#1f2a37').setFontColor('#ffffff');
  }
  const gapMs = (Number(getSettings_().sessionGapMinutes) || 30) * 60000;
  const last = sh.getLastRow();
  if (last >= 2) {
    const n = Math.min(200, last - 1);
    const rows = sh.getRange(last - n + 1, 1, n, col).getValues();
    let best = null;
    rows.forEach(function (r) {
      const s = r[1] instanceof Date ? r[1] : new Date(r[1]);
      const e = r[2] instanceof Date ? r[2] : new Date(r[2]);
      if (!(s <= start) || isNaN(e)) return;
      if (!best || e > best.end) best = { end: e, tag: String(r[col - 1] || '') };
    });
    if (best && best.tag && start - best.end <= gapMs) return best.tag;
  }
  return 'BS ' + Utilities.formatDate(start, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
}

/** Saves one audio segment (base64) into a per-episode subfolder. */
function saveClip_(episodeId, fileName, base64, mimeType) {
  if (!/^E[\w-]+$/.test(String(episodeId))) throw new Error('Bad episode id');
  const store = getStore_();
  const it = store.folder.getFoldersByName(episodeId);
  const sub = it.hasNext() ? it.next() : store.folder.createFolder(episodeId);
  const safeName = String(fileName || 'clip.webm').replace(/[^\w.-]/g, '_').slice(0, 80);
  const type = /^audio\//.test(String(mimeType)) ? String(mimeType).split(';')[0] : 'audio/webm';
  sub.createFile(Utilities.newBlob(Utilities.base64Decode(base64), type, safeName));

  withLock_(function () {
    const sh = store.ss.getSheetByName(SHEET_EPISODES);
    const row = findRow_(sh, episodeId);
    if (row) {
      const cnt = Number(sh.getRange(row, 12).getValue()) || 0;
      sh.getRange(row, 11, 1, 2).setValues([[sub.getUrl(), cnt + 1]]);
    }
  });
  return sub.getUrl();
}

/* ---------------------------------------------------------------- dashboard */

function getDashboardData_() {
  const store = getStore_();
  const tz = Session.getScriptTimeZone();
  const toIso = function (v) { return v instanceof Date ? v.toISOString() : (v ? String(v) : ''); };

  const eSh = store.ss.getSheetByName(SHEET_EPISODES);
  const eRows = eSh.getLastRow() > 1
    ? eSh.getRange(2, 1, eSh.getLastRow() - 1, EPISODE_HEADERS.length).getValues() : [];
  const episodes = eRows.filter(function (r) { return r[0]; }).map(function (r) {
    return {
      id: String(r[0]), start: toIso(r[1]), end: toIso(r[2]), durationMin: Number(r[3]) || 0,
      barkSeconds: Number(r[4]) || 0, density: Number(r[5]) || 0,
      peakConf: Number(r[6]) || 0, avgConf: Number(r[7]) || 0, peakDb: Number(r[8]) || 0,
      sustained: String(r[9]) === 'Yes', clipsUrl: String(r[10] || ''),
      clipCount: Number(r[11]) || 0, device: String(r[12] || ''), notes: String(r[14] || ''),
      barkSession: String(r[15] || '')
    };
  });

  const sSh = store.ss.getSheetByName(SHEET_SESSIONS);
  const sRows = sSh.getLastRow() > 1
    ? sSh.getRange(2, 1, sSh.getLastRow() - 1, SESSION_HEADERS.length).getValues() : [];
  const sessions = sRows.filter(function (r) { return r[0]; }).map(function (r) {
    return {
      id: String(r[0]), device: String(r[1]), start: toIso(r[2]),
      lastBeat: toIso(r[3]), stopped: toIso(r[4]), status: String(r[5])
    };
  });

  return {
    episodes: episodes, sessions: sessions, settings: getSettings_(), timeZone: tz,
    sheetUrl: store.ss.getUrl(), folderUrl: store.folder.getUrl(),
    generated: new Date().toISOString()
  };
}

/* ------------------------------------------------- WebM → MP3 conversion */

/** WebM clips in the clips folder's episode subfolders that don't have an MP3 copy yet. */
function listWebmClips_() {
  const store = getStore_();
  const out = [];
  const subs = store.folder.getFolders();
  while (subs.hasNext()) {
    const sub = subs.next();
    const names = {}, webm = [];
    const files = sub.getFiles();
    while (files.hasNext()) {
      const f = files.next();
      names[f.getName()] = true;
      if (/\.webm$/i.test(f.getName())) webm.push(f);
    }
    webm.forEach(function (f) {
      const mp3Name = f.getName().replace(/\.webm$/i, '.mp3');
      if (!names[mp3Name]) out.push({ id: f.getId(), name: f.getName(), folder: sub.getName(), size: f.getSize() });
    });
  }
  out.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  return out;
}

function clipFileInFolder_(fileId) {
  const f = DriveApp.getFileById(fileId);
  const parents = f.getParents();
  if (!parents.hasNext()) throw new Error('Clip has no folder');
  const parent = parents.next();
  const gp = parent.getParents();
  if (!gp.hasNext() || gp.next().getId() !== getStore_().folder.getId()) throw new Error('Not a Bark Monitor clip');
  return { file: f, folder: parent };
}

function getClipData_(fileId) {
  const c = clipFileInFolder_(fileId);
  return Utilities.base64Encode(c.file.getBlob().getBytes());
}

/** Saves an MP3 copy next to the original WebM (same name, .mp3). The original is kept. */
function saveMp3Copy_(fileId, base64) {
  const c = clipFileInFolder_(fileId);
  const name = c.file.getName().replace(/\.webm$/i, '.mp3');
  const existing = c.folder.getFilesByName(name);
  if (existing.hasNext()) return { skipped: true, name: name };
  c.folder.createFile(Utilities.newBlob(Utilities.base64Decode(base64), 'audio/mpeg', name));
  return { saved: true, name: name };
}

/* ------------------------------------------------- No-bark clip cleanup */

/** Every recording in the episode subfolders. A WebM and its MP3 copy count as one clip
 *  (checkId is the file the browser analyzes: the MP3 when there is one). */
function listAudioClips_() {
  const store = getStore_();
  const out = [];
  const subs = store.folder.getFolders();
  while (subs.hasNext()) {
    const sub = subs.next();
    const groups = {};
    const files = sub.getFiles();
    while (files.hasNext()) {
      const f = files.next(), m = f.getName().match(/^(.*)\.(mp3|webm)$/i);
      if (!m) continue;
      const g = groups[m[1]] || (groups[m[1]] = { name: m[1], folder: sub.getName(), ids: [], checkId: '', isMp3: false });
      g.ids.push(f.getId());
      if (/mp3/i.test(m[2])) { g.checkId = f.getId(); g.isMp3 = true; }
      else if (!g.isMp3) g.checkId = f.getId();
    }
    Object.keys(groups).forEach(function (k) { out.push(groups[k]); });
  }
  out.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  return out;
}

/** Moves clips to the Drive trash (restorable for 30 days). Only Bark Monitor clips are accepted. */
function trashClips_(ids) {
  let trashed = 0;
  (ids || []).forEach(function (id) {
    const c = clipFileInFolder_(id);
    c.file.setTrashed(true);
    trashed++;
  });
  return { trashed: trashed };
}

function round_(n, d) { const p = Math.pow(10, d); return Math.round((Number(n) || 0) * p) / p; }

/* ======================================================= Cloudflare sync
 * The Cloudflare Worker calls these every 5 minutes (see src/worker.js).
 * Each synced tab gets two hidden columns: "Updated" (ms) and "Sync hash". A row whose hash no
 * longer matches was edited in the Sheet, so it is stamped and sent to Cloudflare on the next pull.
 */

const SHEET_T_EPISODES = 'Tester Episodes';
const SHEET_T_SESSIONS = 'Tester Sessions';
const SHEET_FEEDBACK = 'Feedback';
const SHEET_TESTERS = 'Testers';
const SYNC_HEADERS = ['Updated', 'Sync hash'];

const SYNC_SPECS = {
  episodes: {
    fields: ['id', 'start', 'end', 'durationMin', 'barkSeconds', 'density', 'peakConf', 'avgConf', 'peakDb',
      'sustained', 'clipsUrl', 'clipCount', 'device', 'sessionId', 'notes', 'barkSession'],
    headers: EPISODE_HEADERS, dates: ['start', 'end'], bools: ['sustained'],
    sheetOwned: ['clipsUrl', 'clipCount'],   // set here when clips are saved; never overwritten from Cloudflare
    key: 'id', owner: SHEET_EPISODES, tester: SHEET_T_EPISODES
  },
  sessions: {
    fields: ['id', 'device', 'started', 'lastBeat', 'stopped', 'status'], headers: SESSION_HEADERS,
    dates: ['started', 'lastBeat', 'stopped'], bools: [], sheetOwned: [],
    key: 'id', owner: SHEET_SESSIONS, tester: SHEET_T_SESSIONS
  },
  feedback: {
    fields: ['id', 'user', 'created', 'kind', 'message', 'page', 'status', 'reply'],
    headers: ['ID', 'User', 'Created', 'Type', 'Message', 'Page', 'Status', 'Reply'],
    dates: ['created'], bools: [], sheetOwned: [], key: 'id', all: SHEET_FEEDBACK
  },
  users: {
    fields: ['email', 'name', 'role', 'active', 'created', 'lastLogin'],
    headers: ['Email', 'Name', 'Role', 'Active', 'Created', 'Last login'],
    dates: ['created', 'lastLogin'], bools: ['active'], sheetOwned: [], key: 'email', all: SHEET_TESTERS
  }
};

function syncLayouts_(spec) {
  const list = [];
  if (spec.all) list.push({ name: spec.all, userCol: false, kind: 'all' });
  if (spec.owner) list.push({ name: spec.owner, userCol: false, kind: 'owner' });
  if (spec.tester) list.push({ name: spec.tester, userCol: true, kind: 'tester' });
  return list;
}

function pickLayout_(spec, o, ownerEmail) {
  const lays = syncLayouts_(spec);
  if (spec.all) return lays[0];
  const own = String(o.user || '').toLowerCase() === ownerEmail;
  return lays.filter(function (l) { return l.kind === (own ? 'owner' : 'tester'); })[0];
}

/** Opens (or creates) a synced tab and makes sure its two hidden sync columns exist. */
function syncTab_(ss, spec, lay) {
  const headers = (lay.userCol ? ['User'] : []).concat(spec.headers);
  const n = headers.length;
  const sh = ensureSheet_(ss, lay.name, headers.concat(SYNC_HEADERS));
  if (sh.getMaxColumns() < n + 2) sh.insertColumnsAfter(sh.getMaxColumns(), n + 2 - sh.getMaxColumns());
  const cur = sh.getRange(1, n + 1, 1, 2).getValues()[0];
  if (cur[0] !== SYNC_HEADERS[0] || cur[1] !== SYNC_HEADERS[1]) {
    sh.getRange(1, n + 1, 1, 2).setValues([SYNC_HEADERS])
      .setFontWeight('bold').setBackground('#1f2a37').setFontColor('#ffffff');
  }
  if (!sh.isColumnHiddenByUser(n + 1)) sh.hideColumns(n + 1, 2);
  return { sh: sh, n: n, lay: lay, keyIdx: (lay.userCol ? 1 : 0) + spec.fields.indexOf(spec.key) };
}

function keyIndex_(t) {
  const idx = {};
  const last = t.sh.getLastRow();
  if (last >= 2) {
    t.sh.getRange(2, t.keyIdx + 1, last - 1, 1).getValues().forEach(function (r, i) {
      const k = String(r[0] || '').trim();
      if (k) idx[k] = i + 2;
    });
  }
  return idx;
}

function rowHash_(vals) {
  const s = JSON.stringify(vals.map(function (v) { return v instanceof Date ? v.toISOString() : v; }));
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8));
}

function rowToObj_(spec, t, r, ownerEmail) {
  const o = {};
  const off = t.lay.userCol ? 1 : 0;
  spec.fields.forEach(function (f, i) {
    let v = r[off + i];
    if (spec.dates.indexOf(f) >= 0) v = v instanceof Date ? v.toISOString() : (v ? String(v) : '');
    else if (spec.bools.indexOf(f) >= 0) v = /^(yes|true|1)$/i.test(String(v));
    else if (v instanceof Date) v = v.toISOString();
    o[f] = v;
  });
  if (t.lay.userCol) o.user = String(r[0] || '').trim().toLowerCase();
  else if (t.lay.kind === 'owner') o.user = ownerEmail;
  return o;
}

function objToRow_(spec, t, o) {
  const vals = t.lay.userCol ? [String(o.user || '')] : [];
  spec.fields.forEach(function (f) {
    let v = o[f];
    if (spec.dates.indexOf(f) >= 0) { const d = v ? new Date(v) : null; v = d && !isNaN(d) ? d : ''; }
    else if (spec.bools.indexOf(f) >= 0) v = v ? 'Yes' : 'No';
    else if (v === null || v === undefined) v = '';
    if (typeof v === 'string' && /^[=+\-@]/.test(v)) v = "'" + v;   // tester text never becomes a formula
    vals.push(v);
  });
  return vals;
}

/** Rows added or edited in the Sheet since `since` (ms), plus the owner's settings. */
function syncPull_(since, ownerEmail) {
  ownerEmail = String(ownerEmail || '').toLowerCase();
  return withLock_(function () {
    const ss = getStore_().ss;
    const now = Date.now();
    const rows = {};
    Object.keys(SYNC_SPECS).forEach(function (k) {
      const spec = SYNC_SPECS[k];
      rows[k] = [];
      syncLayouts_(spec).forEach(function (lay) {
        if (lay.kind === 'owner' && !ownerEmail) return;
        const t = syncTab_(ss, spec, lay);
        const last = t.sh.getLastRow();
        if (last < 2) return;
        const vals = t.sh.getRange(2, 1, last - 1, t.n + 2).getValues();
        let changed = false;
        const sync = vals.map(function (r) {
          const data = r.slice(0, t.n);
          if (!String(data[t.keyIdx] || '').trim()) return [r[t.n], r[t.n + 1]];
          let upd = Number(r[t.n]) || 0;
          let h = String(r[t.n + 1] || '');
          const nh = rowHash_(data);
          if (nh !== h) { h = nh; upd = now; changed = true; }
          if (upd > since) {
            const o = rowToObj_(spec, t, data, ownerEmail);
            o.updated = upd;
            rows[k].push(o);
          }
          return [upd, h];
        });
        if (changed) t.sh.getRange(2, t.n + 1, sync.length, 2).setValues(sync);
      });
    });
    return { now: now, settings: getSettings_(), rows: rows };
  });
}

/** Writes rows changed on Cloudflare. The newer "Updated" wins if both sides changed a row. */
function syncPush_(req) {
  const ownerEmail = String(req.ownerEmail || '').toLowerCase();
  return withLock_(function () {
    const ss = getStore_().ss;
    const tabs = {};
    let applied = 0, skipped = 0;
    Object.keys(SYNC_SPECS).forEach(function (k) {
      const spec = SYNC_SPECS[k];
      ((req.rows && req.rows[k]) || []).forEach(function (o) {
        const keyVal = String(o[spec.key] || '').trim();
        const lay = pickLayout_(spec, o, ownerEmail);
        if (!keyVal || !lay) return;
        let t = tabs[lay.name];
        if (!t) { t = tabs[lay.name] = syncTab_(ss, spec, lay); t.index = keyIndex_(t); }
        const vals = objToRow_(spec, t, o);
        let row = t.index[keyVal];
        if (row) {
          const cur = t.sh.getRange(row, 1, 1, t.n + 2).getValues()[0];
          if ((Number(cur[t.n]) || 0) > (Number(o.updated) || 0)) { skipped++; return; }
          spec.sheetOwned.forEach(function (f) {
            const i = (t.lay.userCol ? 1 : 0) + spec.fields.indexOf(f);
            vals[i] = cur[i];
          });
          t.sh.getRange(row, 1, 1, t.n).setValues([vals]);
        } else {
          t.sh.appendRow(vals);
          row = t.sh.getLastRow();
          t.index[keyVal] = row;
        }
        const back = t.sh.getRange(row, 1, 1, t.n).getValues()[0];
        t.sh.getRange(row, t.n + 1, 1, 2).setValues([[Number(o.updated) || Date.now(), rowHash_(back)]]);
        applied++;
      });
    });
    if (req.settings) saveSettings_(req.settings);
    return { applied: applied, skipped: skipped };
  });
}

function getTesterRoot_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('TESTER_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (err) { /* recreate below */ } }
  const f = DriveApp.createFolder('Bark Monitor Tester Clips');
  props.setProperty('TESTER_FOLDER_ID', f.getId());
  return f;
}

function subFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** {user: '' for the owner or the tester's email, episodeId} for a Bark Monitor clip, else null. */
function clipOwnerOf_(f, ownerId, testerRootId) {
  const ps = f.getParents();
  if (!ps.hasNext()) return null;
  const ep = ps.next();
  const gps = ep.getParents();
  if (!gps.hasNext()) return null;
  const gp = gps.next();
  if (gp.getId() === ownerId) return { user: '', episodeId: ep.getName() };
  const ggs = gp.getParents();
  if (ggs.hasNext() && ggs.next().getId() === testerRootId) return { user: gp.getName(), episodeId: ep.getName() };
  return null;
}

/** Clip files changed since `since` (ms). Clip names start with the episode id ("E2026…"). */
function syncClipList_(since) {
  const ownerId = getStore_().folder.getId();
  const testerRootId = getTesterRoot_().getId();
  const when = Utilities.formatDate(new Date(since), 'UTC', "yyyy-MM-dd'T'HH:mm:ss");
  const it = DriveApp.searchFiles(
    "title contains 'E20' and mimeType contains 'audio/' and trashed = false and modifiedDate > '" + when + "'");
  const files = [];
  while (it.hasNext() && files.length < 300) {
    const f = it.next();
    const c = clipOwnerOf_(f, ownerId, testerRootId);
    if (!c) continue;
    files.push({
      id: f.getId(), name: f.getName(), episodeId: c.episodeId, user: c.user,
      size: f.getSize(), mime: f.getMimeType(), created: f.getDateCreated().toISOString()
    });
  }
  return { now: Date.now(), files: files, more: it.hasNext() };
}

function syncClipGet_(fileId) {
  const f = DriveApp.getFileById(String(fileId));
  if (!clipOwnerOf_(f, getStore_().folder.getId(), getTesterRoot_().getId())) throw new Error('Not a Bark Monitor clip');
  return { name: f.getName(), mime: f.getMimeType(), data: Utilities.base64Encode(f.getBlob().getBytes()) };
}

/** Saves a clip recorded on Cloudflare into Drive and updates its episode row's clip link and count. */
function syncClipUp_(req) {
  if (!/^E[\w-]+$/.test(String(req.episodeId))) throw new Error('Bad episode id');
  const name = String(req.name || 'clip.mp3').replace(/[^\w.-]/g, '_').slice(0, 80);
  const type = /^audio\//.test(String(req.mime)) ? String(req.mime).split(';')[0] : 'audio/mpeg';
  const store = getStore_();
  let parent = store.folder;
  if (!req.owner) {
    const u = String(req.user || '').replace(/[^\w@.+-]/g, '_').slice(0, 120);
    if (!u) throw new Error('Missing user');
    parent = subFolder_(getTesterRoot_(), u);
  }
  const sub = subFolder_(parent, String(req.episodeId));
  const existing = sub.getFilesByName(name);
  const file = existing.hasNext() ? existing.next()
    : sub.createFile(Utilities.newBlob(Utilities.base64Decode(String(req.data || '')), type, name));

  let count = 0;
  const all = sub.getFiles();
  while (all.hasNext()) { if (/^audio\//.test(all.next().getMimeType())) count++; }

  withLock_(function () {
    const spec = SYNC_SPECS.episodes;
    const lay = syncLayouts_(spec).filter(function (l) { return l.kind === (req.owner ? 'owner' : 'tester'); })[0];
    const t = syncTab_(store.ss, spec, lay);
    const row = keyIndex_(t)[String(req.episodeId)];
    if (row) {
      const off = t.lay.userCol ? 1 : 0;
      t.sh.getRange(row, off + spec.fields.indexOf('clipsUrl') + 1, 1, 2).setValues([[sub.getUrl(), count]]);
    }
  });
  return { fileId: file.getId() };
}
