/*
 * Who is allowed to talk to this server.
 *
 * Binding to 127.0.0.1 keeps other machines out. It does *not* keep out the
 * browser already running on this machine, and that browser will happily be
 * pointed at us by any web page the user visits. Two attacks follow from that,
 * and neither is stopped by the bind address:
 *
 *   DNS rebinding - evil.com answers with its own IP, serves a page, then
 *   re-answers with 127.0.0.1. The page is now same-origin with this server and
 *   can read every response: settings.json (with env vars), any file under
 *   ~/.claude, whole transcripts. Defence: only serve requests whose Host is a
 *   loopback name, so a request addressed to "evil.com:4144" is refused.
 *
 *   Cross-site POST - a page cannot read our responses without CORS, but it can
 *   still *send* a request. `Content-Type: text/plain` is CORS-safelisted, so it
 *   sends with no preflight, and this server used to JSON.parse the body
 *   whatever the content type said. That is enough to write a PreToolUse hook
 *   into settings.json - arbitrary code execution the next time Claude Code
 *   runs - or to POST /api/launch. Defence: mutations must be same-origin and
 *   must be declared application/json, which forces a preflight the attacker's
 *   page cannot satisfy.
 */
'use strict';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

const hostname = (value) => {
  const v = String(value || '');
  const bare = v.startsWith('[') ? v.slice(0, v.indexOf(']') + 1) : v.split(':')[0];
  return bare.replace(/^\[|\]$/g, '').toLowerCase();
};

// Returns null when the request is allowed, or a reason string to refuse it.
function guardRequest(req) {
  if (!LOOPBACK.has(hostname(req.headers.host))) {
    return 'request was addressed to a non-loopback host name';
  }
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && !LOOPBACK.has(hostname(new URL(origin).host))) {
    return 'cross-origin request refused';
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    return 'cross-site request refused';
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      return 'mutations must declare Content-Type: application/json';
    }
  }
  return null;
}

module.exports = { guardRequest };
