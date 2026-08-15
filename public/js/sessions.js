'use strict';
const S = { meta: null, sessions: [], scope: 'user', dir: '', doc: {}, rawMode: false, dirty: false, file: '', sortMode: 'recent', showArchived: false, search: null, staleSessions: false };

/* ------------------------------------------------------------- header */
async function loadMeta() {
  S.meta = await api('/api/meta');
  const nProj = S.meta.projects.length;
  $('#ann').innerHTML = `
    <div class="ann lit"><div class="k">Projects</div><div class="v">${nProj}</div></div>
    <div class="ann" id="ann-sess"><div class="k">Sessions</div><div class="v">–</div></div>
    <div class="ann lit" id="ann-usd" title="Estimated cost of sessions touched in the last 30 days. There is no all-time figure: it only grows, so it cannot tell you whether this month cost more than the last one."><div class="k">Est. cost 30d</div><div class="v">–</div><div class="sub"></div></div>
    <div class="ann ${S.meta.claudeCli ? 'ok' : 'err'}"><div class="k">Claude CLI</div><div class="v">${S.meta.claudeCli ? 'FOUND' : 'MISSING'}</div></div>
    <div class="ann"><div class="k">Platform</div><div class="v">${esc(S.meta.platform)}</div></div>`;
  initQuit();
  fillProjectSelects();
}
function projectOptionsHtml() {
  return S.meta.projects.map((p) =>
    `<option value="${esc(p.path)}"${p.exists ? '' : ' disabled'}>${esc(p.path)}${p.exists ? '' : '  (missing)'}</option>`).join('');
}
function fillProjectSelects() {
  const opts = projectOptionsHtml();
  $('#projsel').innerHTML = '<option value="">- choose project -</option>' + opts;
  $('#effsel').innerHTML = '<option value="">- choose project -</option>' + opts;
  $('#gprojsel').innerHTML = '<option value="">- choose project -</option>' + opts;
  $('#lprojsel').innerHTML = '<option value="">- choose project -</option>' + opts;
  $('#fprojsel').innerHTML = '<option value="">- choose project -</option>' + opts;
  $('#mprojsel').innerHTML = '<option value="">- choose project (for .mcp.json and local servers) -</option>' + opts;
}

/* ------------------------------------------------------------ sessions */
async function loadSessions() {
  const j = await api('/api/sessions');
  S.sessions = j.projects;
  const total = S.sessions.reduce((a, p) => a + p.sessions.length, 0);
  const el = document.getElementById('ann-sess');
  if (el) el.querySelector('.v').textContent = total;
  S.summary = j.summary; S.pricingFile = j.pricingFile;
  S.pricingAsOf = j.pricingAsOf; S.pricingCustom = j.pricingCustom;
  const spend = document.getElementById('ann-usd');
  if (spend && j.summary) {
    spend.querySelector('.v').textContent = usd(j.summary.last30.usd);
    spend.querySelector('.sub').textContent = j.summary.last30.sessions + ' sessions';
  }
  renderUsage();
  // Separate, slightly slower request - never blocks the list above from
  // showing up first.
  api('/api/cost-regressions').then((r) => { S.costRegressions = r.regressions; renderUsage(); }).catch(() => {});
  renderSessions();
}

