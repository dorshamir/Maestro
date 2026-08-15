'use strict';
/* ------------------------------------------------------------ settings */
const SCOPE_NOTES = {
  user: '~/.claude/settings.json - applies to you, across all projects.',
  project: '.claude/settings.json - committed to the repo, shared with the whole team.',
  local: '.claude/settings.local.json - personal overrides for one project, git-ignored.',
};
function markDirty(v) { S.dirty = v; $('#dirty').classList.toggle('hidden', !v); }

async function loadSettings() {
  if (S.scope !== 'user' && !S.dir) {
    $('#settings-file').textContent = 'choose a project above';
    hookFormClear();
    S.doc = {}; renderForm();
    renderBackupSelect('#settings-backups', [], null);
    return;
  }
  // Any pending hook edit points at indices inside the *old* S.doc. Carrying it
  // across a scope switch would splice whatever happens to sit at those
  // coordinates in the new file - deleting a hook the user never touched.
  hookFormClear();
  const j = await api(`/api/settings?scope=${S.scope}&dir=${encodeURIComponent(S.dir)}`);
  S.file = j.file;
  $('#settings-file').textContent = j.file + (j.exists ? '' : '  (will be created)');
  if (j.parseError) toast('Existing file has invalid JSON - fix it in Raw tab. ' + j.parseError, 'err');
  S.doc = j.json || (j.parseError ? null : {});
  if (S.doc === null) { setRawMode(true); $('#raw').value = j.content; }
  else { $('#raw').value = JSON.stringify(S.doc, null, 2); renderForm(); }
  markDirty(false);
  refreshHookScopeCount();
  renderBackupSelect('#settings-backups', j.backups, async (name) => {
    await api('/api/settings/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: S.scope, dir: S.dir, backup: name }) });
    toast('Restored from backup');
    await loadSettings();
  });
}
// Hooks concatenate across scopes rather than overriding, so the file on screen
// is never the whole story - a project hook and a user hook both fire. Count
// what else is out there so an empty-looking Hooks card cannot be read as
// "nothing runs here".
async function refreshHookScopeCount() {
  const el = $('#hook-othercount');
  el.textContent = '';
  const count = (hooks) => Object.values(hooks || {})
    .reduce((a, ms) => a + (ms || []).reduce((b, m) => b + ((m.hooks || []).length), 0), 0);
  try {
    const eff = await api('/api/effective?dir=' + encodeURIComponent(S.dir || ''));
    const others = count(eff.merged.hooks) - count((S.doc || {}).hooks);
    if (others > 0) {
      el.textContent = `+${others} from other scopes`;
      el.title = 'Hooks defined in the other settings files that also fire here. Effective config shows all of them.';
    }
  } catch { /* the count is a nicety; never let it break the settings view */ }
}
function renderForm() {
  const d = S.doc || {};
  const perms = d.permissions || {};
  for (const list of ['allow', 'ask', 'deny']) {
    $('#rules-' + list).innerHTML = (perms[list] || []).map((r, i) =>
      `<div class="rule"><span style="flex:1">${esc(r)}</span><button data-dr="${list}:${i}" title="remove">✕</button></div>`).join('')
      || '<div class="scope-note" style="margin:0">none</div>';
  }
  const hooks = d.hooks || {};
  const hfrag = [];
  for (const [ev, matchers] of Object.entries(hooks)) {
    const meta = HOOK_EVENTS[ev];
    (matchers || []).forEach((m, mi) => (m.hooks || []).forEach((h, hi) => {
      // A matcher on an event that does not match on anything is not an error,
      // but it is almost always someone expecting it to narrow the hook. Say so
      // where they will see it, next to the hook itself.
      const stray = m.matcher && meta && !meta.matcher
        ? ` <span class="m" style="color:var(--brass)" title="${esc(ev)} fires once, with nothing to match against - this matcher is ignored">matcher ignored</span>` : '';
      hfrag.push(`<div class="hook"><span class="ev">${esc(ev)}</span>
        <div class="body">${m.matcher ? `<span class="m">[${esc(m.matcher)}]</span> ` : ''}${esc(h.command || h.url || h.type)}
        ${h.type && h.type !== 'command' ? ` <span class="m">(${esc(h.type)})</span>` : ''}
        ${h.timeout ? ` <span class="m">⏱ ${h.timeout}s</span>` : ''}${stray}</div>
        <button class="btn sm" data-eh="${esc(ev)}:${mi}:${hi}">edit</button>
        <button class="btn sm danger" data-dh="${esc(ev)}:${mi}:${hi}">remove</button></div>`);
    }));
  }
  $('#hooks-list').innerHTML = hfrag.join('') || '<div class="scope-note" style="margin:0 0 6px">no hooks in this file</div>';
  renderHookHelp();
  renderDefKeys();
  renderCatalog();
}

/* ---- settings catalog: every documented settings.json key, type-aware ---- */
const CATALOG = [
  { k:'statusLine', t:'object', d:'Custom terminal status line - run your script, its stdout becomes the footer', ex:{type:'command',command:'~/.claude/statusline.sh'} },
  { k:'model', t:'string', d:'Default model for sessions', ex:'opus' },
  { k:'effortLevel', t:'enum', o:['low','medium','high','xhigh'], d:'Persisted reasoning effort level', ex:'high' },
  { k:'outputStyle', t:'string', d:'Output style applied to the system prompt', ex:'Explanatory' },
  { k:'language', t:'string', d:'Preferred response language (also dictation + session titles)', ex:'hebrew' },
  { k:'env', t:'object', d:'Environment variables injected into every session and subprocess', ex:{MY_VAR:'value'} },
  { k:'apiKeyHelper', t:'string', d:'Script that generates the auth value for model requests', ex:'/bin/gen_key.sh' },
  { k:'alwaysThinkingEnabled', t:'bool', d:'Extended thinking on by default for all sessions', ex:true },
  { k:'autoCompactEnabled', t:'bool', d:'Auto-compact the conversation as context fills', ex:false },
  { k:'autoCompactWindow', t:'number', d:'Tokens of context before auto-compact kicks in (100k–1M)', ex:500000 },
  { k:'cleanupPeriodDays', t:'number', d:'Delete session transcripts older than this many days', ex:30 },
  { k:'autoUpdatesChannel', t:'enum', o:['latest','stable'], d:'Release channel: stable lags ~a week, skips bad releases', ex:'stable' },
  { k:'minimumVersion', t:'string', d:'Floor version - updater will not go below this', ex:'2.1.100' },
  { k:'editorMode', t:'enum', o:['normal','vim'], d:'Prompt input key bindings', ex:'vim' },
  { k:'defaultShell', t:'enum', o:['bash','powershell'], d:'Shell for ! commands in the input box', ex:'powershell' },
  { k:'fastMode', t:'bool', d:'Fast mode on where available', ex:true },
  { k:'fastModePerSessionOptIn', t:'bool', d:'Fast mode never persists - each session starts off', ex:true },
  { k:'fallbackModel', t:'array', d:'Model chain tried in order when the primary is overloaded (max 3)', ex:['claude-sonnet-4-6','claude-haiku-4-5'] },
  { k:'availableModels', t:'array', d:'Restrict which models can be selected (sessions, subagents, skills)', ex:['sonnet','haiku'] },
  { k:'attribution', t:'object', d:'Customize or empty git commit / PR attribution lines', ex:{commit:'',pr:''} },
  { k:'companyAnnouncements', t:'array', d:'Startup announcements, cycled at random - great for team scope', ex:['Review the team CLAUDE.md before big refactors'] },
  { k:'claudeMdExcludes', t:'array', d:'Glob patterns of CLAUDE.md files to skip when loading memory', ex:['**/vendor/**/CLAUDE.md'] },
  { k:'includeGitInstructions', t:'bool', d:'Include built-in commit/PR workflow in the system prompt', ex:false },
  { k:'autoMemoryEnabled', t:'bool', d:'Auto memory read/write', ex:false },
  { k:'autoMemoryDirectory', t:'string', d:'Custom auto-memory storage directory', ex:'~/my-memory-dir' },
  { k:'fileCheckpointingEnabled', t:'bool', d:'Snapshot files before edits so /rewind can restore', ex:true },
  { k:'enableAllProjectMcpServers', t:'bool', d:'Auto-approve every MCP server in the project .mcp.json', ex:true },
  { k:'enabledMcpjsonServers', t:'array', d:'Specific .mcp.json servers to approve', ex:['memory','github'] },
  { k:'disabledMcpjsonServers', t:'array', d:'Specific .mcp.json servers to reject', ex:['filesystem'] },
  { k:'disableAllHooks', t:'bool', d:'Kill switch: disable all hooks and custom status line', ex:true },
  { k:'disableBundledSkills', t:'bool', d:'Remove the skills/workflows bundled with Claude Code', ex:true },
  { k:'disableWorkflows', t:'bool', d:'Disable dynamic workflows and bundled workflow commands', ex:true },
  { k:'disableAgentView', t:'bool', d:'Turn off background agents / agent view', ex:true },
  { k:'disableRemoteControl', t:'bool', d:'Block Remote Control (phone pairing) entirely', ex:true },
  { k:'awaySummaryEnabled', t:'bool', d:'One-line recap when you return to the terminal', ex:true },
  { k:'autoScrollEnabled', t:'bool', d:'Follow output to the bottom in fullscreen rendering', ex:false },
  { k:'emojiCompletionEnabled', t:'bool', d:'Emoji :shortcode: suggestions in the prompt', ex:false },
  { k:'askUserQuestionTimeout', t:'enum', o:['60s','5m','10m','never'], d:'Auto-continue idle question dialogs (user scope only)', ex:'5m' },
  { k:'spinnerTipsEnabled', t:'bool', d:'Tips shown in the loading spinner', ex:false },
  { k:'advisorModel', t:'string', d:'Model for the server-side advisor tool', ex:'opus' },
  { k:'agent', t:'string', d:'Run the main thread as a named subagent by default', ex:'code-reviewer' },
  { k:'forceLoginMethod', t:'enum', o:['claudeai','console','gateway'], d:'Restrict which account type can log in', ex:'console' },
  { k:'feedbackSurveyRate', t:'number', d:'Probability (0–1) of the session quality survey', ex:0 },
  { k:'crossSessionInbound', t:'enum', o:['accept','hold','refuse'], d:'How this session treats messages from your other sessions', ex:'hold' },
  { k:'allowedHttpHookUrls', t:'array', d:'URL allowlist for HTTP hooks (empty array blocks all)', ex:['https://hooks.example.com/*'] },
  { k:'autoMode', t:'object', d:'Tune what auto mode blocks/allows - prose rules (user/managed scope only)', ex:{soft_deny:['$defaults','Never run terraform apply']} },
];
const CAT_BY_KEY = Object.fromEntries(CATALOG.map((c) => [c.k, c]));

function defEditor(key, val) {
  const meta = CAT_BY_KEY[key] || {};
  const t = meta.t || (typeof val === 'boolean' ? 'bool' : typeof val === 'number' ? 'number'
    : typeof val === 'string' ? 'string' : 'json');
  if (t === 'bool') return `<select data-defkey="${esc(key)}" data-deftype="bool">
      <option value="true"${val === true ? ' selected' : ''}>true</option>
      <option value="false"${val === false ? ' selected' : ''}>false</option></select>`;
  if (t === 'enum') return `<select data-defkey="${esc(key)}" data-deftype="string">
      ${(meta.o || []).map((o) => `<option${o === val ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  if (t === 'number') return `<input type="number" data-defkey="${esc(key)}" data-deftype="number" value="${esc(val)}">`;
  if (t === 'string') return `<input data-defkey="${esc(key)}" data-deftype="string" value="${esc(val)}">`;
  return `<textarea data-defkey="${esc(key)}" data-deftype="json" rows="3" style="width:100%">${esc(JSON.stringify(val, null, 2))}</textarea>`;
}
function renderDefKeys() {
  const d = S.doc || {};
  const keys = Object.keys(d).filter((k) => k !== 'permissions' && k !== 'hooks' && k !== '$schema');
  $('#defcount').textContent = keys.length + (d.permissions ? 1 : 0) + (d.hooks ? 1 : 0) + ' keys';
  $('#defkeys').innerHTML = keys.map((k) => `
    <div class="genrow">
      <label title="${esc((CAT_BY_KEY[k] || {}).d || '')}">${esc(k)}</label>
      <div style="display:flex;gap:8px;align-items:flex-start">${defEditor(k, d[k])}
        <button class="btn sm danger" data-delkey="${esc(k)}" title="remove key">✕</button></div>
    </div>`).join('')
    || '<div class="scope-note" style="margin:0">nothing defined here yet - pick from the catalog below (permissions & hooks are edited above)</div>';
}
function renderCatalog() {
  const q = ($('#catq').value || '').toLowerCase();
  const defined = new Set(Object.keys(S.doc || {}));
  $('#catalog').innerHTML = CATALOG
    .filter((c) => !defined.has(c.k) && (!q || (c.k + ' ' + c.d).toLowerCase().includes(q)))
    .map((c) => `<div class="hook" style="align-items:center">
      <div class="body"><b style="font:600 12px var(--mono)">${esc(c.k)}</b>
        <span class="m"> - ${esc(c.d)}</span></div>
      <button class="btn sm" data-addkey="${esc(c.k)}">Add</button></div>`).join('')
    || '<div class="scope-note" style="margin:0">no matches - anything undocumented goes in the Raw JSON tab</div>';
}
$('#catq').addEventListener('input', renderCatalog);

function setRawMode(raw) {
  if (raw && S.doc) $('#raw').value = JSON.stringify(S.doc, null, 2);
  if (!raw) {
    try { S.doc = JSON.parse($('#raw').value || '{}'); renderForm(); }
    catch (e) { toast('Raw JSON is invalid - staying in Raw tab. ' + e.message, 'err'); raw = true; }
  }
  S.rawMode = raw;
  $('#form-editor').classList.toggle('hidden', raw);
  $('#raw-editor').classList.toggle('hidden', !raw);
  $('#tab-form').classList.toggle('on', !raw);
  $('#tab-raw').classList.toggle('on', raw);
}
$('#tab-form').addEventListener('click', () => setRawMode(false));
$('#tab-raw').addEventListener('click', () => setRawMode(true));
$('#raw').addEventListener('input', () => markDirty(true));
$('#add-schema').addEventListener('click', () => {
  try {
    const d = JSON.parse($('#raw').value || '{}');
    d.$schema = 'https://json.schemastore.org/claude-code-settings.json';
    $('#raw').value = JSON.stringify(d, null, 2); markDirty(true);
  } catch (e) { toast('Fix JSON first: ' + e.message, 'err'); }
});

$('#scopes').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.scope = b.dataset.scope;
  document.querySelectorAll('#scopes button').forEach((x) => x.classList.toggle('on', x === b));
  $('#projsel').classList.toggle('hidden', S.scope === 'user');
  $('#scope-note').textContent = SCOPE_NOTES[S.scope];
  loadSettings().catch((err) => toast(err.message, 'err'));
});
$('#projsel').addEventListener('change', () => { S.dir = $('#projsel').value; loadSettings().catch((err) => toast(err.message, 'err')); });

