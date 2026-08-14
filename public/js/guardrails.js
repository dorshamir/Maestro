'use strict';
/* ------------------------------------------------------------ guardrails */
const G = { scope: 'user', dir: '', files: [], commands: [] };
// The pattern set every README example already uses for the input
// placeholders - secrets plus the handful of commands that do the most
// damage if they run by accident. One click for someone who does not yet
// know what they'd type here.
const GUARD_STARTER = {
  files: ['.env', '.env.*', 'secrets/**', '*.pem', '*_rsa'],
  commands: ['rm -rf', 'git push --force', 'DROP TABLE'],
};
function renderGuard() {
  const chipList = (arr, attr) => arr.map((v, i) =>
    `<div class="rule"><span style="flex:1">${esc(v)}</span><button data-${attr}="${i}" title="remove">✕</button></div>`).join('')
    || '<div class="scope-note" style="margin:0">nothing blocked yet</div>';
  $('#gfiles').innerHTML = chipList(G.files, 'gdf');
  $('#gcmds').innerHTML = chipList(G.commands, 'gdc');
  $('#g-empty-cta').classList.toggle('hidden', G.files.length > 0 || G.commands.length > 0);
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
$('#g-starter').addEventListener('click', () => {
  for (const v of GUARD_STARTER.files) if (!G.files.includes(v)) G.files.push(v);
  for (const v of GUARD_STARTER.commands) if (!G.commands.includes(v)) G.commands.push(v);
  renderGuard();
  toast('Added - press Apply guardrails to make it real');
});

// Tests the rules as they stand on screen, not what is saved to disk - the
// server takes the same draft {files, commands} PUT already sends on Apply.
async function runGuardTest(kind, inputSel, btnSel) {
  const value = $(inputSel).value.trim();
  if (!value) return toast('Type something to test first', 'err');
  const btn = $(btnSel);
  btn.disabled = true;
  try {
    const r = await api('/api/guard-test', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: G.files, commands: G.commands, kind, value }) });
    $('#gtest-result').innerHTML = r.blocked
      ? `<span class="chip" style="color:var(--deny);border-color:var(--deny)">blocked</span> ${esc(r.reason || 'matched a rule above')}`
      : `<span class="chip" style="color:var(--allow);border-color:var(--allow)">allowed</span> no rule above matches this`;
  } catch (err) { toast(err.message, 'err'); }
  finally { btn.disabled = false; }
}
$('#gtest-file-btn').addEventListener('click', () => runGuardTest('file', '#gtest-file', '#gtest-file-btn'));
$('#gtest-cmd-btn').addEventListener('click', () => runGuardTest('command', '#gtest-cmd', '#gtest-cmd-btn'));
$('#gtest-file').addEventListener('keydown', (e) => { if (e.key === 'Enter') runGuardTest('file', '#gtest-file', '#gtest-file-btn'); });
$('#gtest-cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') runGuardTest('command', '#gtest-cmd', '#gtest-cmd-btn'); });

$('#gapply').addEventListener('click', async () => {
  try {
    const j = await api('/api/guard', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: G.scope, dir: G.dir, files: G.files, commands: G.commands,
        mirrorDeny: $('#gmirror').checked, forbidBypass: $('#gbypass').checked }) });
    toast(`Guardrails applied - hook + ${j.mirrored} mirrored deny rules`, '', j.hookFile);
    loadGuard();
  } catch (err) { toast(err.message, 'err'); }
});

