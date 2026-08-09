/*
 * Walks ~/.claude/projects, turning transcript files into the project/session
 * tree the UI renders - and rolling up the cost summary while it is in there.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { HOME, CLAUDE_DIR, PROJECTS_DIR, SESSION_ID_RE } = require('./constants');
const { readJsonSafe, extractText } = require('./util');
const { pricing, rateFor, priceUsage } = require('./pricing');
const { getDigest, saveDigests } = require('./digests');

let sessionCache = { ts: 0, data: null };

// Called after anything that changes what a rescan would find, so the next
// /api/sessions rebuilds instead of serving the 15-second cache.
function invalidateSessionCache() { sessionCache = { ts: 0, data: null }; }

function parseHead(file, maxBytes) {
  // Read the first chunk of a session JSONL and pull out metadata.
  const out = { cwd: null, sessionId: null, gitBranch: null, firstUser: null, summary: null, firstTs: null, version: null };
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return out; }
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    const lines = buf.toString('utf8', 0, n).split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; } // last line may be cut
      if (!out.cwd && typeof obj.cwd === 'string') out.cwd = obj.cwd;
      if (!out.sessionId && typeof obj.sessionId === 'string') out.sessionId = obj.sessionId;
      if (!out.gitBranch && typeof obj.gitBranch === 'string' && obj.gitBranch) out.gitBranch = obj.gitBranch;
      if (!out.firstTs && typeof obj.timestamp === 'string') out.firstTs = obj.timestamp;
      if (!out.version && typeof obj.version === 'string') out.version = obj.version;
      if (!out.summary && obj.type === 'summary' && typeof obj.summary === 'string') out.summary = obj.summary;
      if (!out.firstUser && obj.type === 'user' && obj.message && !obj.isMeta) {
        const t = extractText(obj.message.content);
        if (t && !t.startsWith('<')) out.firstUser = t; // skip command/meta XML-ish payloads
      }
      if (out.cwd && out.firstUser && out.summary) break;
    }
  } catch { /* ignore */ } finally { fs.closeSync(fd); }
  return out;
}

function countLines(file, size) {
  if (size > 3_000_000) return null; // too big to bother; UI falls back to file size
  try {
    const data = fs.readFileSync(file);
    let count = 0;
    for (let i = 0; i < data.length; i++) if (data[i] === 10) count++;
    return count;
  } catch { return null; }
}

// User preferences that must never touch the transcript .jsonl files -
// Claude Code owns those, and resume depends on them staying untouched.
// Renames, archive flags, and folder pins all live in this sidecar instead.
const OVERRIDES_FILE = path.join(CLAUDE_DIR, '.maestro-overrides.json');
function loadOverrides() {
  return readJsonSafe(OVERRIDES_FILE) || { sessions: {}, pins: {} };
}
function saveOverrides(o) {
  try {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(o, null, 2));
  } catch { /* best effort */ }
}

// Rolled up while scanning, so the summary panel costs nothing extra.
let lastSummary = null;
function sessionSummary() { scanSessions(); return lastSummary; }

const DAY = 86_400_000;