$('#view-settings').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || !S.doc) return;
  if (b.dataset.dr) {
    const [list, i] = b.dataset.dr.split(':');
    S.doc.permissions[list].splice(Number(i), 1);
    if (!S.doc.permissions[list].length) delete S.doc.permissions[list];
    markDirty(true); renderForm();
  } else if (b.dataset.dh) {
    const [ev, mi, hi] = b.dataset.dh.split(':');
    const m = S.doc.hooks[ev][Number(mi)];
    m.hooks.splice(Number(hi), 1);
    if (!m.hooks.length) S.doc.hooks[ev].splice(Number(mi), 1);
    if (!S.doc.hooks[ev].length) delete S.doc.hooks[ev];
    if (!Object.keys(S.doc.hooks).length) delete S.doc.hooks;
    if (hookEditing === b.dataset.dh) hookFormClear();
    markDirty(true); renderForm();
  } else if (b.dataset.eh) {
    const [ev, mi, hi] = b.dataset.eh.split(':');
    const m = S.doc.hooks[ev][Number(mi)];
    const h = m.hooks[Number(hi)];
    hookEditing = b.dataset.eh;
    $('#hook-event').value = ev;
    $('#hook-type').value = h.type === 'http' ? 'http' : 'command';
    renderHookHelp();
    $('#hook-matcher').value = m.matcher || '';
    $('#hook-cmd').value = h.command || '';
    $('#hook-url').value = h.url || '';
    $('#hook-timeout').value = h.timeout || '';
    $('#hook-add').textContent = 'Update hook';
    $('#hook-cancel').classList.remove('hidden');
    $('#hook-event').scrollIntoView({ block: 'center', behavior: 'smooth' });
  } else if (b.dataset.delkey) {
    delete S.doc[b.dataset.delkey];
    markDirty(true); renderForm();
  } else if (b.dataset.addkey) {
    const c = CAT_BY_KEY[b.dataset.addkey];
    S.doc[c.k] = JSON.parse(JSON.stringify(c.ex));
    markDirty(true); renderForm();
    toast(`${c.k} added - adjust the value, then Save file`);
  }
});
$('#view-settings').addEventListener('change', (e) => {
  const el = e.target.closest('[data-defkey]');
  if (el && S.doc) {
    const t = el.dataset.deftype;
    let v = el.value;
    if (t === 'bool') v = v === 'true';
    else if (t === 'number') v = Number(v);
    else if (t === 'json') {
      try { v = JSON.parse(v); }
      catch (err) { return toast(`${el.dataset.defkey}: invalid JSON - ${err.message}`, 'err'); }
    }
    S.doc[el.dataset.defkey] = v;
    markDirty(true);
  } else if (e.target.closest('#form-editor')) markDirty(true);
});
$('#rule-add').addEventListener('click', () => {
  if (!S.doc) return;
  const tool = $('#rule-tool').value;
  const spec = $('#rule-spec').value.trim();
  const rule = tool ? (spec ? `${tool}(${spec})` : tool) : spec;
  if (!rule) return toast('Enter a rule first', 'err');
  const list = $('#rule-list').value;
  S.doc.permissions = S.doc.permissions || {};
  S.doc.permissions[list] = S.doc.permissions[list] || [];
  if (!S.doc.permissions[list].includes(rule)) S.doc.permissions[list].push(rule);
  $('#rule-spec').value = ''; markDirty(true); renderForm();
});
$('#preset-safety').addEventListener('click', () => {
  if (!S.doc) return;
  const pack = ['Bash(rm -rf *)', 'Bash(git push --force*)', 'Bash(git reset --hard*)',
    'Read(./.env)', 'Read(./.env.*)', 'Read(./secrets/**)', 'Read(**/id_rsa*)'];
  S.doc.permissions = S.doc.permissions || {};
  S.doc.permissions.deny = S.doc.permissions.deny || [];
  for (const r of pack) if (!S.doc.permissions.deny.includes(r)) S.doc.permissions.deny.push(r);
  markDirty(true); renderForm(); toast('Safety pack added to deny list');
});
/* ------------------------------------------------------------------ hooks */
// What each event is for, and whether a matcher means anything to it. Written
// down here because the difference is invisible in settings.json: a matcher on
// Stop parses fine, saves fine, and silently never narrows anything.
const HOOK_EVENTS = {
  PreToolUse:       { matcher: 'tool name, e.g. Bash or Edit|Write', d: 'Before a tool runs. The only event that can refuse one: exit 2 blocks the call and tells Claude why.' },
  PostToolUse:      { matcher: 'tool name, e.g. Bash or Edit|Write', d: 'After a tool has run. Good for formatters, linters and audit logs.' },
  UserPromptSubmit: { matcher: null, d: 'When you submit a prompt, before Claude sees it. Can inject context or refuse the turn.' },
  Notification:     { matcher: null, d: 'When Claude Code raises a notification - waiting for input, permission needed.' },
  Stop:             { matcher: null, d: 'When the main agent has finished responding.' },
  SubagentStop:     { matcher: null, d: 'When a subagent (Task tool) finishes.' },
  PreCompact:       { matcher: 'manual or auto', d: 'Before the context window is compacted.' },
  SessionStart:     { matcher: 'startup, resume, clear or compact', d: 'When a session starts or resumes.' },
  SessionEnd:       { matcher: null, d: 'When a session ends.' },
  ConfigChange:     { matcher: null, d: 'When settings change while a session is running.' },
};
// Which hook is being edited, as event:matcherIndex:hookIndex - null when the
// form is adding. Editing is remove-then-insert at the same place, so a hook
// keeps its position in the file rather than jumping to the end.
let hookEditing = null;
function renderHookHelp() {
  const ev = $('#hook-event').value;
  const meta = HOOK_EVENTS[ev] || {};
  const m = $('#hook-matcher');
  m.placeholder = meta.matcher ? `matcher: ${meta.matcher}` : 'no matcher for this event';
  m.disabled = !meta.matcher;
  m.classList.toggle('hidden', !meta.matcher);
  const http = $('#hook-type').value === 'http';
  $('#hook-cmd').classList.toggle('hidden', http);
  $('#hook-url').classList.toggle('hidden', !http);
  $('#hook-help').innerHTML = `<b>${esc(ev)}</b> - ${esc(meta.d || '')}` +
    (http ? ' <b>HTTP hooks only fire for URLs allowed by <code>allowedHttpHookUrls</code></b>, which is a settings key like any other - add it below if it is not set.' : '') +
    ' Hooks from User, Project and Local scope all run: a hook here adds to the others rather than replacing them.';
}
$('#hook-event').addEventListener('change', renderHookHelp);
$('#hook-type').addEventListener('change', renderHookHelp);
function hookFormClear() {
  hookEditing = null;
  $('#hook-cmd').value = ''; $('#hook-url').value = '';
  $('#hook-matcher').value = ''; $('#hook-timeout').value = '';
  $('#hook-add').textContent = 'Add hook';
  $('#hook-cancel').classList.add('hidden');
}
$('#hook-cancel').addEventListener('click', hookFormClear);
$('#hook-add').addEventListener('click', () => {
  if (!S.doc) return;
  const ev = $('#hook-event').value;
  const type = $('#hook-type').value;
  const meta = HOOK_EVENTS[ev] || {};
  const timeout = Number($('#hook-timeout').value) || undefined;
  if (timeout !== undefined && (!isFinite(timeout) || timeout <= 0)) return toast('Timeout must be a positive number of seconds', 'err');

  let h;
  if (type === 'http') {
    const url = $('#hook-url').value.trim();
    if (!url) return toast('Enter a hook URL', 'err');
    if (!/^https?:\/\//i.test(url)) return toast('Hook URL must start with http:// or https://', 'err');
    h = { type: 'http', url, ...(timeout ? { timeout } : {}) };
  } else {
    const cmd = $('#hook-cmd').value.trim();
    if (!cmd) return toast('Enter a hook command', 'err');
    h = { type: 'command', command: cmd, ...(timeout ? { timeout } : {}) };
  }
  const matcher = meta.matcher ? $('#hook-matcher').value.trim() : '';

  S.doc.hooks = S.doc.hooks || {};
  if (hookEditing) {
    // Drop the original first, then insert in its place. Editing the event or
    // the matcher means it may not land back where it came from, which is why
    // this is a remove-and-insert and not a field-by-field patch.
    const [oev, omi, ohi] = hookEditing.split(':');
    const om = S.doc.hooks[oev] && S.doc.hooks[oev][Number(omi)];
    if (om) {
      om.hooks.splice(Number(ohi), 1);
      if (!om.hooks.length) S.doc.hooks[oev].splice(Number(omi), 1);
      if (!S.doc.hooks[oev].length) delete S.doc.hooks[oev];
    }
  }
  S.doc.hooks[ev] = S.doc.hooks[ev] || [];
  // Reuse a matcher group that already exists so the file does not grow a
  // separate entry per hook for the same matcher.
  const group = S.doc.hooks[ev].find((g) => (g.matcher || '') === matcher);
  if (group) { group.hooks = group.hooks || []; group.hooks.push(h); }
  else S.doc.hooks[ev].push(matcher ? { matcher, hooks: [h] } : { hooks: [h] });

  toast(hookEditing ? 'Hook updated - Save file to write it' : 'Hook added - Save file to write it');
  hookFormClear();
  markDirty(true); renderForm();
});
$('#save-settings').addEventListener('click', async () => {
  let content;
  if (S.rawMode) content = $('#raw').value;
  else content = JSON.stringify(S.doc, null, 2);
  try {
    const j = await api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: S.scope, dir: S.dir, content }) });
    markDirty(false);
    toast('Saved - running sessions hot-reload most keys', '', j.file);
    loadSettings();
  } catch (err) { toast(err.message, 'err'); }
});
$('#reload-settings').addEventListener('click', () => loadSettings().then(() => toast('Reloaded from disk')).catch((e) => toast(e.message, 'err')));

