#!/usr/bin/env node
/*
 * Static checks - no server required.  npm test
 *
 * These exist because each one is a bug that actually shipped: a dead $('#id')
 * that threw during startup and silently stopped every listener below it from
 * attaching; a tab with no panel; a keepAliveTimeout short enough for browsers
 * to trip over; a synchronous exec that froze the event loop; a `shell: true`
 * spawn that tied the server's life to a terminal window.
 *
 * It also runs the guardrail hook for real - crafted stdin, asserted exit codes
 * - because that hook is a template literal carrying three levels of escaping,
 * and eyeballing it is not a test.
 *
 * The unit checks require lib/ modules directly. That is only safe because
 * requiring a lib module has no side effects: everything that *runs* - the
 * process handlers, pruneDigests(), listen() - lives in server.js. If a module
 * ever starts doing work at require time, this file will hang or open a port,
 * and that is the signal to move the work back into the entry point.
 *
 * The source-level greps below must scan the entry point AND every lib file.
 * Pointed at server.js alone they would still pass, silently, forever - the
 * code they are policing having simply moved out from under them.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const SERVER = path.join(ROOT, 'server.js');
const LIB = path.join(ROOT, 'lib');
const PAGE = path.join(ROOT, 'public', 'index.html');

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log('  ok    ' + name); };
const bad = (name, detail) => {
  fail++;
  console.log('  FAIL  ' + name + (detail ? '\n          ' + String(detail).split('\n').join('\n          ') : ''));
};
const check = (name, cond, detail) => (cond ? ok(name) : bad(name, detail));
const group = (t) => console.log('\n' + t);

const libFiles = fs.readdirSync(LIB).filter((f) => f.endsWith('.js')).sort()
  .map((f) => path.join(LIB, f));
const server = fs.readFileSync(SERVER, 'utf8');
const page = fs.readFileSync(PAGE, 'utf8');
// Everything that ships as server-side code, for the whole-codebase greps.
const allSource = [SERVER, ...libFiles].map((f) => fs.readFileSync(f, 'utf8')).join('\n');

/* ------------------------------------------------------------ syntax */
group('syntax');
for (const file of [SERVER, ...libFiles, __filename]) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  check(path.relative(ROOT, file).replace(/\\/g, '/') + ' parses', r.status === 0, r.stderr);
}
{
  // The page's inline <script> must parse too - a syntax error there is a
  // blank UI with one console message nobody sees.
  const m = page.match(/<script>([\s\S]*)<\/script>/);
  if (!m) bad('index.html has an inline script', 'no <script> block found');
  else {
    try { new Function(m[1]); ok('index.html inline script parses'); }
    catch (e) { bad('index.html inline script parses', e.message); }
  }
}

