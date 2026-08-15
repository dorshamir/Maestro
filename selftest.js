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
const PUBLIC_JS_DIR = path.join(ROOT, 'public', 'js');
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
// The frontend used to be one inline <script> in index.html; it is now these
// files plus a boot script (see public/js/*.js and the <script src> tags at
// the bottom of index.html). Load order matters at runtime but not for these
// checks - every top-level const/function in a classic script is global
// regardless of which file defines it.
const frontendJS = fs.readdirSync(PUBLIC_JS_DIR).filter((f) => f.endsWith('.js')).sort()
  .map((f) => path.join(PUBLIC_JS_DIR, f));
const server = fs.readFileSync(SERVER, 'utf8');
const page = fs.readFileSync(PAGE, 'utf8');
// Element ids live in the page's markup only; references to them and the
// /api/ calls that use them live wherever a view's script landed - so wiring
// checks below read ids from `page` alone but refs/calls from `frontend`.
const frontend = [page, ...frontendJS.map((f) => fs.readFileSync(f, 'utf8'))].join('\n');
// Everything that ships as server-side code, for the whole-codebase greps.
const allSource = [SERVER, ...libFiles].map((f) => fs.readFileSync(f, 'utf8')).join('\n');

// CommonJS has no top-level await, and one group below (the guardrail rule
// tester) is genuinely async - it shells out to node, same as run() in
// lib/util.js does in the real server, which is why sync exec is banned
// below in the first place. Everything else in this file is synchronous and
// unaffected: wrapping the whole run in one IIFE preserves top-to-bottom
// group order without having to thread async through every other check.
(async () => {

/* ------------------------------------------------------------ syntax */
group('syntax');
for (const file of [SERVER, ...libFiles, ...frontendJS, __filename]) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  check(path.relative(ROOT, file).replace(/\\/g, '/') + ' parses', r.status === 0, r.stderr);
}
{
  // The page itself must ship no inline script any more - the whole point of
  // the split was to stop code piling up somewhere selftest.js can't see it
  // split by file. A stray inline block would silently escape every check
  // above and below that scans public/js/*.js instead of the page.
  const m = page.match(/<script>[\s\S]*?<\/script>/);
  check('index.html has no inline script (split into public/js/*.js)', !m,
    m ? 'found one: ' + m[0].slice(0, 80) + '…' : '');
}

/* -------------------------------------------------------------- UI wiring */
group('UI wiring');
{
  const ids = new Set([...page.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const refs = [...new Set([...frontend.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))];
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
  const called = [...new Set([...frontend.matchAll(/\/api\/[a-z][a-z-]*/g)].map((m) => m[0]))];
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

  const css = call('GET /styles.css', '/styles.css');
  check('GET /styles.css resolves from ROOT', css.code === 200,
    `status ${css.code} - split-out frontend files must resolve from ROOT too`);
  const boot = call('GET /js/boot.js', '/js/boot.js');
  check('GET /js/boot.js resolves from ROOT', boot.code === 200,
    `status ${boot.code} - split-out frontend files must resolve from ROOT too`);

  // Every public/js/*.js file on disk must have an exact-match route, and vice
  // versa - a file left unrouted after a split is a silent 404 in the browser
  // console, and a route pointing at a file that no longer exists 500s.
  const routedJsFiles = keys.filter((k) => k.startsWith('GET /js/')).map((k) => k.slice('GET /js/'.length));
  const onDiskJsFiles = frontendJS.map((f) => path.basename(f));
  check('every public/js/*.js file has a route',
    onDiskJsFiles.every((f) => routedJsFiles.includes(f)),
    'unrouted: ' + onDiskJsFiles.filter((f) => !routedJsFiles.includes(f)).join(', '));
  check('every GET /js/* route points at a file that exists',
    routedJsFiles.every((f) => onDiskJsFiles.includes(f)),
    'dangling: ' + routedJsFiles.filter((f) => !onDiskJsFiles.includes(f)).join(', '));
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
  const { pricing, priceUsage, rateFor, totalUsd } = require('./lib/pricing');
  const p = pricing();

  // Family-prefix matching is the whole reason this table is 5 lines instead
  // of one per model: an unreleased point release must price itself.
  const families = [
    ['claude-opus-5', 5, 25],
    ['claude-opus-4-8', 5, 25],
    ['claude-opus-9-20991231', 5, 25],   // does not exist yet - must still price
    // claude-sonnet-5 is deliberately NOT in this table: its rate is time-boxed
    // (see below) and calling rateFor() with the real wall clock here would
    // make this test start failing the day the introductory rate lapses.
    // Sonnet 5's $2/$10 is an introductory rate for that one model - every
    // other Sonnet already bills at the $3/$15 family rate. A flat
    // 'claude-sonnet' prefix once priced them all at Sonnet 5's rate.
    ['claude-sonnet-4-6', 3, 15],
    ['claude-sonnet-4-5-20250929', 3, 15],
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

  // The intro rate is time-boxed: past its `until` date, Sonnet 5 must fall
  // through to the same $3/$15 family rate every other Sonnet already pays,
  // not keep billing the lapsed introductory price forever.
  const beforeExpiry = Date.parse('2026-08-30T00:00:00Z');
  const afterExpiry = Date.parse('2026-09-01T00:00:00Z');
  const introRate = rateFor('claude-sonnet-5', p, beforeExpiry);
  check('sonnet 5 intro rate holds before expiry',
    introRate && introRate.in === 2 && introRate.out === 10, JSON.stringify(introRate));
  const lapsedRate = rateFor('claude-sonnet-5', p, afterExpiry);
  check('sonnet 5 falls back to the family rate after the intro expires',
    lapsedRate && lapsedRate.in === 3 && lapsedRate.out === 15, JSON.stringify(lapsedRate));

  // totalUsd(): reported cost is trusted only when nothing in scope batched
  // more than one billed attempt - a multi-attempt response's reported cost
  // never covers its advisor/retry attempts (see digests.js), so trusting it
  // there would silently drop them from the total.
  const byModel = { 'claude-opus-5': { in: 0, out: 1e6, cacheR: 0, cacheW: 0, cacheW1h: 0 } }; // = $25
  check('single-attempt scope trusts the reported cost',
    totalUsd(5, false, byModel, p) === 5, 'got ' + totalUsd(5, false, byModel, p));
  check('multi-attempt scope ignores reported cost and computes from tokens',
    totalUsd(5, true, byModel, p) === 25, 'got ' + totalUsd(5, true, byModel, p));
  check('no reported cost always computes from tokens',
    totalUsd(0, false, byModel, p) === 25, 'got ' + totalUsd(0, false, byModel, p));

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
    check('an ordinary single-attempt session is not flagged multi-attempt',
      d.hadMultiAttempt === false, 'hadMultiAttempt=' + d.hadMultiAttempt);
  } finally { try { fs.unlinkSync(tmp); } catch { /* best effort */ } }
}

/* ------------------------------------------------- per-attempt (iterations) */
group('token counting (usage.iterations)');
{
  const { computeDigest } = require('./lib/digests');
  const { priceUsage, pricing } = require('./lib/pricing');

  // A turn that consults the advisor runs more than one model, and the API bills
  // each attempt separately. `usage.iterations` is the per-attempt record; the
  // top-level usage object describes ONLY the attempt that produced the returned
  // message, so pricing the top level silently drops every advisor consultation
  // - measured at 13%-110% of a session's real spend on real transcripts.
  const tmp = path.join(os.tmpdir(), 'maestro-selftest-iter-' + process.pid + '.jsonl');
  const usage = {
    input_tokens: 2, output_tokens: 155,
    cache_read_input_tokens: 41338,
    cache_creation: { ephemeral_5m_input_tokens: 1351, ephemeral_1h_input_tokens: 0 },
    speed: 'standard',
    iterations: [
      { type: 'message', input_tokens: 2, output_tokens: 487,
        cache_read_input_tokens: 39711,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1627 } },
      { type: 'advisor_message', model: 'claude-fable-5',
        input_tokens: 43021, output_tokens: 5078,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } },
      { type: 'message', input_tokens: 2, output_tokens: 155,
        cache_read_input_tokens: 41338,
        cache_creation: { ephemeral_5m_input_tokens: 1351, ephemeral_1h_input_tokens: 0 } },
    ],
  };
  const line = (blocks) => JSON.stringify({
    type: 'assistant', requestId: 'req_1', timestamp: '2026-03-01T10:00:00Z',
    advisorModel: 'claude-fable-5',
    message: { id: 'msg_1', model: 'claude-opus-5', usage, content: blocks },
  });
  fs.writeFileSync(tmp, [
    // still split across content-block lines: the dedup must survive this change
    line([{ type: 'thinking' }]),
    line([{ type: 'text' }]),
  ].join('\n') + '\n');

  try {
    const d = computeDigest(tmp);
    const adv = d.byModel['claude-fable-5'] || {};
    check('the advisor\'s own attempt is counted',
      adv.in === 43021 && adv.out === 5078, 'fable=' + JSON.stringify(adv));
    const exec = d.byModel['claude-opus-5'] || {};
    check('every executor attempt is counted, not just the returned one',
      exec.out === 642, `out=${exec.out}, want 642 (487 + 155)`);
    check('iteration cache writes keep their own TTL',
      exec.cacheW === 1351 && exec.cacheW1h === 1627, 'exec=' + JSON.stringify(exec));
    check('iterations are deduped per response, not per content-block line',
      exec.in === 4, `in=${exec.in}, want 4 (2 + 2, counted once)`);
    check('the advisor is priced at its own rate',
      priceUsage({ 'claude-fable-5': adv }, pricing()) > 0.68,
      'advisor spend must not be priced as the executor model');
    const day = (d.byDay['2026-03-01'] || {}).models || {};
    check('byDay splits attempts by model too',
      (day['claude-fable-5'] || {}).out === 5078, 'day=' + JSON.stringify(day));
    check('a 3-attempt response flags the session as multi-attempt',
      d.hadMultiAttempt === true, 'hadMultiAttempt=' + d.hadMultiAttempt);
    check('and flags the day it landed on',
      (d.byDay['2026-03-01'] || {}).multi === true,
      'multi=' + (d.byDay['2026-03-01'] || {}).multi);
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

/* ---------------------------------------------------- guardrail rule tester */
group('guardrail rule tester (against a draft config, not the saved one)');
{
  const { testFile, testCommand } = require('./lib/guardrail-analysis');

  const cfg = { files: ['.env', 'secrets/**'], commands: ['rm -rf'] };
  {
    const r = await testFile(cfg, '/p/.env');
    check('testFile: guarded file blocked', r.blocked === true, JSON.stringify(r));
    check('testFile: reason names the rule', /\.env/.test(r.reason), r.reason);
  }
  {
    const r = await testFile(cfg, '/p/src/app.js');
    check('testFile: ordinary file allowed', r.blocked === false, JSON.stringify(r));
  }
  {
    const r = await testCommand(cfg, 'cd /x && rm -rf build');
    check('testCommand: blocked token after && is caught', r.blocked === true, JSON.stringify(r));
  }
  {
    const r = await testCommand(cfg, 'ls -la');
    check('testCommand: harmless command allowed', r.blocked === false, JSON.stringify(r));
  }
  {
    // The whole point: this tests the draft in memory, not whatever (if
    // anything) is written to disk for this scope/project.
    const r = await testFile({ files: ['*.pem'], commands: [] }, '/p/certs/key.pem');
    check('testFile: reacts to a config that was never applied/saved', r.blocked === true, JSON.stringify(r));
  }
  {
    const r = await testFile({ files: [], commands: [] }, '/p/.env');
    check('testFile: empty draft config blocks nothing', r.blocked === false, JSON.stringify(r));
  }
}

/* --------------------------------------------------- near-miss synthesis */
group('near-miss guardrail synthesis (scanning transcript history)');
{
  const { scanTranscriptForRisks } = require('./lib/guardrail-analysis');

  const tmp = path.join(os.tmpdir(), 'maestro-selftest-nearmiss-' + process.pid + '.jsonl');
  const toolUse = (name, input, ts) => JSON.stringify({
    type: 'assistant', timestamp: ts,
    message: { content: [{ type: 'tool_use', name, input }] },
  });
  fs.writeFileSync(tmp, [
    toolUse('Bash', { command: 'cd /repo && rm -rf node_modules' }, '2026-03-01T10:00:00Z'),
    toolUse('Bash', { command: 'git push --force origin main' }, '2026-03-01T10:05:00Z'),
    toolUse('Bash', { command: 'ls -la' }, '2026-03-01T10:06:00Z'), // harmless - must not appear
    toolUse('Read', { file_path: '/repo/.env' }, '2026-03-01T10:07:00Z'),
    toolUse('Read', { file_path: '/repo/src/app.js' }, '2026-03-01T10:08:00Z'), // harmless - must not appear
    // isMeta lines and non-assistant/no-content-array lines must not throw.
    JSON.stringify({ isMeta: true, type: 'assistant', message: { content: [] } }),
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    'not even json',
  ].join('\n') + '\n');

  try {
    const hits = scanTranscriptForRisks(tmp);
    const cmds = hits.filter((h) => h.kind === 'command');
    const files = hits.filter((h) => h.kind === 'file');
    check('flags a recursive force delete', cmds.some((h) => h.seen === 'cd /repo && rm -rf node_modules'), JSON.stringify(hits));
    check('flags a force push', cmds.some((h) => h.seen === 'git push --force origin main'), JSON.stringify(hits));
    check('does not flag a harmless command', !cmds.some((h) => h.seen === 'ls -la'), JSON.stringify(hits));
    check('flags a read of a guarded-looking file', files.some((h) => h.seen === '/repo/.env'), JSON.stringify(hits));
    check('does not flag an ordinary file read', !files.some((h) => h.seen === '/repo/src/app.js'), JSON.stringify(hits));
    check('every hit carries a label and a timestamp',
      hits.every((h) => h.label && h.ts), JSON.stringify(hits));
    // The proposed rule is a reusable token/pattern, not the whole observed
    // command line - "rm -rf", not "cd /repo && rm -rf node_modules", or
    // adding it as a guard rule would only ever match that one exact line
    // again instead of the general danger it was flagged for.
    const delHit = cmds.find((h) => h.seen.includes('node_modules'));
    check('a command hit suggests a short reusable token, not the full line',
      delHit && delHit.suggest === 'rm -rf' && delHit.suggest !== delHit.seen, JSON.stringify(delHit));
    const envHit = files.find((h) => h.seen === '/repo/.env');
    check('a file hit suggests a reusable pattern', envHit && envHit.suggest === '.env', JSON.stringify(envHit));
    check('malformed/meta/user lines do not throw and produce no extra hits', hits.length === 3, JSON.stringify(hits));
  } finally { try { fs.unlinkSync(tmp); } catch { /* best effort */ } }

  check('a missing file returns no hits rather than throwing',
    Array.isArray(scanTranscriptForRisks(path.join(os.tmpdir(), 'maestro-does-not-exist.jsonl'))));
}

/* --------------------------------------------------- cross-project gaps */
group('cross-project guardrail gap detector');
{
  const { ownGuardRules, computeGaps } = require('./lib/guardrail-analysis');
  const { applyGuard } = require('./lib/guardrails');

  // ownGuardRules: dir-relative (no HOME isolation needed - readGuard
  // never touches CLAUDE_DIR for 'project'/'local' scope). Entries are
  // kind-tagged (file: / cmd:) so a gap's `missing` list can later be split
  // back into {files, commands} for propagate - a guard command rule and a
  // guard file rule are never interchangeable even if the two strings
  // happened to collide.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-gap-proj-'));
    try {
      check('a project with nothing applied yet has an empty rule set',
        ownGuardRules(dir).size === 0);
      applyGuard({ scope: 'project', dir, files: ['.env'], commands: ['rm -rf'] });
      const rules = ownGuardRules(dir);
      check('picks up applied rules, tagged by kind',
        rules.has('file:.env') && rules.has('cmd:rm -rf'), [...rules].join(','));
      // 'project' and 'local' scope share one rule file per directory (only
      // which settings file registers the hook differs) - applying at
      // 'local' scope for the same dir replaces the same file, it does not
      // add a second independent list.
      applyGuard({ scope: 'local', dir, files: [], commands: ['git push --force'] });
      const rules2 = ownGuardRules(dir);
      check('applying at local scope for the same dir replaces the shared rule file',
        rules2.has('cmd:git push --force') && !rules2.has('file:.env'), [...rules2].join(','));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // computeGaps: pure, no I/O - takes a Map<dir, Set<rule>> directly.
  {
    const rulesByDir = new Map([
      ['/a', new Set()],                          // nothing at all
      ['/b', new Set(['.env', 'rm -rf'])],        // a strict superset of /a
      ['/c', new Set(['.env'])],                  // strict subset of /b
      ['/d', new Set(['DROP TABLE'])],            // incomparable to /b - not a subset either way
    ]);
    const gaps = computeGaps(rulesByDir);
    const byDir = Object.fromEntries(gaps.map((g) => [g.dir, g]));

    check('flags a project with zero rules against a sibling that has some',
      !!byDir['/a'] && byDir['/a'].sibling === '/b', JSON.stringify(gaps));
    check('missing lists exactly the sibling rules this project lacks',
      byDir['/a'] && byDir['/a'].missing.sort().join(',') === '.env,rm -rf', JSON.stringify(byDir['/a']));
    check('flags a project whose rules are a strict subset of a sibling\'s',
      !!byDir['/c'] && byDir['/c'].sibling === '/b' && byDir['/c'].missing.join(',') === 'rm -rf', JSON.stringify(byDir['/c']));
    check('does not flag a project whose rules are not a subset of anything (incomparable, not a superset)',
      !byDir['/d'], JSON.stringify(byDir['/d']));
    check('does not flag the project that already has the most rules',
      !byDir['/b'], JSON.stringify(byDir['/b']));

    // Two equally-sized, equally-covering supersets: pick one deterministically
    // (the largest) rather than nondeterministically depending on Map order.
    const tied = new Map([
      ['/x', new Set()],
      ['/y', new Set(['a', 'b'])],
      ['/z', new Set(['a', 'b', 'c'])],
    ]);
    const g = computeGaps(tied).find((r) => r.dir === '/x');
    check('among multiple dominating siblings, proposes the most comprehensive one',
      g && g.sibling === '/z', JSON.stringify(g));
  }

  // splitTaggedRules: the missing list mixes file rules and command rules -
  // propagate has to put each back in the right array, not just append the
  // raw strings to both.
  {
    const { splitTaggedRules } = require('./lib/guardrail-analysis');
    const r = splitTaggedRules(['file:.env', 'cmd:rm -rf', 'file:*.pem', 'cmd:git push --force']);
    check('splits file: entries into files', r.files.sort().join(',') === '*.pem,.env', JSON.stringify(r));
    check('splits cmd: entries into commands',
      r.commands.sort().join(',') === 'git push --force,rm -rf', JSON.stringify(r));
    check('an empty list splits into two empty arrays',
      splitTaggedRules([]).files.length === 0 && splitTaggedRules([]).commands.length === 0);
  }

  // Dismissal is applied by the orchestration layer (findGuardGaps, HOME-
  // dependent, not unit tested here) by comparing each gap's `key` against
  // what was last dismissed for that project - so the key only has to be
  // stable per missing-rule-set and change when the missing set does.
  {
    const key = (rulesByDir) => computeGaps(rulesByDir).find((g) => g.dir === '/a').key;
    const k1 = key(new Map([['/a', new Set()], ['/b', new Set(['.env', 'rm -rf'])]]));
    const k1reordered = key(new Map([['/a', new Set()], ['/b', new Set(['rm -rf', '.env'])]]));
    const k2 = key(new Map([['/a', new Set()], ['/b', new Set(['.env', 'rm -rf', 'DROP TABLE'])]]));
    check('dismiss key is stable regardless of rule insertion order', k1 === k1reordered, `${k1} vs ${k1reordered}`);
    check('dismiss key changes when the missing-rule set changes', k1 !== k2, `${k1} vs ${k2}`);
  }
}

/* ------------------------------------------------------------------ mcp */
group('mcp (isolated ~/.claude.json)');
{
  const { readJsonSafe } = require('./lib/util');
  const keyOf = (dir) => path.resolve(dir).replace(/\\/g, '/');

  // Runs one lib/mcp.js call in a fresh child process with HOME/USERPROFILE
  // pointed at a throwaway directory, so this suite never touches the real
  // ~/.claude.json. lib/mcp.js computes CLAUDE_JSON = path.join(HOME, ...) at
  // require time, so isolation has to happen before that require, in a
  // process of its own - an in-process HOME swap plus a require-cache bust
  // would be fragile and easy to get wrong.
  function mcpCall(homeDir, fnName, args) {
    const mcpPath = path.join(ROOT, 'lib', 'mcp');
    const script = `
      const mcp = require(${JSON.stringify(mcpPath)});
      try {
        const result = mcp[${JSON.stringify(fnName)}](${args.map((a) => JSON.stringify(a)).join(',')});
        process.stdout.write(JSON.stringify({ ok: true, result }));
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, message: err.message, partial: !!err.partial, file: err.file || null }));
      }
    `;
    const r = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    });
    const out = (r.stdout || '').trim();
    if (!out) throw new Error('mcp child produced no output - stderr: ' + r.stderr);
    return JSON.parse(out);
  }

  // user-scope save + delete round trip.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    try {
      let r = mcpCall(home, 'saveServer', ['user', null, 'srv1', { command: 'foo' }]);
      check('user save reports ok', r.ok === true, JSON.stringify(r));
      let doc = readJsonSafe(path.join(home, '.claude.json'));
      check('user save writes mcpServers.srv1',
        !!(doc && doc.mcpServers && doc.mcpServers.srv1 && doc.mcpServers.srv1.command === 'foo'), JSON.stringify(doc));

      r = mcpCall(home, 'deleteServer', ['user', null, 'srv1']);
      check('user delete reports ok', r.ok === true, JSON.stringify(r));
      doc = readJsonSafe(path.join(home, '.claude.json'));
      check('user delete removes srv1', !doc.mcpServers || !doc.mcpServers.srv1, JSON.stringify(doc));
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }

  // local-scope save + delete round trip.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-proj-'));
    try {
      let r = mcpCall(home, 'saveServer', ['local', projA, 'srv1', { command: 'bar' }]);
      check('local save reports ok', r.ok === true, JSON.stringify(r));
      let doc = readJsonSafe(path.join(home, '.claude.json'));
      check('local save writes projects[dir].mcpServers.srv1',
        doc.projects[keyOf(projA)].mcpServers.srv1.command === 'bar', JSON.stringify(doc));

      r = mcpCall(home, 'deleteServer', ['local', projA, 'srv1']);
      check('local delete reports ok', r.ok === true, JSON.stringify(r));
      doc = readJsonSafe(path.join(home, '.claude.json'));
      check('local delete removes srv1', !doc.projects[keyOf(projA)].mcpServers.srv1, JSON.stringify(doc));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(projA, { recursive: true, force: true });
    }
  }

  // Deleting a name that was never configured must be a pure no-op - no
  // ~/.claude.json scaffold left behind for a project that was never touched.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    const projB = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-proj-'));
    try {
      const r = mcpCall(home, 'deleteServer', ['local', projB, 'ghost']);
      check('deleting a never-configured name reports ok', r.ok === true, JSON.stringify(r));
      const doc = readJsonSafe(path.join(home, '.claude.json'));
      check('and leaves no project/mcpServers scaffold behind',
        doc !== null && Object.keys(doc).length === 0, JSON.stringify(doc));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(projB, { recursive: true, force: true });
    }
  }

  // user -> local: single ~/.claude.json transaction.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-proj-'));
    try {
      mcpCall(home, 'saveServer', ['user', null, 'srv1', { command: 'foo' }]);
      const r = mcpCall(home, 'moveServer', [{ scope: 'user', dir: null }, { scope: 'local', dir: projA }, 'srv1']);
      check('user->local move reports ok', r.ok === true, JSON.stringify(r));
      const doc = readJsonSafe(path.join(home, '.claude.json'));
      check('user->local removes it from user scope', !doc.mcpServers || !doc.mcpServers.srv1, JSON.stringify(doc));
      check('user->local lands it in local scope',
        doc.projects[keyOf(projA)].mcpServers.srv1.command === 'foo', JSON.stringify(doc));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(projA, { recursive: true, force: true });
    }
  }

  // local -> user: same transaction, the other direction.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-proj-'));
    try {
      mcpCall(home, 'saveServer', ['local', projA, 'srv1', { command: 'foo' }]);
      const r = mcpCall(home, 'moveServer', [{ scope: 'local', dir: projA }, { scope: 'user', dir: null }, 'srv1']);
      check('local->user move reports ok', r.ok === true, JSON.stringify(r));
      const doc = readJsonSafe(path.join(home, '.claude.json'));
      check('local->user removes it from local scope', !doc.projects[keyOf(projA)].mcpServers.srv1, JSON.stringify(doc));
      check('local->user lands it in user scope', doc.mcpServers.srv1.command === 'foo', JSON.stringify(doc));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(projA, { recursive: true, force: true });
    }
  }

  // local(A) -> local(B): same file, different project - still one transaction.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-proj-'));
    const projB = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-proj-'));
    try {
      mcpCall(home, 'saveServer', ['local', projA, 'srv1', { command: 'foo' }]);
      const r = mcpCall(home, 'moveServer', [{ scope: 'local', dir: projA }, { scope: 'local', dir: projB }, 'srv1']);
      check('local(A)->local(B) reports ok', r.ok === true, JSON.stringify(r));
      const doc = readJsonSafe(path.join(home, '.claude.json'));
      check('gone from project A', !(doc.projects[keyOf(projA)] && doc.projects[keyOf(projA)].mcpServers.srv1), JSON.stringify(doc));
      check('present in project B', doc.projects[keyOf(projB)].mcpServers.srv1.command === 'foo', JSON.stringify(doc));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(projA, { recursive: true, force: true });
      fs.rmSync(projB, { recursive: true, force: true });
    }
  }

  // project -> local: cross-file, straightforward direction.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-proj-'));
    const projB = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-proj-'));
    try {
      mcpCall(home, 'saveServer', ['project', projA, 'srv1', { command: 'foo' }]);
      const r = mcpCall(home, 'moveServer', [{ scope: 'project', dir: projA }, { scope: 'local', dir: projB }, 'srv1']);
      check('project->local reports ok', r.ok === true, JSON.stringify(r));
      const mcpJson = readJsonSafe(path.join(projA, '.mcp.json'));
      check('gone from source .mcp.json', !(mcpJson && mcpJson.mcpServers && mcpJson.mcpServers.srv1), JSON.stringify(mcpJson));
      const doc = readJsonSafe(path.join(home, '.claude.json'));
      check('present in target local scope', doc.projects[keyOf(projB)].mcpServers.srv1.command === 'foo', JSON.stringify(doc));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(projA, { recursive: true, force: true });
      fs.rmSync(projB, { recursive: true, force: true });
    }
  }

  // local -> project, with the source delete forced to fail: the write to the
  // target must still have happened, and the failure must come back as a
  // partial success (config safe in both places), never a silent loss.
  //
  // This relies on chmod 0o444 actually blocking the write, which holds on
  // Windows and for a normal POSIX user, but not for this suite run as root
  // on Linux/CI, where root ignores the read-only permission bit and the
  // "delete fails" branch below this comment never triggers.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-proj-'));
    const claudeJson = path.join(home, '.claude.json');
    try {
      mcpCall(home, 'saveServer', ['local', projA, 'srv1', { command: 'foo' }]);
      fs.chmodSync(claudeJson, 0o444);
      const r = mcpCall(home, 'moveServer', [{ scope: 'local', dir: projA }, { scope: 'project', dir: projA }, 'srv1']);
      check('local->project reports partial when the source delete fails',
        r.ok === false && r.partial === true, JSON.stringify(r));
      check('partial response names the target file',
        typeof r.file === 'string' && r.file.endsWith('.mcp.json'), JSON.stringify(r));
      const mcpJson = readJsonSafe(path.join(projA, '.mcp.json'));
      check('target write happened despite the later failure', mcpJson.mcpServers.srv1.command === 'foo', JSON.stringify(mcpJson));
      fs.chmodSync(claudeJson, 0o666);
      const doc = readJsonSafe(claudeJson);
      check('source still has it too - nothing was silently lost',
        doc.projects[keyOf(projA)].mcpServers.srv1.command === 'foo', JSON.stringify(doc));
    } finally {
      try { fs.chmodSync(claudeJson, 0o666); } catch { /* already restored */ }
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(projA, { recursive: true, force: true });
    }
  }

  // Collision at the target: refuse, mutate nothing.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-proj-'));
    try {
      mcpCall(home, 'saveServer', ['user', null, 'srv1', { command: 'foo' }]);
      mcpCall(home, 'saveServer', ['local', projA, 'srv1', { command: 'already-here' }]);
      const before = readJsonSafe(path.join(home, '.claude.json'));
      const r = mcpCall(home, 'moveServer', [{ scope: 'user', dir: null }, { scope: 'local', dir: projA }, 'srv1']);
      check('collision reports failure', r.ok === false, JSON.stringify(r));
      check('collision message says already exists', /already exists/.test(r.message), r.message);
      const after = readJsonSafe(path.join(home, '.claude.json'));
      check('neither side was mutated', JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(projA, { recursive: true, force: true });
    }
  }

  // Same location: refuse, mutate nothing.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    try {
      mcpCall(home, 'saveServer', ['user', null, 'srv1', { command: 'foo' }]);
      const before = readJsonSafe(path.join(home, '.claude.json'));
      const r = mcpCall(home, 'moveServer', [{ scope: 'user', dir: null }, { scope: 'user', dir: null }, 'srv1']);
      check('same-location reports failure', r.ok === false, JSON.stringify(r));
      check('same-location message says so', /same/.test(r.message), r.message);
      const after = readJsonSafe(path.join(home, '.claude.json'));
      check('doc untouched', JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }));
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }

  // Collision at the target when the existing entry is a literal `null`
  // config (e.g. someone hand-edited ~/.claude.json). getServerConfig()'s
  // "absent" sentinel is undefined, not null, precisely so a stored null does
  // not read the same as "nothing here" and slip past this check.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-proj-'));
    const claudeJson = path.join(home, '.claude.json');
    try {
      mcpCall(home, 'saveServer', ['user', null, 'srv1', { command: 'foo' }]);
      const doc = readJsonSafe(claudeJson) || {};
      doc.projects = doc.projects || {};
      doc.projects[keyOf(projA)] = { mcpServers: { srv1: null } };
      fs.writeFileSync(claudeJson, JSON.stringify(doc, null, 2));
      const before = readJsonSafe(claudeJson);
      const r = mcpCall(home, 'moveServer', [{ scope: 'user', dir: null }, { scope: 'local', dir: projA }, 'srv1']);
      check('a null-valued target entry is still treated as a collision', r.ok === false, JSON.stringify(r));
      check('collision message says already exists', /already exists/.test(r.message || ''), r.message);
      const after = readJsonSafe(claudeJson);
      check('neither side was mutated', JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(projA, { recursive: true, force: true });
    }
  }

  // A malformed `from` (missing/relative dir for a scope that needs one) must
  // produce the same kind of descriptive Error that a malformed `to` already
  // does, not a raw TypeError from path.isAbsolute()/path.resolve() further in.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    try {
      const r = mcpCall(home, 'moveServer', [{ scope: 'local', dir: null }, { scope: 'user', dir: null }, 'srv1']);
      check('malformed from reports failure', r.ok === false, JSON.stringify(r));
      check('malformed from gets a descriptive message, not a raw TypeError',
        /source project required/.test(r.message || ''), r.message);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
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

