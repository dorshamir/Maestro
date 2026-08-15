'use strict';
/* ------------------------------------------------------------------ mcp */
// Three scopes, two files. User and Local both live inside ~/.claude.json -
// Claude Code's own state file - so every write here is read-modify-write of
// just the mcpServers subtree, with a backup taken first (see lib/mcp.js).
const MC = { data: null, dir: '' };
async function loadMcp() {
  MC.dir = $('#mprojsel').value || '';
  MC.data = await api('/api/mcp?dir=' + encodeURIComponent(MC.dir));
  renderMcp();
}
const MCP_SCOPE_NOTE = {
  user: 'Loads in every project.',
  project: 'Shared with anyone who clones the repo. Needs approval per project before it starts.',
  local: 'This project, this machine. Never shared.',
};
function renderMcp() {
  const j = MC.data;
  if (!j) return;
  const warn = j.claudeJsonBroken
    ? '<div class="card"><div class="bd"><b style="color:var(--deny)">~/.claude.json is not valid JSON.</b> User and Local servers cannot be read or written until that is fixed - Maestro will not overwrite a file it could not parse.</div></div>'
    : '';
  // Identical for every row in every scope card - computed once per render
  // rather than once per server, since j.scopes.map(...).servers.map(...)
  // used to call it again for every row for no reason.
  const projOpts = projectOptionsHtml();
  const cards = j.scopes.map((sc) => {
    const rows = sc.servers.length ? sc.servers.map((s) => {
      const appr = s.approval ? `
        <select class="mcp-appr" data-name="${esc(s.name)}" aria-label="Approval for ${esc(s.name)}" title="Whether Claude Code may start this server in this project">
          <option value="pending"${s.approval === 'pending' ? ' selected' : ''}>not decided</option>
          <option value="enabled"${s.approval === 'enabled' ? ' selected' : ''}>approved</option>
          <option value="disabled"${s.approval === 'disabled' ? ' selected' : ''}>blocked</option>
        </select>` : '';
      return `
        <div class="mcp-row">
          <div class="mcp-main">
            <span class="mcp-name">${esc(s.name)}</span>
            <span class="badge">${esc(s.kind)}</span>
            ${s.envKeys.length ? `<span class="badge" title="Values are not shown here - edit the file directly to see them">env: ${esc(s.envKeys.join(', '))}</span>` : ''}
            ${s.approval === 'pending' ? '<span class="badge" style="color:var(--brass);border-color:var(--brass)" title="Configured but not yet approved, so Claude Code will not start it">not started</span>' : ''}
          </div>
          <div class="mcp-detail">${esc(s.detail) || '<span style="color:var(--faint)">no command or url recorded</span>'}</div>
          <div class="mcp-acts">${appr}
            <button class="btn sm" data-mcp-move-toggle>Move</button>
            <button class="btn sm danger" data-mcp-del="${esc(s.name)}" data-scope="${esc(sc.scope)}">Remove</button>
          </div>
          <div class="mcp-move-panel hidden">
            <select class="mcp-move-toscope" aria-label="Target scope for ${esc(s.name)}">
              <option value="user">User - every project</option>
              <option value="project">Project - .mcp.json, shared with the repo</option>
              <option value="local">Local - this project, this machine only</option>
            </select>
            <select class="mcp-move-todir hidden" aria-label="Target project for ${esc(s.name)}">
              <option value="">- choose project -</option>${projOpts}
            </select>
            <button class="btn sm amber" data-mcp-move-confirm="${esc(s.name)}" data-scope="${esc(sc.scope)}" data-env="${s.envKeys.length ? '1' : '0'}" data-envkeys="${esc(s.envKeys.join(', '))}">Confirm move</button>
            <button class="btn sm" data-mcp-move-cancel>Cancel</button>
          </div>
        </div>`;
    }).join('') : `<div class="empty">No ${esc(sc.scope)} MCP servers.</div>`;
    return `
      <div class="card">
        <h3>${esc(sc.scope)} <span class="badge" style="font-weight:400">${sc.servers.length}</span>
          <span style="margin-left:auto;font:11px var(--mono);color:var(--faint)">${esc(sc.file)}</span></h3>
        <div class="bd">
          <p class="scope-note" style="margin:0 0 10px">${esc(MCP_SCOPE_NOTE[sc.scope] || '')}${
            sc.broken ? ' <b style="color:var(--deny)">This file is not valid JSON.</b>' : ''}</p>
          ${rows}
        </div>
      </div>`;
  }).join('');
  const pick = j.dir ? '' : '<div class="scope-note">Choose a project above to see its <code>.mcp.json</code> and local servers.</div>';
  $('#mcplist').innerHTML = warn + cards + pick;
}
// stdio takes a command, http/sse take a url; showing both at once invites
// filling in the one that will be ignored.
function mcpKindChanged() {
  const stdio = $('#mcp-kind').value === 'stdio';
  $('#mcp-stdio-fields').classList.toggle('hidden', !stdio);
  $('#mcp-url').classList.toggle('hidden', stdio);
}
$('#mcp-kind').addEventListener('change', mcpKindChanged);
$('#mprojsel').addEventListener('change', () => loadMcp().catch((e) => toast(e.message, 'err')));
$('#mcp-reload').addEventListener('click', () => loadMcp().then(() => toast('Reloaded from disk')).catch((e) => toast(e.message, 'err')));
$('#mcp-add').addEventListener('click', async () => {
  const scope = $('#mcp-scope').value;
  const name = $('#mcp-name').value.trim();
  const kind = $('#mcp-kind').value;
  if (!name) return toast('Give the server a name', 'err');
  if (scope !== 'user' && !MC.dir) return toast('Choose a project first - that scope is per project', 'err');
  const config = {};
  if (kind === 'stdio') {
    config.command = $('#mcp-cmd').value.trim();
    // Space-separated is what people paste out of a README. Quoted arguments
    // are rare enough here that a wrong split is better met by editing the
    // file than by half a shell parser living in the page.
    const args = $('#mcp-args').value.trim();
    if (args) config.args = args.split(/\s+/);
  } else {
    config.type = kind;
    config.url = $('#mcp-url').value.trim();
  }
  const env = $('#mcp-env').value.trim();
  if (env) {
    config.env = {};
    for (const pair of env.split(/\s+/)) {
      const at = pair.indexOf('=');
      if (at < 1) return toast(`env must be KEY=value - could not read "${pair}"`, 'err');
      config.env[pair.slice(0, at)] = pair.slice(at + 1);
    }
  }
  try {
    const j = await api('/api/mcp', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, dir: MC.dir, name, config }) });
    toast(`${name} saved - restart Claude Code to pick it up`, '', j.file);
    $('#mcp-name').value = ''; $('#mcp-cmd').value = ''; $('#mcp-args').value = '';
    $('#mcp-url').value = ''; $('#mcp-env').value = '';
    await loadMcp();
  } catch (err) { toast(err.message, 'err'); }
});
$('#mcplist').addEventListener('click', async (e) => {
  const toggle = e.target.closest('[data-mcp-move-toggle]');
  if (toggle) {
    const panel = toggle.closest('.mcp-row').querySelector('.mcp-move-panel');
    const wasOpen = !panel.classList.contains('hidden');
    // Only one panel open at a time - close every other one first.
    $('#mcplist').querySelectorAll('.mcp-move-panel').forEach((p) => p.classList.add('hidden'));
    panel.classList.toggle('hidden', wasOpen);
    return;
  }
  const cancel = e.target.closest('[data-mcp-move-cancel]');
  if (cancel) { cancel.closest('.mcp-move-panel').classList.add('hidden'); return; }

  const confirmMove = e.target.closest('[data-mcp-move-confirm]');
  if (confirmMove) {
    const panel = confirmMove.closest('.mcp-move-panel');
    const name = confirmMove.dataset.mcpMoveConfirm;
    const fromScope = confirmMove.dataset.scope;
    const toScope = panel.querySelector('.mcp-move-toscope').value;
    const toDir = toScope === 'user' ? '' : panel.querySelector('.mcp-move-todir').value;
    if (toScope !== 'user' && !toDir) return toast('Choose a target project first', 'err');
    if (confirmMove.dataset.env === '1' && toScope === 'project') {
      const ok = confirm(`This server has env values (${confirmMove.dataset.envkeys}). Moving it into .mcp.json checks those into git and shares them with anyone who clones the project. Continue?`);
      if (!ok) return;
    }
    try {
      const j = await api('/api/mcp-move', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: { scope: fromScope, dir: MC.dir }, to: { scope: toScope, dir: toDir }, name }) });
      if (j.partial) toast(j.warning, 'err', j.file);
      else {
        const dest = toScope === 'user' ? 'user scope' : `${toScope} scope (${toDir})`;
        toast(`${name} moved to ${dest}${toScope === 'project' ? ' - check its approval state there before relying on it' : ''}`);
      }
      await loadMcp();
    } catch (err) { toast(err.message, 'err'); }
    return;
  }

  const del = e.target.closest('[data-mcp-del]');
  if (!del) return;
  const name = del.dataset.mcpDel;
  if (!confirm(`Remove the MCP server "${name}" from ${del.dataset.scope} scope?`)) return;
  try {
    await api('/api/mcp', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: del.dataset.scope, dir: MC.dir, name }) });
    toast(`${name} removed`);
    await loadMcp();
  } catch (err) { toast(err.message, 'err'); }
});
$('#mcplist').addEventListener('change', async (e) => {
  const toscope = e.target.closest('.mcp-move-toscope');
  if (toscope) {
    toscope.closest('.mcp-move-panel').querySelector('.mcp-move-todir').classList.toggle('hidden', toscope.value === 'user');
    return;
  }
  const sel = e.target.closest('.mcp-appr');
  if (!sel) return;
  try {
    await api('/api/mcp-approval', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: MC.dir, name: sel.dataset.name, approval: sel.value }) });
    toast(`${sel.dataset.name}: ${sel.value === 'enabled' ? 'approved' : sel.value === 'disabled' ? 'blocked' : 'left undecided'}`);
    await loadMcp();
  } catch (err) { toast(err.message, 'err'); }
});

