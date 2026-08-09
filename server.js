#!/usr/bin/env node
/*
 * Maestro - conduct Claude Code
 * Zero dependencies. Binds to 127.0.0.1 only.
 *
 *   node server.js            → http://localhost:4144
 *   MAESTRO_PORT=5000 node server.js
 *
 * This file is the entry point and nothing else: process-level wiring, the
 * request loop, and listen(). All the actual work lives in lib/ -
 *
 *   constants.js   paths and limits everything else agrees on
 *   util.js        logging, JSON reads, HTTP replies, child processes, backups
 *   http-guard.js  who is allowed to talk to this server (rebinding / CSRF)
 *   routes.js      every route, keyed "METHOD /path"
 *   sessions.js    the ~/.claude/projects scan and its cost roll-up
 *   digests.js     per-transcript "what happened" summaries, cached
 *   pricing.js     model rate table and cost arithmetic
 *   transcripts.js the viewer feed, export capsules, import
 *   launch.js      building the claude command line and opening a terminal
 *   settings.js    settings.json across scopes, plus the effective merge
 *   guardrails.js  the generated PreToolUse hook and its deny-rule mirror
 *   library.js     commands / agents / skills as files
 *   files.js       the narrow file explorer over ~/.claude
 *   presence.js    who still has the UI open, so a closed window can stop us
 */
'use strict';

const http = require('http');
const { spawn } = require('child_process');

const { PORT } = require('./lib/constants');
const { log, send } = require('./lib/util');
const { guardRequest } = require('./lib/http-guard');
const { routes } = require('./lib/routes');
const { pruneDigests } = require('./lib/digests');
const { touch, orphanedFor, everConnected } = require('./lib/presence');

// A config tool must not die on a background error and leave the UI unreachable.
process.on('uncaughtException', (e) => log('UNCAUGHT', e && e.stack || e));
process.on('unhandledRejection', (e) => log('UNHANDLED', e && (e.stack || e.message) || e));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const route = `${req.method} ${url.pathname}`;

  const denied = guardRequest(req);
  if (denied) {
    log('BLOCKED', route, denied, 'host=' + req.headers.host, 'origin=' + (req.headers.origin || '-'));
    return send(res, 403, { error: denied });
  }

  // A request that got this far came from the UI or from a launcher checking
  // whether to start one, and either way a window is open or about to be.
  touch();

  try {
    const handler = routes[route];
    // Awaited inside the try: an async handler that throws must still become a
    // 500 rather than an unhandled rejection and a request that never answers.
    if (handler) return await handler(req, res, url);
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

pruneDigests();

// Closing the window is the only stop gesture most people make, and X used not
// to reach us at all: the server outlived its own UI, held the port, and went on
// serving an install root that had since moved. The page holds an event stream
// open while its window exists (lib/presence.js), so the last one closing is
// what stops us.
//
// Only under a launcher. Started from a terminal, Ctrl+C is the expected way out
// and a server that quit on its own because nobody had pointed a browser at it
// would be a worse surprise than a stray process. Same signal the UI uses to
// decide whether to offer the Quit button.
if (process.env.MAESTRO_NO_OPEN) {
  const ORPHAN_MS = 10_000;     // a refresh reconnects in a fraction of this
  const STARTUP_MS = 120_000;   // a cold browser, first launch, busy machine
  const watch = setInterval(() => {
    const orphaned = orphanedFor();
    if (!orphaned) return;
    // Until the first window ever connects the clock is the boot clock, and a
    // launcher can take a while to get a browser on screen. After that, a
    // closed window is a closed window.
    if (orphaned < (everConnected() ? ORPHAN_MS : STARTUP_MS)) return;
    log('no UI connected for ' + Math.round(orphaned / 1000) + 's - exiting');
    process.exit(0);
  }, 5000);
  watch.unref();
}

// Browsers keep a socket open for minutes and write the next request onto it
// without checking. Node's 5s default closes idle sockets far sooner, so the
// browser writes into a dead socket and fetch() fails with "Failed to fetch"
// after any pause. Outlive the browser's reuse window instead.
server.keepAliveTimeout = 5 * 60 * 1000;
server.headersTimeout = 5 * 60 * 1000 + 10_000;   // must exceed keepAliveTimeout
server.requestTimeout = 0;                        // long scans must not be cut off

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error('  Maestro may already be running - try http://localhost:' + PORT);
    console.error(`  Or pick another port:  MAESTRO_PORT=4145 node server.js\n`);
  } else {
    console.error('\n  Could not start Maestro:', e.message, '\n');
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Maestro is running.`);
  console.log(`  Open:  ${url}`);
  console.log(`  Note:  open that address, not public/index.html - the page needs this server.`);
  console.log(`  Stop:  Ctrl+C\n`);
  // Maestro.exe opens the UI itself, in app mode - it sets this so the server
  // does not also pop a second, ordinary browser tab.
  if (process.env.MAESTRO_NO_OPEN) return;
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' });
    child.on('error', () => console.log(`  (Could not open a browser automatically - visit ${url})`));
    child.unref();
  } catch { /* headless: the URL above is enough */ }
});