/* -------------------------------------------------------------- presence */
// Closing the window is the stop gesture people actually make, and X never
// reached the server: it survived with no console and no window, held the port,
// and kept serving from a directory that had since been moved out from under
// it. This stream is how the server knows a window exists - it is never read
// from, only held open, and the server exits once the last one drops.
// EventSource reconnects on its own, so a refresh is a blip well inside that
// grace period. Held in a variable so nothing collects it.
//
// But "on its own" has a hole that used to strand this page: an EventSource
// whose *connection attempt* is refused goes to CLOSED and never retries. Once
// the server had quit - which it did, on a 10s timer, the moment a suspend or a
// throttled reconnect broke the stream - the page held no stream at all, so
// even a restarted server saw no window and quit again. Reopen it ourselves,
// and reopen it at once when the user comes back to the window rather than
// waiting on a timer the browser is free to throttle while it is hidden.
let presenceStream = null;
function initPresence() {
  if (presenceStream && presenceStream.readyState !== 2) return;  // 2 = CLOSED
  try {
    presenceStream = new EventSource('/api/presence');
    presenceStream.onerror = () => {
      // OPEN/CONNECTING means it is retrying by itself; only CLOSED is final.
      if (presenceStream.readyState === 2) setTimeout(initPresence, 2000);
    };
    // Claude Code wrote to a transcript. This arrives while the user is working
    // in a terminal Maestro opened for them, so it refreshes quietly and never
    // interrupts: no toast, and nothing happens at all while the window is
    // hidden or while a transcript tab is up, because re-rendering underneath
    // someone who is reading is worse than a list that is a minute old.
    presenceStream.addEventListener('sessions', () => {
      if (document.hidden || T.active !== null) { S.staleSessions = true; return; }
      S.staleSessions = false;
      loadSessions().catch(() => {});
    });
  } catch { /* no EventSource: the health ping below still counts as presence */ }
}
if (SERVED) {
  ['visibilitychange', 'focus', 'online', 'pageshow'].forEach((e) =>
    window.addEventListener(e, () => {
      if (document.hidden) return;
      initPresence();
      // A refresh that was held back while the window was hidden or a
      // transcript was open lands now, when it is no longer in the way.
      if (S.staleSessions && T.active === null) { S.staleSessions = false; loadSessions().catch(() => {}); }
    }));
  // Closing the window should free the port promptly, and a dropped socket on
  // its own cannot say whether that is what happened. pagehide is the last
  // event a closing window reliably fires; the server treats it as "wait the
  // short grace, not the long one", so a refresh - which fires it too - is
  // taken back by the reconnect that follows. sendBeacon because the window is
  // already going away; same-origin, so the Blob type satisfies the CSRF guard
  // without needing a preflight it could never complete.
  window.addEventListener('pagehide', () => {
    try {
      navigator.sendBeacon('/api/bye', new Blob(['{}'], { type: 'application/json' }));
    } catch { /* the long grace still frees the port */ }
  });
  // A second, independent way to say "a window is still here": any request at
  // all resets the server's clock. A closed window runs no timers, so this
  // cannot keep a dead page's server alive - it only covers the case where the
  // stream is wedged and the page is not.
  setInterval(() => {
    if (document.hidden) return;
    fetch('/api/health', { cache: 'no-store' }).catch(() => {});
  }, 25_000);
}

