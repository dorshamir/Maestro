'use strict';
/* ------------------------------------------------------------ nav + boot */
const VIEWS = ['sessions', 'settings', 'guard', 'lib', 'mcp', 'files', 'effective'];
const NAV_BTNS = [...document.querySelectorAll('nav button')];
let CURRENT_VIEW = 'sessions';
function showView(name) {
  NAV_BTNS.forEach((b) => {
    const on = b.dataset.view === name;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  });
  VIEWS.forEach((v) => document.getElementById('view-' + v).classList.toggle('hidden', v !== name));
  // Persist from here, not from the click handler: arrow-key navigation calls
  // showView too, and a tab you moved to with the keyboard has to stick as well.
  CURRENT_VIEW = name;
  if (location.hash.slice(1) !== name) location.hash = name;
  LS.set('view', name);
  const loaders = { effective: loadEffective, guard: loadGuard, lib: loadLib, files: loadFiles, mcp: loadMcp };
  if (loaders[name]) Promise.resolve(loaders[name]()).catch((err) => toast(err.message, 'err'));
}
// Hash first so Back/Forward and a refresh both land on the same tab; the
// stored value covers closing and reopening the app, where there is no hash.
function initialView() {
  const fromHash = location.hash.slice(1);
  if (VIEWS.includes(fromHash)) return fromHash;
  const stored = LS.get('view', 'sessions');
  return VIEWS.includes(stored) ? stored : 'sessions';
}
window.addEventListener('hashchange', () => {
  const v = location.hash.slice(1);
  if (VIEWS.includes(v) && v !== CURRENT_VIEW) showView(v);
});
document.querySelector('nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) showView(b.dataset.view);
});
document.querySelector('nav').addEventListener('keydown', (e) => {
  const i = NAV_BTNS.indexOf(document.activeElement);
  if (i < 0) return;
  const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'Home' ? -i
    : e.key === 'End' ? NAV_BTNS.length - 1 - i : 0;
  if (!step) return;
  e.preventDefault();
  const next = NAV_BTNS[(i + step + NAV_BTNS.length) % NAV_BTNS.length];
  next.focus(); showView(next.dataset.view);
});
window.addEventListener('beforeunload', (e) => { if (S.dirty) e.preventDefault(); });

$('#scope-note').textContent = SCOPE_NOTES.user;
function showNotServed() {
  document.querySelector('nav').classList.add('hidden');
  document.querySelector('main').innerHTML = `
    <div class="card" style="max-width:620px;margin:8vh auto 0">
      <h3>Maestro needs its server</h3>
      <div class="bd">
        <p style="margin:0 0 var(--sp-4)">You opened <code>public/index.html</code> directly, so the page is running from
        <code>${esc(location.protocol)}//</code> with nothing to talk to. Maestro reads your sessions and settings
        through a small local server - the page on its own cannot reach your disk.</p>
        <p style="margin:0 0 var(--sp-2);font:600 12px var(--sans);letter-spacing:.6px;text-transform:uppercase;color:var(--dim)">Start it</p>
        <pre class="json" style="margin:0 0 var(--sp-4)">cd claude-maestro
node server.js</pre>
        <p style="margin:0">It prints an address (<code>http://localhost:4144</code> by default) and opens your
        browser there. On Windows you can double-click <code>start.cmd</code> instead.</p>
      </div>
    </div>`;
}

if (!SERVED) {
  fatal('Open http://localhost:4144 instead - this page cannot run from a file:// URL.', true);
  showNotServed();
} else {
  // Before anything else, and not behind loadMeta: while this stream is not
  // open the server counts itself as having no UI.
  initPresence();
  applyLibState();
  loadMeta()
    // Restore the tab only after meta lands: the lib/files/guard loaders and
    // their project selects are populated by loadMeta, so showView() before it
    // would open a tab onto empty dropdowns.
    .then(() => { loadSessions(); loadSettings(); showView(initialView()); })
    .catch((e) => { toast(e.message, 'err'); fatal(e.message); })
    .finally(() => { if (MISSING.length) fatal('missing elements: ' + [...new Set(MISSING)].join(', ')); });
}