/* -------------------------------------------------------------- UI wiring */
group('UI wiring');
{
  const ids = new Set([...page.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const refs = [...new Set([...page.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))];
  const missing = refs.filter((r) => !ids.has(r));
  check(`every $('#id') resolves (${refs.length} refs)`, missing.length === 0,
    missing.length ? 'no element for: ' + missing.join(', ') : '');

  const tabs = [...page.matchAll(/role="tab"[^>]*aria-controls="([^"]+)"/g)].map((m) => m[1]);
  const orphan = tabs.filter((t) => !ids.has(t));
  check(`every tab has a panel (${tabs.length} tabs)`, orphan.length === 0,
    orphan.length ? 'no panel for: ' + orphan.join(', ') : '');
}

/* ------------------------------------------------------------ route table */
group('route table');
{
  // Requiring this pulls in every other lib module, so a broken require path
  // anywhere in the graph fails here rather than at first HTTP request.
  const { routes } = require('./lib/routes');
  const keys = Object.keys(routes);
  check(`route table loads (${keys.length} routes)`, keys.length > 0, 'no routes exported');

  const malformed = keys.filter((k) => !/^(GET|PUT|POST|DELETE|HEAD) \/\S*$/.test(k));
  check('every key is "METHOD /path"', malformed.length === 0, 'bad keys: ' + malformed.join(', '));
  const notFn = keys.filter((k) => typeof routes[k] !== 'function');
  check('every route is a function', notFn.length === 0, 'not callable: ' + notFn.join(', '));

  // The page is the only client. An endpoint it calls that no longer exists is
  // a 404 the user meets as a dead button.
  const served = new Set(keys.map((k) => k.split(' ')[1]));
  const called = [...new Set([...page.matchAll(/\/api\/[a-z][a-z-]*/g)].map((m) => m[0]))];
  const dead = called.filter((p) => !served.has(p));
  check(`every endpoint the page calls exists (${called.length} paths)`, dead.length === 0,
    'no route for: ' + dead.join(', '));

  check('the page itself is served', served.has('/'), 'GET / is missing');

  // Bundled files (public/index.html, assets/*) are read relative to the
  // install root. A handler that reaches for __dirname now resolves inside
  // lib/ and 404s the whole UI - so run the handlers against a stub response
  // rather than grepping for the mistake.
  const capture = () => {
    const out = { code: 0, body: null };
    return { out, res: { writeHead(c) { out.code = c; }, end(b) { out.body = b; } } };
  };
  const call = (key, pathname) => {
    const { out, res } = capture();
    routes[key]({ method: key.split(' ')[0], headers: {} }, res, new URL('http://127.0.0.1:4144' + pathname));
    return out;
  };

  const home = call('GET /', '/');
  check('GET / serves the real index.html', home.code === 200 && /<\/html>/i.test(String(home.body)),
    `status ${home.code}, ${String(home.body).length} bytes - bundled files must resolve from ROOT`);

  const icon = call('GET /assets/maestro.svg', '/assets/maestro.svg');
  check('GET /assets/maestro.svg serves the icon', icon.code === 200,
    `status ${icon.code} - assets must resolve from ROOT`);
}

/* ------------------------------------------------------- server hygiene */
group('server hygiene');
{
  // Node closes idle sockets after 5s by default; browsers reuse them for
  // minutes and then report ERR_EMPTY_RESPONSE, which fetch() surfaces as
  // "Failed to fetch" after any pause in the UI.
  const m = server.match(/server\.keepAliveTimeout\s*=\s*([^;]+);/);
  const val = m ? Function('return ' + m[1])() : 0;
  check('keepAliveTimeout outlives browser socket reuse (>=60s)', val >= 60_000,
    m ? `is ${val}ms` : 'not set at all');

  const h = server.match(/server\.headersTimeout\s*=\s*([^;]+);/);
  const hv = h ? Function('return ' + h[1])() : 0;
  check('headersTimeout exceeds keepAliveTimeout', hv > val, `headers=${hv} keepAlive=${val}`);

  // One synchronous exec freezes every other request - Node is single
  // threaded, and on macOS the AppleScript probe can block indefinitely
  // waiting on an Accessibility permission dialog. Scanned across every
  // server-side file, not just the entry point.
  const sync = [...allSource.matchAll(/\b(execSync|execFileSync|spawnSync)\s*\(/g)].map((m) => m[1]);
  check(`no synchronous exec anywhere in the server (${libFiles.length + 1} files)`,
    sync.length === 0, 'found: ' + sync.join(', '));

  // shell:true + detached made the launched cmd share this process's console
  // on Windows, so closing the Claude window killed the Maestro server.
  // Strip comments first - the rule against it is itself written in a comment.
  // `[^\n]*` rather than `.*`: JS's dot does not match \r, so on a CRLF file
  // `.*$` never reaches end-of-string and the comment survives the strip.
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/(^|[^:])\/\/[^\n]*$/, '$1')).join('\n');
  check('no shell:true spawn', !/shell\s*:\s*true/.test(stripComments(allSource)), 'found shell: true');

  check('binds to loopback only', /listen\(\s*PORT\s*,\s*'127\.0\.0\.1'/.test(server),
    'server.listen must pin 127.0.0.1');

  // The idle-shutdown timer belongs in the entry point, next to listen(), even
  // though lib/presence.js is where it reads most naturally - beside the sockets
  // it watches. A lib module that starts a timer at require time makes this file
  // hang, because the checks below require those modules directly.
  const libOnly = libFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  check('no setInterval in lib/', !/setInterval\s*\(/.test(stripComments(libOnly)),
    'timers must live in server.js - selftest requires lib modules directly');
}

/* --------------------------------------------------------------- presence */
group('presence (closing the window stops the server)');
{
  const { EventEmitter } = require('events');
  const { attach, orphanedFor, everConnected, count } = require('./lib/presence');
  // attach() only writes headers and one comment line, then waits for 'close'.
  const win = () => Object.assign(new EventEmitter(), { writeHead() {}, write() {} });
  const later = (ms) => Date.now() + ms;

  check('a server nobody connected to is orphaned from boot', orphanedFor(later(60_000)) >= 60_000,
    'a launcher that never opens a browser must not leave a server behind');
  check('nothing has connected yet', everConnected() === false);

  const a = win(), b = win();
  attach({}, a);
  check('an open window is not orphaned', orphanedFor(later(60_000)) === 0, 'orphaned while a window is open');
  check('a connection is remembered', everConnected() === true);

  attach({}, b);
  a.emit('close');
  check('a second window keeps it alive', orphanedFor(later(60_000)) === 0 && count() === 1,
    'closing one of two windows must not stop the server');

  b.emit('close');
  check('the last window closing starts the clock', orphanedFor(later(9_000)) >= 9_000, 'clock did not start');
  b.emit('close');
  check('a duplicate close does not restart the clock', orphanedFor(later(9_000)) >= 9_000,
    'req and res can both report close; the second must not extend the grace period');
}

/* -------------------------------------------------------------- packaging */
group('packaging');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('lib/ is published', (pkg.files || []).includes('lib'),
    'package.json "files" must list lib, or npm ships a server with no modules');
  check('entry point is still server.js', pkg.bin['claude-maestro'] === './server.js',
    'Maestro.exe and start.sh both look for server.js by name');
  check('still zero dependencies', Object.keys(pkg.dependencies || {}).length === 0,
    'dependencies: ' + Object.keys(pkg.dependencies || {}).join(', '));
}

/* -------------------------------------------------------------- pricing */
group('pricing');
{
  const { pricing, priceUsage, rateFor } = require('./lib/pricing');
  const p = pricing();

  // Family-prefix matching is the whole reason this table is 5 lines instead
  // of one per model: an unreleased point release must price itself.
  const families = [
    ['claude-opus-5', 5, 25],
    ['claude-opus-4-8', 5, 25],
    ['claude-opus-9-20991231', 5, 25],   // does not exist yet - must still price
    ['claude-sonnet-5', 3, 15],
    ['claude-haiku-4-5-20251001', 1, 5],
    ['claude-fable-5', 10, 50],
    ['claude-mythos-5', 10, 50],
  ];
  for (const [id, i, o] of families) {
    const r = rateFor(id, p);
    check(`rate for ${id}`, r && r.in === i && r.out === o,
      r ? `got in=${r.in} out=${r.out}, want in=${i} out=${o}` : 'no rate matched');
  }
  check('unknown vendor stays unpriced', rateFor('gpt-4o', p) === null,
    'a non-Claude model must not silently inherit a Claude rate');
  check('fast mode costs more than standard',
    rateFor('claude-opus-5|fast', p).out > rateFor('claude-opus-5', p).out);

  // 1M output tokens on Opus is exactly the headline rate.
  const oneM = priceUsage({ 'claude-opus-5': { in: 0, out: 1e6, cacheR: 0, cacheW: 0, cacheW1h: 0 } }, p);
  check('1M Opus output tokens = $25', Math.abs(oneM - 25) < 1e-9, 'got ' + oneM);
  // Cache reads bill at 0.1x input, so 1M of them on Opus is $0.50.
  const reads = priceUsage({ 'claude-opus-5': { in: 0, out: 0, cacheR: 1e6, cacheW: 0, cacheW1h: 0 } }, p);
  check('1M Opus cache reads = $0.50', Math.abs(reads - 0.5) < 1e-9, 'got ' + reads);
  const w1h = priceUsage({ 'claude-opus-5': { in: 0, out: 0, cacheR: 0, cacheW: 0, cacheW1h: 1e6 } }, p);
  check('1M Opus 1h cache writes = $10', Math.abs(w1h - 10) < 1e-9, 'got ' + w1h);
  check('unpriced model contributes $0',
    priceUsage({ 'llama-3': { in: 1e9, out: 1e9, cacheR: 0, cacheW: 0, cacheW1h: 0 } }, p) === 0);
}

/* ------------------------------------------------------- token counting */
group('token counting (transcript dedup)');
{
  const { computeDigest } = require('./lib/digests');

  const tmp = path.join(os.tmpdir(), 'maestro-selftest-' + process.pid + '.jsonl');
  const usage = {
    input_tokens: 100, output_tokens: 200,
    cache_read_input_tokens: 1000,
    cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 0 },
  };
  // One API response, split across three content-block lines - exactly how
  // Claude Code writes a turn with thinking + text + tool_use. Every line
  // repeats the same complete usage object.
  const line = (blocks) => JSON.stringify({
    type: 'assistant', requestId: 'req_1', timestamp: '2026-01-01T00:00:00Z',
    message: { id: 'msg_1', model: 'claude-opus-5', usage, content: blocks },
  });
  fs.writeFileSync(tmp, [
    line([{ type: 'thinking' }]),
    line([{ type: 'text' }]),
    line([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]),
    // a genuinely separate response must still be counted
    JSON.stringify({
      type: 'assistant', requestId: 'req_2', timestamp: '2026-01-01T00:01:00Z',
      message: { id: 'msg_2', model: 'claude-opus-5', usage, content: [{ type: 'text' }] },
    }),
    // a synthetic Claude Code notice is not an API call at all
    JSON.stringify({
      type: 'assistant', requestId: 'req_3', isApiErrorMessage: true,
      message: { id: 'msg_3', model: '<synthetic>', usage, content: [{ type: 'text' }] },
    }),
  ].join('\n') + '\n');

  try {
    const d = computeDigest(tmp);
    const u = d.byModel['claude-opus-5'] || {};
    check('one response counted once, not once per content block',
      u.out === 400, `output_tokens=${u.out}, want 400 (2 responses x 200)`);
    check('input tokens deduped', u.in === 200, `in=${u.in}, want 200`);
    check('cache reads deduped', u.cacheR === 2000, `cacheR=${u.cacheR}, want 2000`);
    check('cache writes deduped', u.cacheW === 100, `cacheW=${u.cacheW}, want 100`);
    check('turn count is responses, not lines', d.aiTurns === 3, `aiTurns=${d.aiTurns}, want 3`);
    check('<synthetic> excluded from model list',
      !('<synthetic>' in d.byModel), 'synthetic notices are not API usage');
    check('tool use still detected across split lines', d.bashes === 1, `bashes=${d.bashes}`);
  } finally { try { fs.unlinkSync(tmp); } catch { /* best effort */ } }
}

/* --------------------------------------------------- spend by calendar day */
group('spend attribution (byDay)');
{
  const { computeDigest } = require('./lib/digests');
  const { priceUsage, pricing } = require('./lib/pricing');

  // The 7/30-day windows used to attribute a session's WHOLE cost to the file's
  // mtime, so a session opened weeks ago and touched today dropped all of its
  // spend into "last 7 days". Buckets are per local calendar day, which is why
  // these timestamps carry an offset: the day is the user's, not UTC's.
  const tmp = path.join(os.tmpdir(), 'maestro-selftest-day-' + process.pid + '.jsonl');
  const usage = (n) => ({ input_tokens: n, output_tokens: n, cache_read_input_tokens: 0 });
  const at = (ts, id, n) => JSON.stringify({
    type: 'assistant', requestId: id, timestamp: ts,
    message: { id, model: 'claude-opus-5', usage: usage(n), content: [{ type: 'text' }] },
  });
  const local = (day, hour) => {
    // Build an ISO string that lands on `day` in *this* machine's zone, so the
    // assertion does not flip depending on where the suite runs.
    const d = new Date(`${day}T${hour}:00:00`);
    return d.toISOString();
  };
  fs.writeFileSync(tmp, [
    at(local('2026-03-01', '10'), 'a1', 100),
    at(local('2026-03-01', '11'), 'a2', 100),   // same day, must add up
    at(local('2026-03-05', '09'), 'b1', 300),
    // split across content blocks: the dedup must hold inside a day too
    at(local('2026-03-05', '09'), 'b1', 300),
  ].join('\n') + '\n');

  try {
    const d = computeDigest(tmp);
    const days = Object.keys(d.byDay || {}).sort();
    check('one bucket per calendar day', days.length === 2, 'days=' + JSON.stringify(days));
    check('buckets carry the right dates',
      days[0] === '2026-03-01' && days[1] === '2026-03-05', JSON.stringify(days));
    const m1 = (d.byDay['2026-03-01'] || {}).models || {};
    const m5 = (d.byDay['2026-03-05'] || {}).models || {};
    check('same-day responses accumulate',
      (m1['claude-opus-5'] || {}).in === 200, 'in=' + JSON.stringify(m1));
    check('a repeated response is not double-counted in its day',
      (m5['claude-opus-5'] || {}).in === 300, 'in=' + JSON.stringify(m5));
    const dayTotal = Object.values(d.byDay)
      .reduce((a, x) => a + priceUsage(x.models, pricing()), 0);
    const sessionTotal = priceUsage(d.byModel, pricing());
    check('days sum to the session total',
      Math.abs(dayTotal - sessionTotal) < 1e-9, `days=${dayTotal} session=${sessionTotal}`);
  } finally { try { fs.unlinkSync(tmp); } catch { /* best effort */ } }
}

/* ------------------------------------------------------------ guardrails */
group('guardrail hook (executed for real)');
{
  const { HOOK_SCRIPT } = require('./lib/guardrails');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-guard-'));
  const hook = path.join(dir, 'maestro-guard.js');
  fs.writeFileSync(hook, HOOK_SCRIPT);
  fs.writeFileSync(path.join(dir, 'maestro-guardrails.json'), JSON.stringify({
    files: ['.env', 'secrets/**', '*.pem'],
    commands: ['rm -rf', 'git push --force', 'DROP TABLE'],
  }));

  const cases = [
    ['Read a guarded file', { tool_name: 'Read', tool_input: { file_path: '/p/.env' } }, true],
    ['Read inside a guarded glob', { tool_name: 'Read', tool_input: { file_path: '/p/secrets/db.txt' } }, true],
    ['Read a guarded extension', { tool_name: 'Read', tool_input: { file_path: '/p/certs/key.pem' } }, true],
    ['Read an ordinary file', { tool_name: 'Read', tool_input: { file_path: '/p/src/app.js' } }, false],
    ['Write a guarded file', { tool_name: 'Write', tool_input: { file_path: '/p/.env' } }, true],
    ['NotebookEdit a guarded file', { tool_name: 'NotebookEdit', tool_input: { notebook_path: '/p/.env' } }, true],
    // Grep -> content is a read path; blocking Read alone left it wide open.
    ['Grep the contents of a guarded file',
      { tool_name: 'Grep', tool_input: { pattern: '.', path: '/p/.env', output_mode: 'content' } }, true],
    ['Grep scoped by a guarded glob',
      { tool_name: 'Grep', tool_input: { pattern: 'KEY', glob: '*.pem' } }, true],
    ['Glob a guarded tree', { tool_name: 'Glob', tool_input: { pattern: 'secrets/**' } }, true],
    ['Glob an ordinary tree', { tool_name: 'Glob', tool_input: { pattern: 'src/**/*.js' } }, false],
    ['Bash reading a guarded file', { tool_name: 'Bash', tool_input: { command: 'cat .env | grep KEY' } }, true],
    ['Bash redirecting into a guarded file', { tool_name: 'Bash', tool_input: { command: 'echo x>.env' } }, true],
    ['Blocked token, bare', { tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' } }, true],
    ['Blocked token after &&', { tool_name: 'Bash', tool_input: { command: 'cd /x && rm -rf build' } }, true],
    ['Blocked token inside quotes', { tool_name: 'Bash', tool_input: { command: 'sh -c "rm -rf build"' } }, true],
    ['Blocked token in a pipeline', { tool_name: 'Bash', tool_input: { command: 'true | git push --force' } }, true],
    ['Blocked token, different case', { tool_name: 'Bash', tool_input: { command: 'psql -c "drop table users"' } }, true],
    ['Harmless command', { tool_name: 'Bash', tool_input: { command: 'ls -la' } }, false],
    ['Substring must not false-positive', { tool_name: 'Bash', tool_input: { command: 'echo performing' } }, false],
  ];
  for (const [label, evt, expectBlock] of cases) {
    const r = spawnSync(process.execPath, [hook], { input: JSON.stringify(evt), encoding: 'utf8' });
    const blocked = r.status === 2;
    check(label + ' -> ' + (expectBlock ? 'blocked' : 'allowed'), blocked === expectBlock,
      blocked ? 'blocked: ' + r.stderr : 'allowed when it should have been blocked');
  }

  // A typo in the config must never brick every session.
  fs.writeFileSync(path.join(dir, 'maestro-guardrails.json'), '{ this is not json');
  const broken = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/p/.env' } }), encoding: 'utf8',
  });
  check('fails open on a corrupt config', broken.status === 0,
    'exit ' + broken.status + ' - a bad config must not block every tool call');

  fs.rmSync(dir, { recursive: true, force: true });
}

/* -------------------------------------------------------------- security */
group('request guards (DNS rebinding / CSRF)');
{
  const { guardRequest } = require('./lib/http-guard');
  const call = (method, headers) => guardRequest({ method, headers });
  const JSONCT = { 'content-type': 'application/json' };

  // Allowed: what the UI itself sends.
  check('loopback GET allowed', call('GET', { host: '127.0.0.1:4144' }) === null);
  check('localhost GET allowed', call('GET', { host: 'localhost:4144' }) === null);
  check('same-origin JSON mutation allowed',
    call('PUT', { host: '127.0.0.1:4144', origin: 'http://127.0.0.1:4144', ...JSONCT }) === null);
  check('direct navigation allowed (sec-fetch-site: none)',
    call('GET', { host: 'localhost:4144', 'sec-fetch-site': 'none' }) === null);

  // Blocked: DNS rebinding. evil.com resolves to 127.0.0.1, so the socket is
  // ours - only the Host header reveals the request was not meant for us.
  check('rebound Host refused', call('GET', { host: 'evil.com:4144' }) !== null);
  check('rebound Host refused (no port)', call('GET', { host: 'evil.com' }) !== null);
  check('missing Host refused', call('GET', {}) !== null);

  // Blocked: cross-site writes.
  check('cross-origin mutation refused',
    call('PUT', { host: '127.0.0.1:4144', origin: 'http://evil.com', ...JSONCT }) !== null);
  check('cross-site fetch refused',
    call('POST', { host: '127.0.0.1:4144', 'sec-fetch-site': 'cross-site', ...JSONCT }) !== null);
  // text/plain is CORS-safelisted, so it sends with no preflight - this is the
  // exact shape that let a random web page write settings.json.
  check('text/plain mutation refused',
    call('PUT', { host: '127.0.0.1:4144', 'content-type': 'text/plain' }) !== null);
  check('form-encoded mutation refused',
    call('POST', { host: '127.0.0.1:4144', 'content-type': 'application/x-www-form-urlencoded' }) !== null);
  check('mutation with no content-type refused',
    call('POST', { host: '127.0.0.1:4144' }) !== null);
}

group('path containment');
{
  const { fileRel } = require('./lib/files');
  const rejects = (label, fn) => {
    let threw = false;
    try { fn(); } catch { threw = true; }
    check(label, threw, 'call was allowed through');
  };
  rejects('traversal rejected', () => fileRel('user', '', '../../.ssh/id_rsa'));
  rejects('encoded-backslash traversal rejected', () => fileRel('user', '', '..\\..\\.ssh\\id_rsa'));
  rejects('absolute path rejected', () => fileRel('user', '', 'C:/Windows/System32/drivers/etc/hosts'));
  rejects('posix absolute path rejected', () => fileRel('user', '', '/etc/passwd'));
  rejects('credentials never exposed', () => fileRel('user', '', '.credentials.json'));
  rejects('transcript store not browsable', () => fileRel('user', '', 'projects/x/y.jsonl'));
  rejects('project scope stays in .claude', () => fileRel('project', process.cwd(), 'package.json'));
  check('ordinary user file allowed',
    typeof fileRel('user', '', 'settings.json') === 'string');
}

/* ---------------------------------------------------------------- report */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
