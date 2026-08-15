/*
 * Small helpers shared across modules: logging, JSON reads, HTTP replies,
 * child processes, path containment, backups.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { LOG_FILE, BACKUP_KEEP } = require('./constants');

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* logging must never break anything */ }
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function send(res, code, body, type) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 80_000_000) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Never block the event loop. A synchronous exec here freezes every other
// request; on macOS an osascript permission prompt can block indefinitely,
// which is exactly what made the server look dead after the first launch.
function run(bin, args, timeout = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, out) => { if (!done) { done = true; resolve({ ok, out: String(out || '') }); } };
    let child;
    try { child = execFile(bin, args, { timeout, windowsHide: true }, (err, stdout) => finish(!err, stdout)); }
    catch { return finish(false, ''); }
    child.on('error', () => finish(false, ''));
    setTimeout(() => { try { child.kill(); } catch {} finish(false, ''); }, timeout + 500);
  });
}

const BIN_CACHE = new Map();
async function binExists(bin) {
  if (BIN_CACHE.has(bin)) return BIN_CACHE.get(bin);
  const r = await run(process.platform === 'win32' ? 'where' : 'which', [bin], 4000);
  BIN_CACHE.set(bin, r.ok);
  return r.ok;
}

async function hasWindowsTerminal() {
  if (process.env.MAESTRO_TERMINAL === 'cmd') return false;
  if (process.env.MAESTRO_TERMINAL === 'wt') return true;
  if (await binExists('wt.exe')) return true;
  const alias = process.env.LOCALAPPDATA
    && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe');
  return !!(alias && fs.existsSync(alias));
}

function shQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// Resolve rel under root and refuse anything that escapes it.
function safeJoin(root, rel) {
  const full = path.resolve(root, rel);
  if (full !== path.resolve(root) && !full.startsWith(path.resolve(root) + path.sep)) {
    throw new Error('invalid path');
  }
  return full;
}

// The first text block of a message's content, whatever shape it takes.
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') return block.text;
    }
  }
  return null;
}

// Copy a file aside before overwriting it, keeping the last BACKUP_KEEP copies.
function rotateBackups(file) {
  try {
    if (!fs.existsSync(file)) return;
    const dir = path.dirname(file);
    const base = path.basename(file);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, path.join(dir, `${base}.maestro-bak.${stamp}`));
    const backups = fs.readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.maestro-bak.`))
      .sort();
    while (backups.length > BACKUP_KEEP) fs.unlinkSync(path.join(dir, backups.shift()));
  } catch { /* backups are best-effort */ }
}

// The names rotateBackups() writes next to `file`, newest first. Sorted by
// the ISO stamp in the name rather than mtime: two backups minted within the
// same millisecond (easy under test, possible under a fast double-save) tie
// on mtime but never on the stamp, which is exactly what rotateBackups' own
// cleanup already sorts by. Best-effort, like rotateBackups itself: a
// listing failure should never break the page that just wants the content.
function listBackups(file) {
  try {
    const dir = path.dirname(file);
    const base = path.basename(file);
    const prefix = `${base}.maestro-bak.`;
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .sort().reverse()
      .map((f) => ({ name: f, mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs }));
  } catch { return []; }
}

// Restore `file` from one of its own backups. `name` must be exactly one of
// the entries listBackups() just enumerated for this same file - the caller
// never gets to hand us an arbitrary path, so this can't be walked outside
// the file's own directory no matter what the request body claims.
function restoreBackup(file, name) {
  const dir = path.dirname(file);
  const hit = listBackups(file).find((b) => b.name === name);
  if (!hit) throw new Error('that backup no longer exists');
  rotateBackups(file); // the pre-restore state becomes a backup too, so restoring is itself undoable
  fs.copyFileSync(path.join(dir, hit.name), file);
}

module.exports = {
  log, readJsonSafe, send, readBody, run, binExists, hasWindowsTerminal,
  shQuote, safeJoin, extractText, rotateBackups, listBackups, restoreBackup,
};