/* -------------------------------------------------------------- backups */
group('backups (list + restore)');
{
  const { listBackups, restoreBackup, rotateBackups } = require('./lib/util');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-backup-'));
  const file = path.join(dir, 'settings.json');
  try {
    check('no backups for a file that was never written', listBackups(file).length === 0);

    fs.writeFileSync(file, 'v1');
    rotateBackups(file); // backs up v1, file still reads v1 until the next write
    fs.writeFileSync(file, 'v2');
    rotateBackups(file); // backs up v2
    fs.writeFileSync(file, 'v3');

    const backups = listBackups(file);
    check('lists one entry per rotateBackups call', backups.length === 2, 'got ' + backups.length);
    check('newest first', backups[0].mtimeMs >= backups[1].mtimeMs, JSON.stringify(backups));

    const v2backup = backups[0]; // most recent rotate captured v2
    restoreBackup(file, v2backup.name);
    check('restore overwrites the file with the backup content',
      fs.readFileSync(file, 'utf8') === 'v2', 'got ' + fs.readFileSync(file, 'utf8'));

    const afterRestore = listBackups(file);
    check('restoring backs up the pre-restore content too (v3 not lost)',
      afterRestore.some((b) => b.name !== v2backup.name), JSON.stringify(afterRestore));
    const preRestoreBackup = afterRestore.find((b) => b.name !== v2backup.name);
    check('the pre-restore backup actually holds v3',
      fs.readFileSync(path.join(dir, preRestoreBackup.name), 'utf8') === 'v3');

    let threw = null;
    try { restoreBackup(file, '../../etc/passwd'); } catch (e) { threw = e; }
    check('restoring an unlisted/traversal name is refused', !!threw, 'call was allowed through');

    let threw2 = null;
    try { restoreBackup(file, 'settings.json.maestro-bak.nonexistent'); } catch (e) { threw2 = e; }
    check('restoring a name that looks right but was never listed is refused', !!threw2, 'call was allowed through');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/* ---------------------------------------------------------------- report */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

})().catch((err) => { console.error(err); process.exit(1); });
