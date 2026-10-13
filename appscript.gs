/**
 * assistant-inbox backend
 * Ori's phone writes lines here; the morning brief reads them and marks them as seen.
 *
 * Access: every action except ping/requestPair/pair needs a device key.
 * The key is generated on the device and never leaves it except in request bodies;
 * only its SHA-256 hash is kept here (Script Properties → DEVICES).
 * A new device pairs with a 6-digit code emailed to the script owner.
 * After 10 wrong codes since the last pairing, pairing locks until unlockPairing is run from the editor.
 * The owner gets an email for every new device and for the lock.
 *
 * All requests: POST, Content-Type text/plain, body = JSON { action, key, ...params }.
 */

const SHEET_ID = '1gj_u_xEtOwRDndMBtNj18qZrUvTq4FreBHpZG_DY9X0';
const OWNER_EMAIL = 'ori@42creative.co.il';
const TZ = 'Asia/Jerusalem';

// Schema (sheet "תיבה"): id(0), נכתב(1), טקסט(2), תזכורת(3), מצב(4), נקלט_ב(5)
const INBOX = 'תיבה';
const INBOX_HEADERS = ['id', 'נכתב', 'טקסט', 'תזכורת', 'מצב', 'נקלט ב'];
const ST_NEW = 'חדש', ST_SEEN = 'נקלט', ST_CANCEL = 'בוטל';

// Sheet "חיבור": the pending pairing code, so it can also be read from the Sheets app.
const PAIR_SHEET = 'חיבור';

const PAIR_TTL_MS = 10 * 60 * 1000;
const PAIR_MAX_TRIES = 5;
// Wrong codes since the last successful pairing, across all codes. Script Properties, not the cache,
// because the cache forgets after 6 hours at most.
const PAIR_MAX_FAILS = 10;
const PAIR_LOCKED_MSG = 'חיבור מכשירים חדשים נעול (יותר מדי קודים שגויים)';
const MAX_TEXT = 2000;

// ───────────────────────── router ─────────────────────────