function scanSessions() {
  const now = Date.now();
  if (sessionCache.data && now - sessionCache.ts < 15_000) return sessionCache.data;
  const overrides = loadOverrides();

  // model id -> tokens, plus 7/30-day windows, accumulated as we walk sessions
  const agg = { byModel: {}, usd: 0, usdReported: 0, sessions: 0, priced: 0 };
  const win = { d7: { usd: 0, sessions: 0 }, d30: { usd: 0, sessions: 0 } };

  const projects = {};
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { /* no projects yet */ }

  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const pdir = path.join(PROJECTS_DIR, d.name);
    // sessions-index.json is internal/undocumented, but when present it has the best metadata.
    const index = readJsonSafe(path.join(pdir, 'sessions-index.json'));
    const indexById = {};
    if (index) {
      const entries = Array.isArray(index) ? index
        : Array.isArray(index.sessions) ? index.sessions
        : (index.entries && Array.isArray(index.entries)) ? index.entries : [];
      for (const e of entries) {
        const id = e.sessionId || e.id || e.uuid;
        if (id) indexById[id] = e;
      }
    }

    let files = [];
    try { files = fs.readdirSync(pdir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }

    for (const f of files) {
      const full = path.join(pdir, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.size === 0) continue;

      const head = parseHead(full, 262_144);
      const id = head.sessionId || f.replace(/\.jsonl$/, '');
      if (!SESSION_ID_RE.test(id)) continue;
      const idx = indexById[id] || {};

      const cwd = head.cwd || idx.cwd || idx.projectPath || null;
      const key = cwd || `~unresolved:${d.name}`;
      if (!projects[key]) {
        projects[key] = {
          cwd,
          encodedName: d.name,
          exists: cwd ? fs.existsSync(cwd) : false,
          pinned: !!(cwd && overrides.pins[cwd]),
          sessions: [],
        };
      }

      const dg = getDigest(full) || {};
      const ov = overrides.sessions[id] || {};
      const p = pricing();
      const tok = Object.values(dg.byModel || {}).reduce((a, u) => ({
        in: a.in + u.in, out: a.out + u.out, cacheR: a.cacheR + u.cacheR,
        cacheW: a.cacheW + u.cacheW + (u.cacheW1h || 0),
      }), { in: 0, out: 0, cacheR: 0, cacheW: 0 });
      const sessUsd = dg.reportedUsd || priceUsage(dg.byModel, p);

      // Roll into the global summary while we are already here.
      agg.sessions++;
      if (sessUsd > 0) agg.priced++;
      agg.usd += sessUsd;
      if (dg.reportedUsd) agg.usdReported += dg.reportedUsd;
      for (const [mid, u] of Object.entries(dg.byModel || {})) {
        const a = agg.byModel[mid] || (agg.byModel[mid] = {
          in: 0, out: 0, cacheR: 0, cacheW: 0, cacheW1h: 0, usd: 0, sessions: 0 });
        a.in += u.in; a.out += u.out; a.cacheR += u.cacheR;
        a.cacheW += u.cacheW; a.cacheW1h += u.cacheW1h || 0;
        a.usd += priceUsage({ [mid]: u }, p);
        a.sessions++;
      }
      const age = now - st.mtimeMs;
      if (age <= 7 * DAY) { win.d7.usd += sessUsd; win.d7.sessions++; }
      if (age <= 30 * DAY) { win.d30.usd += sessUsd; win.d30.sessions++; }

      // Prefer the actual opening prompt as the title; Claude Code's generated
      // summary is a better "about" line than a second title.
      const title = head.firstUser || idx.summary || idx.title || head.summary || '(no prompt captured)';
      projects[key].sessions.push({
        about: dg.about || '',
        usd: sessUsd,
        usdReported: !!dg.reportedUsd,
        tokens: tok,
        models: Object.keys(dg.byModel || {}).map((m) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '')),
        name: (ov.name || dg.customTitle || idx.name || idx.displayName || idx.title
               || dg.summary || idx.summary || head.summary || idx.firstPrompt
               || head.firstUser || '').replace(/\s+/g, ' ').slice(0, 200),
        namedByUser: !!(ov.name || dg.customTitle),
        archived: !!ov.archived,
        edits: dg.edits || 0,
        touched: dg.files || [],
        minutes: dg.minutes,
        id,
        title: String(title).replace(/\s+/g, ' ').slice(0, 600),
        mtime: st.mtimeMs,
        sizeBytes: st.size,
        messageCount: idx.messageCount != null ? idx.messageCount : countLines(full, st.size),
        gitBranch: head.gitBranch || idx.gitBranch || null,
        firstTs: head.firstTs || idx.createdAt || null,
        version: head.version || null,
        file: full,
      });
    }
  }

  const list = Object.values(projects)
    .map((p) => {
      p.sessions.sort((a, b) => b.mtime - a.mtime);
      p.lastActive = p.sessions.length ? p.sessions[0].mtime : 0;
      p.usd = p.sessions.reduce((a, s) => a + (s.usd || 0), 0);
      // in + out only. Cache reads outnumber real tokens 10-100x, so a single
      // "tokens" number that folds them in is dominated by cache traffic and
      // tells you nothing about how much work the session did.
      p.tokens = p.sessions.reduce((a, s) => a + s.tokens.in + s.tokens.out, 0);
      p.tokensAll = p.sessions.reduce((a, s) =>
        a + s.tokens.in + s.tokens.out + s.tokens.cacheW + s.tokens.cacheR, 0);
      return p;
    })
    .filter((p) => p.sessions.length)
    .sort((a, b) => (b.pinned - a.pinned) || (b.lastActive - a.lastActive));

  const models = Object.entries(agg.byModel)
    .map(([id, u]) => ({
      id,
      label: id.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace('|fast', ' (fast)'),
      priced: rateFor(id, pricing()) != null,
      ...u,
    }))
    .sort((a, b) => b.usd - a.usd || (b.in + b.out) - (a.in + a.out));

  lastSummary = {
    sessions: agg.sessions,
    projects: list.length,
    usd: agg.usd,
    usdReported: agg.usdReported,
    tokens: models.reduce((a, m) => ({
      in: a.in + m.in, out: a.out + m.out,
      cacheR: a.cacheR + m.cacheR, cacheW: a.cacheW + m.cacheW + m.cacheW1h,
    }), { in: 0, out: 0, cacheR: 0, cacheW: 0 }),
    models,
    unpriced: models.filter((m) => !m.priced).map((m) => m.label),
    last7: win.d7,
    last30: win.d30,
    top: list.slice().sort((a, b) => b.usd - a.usd).slice(0, 5)
      .map((p) => ({ cwd: p.cwd || p.encodedName, usd: p.usd, sessions: p.sessions.length })),
  };

  saveDigests();
  sessionCache = { ts: now, data: list };
  return list;
}

// Every folder Claude Code knows about, whether or not it still has sessions.
function knownProjects() {
  const set = new Set();
  const cj = readJsonSafe(path.join(HOME, '.claude.json'));
  if (cj && cj.projects && typeof cj.projects === 'object') {
    for (const p of Object.keys(cj.projects)) set.add(p);
  }
  for (const p of scanSessions()) if (p.cwd) set.add(p.cwd);
  return [...set].sort().map((p) => ({ path: p, exists: fs.existsSync(p) }));
}

module.exports = {
  scanSessions, sessionSummary, invalidateSessionCache,
  loadOverrides, saveOverrides, knownProjects,
};