/* ------------------------------------------------------------------ quit */
// Only offered when a launcher started the server, because then there is no
// console to Ctrl+C. Started from a terminal, Ctrl+C is the expected way out
// and a stray Quit button would just be a trap.
function initQuit() {
  if (!(S.meta && S.meta.launcher)) return;
  const b = $('#quit');
  b.classList.remove('hidden');
  b.addEventListener('click', async () => {
    // Content-Type is required by the server's CSRF guard, not by this handler.
    try {
      await fetch('/api/quit', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    } catch { /* the server exits mid-response */ }
    closeWindow();
  });
}
// Quit should leave nothing behind, including the window. Chrome refuses
// window.close() for any page it did not open itself, which is every page the
// launcher's fallback path produces (`start "" http://localhost:4144` opens an
// ordinary tab, not an --app window). Re-opening the document onto itself makes
// the page its own opener, which is the one thing that still lifts that
// restriction; in an --app window close() was already allowed and this is a
// no-op. The goodbye panel is the *fallback*, shown only once the browser has
// actually refused - it used to appear immediately, so even a successful close
// flashed a message telling the user to do what had just been done for them.
function closeWindow() {
  try { window.open('', '_self'); } catch { /* not permitted here; try anyway */ }
  try { window.close(); } catch { /* same */ }
  setTimeout(() => {
    if (document.hidden) return;   // going away, just slowly
    document.body.innerHTML =
      '<div class="empty" style="margin-top:20vh">Maestro has stopped.<br><br>'
      + '<span style="color:var(--faint)">This browser will not let a page close its own window, '
      + 'so this tab has to go by hand.</span></div>';
  }, 500);
}

/* -------------------------------------------------------- usage summary */
// Thirty bars, one per calendar day, scaled to the busiest of them. Days are
// server-side buckets of when the spend actually happened - not of when the
// transcript file was last written, which used to drop a month-old session's
// whole cost onto the day you last touched it.
function renderSpark(daily) {
  if (!Array.isArray(daily) || !daily.length) return '';
  const max = Math.max(...daily.map((d) => d.usd), 0);
  const today = daily[daily.length - 1].day;
  const fmt = (day) => {
    const [y, m, dd] = day.split('-').map(Number);
    return new Date(y, m - 1, dd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  const bars = daily.map((d) => {
    // A zero day is drawn as a hairline in the line colour rather than as a
    // very short brass bar, so "nothing happened" cannot read as "a little".
    const h = max > 0 && d.usd > 0 ? Math.max(4, (d.usd / max) * 100) : 0;
    const cls = 'sbar' + (d.usd > 0 ? '' : ' zero') + (d.day === today ? ' today' : '');
    return `<div class="${cls}" style="height:${h.toFixed(1)}%" title="${esc(fmt(d.day) + ' · ' + (d.usd > 0 ? '$' + d.usd.toFixed(2) : 'no sessions'))}"></div>`;
  }).join('');
  const busiest = daily.reduce((a, d) => (d.usd > a.usd ? d : a), daily[0]);
  return `
    <h4 style="font:600 9px/1.4 var(--sans);letter-spacing:1.3px;text-transform:uppercase;color:var(--faint);margin:0 0 var(--sp-2)">Last 30 days</h4>
    <div class="spark" role="img" aria-label="Daily estimated spend over the last 30 days. Busiest day ${esc(fmt(busiest.day))} at ${esc(usd(busiest.usd).replace(/<[^>]*>/g, ''))}.">${bars}</div>
    <div class="spark-ax"><span>${esc(fmt(daily[0].day))}</span>
      <span>peak ${esc(fmt(busiest.day))} · ${max > 0 ? esc(busiest.usd.toFixed(2)) : '0.00'}</span>
      <span>today</span></div>`;
}
function renderUsage() {
  const box = $('#usage'), s = S.summary;
  if (!s || !s.sessions) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const t = s.tokens;
  const max = Math.max(...s.models.map((m) => m.usd), 0.0001);
  const models = s.models.map((m) => `
    <div class="mbar">
      <span class="name" title="${esc(m.id)}">${esc(m.label)}</span>
      <span class="track"><span class="fill" style="width:${Math.max(1, (m.usd / max) * 100).toFixed(1)}%"></span></span>
      <span class="amt" title="${esc(`in ${m.in} · out ${m.out} · cache write ${m.cacheW + m.cacheW1h} · cache read ${m.cacheR} · ${m.sessions} session(s)`)}">${
        m.priced ? usd(m.usd) : '<span style="color:var(--faint);font-weight:400">unpriced</span>'}</span>
    </div>`).join('');
  const top = s.top.map((p) => `
    <div class="u-row"><span class="l" title="${esc(p.cwd)}">${esc(p.cwd.replace(/^.*[\\/]/, '') || p.cwd)}</span>
      <span class="r">${usd(p.usd)}</span></div>`).join('');
  const spark = renderSpark(s.daily);
  const regs = S.costRegressions || [];
  const regressions = regs.length ? `
    <h4 style="font:600 9px/1.4 var(--sans);letter-spacing:1.3px;text-transform:uppercase;color:var(--faint);margin:0 0 var(--sp-2)">Cost jumps</h4>
    ${regs.map((r) => `
      <div class="u-row"><span class="l" title="${esc(r.cwd)}">${esc(r.cwd.replace(/^.*[\\/]/, '') || r.cwd)}
          <span class="m">${esc(r.priorTopModel || '?')} → ${esc(r.trailingTopModel || '?')}</span></span>
        <span class="r" style="color:var(--danger)">${usd(r.trailingUsd)} <span class="m">(${r.ratio.toFixed(1)}×)</span></span></div>`).join('')}
    <p class="scope-note" style="margin:var(--sp-2) 0 0">Last 7 days vs the 7 before that, folders with at least a
      few priced sessions only - a quiet model-mix change can be as much of a cost driver as more usage.</p>` : '';

  box.innerHTML = `
    <div class="u-head" id="u-toggle" role="button" tabindex="0" aria-expanded="${box.classList.contains('open')}">
      <div class="u-stat"><span class="u-cap">Last 7 days</span><span class="u-big">${usd(s.last7.usd)}</span></div>
      <div class="u-stat"><span class="u-cap">Last 30 days</span><span class="u-big">${usd(s.last30.usd)}</span></div>
      <div class="u-stat"><span class="u-cap">Sessions 7 / 30d</span><span class="n">${s.last7.sessions} / ${s.last30.sessions}</span></div>
      <div class="u-stat"><span class="u-cap">Tokens in → out</span><span class="n">${tk(t.in)} → ${tk(t.out)}</span></div>
      <div class="u-stat"><span class="u-cap">Cache read</span><span class="n">${tk(t.cacheR)}</span></div>
      <span class="u-chev">▶</span>
    </div>
    <div class="u-body">
      ${spark}
      ${regressions}
      <h4 style="font:600 9px/1.4 var(--sans);letter-spacing:1.3px;text-transform:uppercase;color:var(--faint);margin:${spark || regressions ? 'var(--sp-4)' : '0'} 0 var(--sp-2)">Cost by model</h4>
      ${models || '<p class="scope-note">No model usage recorded.</p>'}
      <div class="u-grid">
        <div>
          <h4>Top folders</h4>
          ${top || '<p class="scope-note">-</p>'}
        </div>
        <div>
          <h4>Token breakdown</h4>
          <div class="u-row"><span class="l">Input</span><span class="r">${t.in.toLocaleString()}</span></div>
          <div class="u-row"><span class="l">Output</span><span class="r">${t.out.toLocaleString()}</span></div>
          <div class="u-row"><span class="l">Cache write</span><span class="r">${t.cacheW.toLocaleString()}</span></div>
          <div class="u-row"><span class="l">Cache read</span><span class="r">${t.cacheR.toLocaleString()}</span></div>
        </div>
        <div>
          <h4>Coverage</h4>
          <div class="u-row"><span class="l">Sessions</span><span class="r">${s.sessions}</span></div>
          <div class="u-row"><span class="l">Folders</span><span class="r">${s.projects}</span></div>
          ${s.usdReported > 0 ? `<div class="u-row"><span class="l">Cost recorded by CC</span><span class="r">${usd(s.usdReported)}</span></div>` : ''}
          ${s.unpriced.length ? `<div class="u-row"><span class="l">Unpriced models</span><span class="r" style="color:var(--faint)">${esc(s.unpriced.join(', '))}</span></div>` : ''}
        </div>
      </div>
      <p class="scope-note" style="margin-top:var(--sp-4)">
        Token counts come straight from each transcript and are exact. Dollars are an
        <b>estimate of list API price</b> ${S.pricingCustom
          ? `using your overrides in <code>${esc(S.pricingFile || '')}</code>`
          : `using built-in rates as of ${esc(S.pricingAsOf || '')}`} - cache reads are
        billed at 0.1&times; input and cache writes at 1.25&times; (2&times; for 1-hour).
        Rates are matched by model family, so a new Opus or Sonnet release is priced
        without editing anything. <b>On a Pro or Max plan you are not billed these
        amounts</b> - treat the figure as a way to compare sessions, not an invoice.
        Override any rate by creating <code>${esc(S.pricingFile || '')}</code>.
        The transcript does not capture every request Claude Code makes, so totals are a solid floor.
      </p>
    </div>`;
}
$('#usage').addEventListener('click', (e) => {
  if (e.target.closest('#u-toggle')) $('#usage').classList.toggle('open');
});
$('#usage').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('#u-toggle')) {
    e.preventDefault(); $('#usage').classList.toggle('open');
  }
});
// Which folders are open. Empty by default: a first screen of folder
// headers is readable, where every folder expanded is a wall of rows. Restored
// across refreshes so reopening the app looks like you left it.
const OPENP = new Set(LS.get('openFolders', []));
const projKeys = () => S.sessions.map((p) => p.cwd || p.encodedName);
function toggleProj(key) {
  if (OPENP.has(key)) OPENP.delete(key); else OPENP.add(key);
  LS.set('openFolders', [...OPENP]);
  renderSessions();
}
const SORTERS = {
  recent: (a, b) => b.mtime - a.mtime,
  cost: (a, b) => (b.usd || 0) - (a.usd || 0),
  tokens: (a, b) => (b.tokens.in + b.tokens.out) - (a.tokens.in + a.tokens.out),
  name: (a, b) => (a.name || a.title).localeCompare(b.name || b.title),
};
function renderSessions() {
  const q = $('#q').value.trim().toLowerCase();
  const frag = [];
  for (const p of S.sessions) {
    const label = p.cwd || '(folder unresolved: ' + p.encodedName + ')';
    const key = p.cwd || p.encodedName;
    // Archived sessions are hidden by default and excluded from search too -
    // same reasoning as the collapse rule below: a toggle you forgot you set
    // shouldn't make search results look broken.
    const visible = S.showArchived ? p.sessions : p.sessions.filter((s) => !s.archived);
    const matched = (q
      ? visible.filter((s) => (s.title + ' ' + s.about + ' ' + s.name + ' ' + (s.touched || []).join(' ')
          + ' ' + label + ' ' + (s.gitBranch || '') + ' ' + s.id).toLowerCase().includes(q))
      : visible).slice().sort(SORTERS[S.sortMode] || SORTERS.recent);
    if (!matched.length) continue;
    // A search result hidden behind a closed folder reads as "search is broken",
    // so a filter forces every matching folder open for as long as it is set.
    // An open folder then shows all of its sessions - the folder itself is the
    // only thing that hides rows now.
    const open = !!q || OPENP.has(key);
    const lastSession = p.sessions[0]; // server-sorted mtime desc - independent of the active sort mode
    frag.push(`<div class="proj${p.pinned ? ' pinned' : ''}${open ? ' open' : ''}">
      <div class="proj-head" data-fold-row="${esc(key)}">
        <button class="proj-fold" data-fold="${esc(key)}" aria-expanded="${open}"
          title="${open ? 'Collapse this folder' : 'Expand this folder'}">▶</button>
        <button class="pin-toggle${p.pinned ? ' on' : ''}" data-pin="${esc(p.cwd || '')}" title="${p.pinned ? 'Unpin this folder' : 'Pin this folder to the top'}" ${p.cwd ? '' : 'disabled'}>${p.pinned ? '★' : '☆'}</button>
        <span class="path">${esc(label)}</span>
        <span class="count fold-hint">${matched.length} session${matched.length > 1 ? 's' : ''}</span>
        ${p.usd > 0 ? `<span class="count" title="estimated list API cost for this folder">${usd(p.usd)}</span>` : ''}
        ${p.tokens ? `<span class="count" title="input + output tokens in this folder (cache traffic excluded)">${tk(p.tokens)} tok</span>` : ''}
        ${p.exists ? '' : '<span class="badge gone">folder missing</span>'}
        <span class="spacer"></span>
        ${p.exists && lastSession ? `<button class="btn sm ghost" data-resume="${esc(lastSession.id)}" data-cwd="${esc(p.cwd)}" title="Resume the most recently active session in this folder">Resume last</button>` : ''}
        ${p.exists ? `<button class="btn sm" data-new="${esc(p.cwd)}">New session here</button>` : ''}
      </div>
      ${open ? `
      <div class="colhead">
        <span class="ph"><input type="checkbox" style="width:auto" tabindex="-1"></span>
        <span class="ph"><button class="btn amber sm" tabindex="-1">Resume</button></span>
        <span class="a">Opening prompt</span><span class="b">Session name</span><span class="c">Cost · in→out</span>
        <span class="ph"><button class="btn sm" tabindex="-1">View</button></span>
        <span class="ph"><button class="btn sm ghost" tabindex="-1">rename</button></span>
        <span class="ph"><button class="btn sm ghost" tabindex="-1">archive</button></span>
        <span class="ph"><button class="btn sm ghost" tabindex="-1">share</button></span>
        <span class="ph"><button class="btn sm ghost" tabindex="-1">copy cmd</button></span>
      </div>
      ${matched.map((s) => `
        <div class="sess${s.archived ? ' archived' : ''}" tabindex="0" data-row="${esc(s.id)}">
          <input type="checkbox" class="pick" style="width:auto" data-pick="${esc(s.id)}" data-cwd="${esc(p.cwd || '')}"
            ${p.exists ? '' : 'disabled'} ${SEL.has(s.id) ? 'checked' : ''}>
          <button class="btn amber sm" data-resume="${esc(s.id)}" data-cwd="${esc(p.cwd || '')}">Resume</button>
          <div class="info">
            <div class="title" title="${esc(s.title)}">${esc(s.title)}</div>
            <div class="meta">
              <span>${rel(s.mtime)}</span>
              <span>${s.messageCount != null ? s.messageCount + ' lines' : kb(s.sizeBytes)}</span>
              ${s.gitBranch ? `<span>⎇ ${esc(s.gitBranch)}</span>` : ''}
              <span>${esc(s.id.slice(0, 8))}</span>
              ${s.archived ? '<span class="badge gone" style="color:var(--faint);border-color:var(--line)">archived</span>' : ''}
            </div>
          </div>
          <div class="about" title="${esc((s.name || 'unnamed session') + (s.about ? '\n\n' + s.about : ''))}">
            <span class="${s.name ? 'gen' : 'quiet'}">${esc(s.name || 'unnamed session')}</span>
          </div>
          <div class="spend" title="${esc(`in ${s.tokens.in.toLocaleString()} · out ${s.tokens.out.toLocaleString()} · cache write ${s.tokens.cacheW.toLocaleString()} · cache read ${s.tokens.cacheR.toLocaleString()}${s.models.length ? '\n' + s.models.join(', ') : ''}\n${s.usdReported ? 'cost recorded by Claude Code' : 'estimated at list API price'}`)}">
            <div class="usd ${s.usd > 0 ? '' : 'free'}">${usd(s.usd || 0)}</div>
            <div class="tokline">${tk(s.tokens.in)}→${tk(s.tokens.out)}</div>
          </div>
          <button class="btn sm" data-viewt="${esc(s.file)}" data-title="${esc(s.title.slice(0, 40))}">View</button>
          <button class="btn sm ghost" data-rename="${esc(s.id)}" data-curname="${esc(s.namedByUser ? s.name : '')}" title="Rename this session">rename</button>
          <button class="btn sm ghost" data-archive="${esc(s.id)}" data-archived="${s.archived ? '1' : ''}" title="${s.archived ? 'Unarchive' : 'Archive - hides it from the list without deleting anything'}">${s.archived ? 'unarchive' : 'archive'}</button>
          <button class="btn sm ghost" data-share="${esc(s.file)}" title="Share this session with a teammate">share</button>
          <button class="btn sm ghost" data-copy="${esc(s.id)}" title="Copy resume command">copy cmd</button>
        </div>`).join('')}
      ` : ''}
    </div>`);
  }
  // The cost/token caveats now live in one place: the Usage panel above.
  $('#sessions').innerHTML = frag.join('') ||
    '<div class="empty">No sessions found in ~/.claude/projects - run claude somewhere first, then Rescan.</div>';
  const keys = projKeys();
  const allOpen = keys.length > 0 && keys.every((k) => OPENP.has(k));
  $('#fold-all').textContent = allOpen ? 'Collapse all' : 'Expand all';
  $('#fold-all').disabled = !keys.length;
}
const SEL = new Map(); // sessionId -> cwd
function launchOpts() {
  return { mode: $('#lx-mode').value, model: $('#lx-model').value,
    extraFlags: $('#lx-flags').value.trim(), newTab: $('#lx-tab').checked };
}
function syncSel() {
  $('#lx-count').textContent = SEL.size ? `${SEL.size} selected` : '';
  $('#lx-go').disabled = SEL.size === 0;
  $('#lx-go').textContent = SEL.size > 1 ? `Open ${SEL.size} in tabs` : 'Open selected';
}
$('#sessions').addEventListener('change', (e) => {
  const c = e.target.closest('[data-pick]'); if (!c) return;
  if (c.checked) SEL.set(c.dataset.pick, c.dataset.cwd); else SEL.delete(c.dataset.pick);
  syncSel();
});
$('#lx-go').addEventListener('click', async () => {
  const targets = [...SEL].map(([sessionId, cwd]) => ({ sessionId, cwd }));
  if (!targets.length) return;
  $('#lx-go').disabled = true;
  try {
    const j = await api('/api/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets, options: launchOpts() }) });
    const ok = j.results.filter((r) => r.ok);
    const bad = j.results.filter((r) => !r.ok);
    if (ok.length) toast(`Opened ${ok.length} session${ok.length > 1 ? 's' : ''} - ${ok[0].via}`, '', ok[0].command);
    bad.forEach((r) => toast(`${r.cwd || 'target'}: ${r.error}`, 'err'));
    SEL.clear(); syncSel(); renderSessions();
  } catch (err) { toast(err.message, 'err'); }
  syncSel();
});
// Roving keyboard nav on session rows: Up/Down moves focus, Enter resumes.
// Only fires when the row itself (not a button/input inside it) has focus,
// so the search box and per-row controls keep their normal key behavior.
$('#sessions').addEventListener('keydown', (e) => {
  if (!e.target.matches('.sess[data-row]')) return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
  const rows = [...document.querySelectorAll('#sessions .sess[data-row]')];
  const i = rows.indexOf(e.target);
  if (e.key === 'Enter') { e.target.querySelector('[data-resume]')?.click(); return; }
  e.preventDefault();
  const next = e.key === 'ArrowDown' ? rows[i + 1] : rows[i - 1];
  next?.focus();
});
$('#sessions').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.resume !== undefined) {
    try {
      const j = await api('/api/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: [{ sessionId: b.dataset.resume, cwd: b.dataset.cwd }], options: launchOpts() }) });
      const r = j.results[0];
      if (r.ok) toast(`Opened in ${r.via}`, '', r.command);
      else toast(r.error, 'err', r.command ? `cd into the folder, then: ${r.command}` : null);
    } catch (err) { toast(err.message, 'err', err.command ? `cd into folder, then: ${err.command}` : null); }
  } else if (b.dataset.new !== undefined) {
    try {
      const j = await api('/api/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: [{ cwd: b.dataset.new }], options: launchOpts() }) });
      const r = j.results[0];
      if (r.ok) toast(`New session in ${r.via}`, '', r.command);
      else toast(r.error, 'err');
    } catch (err) { toast(err.message, 'err'); }
  } else if (b.dataset.viewt !== undefined) {
    openTab(b.dataset.viewt, b.dataset.title);
  } else if (b.dataset.share !== undefined) {
    shareSession(b.dataset.share);
  } else if (b.dataset.copy !== undefined) {
    navigator.clipboard.writeText(`claude --resume ${b.dataset.copy}`);
    toast('Command copied', '', `claude --resume ${b.dataset.copy}`);
  } else if (b.dataset.fold !== undefined) {
    toggleProj(b.dataset.fold);
  } else if (b.dataset.pin !== undefined) {
    const nowPinned = !b.classList.contains('on');
    try {
      await api('/api/override', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: b.dataset.pin, pinned: nowPinned }) });
      await loadSessions();
    } catch (err) { toast(err.message, 'err'); }
  } else if (b.dataset.rename !== undefined) {
    const name = prompt('Session name (blank clears it back to the auto-generated one):', b.dataset.curname || '');
    if (name === null) return;
    try {
      await api('/api/override', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: b.dataset.rename, name }) });
      await loadSessions();
    } catch (err) { toast(err.message, 'err'); }
  } else if (b.dataset.archive !== undefined) {
    const archiving = !b.dataset.archived;
    try {
      await api('/api/override', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: b.dataset.archive, archived: archiving }) });
      toast(archiving ? 'Archived - hidden until you toggle "show archived"' : 'Unarchived');
      await loadSessions();
    } catch (err) { toast(err.message, 'err'); }
  }
});
// The whole header row is a fold target - a 12px chevron on its own is too
// small to read as "this opens". Controls inside the header keep their own jobs;
// the handler above already claimed every click that landed on a button.
$('#sessions').addEventListener('click', (e) => {
  if (e.target.closest('button, input, a, select')) return;
  const head = e.target.closest('.proj-head[data-fold-row]');
  if (head) toggleProj(head.dataset.foldRow);
});
$('#fold-all').addEventListener('click', () => {
  const keys = projKeys();
  if (keys.every((k) => OPENP.has(k))) OPENP.clear();
  else keys.forEach((k) => OPENP.add(k));
  LS.set('openFolders', [...OPENP]);
  renderSessions();
});
$('#sort-mode').addEventListener('change', () => { S.sortMode = $('#sort-mode').value; renderSessions(); });
$('#show-archived').addEventListener('change', () => { S.showArchived = $('#show-archived').checked; renderSessions(); });