/* ------------------------------------------------------------ effective */
async function loadEffective() {
  const dir = $('#effsel').value;
  const j = await api('/api/effective?dir=' + encodeURIComponent(dir));
  const chip = (s) => s.split('+').map((x) => `<span class="chip ${x}">${x}</span>`).join('');
  // A short, readable rendering of a value - "why isn't it what I set" is
  // answered by seeing the two values side by side, not by a wall of JSON.
  const brief = (v) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return String(s === undefined ? 'undefined' : s).replace(/\s+/g, ' ').slice(0, 90);
  };
  const rows = Object.entries(j.sources).map(([k, s]) => {
    const o = (j.overridden || {})[k];
    // Naming the scope that lost, and what it had, is the whole point: the
    // winning scope alone still leaves you hunting for the file that is being
    // ignored.
    const beaten = o ? `<div class="beat">${o.beat.map((b) =>
      `overrides <span class="chip ${esc(b.scope)}">${esc(b.scope)}</span> <code>${esc(brief(b.value))}</code>`).join('<br>')}</div>` : '';
    return `<tr><td style="width:40%">${esc(k)}${beaten}</td><td>${chip(s)}${
      o ? ` <code style="font:11px var(--mono);color:var(--dim)">${esc(brief(o.winner.value))}</code>` : ''}</td></tr>`;
  }).join('');
  const nOver = Object.keys(j.overridden || {}).length;
  const rules = ['deny', 'ask', 'allow'].map((list) => j.ruleSources[list].length ?
    `<div style="margin-bottom:10px"><b class="permcol ${list}" style="font:600 12px var(--mono)">${list}</b><br>` +
    j.ruleSources[list].map((r) => `<div class="rule">${chip(r.scope)}<span>${esc(r.rule)}</span></div>`).join('') + '</div>' : '').join('');
  $('#effout').innerHTML = `
    <div class="card"><h3>Files merged</h3><div class="bd">
      ${j.layers.length ? j.layers.map((l) => `<div class="layerline">${chip(l.scope)} ${esc(l.file)}</div>`).join('') : '<div class="empty">no settings files found for this selection</div>'}
    </div></div>
    ${rules ? `<div class="card"><h3>Permission rules (merged across scopes)</h3><div class="bd">${rules}</div></div>` : ''}
    <div class="card"><h3>Key provenance${nOver ? ` <span class="badge" style="color:var(--brass);border-color:var(--brass)" title="Keys set in more than one scope - the lower one is being ignored">${nOver} overridden</span>` : ''}</h3><div class="bd">${rows ? `<table class="eff">${rows}</table>` : '<div class="empty">empty</div>'}</div></div>
    <div class="card"><h3>Merged result</h3><div class="bd"><pre class="json">${esc(JSON.stringify(j.merged, null, 2))}</pre></div></div>
    <div class="scope-note">Approximation of Claude Code's own precedence (managed policies and CLI flags sit above these and aren't shown).</div>`;
}
$('#effsel').addEventListener('change', loadEffective);

