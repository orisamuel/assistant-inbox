// assistant-inbox: phone → Google Sheet. Offline-first: every line goes to a local queue,
// then to the Apps Script backend whenever there is network.
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwPIplTyvr0gUPlPTsVMVOL1WcgGw-sc_3GNUQI0MpcEZDFskeMRpskI1nJiyaR7AJP/exec';
const KEY_LS = 'inbox.key';
const ITEMS_LS = 'inbox.items';
const KEEP = 20;

const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};

let key = store.get(KEY_LS, null);
// item: { id, text, remind, created, ts, status: 'חדש'|'נקלט'|'בוטל'|null, op: 'add'|'cancel'|null }
let items = store.get(ITEMS_LS, []);
const save = () => store.set(ITEMS_LS, items);

// ───────── dates ─────────
const pad = n => String(n).padStart(2, '0');
const dmy = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const stamp = d => `${dmy(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayNames = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function parseDmy(s) { const [d, m, y] = s.split('/').map(Number); return new Date(y, m - 1, d); }
function niceDate(s) {
  const d = parseDmy(s), diff = Math.round((d - startOfToday()) / 864e5);
  if (diff === 0) return 'היום';
  if (diff === 1) return 'מחר';
  return `יום ${dayNames[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;
}

// "15/11", "15.11", "15/11/26" anywhere in the text, or the word "מחר".
function detectDate(text) {
  const m = text.match(/(?:^|[\s(])(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?(?=$|[\s,.:)])/);
  if (m) {
    const day = +m[1], mon = +m[2];
    if (day >= 1 && day <= 31 && mon >= 1 && mon <= 12) {
      let year = m[3] ? +m[3] : new Date().getFullYear();
      if (year < 100) year += 2000;
      let d = new Date(year, mon - 1, day);
      if (d.getDate() !== day) return null;
      if (!m[3] && d < startOfToday()) d = new Date(year + 1, mon - 1, day);
      return dmy(d);
    }
  }
  if (/(^|\s)מחר($|[\s,.])/.test(text)) { const d = startOfToday(); d.setDate(d.getDate() + 1); return dmy(d); }
  return null;
}

// ───────── compose ─────────
const ta = $('text'), sendBtn = $('send'), note = $('remindNote');
let manual = null;      // 'dd/MM/yyyy' chosen with a chip
let autoOff = false;    // user dismissed the date found in the text

function currentRemind() {
  if (manual) return { date: manual, auto: false };
  if (autoOff) return null;
  const d = detectDate(ta.value);
  return d ? { date: d, auto: true } : null;
}

function renderCompose() {
  sendBtn.disabled = !ta.value.trim();
  const r = currentRemind();
  const today = dmy(startOfToday());
  const t = startOfToday(); t.setDate(t.getDate() + 1);
  const tomorrow = dmy(t);
  const cur = r ? r.date : null;
  document.querySelector('[data-when=today]').setAttribute('aria-pressed', String(cur === today));
  document.querySelector('[data-when=tomorrow]').setAttribute('aria-pressed', String(cur === tomorrow));
  const picked = manual && manual !== today && manual !== tomorrow;
  $('pickChip').setAttribute('aria-pressed', String(!!picked));
  $('pickLabel').textContent = picked ? niceDate(manual) : 'תאריך…';
  if (r) {
    note.innerHTML = '';
    note.append(`תזכורת: ${niceDate(r.date)}${r.auto ? ' (מהטקסט)' : ''}`);
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = 'בלי';
    b.onclick = () => { if (r.auto) autoOff = true; manual = null; $('pick').value = ''; renderCompose(); ta.focus(); };
    note.append(' ', b);
  } else note.textContent = '';
}

document.querySelectorAll('[data-when]').forEach(btn => btn.addEventListener('click', () => {
  const d = startOfToday();
  if (btn.dataset.when === 'tomorrow') d.setDate(d.getDate() + 1);
  const v = dmy(d), r = currentRemind();
  if (r && r.date === v) { manual = null; if (r.auto) autoOff = true; }
  else manual = v;
  renderCompose(); ta.focus();
}));
$('pick').addEventListener('click', e => { try { e.target.showPicker(); } catch {} });
$('pick').addEventListener('change', e => {
  const v = e.target.value; // yyyy-mm-dd
  manual = v ? v.split('-').reverse().join('/') : null;
  renderCompose(); ta.focus();
});
ta.addEventListener('input', () => { if (!ta.value.trim()) autoOff = false; renderCompose(); });
// Enter is a new line inside the task; sending is the button. Ctrl/Cmd+Enter sends from a computer keyboard.
ta.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); submit(); }
});
$('form').addEventListener('submit', e => { e.preventDefault(); submit(); });