/* ------------------------------------------------- search inside transcripts */
// The filter box matches metadata: opening prompt, digest, files touched,
// folder, branch, id. It cannot find a conversation by what was said in it,
// which is the only way to answer "where did I work that out". This asks the
// server to grep the transcripts themselves.
async function runDeepSearch() {
  const q = $('#q').value.trim();
  const box = $('#searchres');
  if (q.length < 2) { toast('Type at least 2 characters, then Search inside', 'err'); return; }
  box.classList.remove('hidden');
  box.innerHTML = '<div class="empty">searching every transcript…</div>';
  try {
    S.search = await api('/api/search?q=' + encodeURIComponent(q));
    renderSearch();
  } catch (err) {
    searchError(err.message);
  }
}
// Any dead end here still needs a way out. Without the Clear button the only
// escape from an error was reloading the page.
function searchError(msg) {
  S.search = null;
  $('#searchres').classList.remove('hidden');
  $('#searchres').innerHTML = `
    <div class="sr-head"><span style="color:var(--deny)">${esc(msg)}</span>
      <button class="btn sm ghost" id="sr-clear" style="margin-left:auto">Clear</button></div>`;
}
// Highlight the term inside an already-escaped snippet. Escape first, mark
// second - the other order would let a transcript containing markup write it
// into the page.
function markHit(text, q) {
  const safe = esc(text);
  const needle = esc(q);
  if (!needle) return safe;
  const parts = safe.toLowerCase().split(needle.toLowerCase());
  if (parts.length < 2) return safe;
  let out = '', at = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    at += parts[i].length;
    out += safe.slice(at - parts[i].length, at) + '<b>' + safe.slice(at, at + needle.length) + '</b>';
    at += needle.length;
  }
  return out + safe.slice(at);
}
function renderSearch() {
  const j = S.search, box = $('#searchres');
  if (!j) { box.classList.add('hidden'); return; }
  const ROLE = { user: 'you', ai: 'claude', think: 'thinking', tool: 'tool' };
  const head = `
    <div class="sr-head">
      <b style="color:var(--text)">${j.sessions} session${j.sessions === 1 ? '' : 's'}</b>
      <span>${j.matches} match${j.matches === 1 ? '' : 'es'} for “${esc(j.query)}” · scanned ${j.scanned} transcript${j.scanned === 1 ? '' : 's'} in ${j.ms}ms</span>
      ${j.partial ? '<span class="badge" style="color:var(--brass);border-color:var(--brass)" title="Stopped at the result cap or the time budget - narrow the term to see the rest">partial</span>' : ''}
      ${j.skipped ? `<span class="badge" title="Transcripts too large to grep inside a request">${j.skipped} skipped</span>` : ''}
      <button class="btn sm ghost" id="sr-clear" style="margin-left:auto">Clear</button>
    </div>`;
  const body = j.results.length ? j.results.map((r) => `
    <div class="sr-hit">
      <div class="sr-top">
        <button class="sr-name" data-viewt="${esc(r.file)}" data-title="${esc((r.name || 'session').slice(0, 40))}">${esc(r.name || '(unnamed session)')}</button>
        <span class="sr-where">${esc(r.cwd.replace(/^.*[\\/]/, '') || r.cwd)} · ${rel(r.mtime)}</span>
      </div>
      ${r.hits.map((h) => `<div class="sr-line"><span class="sr-role">${ROLE[h.r] || h.r}</span>${markHit(h.t, j.query)}</div>`).join('')}
    </div>`).join('')
    : `<div class="empty">Nothing in any transcript mentions “${esc(j.query)}”.</div>`;
  box.innerHTML = head + body;
}
$('#deep-btn').addEventListener('click', runDeepSearch);
// Enter in the filter box means "I meant it" - the filter itself is live as you
// type, so the keystroke is otherwise spare.
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') runDeepSearch(); });
$('#searchres').addEventListener('click', (e) => {
  if (e.target.closest('#sr-clear')) { S.search = null; $('#searchres').classList.add('hidden'); return; }
  const b = e.target.closest('[data-viewt]');
  if (b) openTab(b.dataset.viewt, b.dataset.title);
});

