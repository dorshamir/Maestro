'use strict';
/* ------------------------------------------------- transcript tabs (read-only) */
const T = { tabs: [], active: null, cache: {} };
function renderTabs() {
  if (!T.tabs.length) { $('#stabs').innerHTML = ''; showTab(null); return; }
  $('#stabs').innerHTML =
    `<button class="${T.active === null ? 'on' : ''}" data-tab="__list"><span class="tt">▤ All sessions</span></button>` +
    T.tabs.map((t) => `<button class="${T.active === t.file ? 'on' : ''}" data-tab="${esc(t.file)}">
      <span class="tt">${esc(t.title)}</span><span class="x" data-close="${esc(t.file)}">✕</span></button>`).join('');
}
async function showTab(file) {
  T.active = file;
  renderTabs();
  const isList = file === null;
  $('#sessions').classList.toggle('hidden', !isList);
  $('#q').parentElement.classList.toggle('hidden', !isList);
  $('#searchres').classList.toggle('hidden', !isList || !S.search);
  $('#transcript').classList.toggle('hidden', isList);
  if (isList) {
    if (S.staleSessions) { S.staleSessions = false; loadSessions().catch(() => {}); }
    return;
  }
  if (!T.cache[file]) {
    $('#transcript').innerHTML = '<div class="empty">loading transcript…</div>';
    try { T.cache[file] = await api('/api/transcript?file=' + encodeURIComponent(file)); }
    catch (err) { $('#transcript').innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
  }
  const j = T.cache[file];
  const WHO = { user: 'You', ai: 'Claude', think: 'thinking', sum: '' };
  $('#transcript').innerHTML = `<div class="chat">` +
    (j.truncated ? '<div class="cl think">…transcript truncated to the most recent part…</div>' : '') +
    j.entries.map((e) => {
      const side = e.side ? '<span class="side">subagent</span>' : '';
      if (e.r === 'tool') return `<div class="cl tool">▸ <b>${esc(e.name)}</b> ${esc(e.t)}${side}</div>`;
      if (e.r === 'toolres') return `<div class="cl toolres${e.err ? ' err' : ''}">${esc(e.t)}</div>`;
      if (e.r === 'sum') return `<div class="cl sum">§ ${esc(e.t)}</div>`;
      return `<div class="cl ${e.r}"><span class="who">${WHO[e.r]}${side}</span>${esc(e.t)}</div>`;
    }).join('') + `</div>
    <div class="scope-note" style="margin-top:8px">read-only view · ${kb(j.sizeBytes)} on disk · Resume opens the live session in your terminal</div>`;
}
function openTab(file, title) {
  if (!T.tabs.find((t) => t.file === file)) T.tabs.push({ file, title: title || 'session' });
  showTab(file);
}
$('#stabs').addEventListener('click', (e) => {
  const x = e.target.closest('.x');
  if (x) {
    e.stopPropagation();
    T.tabs = T.tabs.filter((t) => t.file !== x.dataset.close);
    delete T.cache[x.dataset.close];
    if (T.active === x.dataset.close) T.active = null;
    renderTabs(); showTab(T.active);
    return;
  }
  const b = e.target.closest('button[data-tab]'); if (!b) return;
  showTab(b.dataset.tab === '__list' ? null : b.dataset.tab);
});
$('#q').addEventListener('input', renderSessions);
$('#refresh').addEventListener('click', loadSessions);

