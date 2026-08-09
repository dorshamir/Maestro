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
 */
'use strict';

const http = require('http');
const { spawn } = require('child_process');

const { PORT } = require('./lib/constants');
const { log, send } = require('./lib/util');
const { guardRequest } = require('./lib/http-guard');
const { routes } = require('./lib/routes');
const { pruneDigests } = require('./lib/digests');

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
