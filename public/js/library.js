'use strict';
/* -------------------------------------------------------------- library */
// Only `kind` is remembered. Scope and project aren't: a restored "project"
// scope with no directory lands you on "choose a project above", which is a
// worse starting point than the User scope the tab opens in anyway.
const LIB_KINDS = ['commands', 'skills', 'agents'];
const L = { kind: 'commands', scope: 'user', dir: '', rel: null, dirty: false, root: '' };
{
  const stored = LS.get('libKind', 'commands');
  if (LIB_KINDS.includes(stored)) L.kind = stored;
}
// The rail's `.on` class is set by the click handler below; a restored kind has
// to set it the same way or the buttons disagree with what is listed.
function applyLibState() {
  document.querySelectorAll('#lkinds button').forEach((x) => x.classList.toggle('on', x.dataset.kind === L.kind));
}
const LIB_NOTES = {
  commands: 'Slash commands - markdown files in ~/.claude/commands (user) or .claude/commands (project, committed). File name = command: review.md → /review. Subfolders namespace: git/pr.md → /git:pr.',
  skills: 'Skills - one folder per skill with a SKILL.md. Claude loads a skill automatically when its description matches the task, so write that line carefully. Extra files in the folder are referenced from SKILL.md.',
  agents: 'Subagents - markdown with YAML frontmatter (name, description, tools, model). Claude delegates via the Task tool, or ask for one by name.',
};
// The listed folder is shown, not just described: "Skills is empty" and "Skills
// is empty *here*" are different problems, and only the second one is solvable
// by the person reading it.
function libTitle() {
  $('#lib-note').innerHTML = esc(LIB_NOTES[L.kind])
    + (L.root ? `<br><span style="font:11px var(--mono);color:var(--faint)">listing ${esc(L.root)}</span>` : '');
  $('#lib-current').textContent = L.rel
    ? (L.kind === 'commands' ? '/' + L.rel.replace(/\.md$/, '').replace(/\//g, ':') : L.rel)
    : 'nothing open';
}
async function loadLib() {
  if (L.scope === 'project' && !L.dir) {
    L.root = ''; // nothing is being listed - don't leave the user scope's path on screen
    $('#lib-list').innerHTML = '<div class="scope-note" style="margin:0">choose a project above</div>';
    libTitle();
    return;
  }
  const j = await api(`/api/assets?kind=${L.kind}&scope=${L.scope}&dir=${encodeURIComponent(L.dir)}`);
  L.root = j.root || '';
  $('#lib-list').innerHTML = j.items.map((it) => `
    <div class="hook" style="align-items:center;cursor:pointer" data-open="${esc(it.rel)}">
      <div class="body"><b style="font:600 12px var(--mono)">${esc(L.kind === 'commands' ? '/' + it.rel.replace(/\.md$/, '').replace(/\//g, ':') : it.rel)}</b>
        ${it.extras ? `<span class="m"> +${it.extras} files</span>` : ''}
        ${it.description ? `<div class="m">${esc(it.description)}</div>` : ''}</div>
      <span class="m" style="font:10px var(--mono)">${rel(it.mtime)}</span>
    </div>`).join('')
    || `<div class="scope-note" style="margin:0">none yet at this scope - press + New${
      L.kind === 'skills' ? '. Skills bundled with Claude Code, and skills from a plugin, are not files in this folder and never show up here.' : ''}</div>`;
  libTitle();
}
async function openLib(relPath) {
  const j = await api(`/api/asset?kind=${L.kind}&scope=${L.scope}&dir=${encodeURIComponent(L.dir)}&rel=${encodeURIComponent(relPath)}`);
  L.rel = relPath; L.dirty = false;
  $('#lib-edit').value = j.content;
  libTitle();
  renderBackupSelect('#lib-backups', j.backups, async (name) => {
    await api('/api/asset/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: L.kind, scope: L.scope, dir: L.dir, rel: L.rel, backup: name }) });
    toast('Restored from backup');
    await openLib(L.rel);
  });
}
$('#lkinds').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  L.kind = b.dataset.kind; L.rel = null; $('#lib-edit').value = '';
  renderBackupSelect('#lib-backups', [], null);
  LS.set('libKind', L.kind);
  applyLibState();
  loadLib().catch((err) => toast(err.message, 'err'));
});
$('#lscopes').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  L.scope = b.dataset.scope; L.rel = null; $('#lib-edit').value = '';
  renderBackupSelect('#lib-backups', [], null);
  document.querySelectorAll('#lscopes button').forEach((x) => x.classList.toggle('on', x === b));
  $('#lprojsel').classList.toggle('hidden', L.scope === 'user');
  loadLib().catch((err) => toast(err.message, 'err'));
});
$('#lprojsel').addEventListener('change', () => {
  L.dir = $('#lprojsel').value; L.rel = null;
  renderBackupSelect('#lib-backups', [], null);
  loadLib().catch((err) => toast(err.message, 'err'));
});
$('#lib-list').addEventListener('click', (e) => {
  const row = e.target.closest('[data-open]'); if (!row) return;
  if (L.dirty && !confirm('Discard unsaved edits?')) return;
  openLib(row.dataset.open).catch((err) => toast(err.message, 'err'));
});
$('#lib-edit').addEventListener('input', () => { L.dirty = true; });
$('#lib-new').addEventListener('click', async () => {
  const hint = { commands: 'command name (subfolders ok): review  or  git/pr', skills: 'skill name: token-audit', agents: 'agent name: code-reviewer' }[L.kind];
  const name = prompt(hint); if (!name) return;
  try {
    const j = await api('/api/asset', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: L.kind, scope: L.scope, dir: L.dir, rel: name.trim(), content: null }) });
    toast(j.created ? 'Created from template' : 'Already existed - opened', '', j.file);
    await loadLib();
    await openLib(L.kind === 'skills' ? name.trim() : (name.trim().endsWith('.md') ? name.trim() : name.trim() + '.md'));
  } catch (err) { toast(err.message, 'err'); }
});
$('#lib-save').addEventListener('click', async () => {
  if (!L.rel) return toast('Nothing open', 'err');
  try {
    const j = await api('/api/asset', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: L.kind, scope: L.scope, dir: L.dir, rel: L.rel, content: $('#lib-edit').value }) });
    L.dirty = false;
    toast('Saved - available in new sessions immediately', '', j.file);
    loadLib();
  } catch (err) { toast(err.message, 'err'); }
});
$('#lib-del').addEventListener('click', async () => {
  if (!L.rel) return toast('Nothing open', 'err');
  if (!confirm(`Delete ${L.rel}? A .maestro-bak copy is kept.`)) return;
  try {
    const j = await api('/api/asset', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: L.kind, scope: L.scope, dir: L.dir, rel: L.rel }) });
    L.rel = null; $('#lib-edit').value = '';
    renderBackupSelect('#lib-backups', [], null);
    toast(j.note || 'Deleted');
    loadLib();
  } catch (err) { toast(err.message, 'err'); }
});

