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
  minBarks: 2,              // bark-seconds needed before a cluster is logged
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

function round_(n, d) { const p = Math.pow(10, d); return Math.round((Number(n) || 0) * p) / p; }
