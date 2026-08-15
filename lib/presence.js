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
// When a page last said it was going away on purpose (pagehide). It is the
// difference between "the user closed the window" and "the stream broke", which
// look identical from a dropped socket but want very different amounts of
// patience - see graceKind().
//
// A timestamp rather than a flag, because two windows are a supported case and
// a sticky flag breaks it: close the first, and its goodbye would sit there
// unspent while the second window kept the count above zero - then hours later
// that window's stream blips and the goodbye it never sent gets spent on it.
let byeAt = 0;

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
  // A refresh sends the same goodbye a close does, and only this tells them
  // apart: the window came back.
  byeAt = 0;
  res.on('close', () => {
    if (!clients.delete(res)) return;
    if (!clients.size) emptySince = Date.now();
  });
}

// Milliseconds since the last window closed; 0 while one is still open.
function orphanedFor(now = Date.now()) {
  return emptySince === null ? 0 : now - emptySince;
}

// Write to every open stream, dropping any that will not take it. A socket
// killed without a FIN - laptop suspended, browser killed, adapter switched -
// stays readable to us indefinitely: `close` never fires and the window looks
// open forever. Writing is what surfaces that.
function writeAll(payload) {
  for (const res of [...clients]) {
    try {
      res.write(payload);
    } catch {
      // Already gone and its `close` may never come - drop it ourselves.
      if (clients.delete(res) && !clients.size) emptySince = Date.now();
    }
  }
}

// A comment line: both a liveness probe and the thing that stops an idle stream
// being reaped as dead in between. EventSource ignores comments, so this reaches
// the page without waking any handler.
//
// No timer here on purpose: server.js drives this from the interval it already
// owns, the same as everything else that runs (see the require-time invariant).
function pingClients() { writeAll(': ping\n\n'); }

// A named event the page does listen for. The stream was originally a socket
// with nothing in it - its existence was the whole signal - and it stays that
// way for presence; this rides along because the channel is already open, which
// beats a second one or a poll.
function broadcast(event) { writeAll(`event: ${event}\ndata: {}\n\n`); }

// Any request at all means a window is about to exist. start.cmd health-checks
// the port before opening the browser, so without this a server sitting in its
// grace period could exit in the gap between that check and the page loading -
// which the user would meet as a launch that opened onto nothing.
function touch() {
  if (!clients.size) emptySince = Date.now();
}

// The page fires this from pagehide, which a window close reaches and a crash
// does not. A refresh fires it too, so it is a hint about how long to wait and
// never an instruction to exit.
function bye() { byeAt = Date.now(); }

// A goodbye only explains the stream that dropped alongside it. Anything older
// belongs to some other window and has nothing to say about this one.
const BYE_WINDOW_MS = 15_000;

// How patient to be about a stream that is gone.
//
//   'closed' - the window said goodbye. Pressing X should free the port
//              promptly, so this stays as short as a refresh allows.
//   'lost'   - the stream dropped with no goodbye: suspend/resume, a dropped
//              adapter, a reconnect timer throttled because Maestro's window is
//              behind the terminal it just launched. The page is probably still
//              on screen and trying to come back, and quitting under it is the
//              bug this split exists to fix. A crashed browser lands here too,
//              so the port still comes back - just later.
function graceKind() {
  if (emptySince === null) return 'lost';   // a window is still here; moot
  return Math.abs(byeAt - emptySince) < BYE_WINDOW_MS ? 'closed' : 'lost';
}

module.exports = {
  attach,
  orphanedFor,
  pingClients,
  broadcast,
  touch,
  bye,
  graceKind,
  everConnected: () => connected,
  count: () => clients.size,
};
