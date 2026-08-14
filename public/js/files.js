'use strict';
/* --------------------------------------------------------------- files tab */
// `open` holds the directories the user has expanded. It starts empty, so the
// tree opens collapsed to its top level - the ~/.claude tree is deep enough
// that a fully expanded dump buries the handful of files anyone actually wants.
const F = { scope: 'user', dir: '', rel: null, items: [], open: new Set() };

/** A row is visible only when every directory above it has been expanded. */
function fVisible(rel) {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    if (!F.open.has(parts.slice(0, i).join('/'))) return false;
  }
  return true;
}

function renderFiles() {
  const rows = F.items.filter((it) => fVisible(it.rel)).map((it) => {
    const pad = 8 + it.depth * 16;
    const name = esc(it.rel.split('/').pop());
    if (it.dir) {
      const open = F.open.has(it.rel);
      // count what expanding would reveal, so a folder is not a blind click
      const kids = F.items.filter((x) => x.rel.startsWith(it.rel + '/')).length;
      return `<div class="frow isdir${open ? ' open' : ''}" style="padding-left:${pad}px" data-fdir="${esc(it.rel)}">
        <span class="chev">&#9656;</span>${name}/<span class="fcount">${kids}</span></div>`;
    }
    const cls = it.text ? '' : ' nontext';
    return `<div class="frow${cls}${F.rel === it.rel ? ' on' : ''}" style="padding-left:${pad}px" ${it.text ? `data-frel="${esc(it.rel)}"` : ''}>
      ${name}<span class="fsize">${kb(it.size)}</span></div>`;
  });
  $('#ftree').innerHTML = rows.join('') ||
    '<div class="scope-note" style="margin:0">nothing here yet</div>';
  const dirs = F.items.filter((it) => it.dir).length;
  $('#f-expand').textContent = F.open.size >= dirs && dirs > 0 ? 'collapse all' : 'expand all';
  $('#f-expand').classList.toggle('hidden', dirs === 0);
}

async function loadFiles() {
  if (F.scope === 'project' && !F.dir) {
    F.items = []; $('#ftree').innerHTML = '<div class="scope-note" style="margin:0">choose a project above</div>';
    $('#f-expand').classList.add('hidden');
    return;
  }
  const j = await api(`/api/files?scope=${F.scope}&dir=${encodeURIComponent(F.dir)}`);
  $('#files-note').textContent = F.scope === 'user'
    ? `Everything Claude Code reads from ${j.root} - hidden system folders: ${j.hidden.join(', ')} (sessions live in the Sessions tab).`
    : `Claude-related files in the project: CLAUDE.md, .mcp.json and the whole .claude/ folder. Committed files affect the whole team.`;
  F.items = j.items;
  // Drop remembered folders that no longer exist, but keep the ones that do -
  // a refresh or a save should not collapse the tree the user just opened.
  const dirs = new Set(j.items.filter((it) => it.dir).map((it) => it.rel));
  for (const rel of [...F.open]) if (!dirs.has(rel)) F.open.delete(rel);
  renderFiles();
}
async function openFile(relPath) {
  try {
    const j = await api(`/api/file?scope=${F.scope}&dir=${encodeURIComponent(F.dir)}&rel=${encodeURIComponent(relPath)}`);
    F.rel = relPath;
    $('#f-current').textContent = j.file;
    $('#f-edit').value = j.content;
    renderFiles();   // just re-mark the selection; no refetch, no collapse
    renderBackupSelect('#f-backups', j.backups, async (name) => {
      await api('/api/file/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: F.scope, dir: F.dir, rel: F.rel, backup: name }) });
      toast('Restored from backup');
      await openFile(F.rel);
    });
  } catch (err) { toast(err.message, 'err'); }
}
$('#fscopes').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  F.scope = b.dataset.scope; F.rel = null; $('#f-edit').value = ''; $('#f-current').textContent = 'nothing open';
  renderBackupSelect('#f-backups', [], null);
  document.querySelectorAll('#fscopes button').forEach((x) => x.classList.toggle('on', x === b));
  $('#fprojsel').classList.toggle('hidden', F.scope === 'user');
  loadFiles().catch((err) => toast(err.message, 'err'));
});
$('#fprojsel').addEventListener('change', () => {
  F.dir = $('#fprojsel').value; F.rel = null;
  renderBackupSelect('#f-backups', [], null);
  loadFiles().catch((err) => toast(err.message, 'err'));
});
$('#f-refresh').addEventListener('click', () => loadFiles().catch((err) => toast(err.message, 'err')));
$('#ftree').addEventListener('click', (e) => {
  const dir = e.target.closest('[data-fdir]');
  if (dir) {
    const rel = dir.dataset.fdir;
    // Collapsing a folder collapses everything inside it, so reopening it does
    // not spill a subtree the user had expanded three visits ago.
    if (F.open.has(rel)) {
      for (const o of [...F.open]) if (o === rel || o.startsWith(rel + '/')) F.open.delete(o);
    } else F.open.add(rel);
    return renderFiles();
  }
  const row = e.target.closest('[data-frel]'); if (!row) return;
  openFile(row.dataset.frel);
});
$('#f-expand').addEventListener('click', () => {
  const dirs = F.items.filter((it) => it.dir).map((it) => it.rel);
  if (F.open.size >= dirs.length) F.open.clear();
  else dirs.forEach((d) => F.open.add(d));
  renderFiles();
});
$('#f-save').addEventListener('click', async () => {
  if (!F.rel) return toast('Nothing open', 'err');
  try {
    const j = await api('/api/file', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: F.scope, dir: F.dir, rel: F.rel, content: $('#f-edit').value }) });
    toast('Saved (backup kept)', '', j.file);
  } catch (err) { toast(err.message, 'err'); }
});

