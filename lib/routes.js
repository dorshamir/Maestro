/*
 * Every HTTP route, keyed "METHOD /path" - exact matches only, no pattern
 * matching, no middleware stack. server.js looks a request up in here and
 * awaits the handler inside its own try/catch, so a throw anywhere below
 * becomes a 500 with the message rather than a hung request.
 *
 * Handlers take (req, res, url) where url is a parsed WHATWG URL.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { ROOT, HOME, CLAUDE_DIR, SESSION_ID_RE } = require('./constants');
const { log, send, readBody, binExists, hasWindowsTerminal, rotateBackups, listBackups, restoreBackup } = require('./util');
const { pricing, PRICING_FILE, PRICING_ASOF } = require('./pricing');
const { getDigest } = require('./digests');
const {
  scanSessions, sessionSummary, invalidateSessionCache,
  loadOverrides, saveOverrides, knownProjects,
} = require('./sessions');
const {
  buildCapsule, readTranscript, transcriptToMarkdown, importCapsule, parseTranscript,
  searchTranscripts,
} = require('./transcripts');
const { buildCommand, launchTerminal } = require('./launch');
const { settingsPath, mergeEffective } = require('./settings');
const { readGuard, applyGuard } = require('./guardrails');
const { testFile, testCommand, findNearMisses, findGuardGaps, dismissGuardGap } = require('./guardrail-analysis');
const { listAssets, assetFile, ASSET_TEMPLATES } = require('./library');
const { listFiles, fileRel } = require('./files');
const { listMcp, saveServer, deleteServer, moveServer, setApproval } = require('./mcp');
const { attach, bye } = require('./presence');

// Icons and the web-app manifest. An explicit allow-list rather than a static
// file server: this process can read the user's whole home directory, so it
// should only ever hand out files it can name.
function sendStatic(res, rel, type) {
  try {
    const buf = fs.readFileSync(path.join(ROOT, ...rel.split('/')));
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=86400' });
    return res.end(buf);
  } catch { return send(res, 404, { error: 'not found' }); }
}

const routes = {

  /* ------------------------------------------------------------ the page */

  'GET /': (req, res) => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'));
    return send(res, 200, html.toString(), 'text/html; charset=utf-8');
  },

  'GET /assets/maestro.svg': (req, res) => sendStatic(res, 'assets/maestro.svg', 'image/svg+xml'),
  'GET /assets/maestro.ico': (req, res) => sendStatic(res, 'assets/maestro.ico', 'image/x-icon'),

  // The frontend used to be one inline <script> in index.html; it is now
  // these files plus a boot script, each served by its own exact-match route
  // rather than a pattern-matched static server - same allowlist shape as the
  // icons above, so a request can never hand back anything but a file this
  // list names on purpose.
  'GET /styles.css': (req, res) => sendStatic(res, 'public/styles.css', 'text/css; charset=utf-8'),
  'GET /js/core.js': (req, res) => sendStatic(res, 'public/js/core.js', 'text/javascript; charset=utf-8'),
  'GET /js/sessions.js': (req, res) => sendStatic(res, 'public/js/sessions.js', 'text/javascript; charset=utf-8'),
  'GET /js/transcripts.js': (req, res) => sendStatic(res, 'public/js/transcripts.js', 'text/javascript; charset=utf-8'),
  'GET /js/settings.js': (req, res) => sendStatic(res, 'public/js/settings.js', 'text/javascript; charset=utf-8'),
  'GET /js/guardrails.js': (req, res) => sendStatic(res, 'public/js/guardrails.js', 'text/javascript; charset=utf-8'),
  'GET /js/library.js': (req, res) => sendStatic(res, 'public/js/library.js', 'text/javascript; charset=utf-8'),
  'GET /js/files.js': (req, res) => sendStatic(res, 'public/js/files.js', 'text/javascript; charset=utf-8'),
  'GET /js/mcp.js': (req, res) => sendStatic(res, 'public/js/mcp.js', 'text/javascript; charset=utf-8'),
  'GET /js/boot.js': (req, res) => sendStatic(res, 'public/js/boot.js', 'text/javascript; charset=utf-8'),

  /* ---------------------------------------------------------- lifecycle */

  'GET /api/health': (req, res) =>
    send(res, 200, { ok: true, pid: process.pid, uptime: Math.round(process.uptime()) }),

  // Held open by the page for as long as its window is. The socket itself is
  // the presence signal, and server.js exits once the last one has been gone
  // for its grace period. It also carries a keep-alive comment and a `sessions`
  // event when a transcript changes - the channel is already open, which beats
  // a second one or a poll. See lib/presence.js.
  'GET /api/presence': (req, res) => attach(req, res),

  // Sent from pagehide, so a closed window frees the port promptly instead of
  // waiting out the much longer grace a stream that merely *broke* has earned.
  // A refresh sends it too, which is why it only shortens the wait and never
  // exits by itself: the reconnect that follows takes it back.
  'POST /api/bye': (req, res) => { bye(); send(res, 200, { ok: true }); },

  // The launcher runs the server with no console, so Ctrl+C is not available.
  // Closing the window is the ordinary way out (presence.js); this is the
  // explicit one, for the Quit button.
  'POST /api/quit': (req, res) => {
    send(res, 200, { ok: true });
    log('quit requested from UI');
    setTimeout(() => process.exit(0), 150);
  },

  'GET /api/meta': async (req, res) => send(res, 200, {
    platform: process.platform,
    home: HOME,
    claudeDir: CLAUDE_DIR,
    claudeCli: await binExists('claude'),
    // Set by Maestro.exe and by start.cmd - the two launchers that start the
    // server with no console. The UI uses it to decide whether to offer Quit:
    // with no console there is nothing to Ctrl+C, so the button is the only way
    // out; when a terminal started us, Ctrl+C is the expected way out instead.
    launcher: !!process.env.MAESTRO_NO_OPEN,
    projects: knownProjects(),
  }),

  'GET /api/diagnose': async (req, res, url) => {
    const cwd = url.searchParams.get('dir') || process.cwd();
    const cmdline = 'claude --resume <session-id>';
    const out = { platform: process.platform, node: process.version, cwd,
      env: { MAESTRO_TERMINAL: process.env.MAESTRO_TERMINAL || '(unset)' } };
    if (process.platform === 'win32') {
      out.windowsTerminal = await hasWindowsTerminal();
      out.strategy = 'cmd /c start (window is owned by the console subsystem, not by Maestro)';
      out.wouldRun = out.windowsTerminal
        ? `cmd /c start "" wt.exe -w 0 nt -d "${cwd}" cmd /k ${cmdline}`
        : `cmd /c start "Claude Code" cmd /k ${cmdline}`;
    } else if (process.platform === 'darwin') {
      out.strategy = 'osascript (iTerm2 tab when running, else Terminal.app window)';
      out.wouldRun = `osascript -e 'tell application "Terminal" to do script "cd ... && ${cmdline}"'`;
    } else {
      const found = [];
      for (const b of ['tmux', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'x-terminal-emulator', 'xterm']) {
        if (await binExists(b)) found.push(b);
      }
      out.terminalsFound = found;
      out.strategy = found[0] ? `first available: ${found[0]}` : 'none found - use the copy-command button';
    }
    out.claudeOnPath = await binExists('claude');
    return send(res, 200, out);
  },

  /* ----------------------------------------------------------- sessions */

  'GET /api/sessions': (req, res) => {
    const projects = scanSessions();
    const p = pricing();
    return send(res, 200, {
      projects,
      summary: sessionSummary(),
      pricingFile: PRICING_FILE,
      pricingAsOf: PRICING_ASOF,
      pricingCustom: !!p.custom,
    });
  },

  'POST /api/override': async (req, res) => {
    const body = JSON.parse(await readBody(req) || '{}');
    const o = loadOverrides();
    if (body.sessionId !== undefined) {
      if (!SESSION_ID_RE.test(body.sessionId)) return send(res, 400, { error: 'bad session id' });
      const cur = o.sessions[body.sessionId] || {};
      if (body.name !== undefined) {
        if (body.name === null || String(body.name).trim() === '') delete cur.name;
        else cur.name = String(body.name).trim().slice(0, 200);
      }
      if (body.archived !== undefined) {
        if (body.archived) cur.archived = true;
        else delete cur.archived;
      }
      if (Object.keys(cur).length) o.sessions[body.sessionId] = cur;
      else delete o.sessions[body.sessionId];
    }
    if (body.cwd !== undefined && body.pinned !== undefined) {
      if (body.pinned) o.pins[body.cwd] = true;
      else delete o.pins[body.cwd];
    }
    saveOverrides(o);
    invalidateSessionCache(); // next /api/sessions rescans instead of serving the stale cache
    return send(res, 200, { ok: true });
  },

  'GET /api/pricing': (req, res) =>
    send(res, 200, { file: PRICING_FILE, custom: fs.existsSync(PRICING_FILE), pricing: pricing() }),

  'GET /api/transcript': (req, res, url) =>
    send(res, 200, parseTranscript(url.searchParams.get('file'))),

  // Greps the conversations themselves; the list filter only ever saw metadata.
  // Bounded by size, match count and a deadline inside searchTranscripts - this
  // reads every transcript on the machine and must not hold a request open.
  'GET /api/search': (req, res, url) =>
    send(res, 200, searchTranscripts(url.searchParams.get('q'), {
      limit: url.searchParams.get('limit'),
    })),

  /* ----------------------------------------------------- share / import */

  'GET /api/share-check': (req, res, url) => {
    const file = url.searchParams.get('file');
    const c = buildCapsule(file);
    return send(res, 200, { meta: c.meta, warnings: c.warnings, sizeKb: Math.round(readTranscript(file).length / 1024) });
  },

  'GET /api/export': (req, res, url) => {
    const file = url.searchParams.get('file');
    const format = url.searchParams.get('format') === 'md' ? 'md' : 'capsule';
    const base = (getDigest(file) || {}).customTitle || path.basename(file, '.jsonl').slice(0, 8);
    const safe = String(base).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'session';
    if (format === 'md') {
      const body = Buffer.from(transcriptToMarkdown(file), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safe}.md"`,
        'Content-Length': body.length,
      });
      return res.end(body);
    }
    // Transcripts run to megabytes, so ship them compressed.
    const body = zlib.gzipSync(Buffer.from(JSON.stringify(buildCapsule(file)), 'utf8'));
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${safe}.maestro.gz"`,
      'Content-Length': body.length,
    });
    return res.end(body);
  },

  'POST /api/import': async (req, res) => {
    const b = JSON.parse(await readBody(req) || '{}');
    let buf = Buffer.from(String(b.data || ''), 'base64');
    if (buf[0] === 0x1f && buf[1] === 0x8b) {                              // gzip magic
      // Cap the output. Gzip reaches ~1000:1 on repetitive input, so a few
      // hundred KB of shared "session file" could otherwise expand to tens of
      // gigabytes and take the process out while it inflated.
      try {
        buf = zlib.gunzipSync(buf, { maxOutputLength: 256 * 1024 * 1024 });
      } catch (e) {
        return send(res, 413, { error: 'that session file expands to more than 256 MB - refusing to unpack it' });
      }
    }
    let capsule;
    try { capsule = JSON.parse(buf.toString('utf8')); }
    catch { return send(res, 400, { error: 'that file is not a Maestro session capsule' }); }
    return send(res, 200, importCapsule(capsule, b.targetDir));
  },

  /* ------------------------------------------------------------- launch */

  'POST /api/launch': async (req, res) => {
    const body = JSON.parse(await readBody(req) || '{}');
    const opts = body.options || {};
    const targets = Array.isArray(body.targets) && body.targets.length
      ? body.targets.slice(0, 12)
      : [{ cwd: body.cwd, sessionId: body.sessionId }];
    const results = [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      let command;
      try {
        command = buildCommand({ ...opts, sessionId: t.sessionId, continueLast: !t.sessionId && opts.continueLast });
      } catch (e) { results.push({ ok: false, error: e.message, cwd: t.cwd }); continue; }
      if (!t.cwd || !fs.existsSync(t.cwd)) {
        results.push({ ok: false, error: 'Project folder no longer exists on disk.', command, cwd: t.cwd });
        continue;
      }
      try {
        // Batches always tab after the first, so one click yields one window of tabs.
        if (i > 0) await new Promise((r) => setTimeout(r, 450)); // let the last tab register
        log('launch', JSON.stringify({ cwd: t.cwd, command, newTab: opts.newTab === true || i > 0 }));
        const via = await launchTerminal(t.cwd, command, opts.newTab === true || i > 0);
        log('launch ok via', via);
        results.push({ ok: true, via, command, cwd: t.cwd });
      } catch (e) {
        log('launch FAILED', e.message);
        results.push({ ok: false, error: e.message, command, cwd: t.cwd });
      }
    }
    const failed = results.filter((r) => !r.ok).length;
    return send(res, failed && failed === results.length ? 500 : 200, { results });
  },

  /* ----------------------------------------------------------- settings */

  'GET /api/settings': (req, res, url) => {
    const scope = url.searchParams.get('scope');
    const dir = url.searchParams.get('dir');
    const file = settingsPath(scope, dir);
    const exists = fs.existsSync(file);
    const content = exists ? fs.readFileSync(file, 'utf8') : '';
    let json = null, parseError = null;
    if (exists) {
      try { json = JSON.parse(content); } catch (e) { parseError = e.message; }
    }
    return send(res, 200, { file, exists, content, json, parseError, backups: listBackups(file) });
  },

  'PUT /api/settings': async (req, res) => {
    const body = JSON.parse(await readBody(req) || '{}');
    const file = settingsPath(body.scope, body.dir);
    let parsed;
    try { parsed = JSON.parse(body.content); } catch (e) {
      return send(res, 400, { error: `Not valid JSON: ${e.message}` });
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateBackups(file);
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    return send(res, 200, { ok: true, file });
  },

  // Undo a bad settings save. `backup` must be one of the names /api/settings
  // just handed back in its own `backups` list - restoreBackup() re-verifies
  // that itself, so this route never trusts a client-supplied path.
  'POST /api/settings/restore': async (req, res) => {
    const body = JSON.parse(await readBody(req) || '{}');
    const file = settingsPath(body.scope, body.dir);
    restoreBackup(file, String(body.backup || ''));
    return send(res, 200, { ok: true, file });
  },

  'GET /api/effective': (req, res, url) => {
    const dir = url.searchParams.get('dir');
    return send(res, 200, mergeEffective(dir && path.isAbsolute(dir) ? dir : null));
  },

  /* ---------------------------------------------------------------- mcp */

  'GET /api/mcp': (req, res, url) => {
    const dir = url.searchParams.get('dir') || '';
    return send(res, 200, listMcp(path.isAbsolute(dir) ? dir : null));
  },

  // Upsert. Adding a server arranges for a command to run the next time Claude
  // Code starts - the same weight of change as writing a hook, and the reason
  // http-guard.js insists a mutation be same-origin and declared JSON.
  'PUT /api/mcp': async (req, res) => {
    const b = JSON.parse(await readBody(req) || '{}');
    const file = saveServer(b.scope, b.dir, b.name, b.config);
    log('mcp save', JSON.stringify({ scope: b.scope, name: b.name, file }));
    return send(res, 200, { ok: true, file });
  },

  'DELETE /api/mcp': async (req, res) => {
    const b = JSON.parse(await readBody(req) || '{}');
    const file = deleteServer(b.scope, b.dir, b.name);
    log('mcp delete', JSON.stringify({ scope: b.scope, name: b.name, file }));
    return send(res, 200, { ok: true, file });
  },

  // Move, not copy - see lib/mcp.js's moveServer() for why the two scopes
  // inside ~/.claude.json get one atomic transaction while anything crossing
  // into/out of .mcp.json does not. A "partial" error means the config landed
  // at the target but could not be removed from the source, which this
  // reports as a 200-with-warning rather than a hard failure: the data is
  // safe, just duplicated, and the UI should say so plainly rather than
  // implying the move failed outright.
  'POST /api/mcp-move': async (req, res) => {
    const b = JSON.parse(await readBody(req) || '{}');
    try {
      const file = moveServer(b.from, b.to, b.name);
      log('mcp move', JSON.stringify({ from: b.from, to: b.to, name: b.name, file }));
      return send(res, 200, { ok: true, file });
    } catch (err) {
      if (!err.partial) throw err;
      log('mcp move partial', JSON.stringify({ from: b.from, to: b.to, name: b.name, file: err.file }));
      return send(res, 200, { ok: true, partial: true, file: err.file, warning: err.message });
    }
  },

  // Whether a .mcp.json server is approved to start in this project. Kept apart
  // from the config itself because the file is shared and the answer is not.
  'POST /api/mcp-approval': async (req, res) => {
    const b = JSON.parse(await readBody(req) || '{}');
    const file = setApproval(b.dir, b.name, b.approval);
    return send(res, 200, { ok: true, file });
  },

  /* --------------------------------------------------------- guardrails */

  'GET /api/guard': (req, res, url) => {
    const scope = url.searchParams.get('scope') || 'user';
    const dir = url.searchParams.get('dir') || '';
    if (scope !== 'user' && !path.isAbsolute(dir)) return send(res, 400, { error: 'project directory required' });
    return send(res, 200, readGuard(scope, dir));
  },

  'PUT /api/guard': async (req, res) => {
    const body = JSON.parse(await readBody(req) || '{}');
    return send(res, 200, applyGuard(body));
  },

  // Tests against the draft {files, commands} in the request body, not
  // whatever is saved to disk - so a rule can be sanity-checked before
  // Apply. Runs the real generated hook as a subprocess (see
  // lib/guardrail-analysis.js), so this never blocks the event loop.
  'POST /api/guard-test': async (req, res) => {
    const b = JSON.parse(await readBody(req) || '{}');
    const cfg = { files: b.files, commands: b.commands };
    const result = b.kind === 'command' ? await testCommand(cfg, b.value) : await testFile(cfg, b.value);
    return send(res, 200, result);
  },

  // Retroactively mines this project's (or, with no dir, every project's)
  // transcripts for dangerous commands/file touches that were not blocked by
  // the guard config actually in effect. Bounded like /api/search: this
  // reads real transcripts inside a request.
  'GET /api/guard-near-miss': async (req, res, url) => {
    const dir = url.searchParams.get('dir') || null;
    return send(res, 200, await findNearMisses(dir));
  },

  // Every known project whose own guardrails are a strict subset of a
  // sibling's - machine-wide, not scoped to whichever project is currently
  // selected in the tab, since the whole point is comparing across projects.
  'GET /api/guard-gaps': (req, res) => send(res, 200, { gaps: findGuardGaps() }),

  'POST /api/guard-gaps-dismiss': async (req, res) => {
    const b = JSON.parse(await readBody(req) || '{}');
    dismissGuardGap(b.dir, String(b.key || ''));
    return send(res, 200, { ok: true });
  },

  /* ------------------------------------------------------------ library */

  'GET /api/assets': (req, res, url) =>
    send(res, 200, listAssets(url.searchParams.get('kind'), url.searchParams.get('scope'), url.searchParams.get('dir'))),

  'GET /api/asset': (req, res, url) => {
    const file = assetFile(url.searchParams.get('kind'), url.searchParams.get('scope'),
      url.searchParams.get('dir'), url.searchParams.get('rel'));
    const exists = fs.existsSync(file);
    return send(res, 200, { file, exists, content: exists ? fs.readFileSync(file, 'utf8') : '', backups: listBackups(file) });
  },

  'PUT /api/asset': async (req, res) => {
    const b = JSON.parse(await readBody(req) || '{}');
    const file = assetFile(b.kind, b.scope, b.dir, b.rel);
    const fresh = !fs.existsSync(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateBackups(file);
    fs.writeFileSync(file, b.content != null ? String(b.content) : ASSET_TEMPLATES[b.kind](path.basename(b.rel, '.md')), 'utf8');
    return send(res, 200, { ok: true, file, created: fresh });
  },

  'DELETE /api/asset': async (req, res) => {
    const b = JSON.parse(await readBody(req) || '{}');
    const file = assetFile(b.kind, b.scope, b.dir, b.rel);
    if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
    rotateBackups(file);
    fs.unlinkSync(file);
    if (b.kind === 'skills') {
      const folder = path.dirname(file);
      const leftovers = fs.readdirSync(folder).filter((f) => !f.includes('.maestro-bak.'));
      if (leftovers.length) {
        return send(res, 200, { ok: true, note: `SKILL.md removed (skill disabled). Folder kept - it still has: ${leftovers.join(', ')}` });
      }
      fs.readdirSync(folder).forEach((f) => fs.unlinkSync(path.join(folder, f)));
      fs.rmdirSync(folder);
    }
    return send(res, 200, { ok: true });
  },

  // Same contract as /api/settings/restore: `backup` must be a name /api/asset
  // already returned for this exact file.
  'POST /api/asset/restore': async (req, res) => {
    const b = JSON.parse(await readBody(req) || '{}');
    const file = assetFile(b.kind, b.scope, b.dir, b.rel);
    restoreBackup(file, String(b.backup || ''));
    return send(res, 200, { ok: true, file });
  },

  /* ----------------------------------------------------- file explorer */

  'GET /api/files': (req, res, url) =>
    send(res, 200, listFiles(url.searchParams.get('scope'), url.searchParams.get('dir'))),

  'GET /api/file': (req, res, url) => {
    const file = fileRel(url.searchParams.get('scope'), url.searchParams.get('dir'), url.searchParams.get('rel'));
    if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
    const st = fs.statSync(file);
    if (st.size > 1_000_000) return send(res, 413, { error: `file is ${Math.round(st.size / 1024)} KB - too large to edit here` });
    const buf = fs.readFileSync(file);
    if (buf.subarray(0, 8192).includes(0)) return send(res, 415, { error: 'binary file - open it in your editor' });
    return send(res, 200, { file, content: buf.toString('utf8'), backups: listBackups(file) });
  },

  'PUT /api/file': async (req, res) => {
    const b = JSON.parse(await readBody(req) || '{}');
    const file = fileRel(b.scope, b.dir, b.rel);
    if (String(b.content).length > 2_000_000) return send(res, 413, { error: 'too large' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateBackups(file);
    fs.writeFileSync(file, String(b.content), 'utf8');
    if (/\.(sh|py)$/.test(file) && process.platform !== 'win32') {
      try { fs.chmodSync(file, 0o755); } catch { /* best effort */ }
    }
    return send(res, 200, { ok: true, file });
  },

  // Same contract as /api/settings/restore: `backup` must be a name /api/file
  // already returned for this exact file. fileRel() applies the same path
  // containment and blocked-name checks the read/write routes use.
  'POST /api/file/restore': async (req, res) => {
    const b = JSON.parse(await readBody(req) || '{}');
    const file = fileRel(b.scope, b.dir, b.rel);
    restoreBackup(file, String(b.backup || ''));
    return send(res, 200, { ok: true, file });
  },
};

module.exports = { routes };