/* --------------------------------------------------------------- sharing */
async function shareSession(file) {
  let info;
  try { info = await api('/api/share-check?file=' + encodeURIComponent(file)); }
  catch (err) { return toast(err.message, 'err'); }

  const warn = info.warnings.length
    ? `<p style="margin:0 0 var(--sp-3);color:var(--deny)"><b>Heads up:</b> this transcript appears to contain
       ${esc(info.warnings.map((w) => `${w.count}× ${w.kind}`).join(', '))}. Whoever you send it to will see that too.</p>`
    : '';
  const box = document.createElement('div');
  box.className = 'card';
  box.style.cssText = 'position:fixed;inset:auto 0 0 0;margin:0 auto 6vh;max-width:560px;z-index:70;box-shadow:var(--shadow)';
  box.innerHTML = `
    <h3>Share “${esc(info.meta.name || 'this session')}”<span style="margin-left:auto"></span>
      <button class="btn sm ghost" data-close="1">close</button></h3>
    <div class="bd">
      ${warn}
      <p class="scope-note" style="margin:0 0 var(--sp-3)">${info.meta.messages} entries · ${info.sizeKb} KB
        · originally in <code>${esc(info.meta.originalCwd || 'unknown folder')}</code></p>
      <div class="addrow" style="margin:0">
        <button class="btn amber" data-dl="capsule">Download session file</button>
        <button class="btn" data-dl="md">Download as Markdown</button>
      </div>
      <p class="scope-note" style="margin:var(--sp-3) 0 0">The session file can be imported by a teammate and resumed
        with Claude Code as if it were theirs. Markdown is read-only, for a PR or a Slack thread.</p>
    </div>`;
  document.body.appendChild(box);
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.close) return box.remove();
    if (b.dataset.dl) {
      window.location.href = `/api/export?file=${encodeURIComponent(file)}&format=${b.dataset.dl}`;
      box.remove();
    }
  });
}

$('#import-btn').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const targetDir = prompt('Import into which project folder?\n\nThe session is rewritten to point at this folder so you can resume it locally.',
    S.meta && S.meta.projects.length ? S.meta.projects[0].path : '');
  if (!targetDir) return;
  try {
    const buf = await f.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const j = await api('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: btoa(bin), targetDir }) });
    toast(`Imported ${j.messages} entries - resume it from the list`, '', j.resume);
    loadSessions();
  } catch (err) { toast(err.message, 'err'); }
});

