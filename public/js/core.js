'use strict';
// A missing element must never take the whole page down: $ warns and returns a
// detached stub so later listeners still register. window.onerror surfaces the
// rest in a banner, because a silently dead UI is the worst failure mode.
const MISSING = [];
function $(sel) {
  const el = document.querySelector(sel);
  if (el) return el;
  MISSING.push(sel);
  console.warn('Maestro: no element matches', sel);
  return document.createElement('div');
}
const SEEN = new Set();
function fatal(msg, plain) {
  if (SEEN.has(msg)) return;            // one identical error is enough
  SEEN.add(msg);
  const bar = document.getElementById('crash');
  if (bar) { bar.textContent = (plain ? '' : 'Maestro UI error - ') + msg; bar.classList.add('show'); }
}
window.addEventListener('error', (e) => fatal(`${e.message} (${(e.filename||'').split('/').pop()}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => fatal(String(e.reason && e.reason.message || e.reason)));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const SERVED = location.protocol === 'http:' || location.protocol === 'https:';
function netHint() {
  return SERVED
    ? `Cannot reach the Maestro server at ${location.origin}. Is it still running? Start it with: node server.js`
    : 'This page was opened straight from the filesystem, so it has no server to talk to. Run node server.js and open the address it prints.';
}
// When the server stops answering, poll until it returns and recover on its own
// rather than leaving a dead page and a scary message.
let reconnecting = false;
async function watchForServer() {
  if (reconnecting || !SERVED) return;
  reconnecting = true;
  const bar = document.getElementById('crash');
  if (bar) { bar.textContent = 'Lost contact with the Maestro server - retrying…'; bar.classList.add('show'); }
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (r.ok) {
        if (bar) bar.classList.remove('show');
        reconnecting = false;
        SEEN.clear();
        toast('Reconnected');
        loadSessions().catch(() => {});
        return;
      }
    } catch { /* still down */ }
  }
  reconnecting = false;
  if (bar) bar.textContent = 'Maestro server is still unreachable. Restart it with: node server.js';
}

const api = async (url, opts) => {
  let r;
  try { r = await fetch(url, opts); }
  catch (e1) {
    // A stale keep-alive socket fails instantly and a fresh one succeeds, so
    // retry once before blaming the server. Only for reads - never replay a
    // write, which could launch a session or save a file twice.
    const method = (opts && opts.method) || 'GET';
    if (method === 'GET') {
      try { r = await fetch(url, { ...opts, cache: 'no-store' }); }
      catch { watchForServer(); throw new Error(netHint()); }
    } else {
      // Confirm the server is really gone before reporting it as unreachable.
      let alive = false;
      try { alive = (await fetch('/api/health', { cache: 'no-store' })).ok; } catch { alive = false; }
      if (!alive) { watchForServer(); throw new Error(netHint()); }
      throw new Error('That request did not reach the server. It is running, so try once more.');
    }
  }
  const j = await r.json().catch(() => ({}));
  // index.html is read from disk on every request, but the route table is
  // require()d once at boot. A server left running across an update therefore
  // serves the NEW page against its OLD routes - the button is there, the
  // endpoint 404s, and "not found" sends people hunting for a bug in a feature
  // that is simply not loaded yet. Name the real problem instead.
  if (r.status === 404 && url.startsWith('/api/')) {
    throw new Error(`This Maestro server has no ${url.split('?')[0]} - it is running older code than the page it served you. Restart Maestro (Quit, or close the window) and try again.`);
  }
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), j);
  return j;
};
let lastToast = { msg: '', at: 0 };
function toast(msg, cls, cmd) {
  const now = Date.now();
  if (msg === lastToast.msg && now - lastToast.at < 4000) return;  // don't stack duplicates
  lastToast = { msg, at: now };
  const el = document.createElement('div');
  el.className = 'toast' + (cls ? ' ' + cls : '');
  el.innerHTML = esc(msg) + (cmd ? `<div class="cmd">${esc(cmd)}</div>` : '');
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), cmd ? 9000 : 4000);
}
const rel = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  if (s < 86400 * 30) return Math.round(s / 86400) + 'd ago';
  return new Date(ms).toLocaleDateString();
};
const usd = (n) => n >= 0.01 ? '$' + n.toFixed(2) : n > 0 ? '<$0.01' : '$0.00';
const tk = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n || 0);
const kb = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';

// Shared by the Settings/Library/Files editors: a <select id="selId"> that
// lists a file's own *.maestro-bak.* copies (newest first, relative time as
// the label) and restores whichever one is picked. Picking is the whole
// interaction - no separate Restore button - because there is nothing to
// configure beyond "which version". Selecting back to the placeholder is a
// no-op, so this never fires on the render that first populates the list.
function renderBackupSelect(selId, backups, onRestore) {
  const sel = $(selId);
  const list = backups || [];
  sel.disabled = !list.length;
  sel.innerHTML = list.length
    ? `<option value="">History (${list.length})</option>` + list.map((b) =>
        `<option value="${esc(b.name)}">${esc(rel(b.mtimeMs))}</option>`).join('')
    : '<option value="">No backups yet</option>';
  sel.onchange = async () => {
    const name = sel.value;
    sel.value = '';
    if (!name) return;
    if (!confirm('Restore this version? The current content becomes a new backup first, so this can be undone.')) return;
    try { await onRestore(name); } catch (err) { toast(err.message, 'err'); }
  };
}

/* ------------------------------------------------------------- state */
// Remembering which tab and which folders were open is what makes a refresh
// feel like a refresh rather than a restart. localStorage is per-origin, and
// Maestro.exe opens 127.0.0.1 while `node server.js` opens localhost - two
// separate buckets - so the active tab also rides in location.hash, which
// survives a refresh on either origin.
const LS = {
  get(key, fallback) {
    try { const v = localStorage.getItem('maestro.' + key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('maestro.' + key, JSON.stringify(value)); } catch { /* private mode / quota */ }
  },
};