function doGet(e) {
  // Only a health check over GET. Data never goes through query strings.
  return jsonResponse({ success: true, message: 'ok' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonResponse({ success: false, message: 'bad json' });
  }
  try {
    switch (req.action) {
      case 'ping': return jsonResponse({ success: true });
      case 'requestPair': return jsonResponse(requestPair(req));
      case 'pair': return jsonResponse(pair(req));
    }
    const device = checkDevice(req.key);
    if (!device) return jsonResponse({ success: false, message: 'unauthorized', unauthorized: true });
    switch (req.action) {
      case 'add': return jsonResponse(addItem(req));
      case 'list': return jsonResponse(listItems(req));
      case 'cancel': return jsonResponse(cancelItem(req));
      case 'markSeen': return jsonResponse(markSeen(req));
      case 'purgeTests': return jsonResponse(purgeTests(req));
      case 'unpair': return jsonResponse(unpairSelf(req));
      default: return jsonResponse({ success: false, message: 'Unknown action: ' + req.action });
    }
  } catch (err) {
    return jsonResponse({ success: false, message: err.toString() });
  }
}

// ───────────────────────── devices ─────────────────────────

function sha256(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function getDevices() {
  return JSON.parse(PropertiesService.getScriptProperties().getProperty('DEVICES') || '{}');
}

function checkDevice(key) {
  if (!key || String(key).length < 32) return null;
  const devices = getDevices();
  return devices[sha256(key)] || null;
}

function pairingLocked(props) {
  return Number(props.getProperty('PAIR_FAILS') || 0) >= PAIR_MAX_FAILS;
}

function requestPair(req) {
  if (pairingLocked(PropertiesService.getScriptProperties())) return { success: false, message: PAIR_LOCKED_MSG };
  const cache = CacheService.getScriptCache();
  if (cache.get('pair_rl')) return { success: false, message: 'נשלח קוד לפני פחות מדקה' };
  const today = fmt(new Date(), 'yyyyMMdd');
  const count = Number(cache.get('pair_day_' + today) || 0);
  if (count >= 10) return { success: false, message: 'יותר מדי בקשות היום' };
  cache.put('pair_rl', '1', 60);
  cache.put('pair_day_' + today, String(count + 1), 21600);

  const code = String(Math.floor(100000 + Math.random() * 900000));
  PropertiesService.getScriptProperties().setProperty('PAIR', JSON.stringify({
    hash: sha256(code), exp: Date.now() + PAIR_TTL_MS, tries: 0
  }));
  const sh = ensureSheet(PAIR_SHEET, ['קוד חיבור', 'בתוקף עד']);
  sh.getRange(2, 1, 1, 2).setValues([[code, fmt(new Date(Date.now() + PAIR_TTL_MS), 'dd/MM/yyyy HH:mm')]]);

  if (req.mail) {
    MailApp.sendEmail({
      to: OWNER_EMAIL,
      subject: 'קוד חיבור לתיבת המשימות: ' + code,
      body: 'הקוד לחיבור מכשיר חדש לתיבת המשימות: ' + code + '\nבתוקף 10 דקות.\n\nלא ביקשת? אפשר להתעלם.'
    });
  }
  return { success: true };
}

function pair(req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const props = PropertiesService.getScriptProperties();
    if (pairingLocked(props)) return { success: false, message: PAIR_LOCKED_MSG };
    const p = JSON.parse(props.getProperty('PAIR') || 'null');
    if (!p || Date.now() > p.exp || p.tries >= PAIR_MAX_TRIES) {
      return { success: false, message: 'הקוד פג. צריך לבקש קוד חדש' };
    }
    if (sha256(String(req.code || '').trim()) !== p.hash) {
      p.tries++;
      props.setProperty('PAIR', JSON.stringify(p));
      const fails = Number(props.getProperty('PAIR_FAILS') || 0) + 1;
      props.setProperty('PAIR_FAILS', String(fails));
      if (fails >= PAIR_MAX_FAILS) {
        lockPairing(props);
        return { success: false, message: PAIR_LOCKED_MSG };
      }
      return { success: false, message: 'קוד שגוי' };
    }
    if (!req.key || String(req.key).length < 32) return { success: false, message: 'מפתח לא תקין' };
    const devices = getDevices();
    const name = String(req.name || 'מכשיר').slice(0, 60);
    const since = fmt(new Date(), 'dd/MM/yyyy HH:mm');
    devices[sha256(req.key)] = { name, since };
    props.setProperty('DEVICES', JSON.stringify(devices));
    props.deleteProperty('PAIR');
    props.deleteProperty('PAIR_FAILS');
    const sh = ensureSheet(PAIR_SHEET, ['קוד חיבור', 'בתוקף עד']);
    sh.getRange(2, 1, 1, 2).clearContent();
    mailOwner('מכשיר חדש התחבר לתיבת המשימות: ' + name,
      'מכשיר חדש התחבר לתיבת המשימות: ' + name + ', ' + since + '.\n\n' +
      'לא אתה? להריץ resetDevices ב-Apps Script של השיטס. זה מנתק את כל המכשירים, ואז מחברים מחדש את שלך.');
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

/** Disconnects the calling device. */
function unpairSelf(req) {
  const devices = getDevices();
  delete devices[sha256(req.key)];
  PropertiesService.getScriptProperties().setProperty('DEVICES', JSON.stringify(devices));
  return { success: true };
}

/** Run by hand from the editor to disconnect all devices. */
function resetDevices() {
  PropertiesService.getScriptProperties().deleteProperty('DEVICES');
}

function lockPairing(props) {
  props.deleteProperty('PAIR');
  ensureSheet(PAIR_SHEET, ['קוד חיבור', 'בתוקף עד']).getRange(2, 1, 1, 2).clearContent();
  mailOwner('תיבת המשימות: חיבור מכשירים חדשים ננעל',
    'מאז החיבור האחרון היו ' + PAIR_MAX_FAILS + ' ניסיונות עם קוד שגוי, אז חיבור מכשירים חדשים ננעל. ' +
    'המכשירים שכבר מחוברים ממשיכים לעבוד.\n\nאם זה לא היית אתה, מישהו ניסה לנחש קוד.\n' +
    'כדי לשחרר: לפתוח את Apps Script מתוך השיטס ולהריץ unlockPairing.');
}

/** Run by hand from the editor to allow pairing again after the lock. */
function unlockPairing() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('PAIR_FAILS');
  props.deleteProperty('PAIR');
}

// Best effort: a failed mail must not undo a pairing that already happened.
function mailOwner(subject, body) {
  try {
    MailApp.sendEmail({ to: OWNER_EMAIL, subject, body });
  } catch (err) {
    console.error('mail failed: ' + err);
  }
}

// ───────────────────────── inbox ─────────────────────────

function inboxSheet() {
  return ensureSheet(INBOX, INBOX_HEADERS);
}

function findRow(sh, id) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const hit = sh.getRange(2, 1, last - 1, 1).createTextFinder(String(id)).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}

function addItem(req) {
  const id = String(req.id || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);
  const text = String(req.text || '').trim().slice(0, MAX_TEXT);
  if (!id || !text) return { success: false, message: 'חסר טקסט' };
  const remind = /^\d{2}\/\d{2}\/\d{4}$/.test(req.remind || '') ? req.remind : '';
  const created = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(req.created || '') ? req.created : fmt(new Date(), 'dd/MM/yyyy HH:mm');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = inboxSheet();
    if (findRow(sh, id)) return { success: true, duplicate: true }; // retries from the offline queue
    // A leading = or + would turn the line into a formula.
    const safe = /^[=+\-@]/.test(text) ? "'" + text : text;
    sh.appendRow([id, created, safe, remind, ST_NEW, '']);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

function listItems(req) {
  const sh = inboxSheet();
  const last = sh.getLastRow();
  if (last < 2) return { success: true, items: [] };
  const n = Math.min(Number(req.limit) || 20, 50);
  const start = Math.max(2, last - n + 1);
  const rows = sh.getRange(start, 1, last - start + 1, 6).getDisplayValues();
  const items = rows.reverse().map(r => ({
    id: r[0], created: r[1], text: r[2], remind: r[3], status: r[4], seenAt: r[5]
  }));
  return { success: true, items };
}

function cancelItem(req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = inboxSheet();
    const row = findRow(sh, req.id);
    if (!row) return { success: true, missing: true };
    const status = sh.getRange(row, 5).getValue();
    if (status === ST_SEEN) return { success: false, message: 'כבר נקלט', status };
    sh.getRange(row, 5).setValue(ST_CANCEL);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

function markSeen(req) {
  const ids = [].concat(req.ids || []).map(String);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = inboxSheet();
    const now = fmt(new Date(), 'dd/MM/yyyy HH:mm');
    let marked = 0;
    ids.forEach(id => {
      const row = findRow(sh, id);
      if (!row) return;
      if (sh.getRange(row, 5).getValue() !== ST_NEW) return;
      sh.getRange(row, 5, 1, 2).setValues([[ST_SEEN, now]]);
      marked++;
    });
    return { success: true, marked };
  } finally {
    lock.releaseLock();
  }
}

/** Hard-deletes rows whose id starts with "test-", or listed in ids (used while building and checking). */
function purgeTests(req) {
  const extra = [].concat((req && req.ids) || []).map(String);
  const sh = inboxSheet();
  const last = sh.getLastRow();
  let removed = 0;
  if (last < 2) return { success: true, removed };
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = String(ids[i][0]);
    if (id.indexOf('test-') === 0 || extra.indexOf(id) >= 0) { sh.deleteRow(i + 2); removed++; }
  }
  return { success: true, removed };
}

// ───────────────────────── helpers ─────────────────────────

function getSpreadsheet() {
  return SpreadsheetApp.openById(SHEET_ID);
}

function ensureSheet(name, headers) {
  const ss = getSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.setRightToLeft(true);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // Plain text everywhere: dates stay exactly as written, no auto-conversion.
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
  }
  return sh;
}

function fmt(d, pattern) {
  return Utilities.formatDate(d, TZ, pattern);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Run once from the editor to approve permissions and build the sheets. */
function setup() {
  inboxSheet();
  ensureSheet(PAIR_SHEET, ['קוד חיבור', 'בתוקף עד']);
  const first = getSpreadsheet().getSheetByName('Sheet1') || getSpreadsheet().getSheetByName('גיליון1');
  if (first && getSpreadsheet().getSheets().length > 1) getSpreadsheet().deleteSheet(first);
  MailApp.getRemainingDailyQuota(); // pulls the mail scope into the consent screen
}