function uid() {
  const a = new Uint8Array(6); crypto.getRandomValues(a);
  return Date.now().toString(36) + '-' + [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

function submit() {
  const text = ta.value.trim();
  if (!text) return;
  const r = currentRemind();
  const now = new Date();
  items.unshift({ id: uid(), text, remind: r ? r.date : '', created: stamp(now), ts: now.getTime(), status: null, op: 'add' });
  save();
  ta.value = ''; manual = null; autoOff = false; $('pick').value = '';
  renderCompose(); renderList(); ta.focus();
  toast(navigator.onLine ? 'נשמר' : 'נשמר. יישלח כשתחזור רשת');
  flush();
}

// ───────── list ─────────
function renderList() {
  const ul = $('list');
  ul.innerHTML = '';
  const shown = items.filter(i => i.status !== 'בוטל').slice(0, KEEP);
  if (!shown.length) { ul.innerHTML = '<li class="empty">עוד לא נשלח כלום.</li>'; }
  for (const it of shown) {
    const li = document.createElement('li');
    const body = document.createElement('div'); body.className = 'txt';
    body.textContent = it.text;
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.textContent = it.created.slice(0, 5) + ' ' + it.created.slice(11) + (it.remind ? ` · תזכורת ${niceDate(it.remind)}` : '');
    body.append(meta);
    const st = document.createElement('div'); st.className = 'st';
    if (it.op === 'add') st.textContent = '⏱ בתור';
    else if (it.status === 'נקלט') { st.textContent = '✓✓ נקלט'; st.classList.add('seen'); }
    else st.textContent = '✓ נשלח';
    li.append(body, st);
    if (it.status !== 'נקלט') {
      const x = document.createElement('button');
      x.className = 'x'; x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'ביטול');
      x.onclick = () => cancel(it.id);
      li.append(x);
    }
    ul.append(li);
  }
  const pending = items.filter(i => i.op).length;
  $('syncNote').textContent = pending ? (navigator.onLine ? `שולח ${pending}…` : `${pending} בתור, אין רשת`) : '';
}

function cancel(id) {
  const it = items.find(i => i.id === id);
  if (!it || !confirm('לבטל את השורה?\n\n' + it.text)) return;
  if (it.op === 'add') items = items.filter(i => i.id !== id); // never left the phone
  else { it.op = 'cancel'; it.status = 'בוטל'; }
  save(); renderList(); flush();
}

// ───────── network ─────────
async function api(action, params = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(SCRIPT_URL, {
      method: 'POST', redirect: 'follow', signal: ctrl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, key, ...params })
    });
    const data = await res.json();
    if (data.unauthorized) { unpair(); throw new Error('unauthorized'); }
    return data;
  } finally { clearTimeout(timer); }
}

let flushing = false, retryTimer = null;
async function flush() {
  if (flushing || !key) return;
  flushing = true; renderList();
  try {
    // oldest first, so the sheet keeps the writing order
    for (const it of items.filter(i => i.op).reverse()) {
      if (it.op === 'add') {
        const r = await api('add', { id: it.id, text: it.text, remind: it.remind, created: it.created });
        if (r.success) { it.op = null; it.status = 'חדש'; }
        else { toast('שגיאה: ' + (r.message || '')); break; }
      } else if (it.op === 'cancel') {
        const r = await api('cancel', { id: it.id });
        if (r.success) it.op = null;
        else { it.op = null; it.status = r.status || 'נקלט'; toast(r.message || 'לא בוטל'); }
      }
      save();
    }
  } catch (e) {
    // offline or timeout: try again soon
  } finally {
    flushing = false; renderList();
    clearTimeout(retryTimer);
    if (items.some(i => i.op)) retryTimer = setTimeout(flush, 15000);
  }
}

async function refresh() {
  if (!key) return;
  try {
    const r = await api('list', { limit: KEEP });
    if (!r.success) return;
    const local = new Map(items.map(i => [i.id, i]));
    const merged = r.items.map(s => {
      const l = local.get(s.id);
      if (l && l.op) return l;
      return { id: s.id, text: s.text, remind: s.remind, created: s.created, ts: l ? l.ts : 0, status: s.status, op: null };
    });
    const onServer = new Set(r.items.map(s => s.id));
    const pendingOnly = items.filter(i => i.op && !onServer.has(i.id));
    items = [...pendingOnly, ...merged].slice(0, KEEP * 2);
    save(); renderList();
  } catch {}
}

// ───────── pairing ─────────
function show(view) {
  $('mainView').hidden = view !== 'main';
  $('pairView').hidden = view !== 'pair';
}
function unpair() { key = null; store.del(KEY_LS); show('pair'); }

async function requestCode() {
  const b = $('reqCode'); b.disabled = true;
  try {
    const r = await api('requestPair', { mail: true });
    if (r.success) { $('codeBox').hidden = false; b.hidden = true; $('code').focus(); toast('הקוד נשלח למייל'); }
    else toast(r.message || 'לא הצליח');
  } catch { toast('אין חיבור'); }
  b.disabled = false;
}
$('reqCode').onclick = requestCode;
$('reqAgain').onclick = requestCode;
$('code').addEventListener('input', e => { if (e.target.value.replace(/\D/g, '').length === 6) doPair(); });
$('doPair').onclick = doPair;

async function doPair() {
  const code = $('code').value.replace(/\D/g, '');
  if (code.length !== 6) return;
  const a = new Uint8Array(32); crypto.getRandomValues(a);
  const newKey = [...a].map(b => b.toString(16).padStart(2, '0')).join('');
  const ua = navigator.userAgent;
  const name = /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : 'מכשיר';
  try {
    const r = await api('pair', { code, key: newKey, name });
    if (!r.success) { toast(r.message || 'לא הצליח'); $('code').select(); return; }
    key = newKey; store.set(KEY_LS, key);
    show('main'); ta.focus(); toast('מחובר'); refresh();
  } catch { toast('אין חיבור'); }
}

// ───────── start ─────────
function start() {
  renderCompose(); renderList();
  if (!key) { show('pair'); return; }
  show('main'); ta.focus();
  flush().then(refresh);
}
window.addEventListener('online', () => { renderList(); flush(); });
window.addEventListener('offline', renderList);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && key) { ta.focus(); flush().then(refresh); }
});
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2200);
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
start();
