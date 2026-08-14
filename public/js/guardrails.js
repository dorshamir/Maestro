'use strict';
/* ------------------------------------------------------------ guardrails */
const G = { scope: 'user', dir: '', files: [], commands: [] };
function renderGuard() {
  const chipList = (arr, attr) => arr.map((v, i) =>
    `<div class="rule"><span style="flex:1">${esc(v)}</span><button data-${attr}="${i}" title="remove">✕</button></div>`).join('')
    || '<div class="scope-note" style="margin:0">nothing blocked yet</div>';
  $('#gfiles').innerHTML = chipList(G.files, 'gdf');
  $('#gcmds').innerHTML = chipList(G.commands, 'gdc');
}
async function loadGuard() {
  if (G.scope !== 'user' && !G.dir) { $('#gfile-path').textContent = 'choose a project above'; G.files = []; G.commands = []; renderGuard(); return; }
  const j = await api(`/api/guard?scope=${G.scope}&dir=${encodeURIComponent(G.dir)}`);
  G.files = j.files; G.commands = j.commands;
  $('#gmirror').checked = j.files.length || j.commands.length ? j.mirrorDeny : true;
  $('#gbypass').checked = j.forbidBypass;
  $('#gfile-path').textContent = `${j.settingsFile}  +  ${j.hookFile}`;
  $('#gstatus').innerHTML = j.hookExists && j.registered
    ? '<span class="chip project">active</span> hook installed and registered - list edits apply on next Apply, instantly to running sessions'
    : '<span class="chip local">inactive</span> not installed yet for this scope - press Apply';
  renderGuard();
}
$('#gscopes').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  G.scope = b.dataset.scope;
  document.querySelectorAll('#gscopes button').forEach((x) => x.classList.toggle('on', x === b));
  $('#gprojsel').classList.toggle('hidden', G.scope === 'user');
  loadGuard().catch((err) => toast(err.message, 'err'));
});
$('#gprojsel').addEventListener('change', () => { G.dir = $('#gprojsel').value; loadGuard().catch((err) => toast(err.message, 'err')); });
$('#view-guard').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.gdf !== undefined) { G.files.splice(Number(b.dataset.gdf), 1); renderGuard(); }
  else if (b.dataset.gdc !== undefined) { G.commands.splice(Number(b.dataset.gdc), 1); renderGuard(); }
});
const addGuardEntry = (inputSel, list) => {
  const v = $(inputSel).value.trim();
  if (!v) return toast('Type a pattern first', 'err');
  if (!list.includes(v)) list.push(v);
  $(inputSel).value = ''; renderGuard();
};
$('#gfile-add').addEventListener('click', () => addGuardEntry('#gfile-in', G.files));
$('#gcmd-add').addEventListener('click', () => addGuardEntry('#gcmd-in', G.commands));
$('#gfile-in').addEventListener('keydown', (e) => { if (e.key === 'Enter') addGuardEntry('#gfile-in', G.files); });
$('#gcmd-in').addEventListener('keydown', (e) => { if (e.key === 'Enter') addGuardEntry('#gcmd-in', G.commands); });
$('#gapply').addEventListener('click', async () => {
  try {
    const j = await api('/api/guard', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: G.scope, dir: G.dir, files: G.files, commands: G.commands,
        mirrorDeny: $('#gmirror').checked, forbidBypass: $('#gbypass').checked }) });
    toast(`Guardrails applied - hook + ${j.mirrored} mirrored deny rules`, '', j.hookFile);
    loadGuard();
  } catch (err) { toast(err.message, 'err'); }
});

