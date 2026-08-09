/*
 * Whether anyone still has the UI open.
 *
 * Closing the window with X only closes the browser. A launcher-started server
 * has no console and no window of its own, so it survived that, kept the port,
 * and kept serving bundled files from whatever directory it started in - two of
 * them were found still answering on 4144 and 4188 hours after the folder they
 * were launched from had been moved, each returning ENOENT for index.html while
 * `start.cmd` health-checked the port, believed Maestro was up, and opened the
 * browser onto the dead one.
 *
 * The page holds one event stream open for as long as its window exists, so
 * "is a window open" is a socket count and not a timer the browser is free to
 * throttle: a minimised window keeps its socket, a refresh reconnects well
 * inside the grace period, and a second window is simply a second socket.
 *
 * Nothing here starts work at require time - server.js owns the timer that acts
 * on this, the same as everything else that runs.
 */
'use strict';

const clients = new Set();
// Boot counts as the moment the last window went away: a launcher that never
// manages to get a browser on screen must not leave a server behind either.
let emptySince = Date.now();
let connected = false;

// One long-lived response per open window. Nothing is ever pushed down it; it
// exists so that closing the window closes a socket.
function attach(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // A stream with no bytes in it is not yet committed, and EventSource would
  // not fire onopen. One comment line is enough.
  res.write(': open\n\n');
  clients.add(res);
  emptySince = null;
  connected = true;
  res.on('close', () => {
    if (!clients.delete(res)) return;
    if (!clients.size) emptySince = Date.now();
  });
}

// Milliseconds since the last window closed; 0 while one is still open.
function orphanedFor(now = Date.now()) {
  return emptySince === null ? 0 : now - emptySince;
}

// Any request at all means a window is about to exist. start.cmd health-checks
// the port before opening the browser, so without this a server sitting in its
// grace period could exit in the gap between that check and the page loading -
// which the user would meet as a launch that opened onto nothing.
function touch() {
  if (!clients.size) emptySince = Date.now();
}

module.exports = {
  attach,
  orphanedFor,
  touch,
  everConnected: () => connected,
  count: () => clients.size,
};
