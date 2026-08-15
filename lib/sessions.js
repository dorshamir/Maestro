/*
 * Walks ~/.claude/projects, turning transcript files into the project/session
 * tree the UI renders - and rolling up the cost summary while it is in there.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { HOME, CLAUDE_DIR, PROJECTS_DIR, SESSION_ID_RE } = require('./constants');
const { readJsonSafe, extractText } = require('./util');
const { pricing, rateFor, priceUsage, totalUsd } = require('./pricing');
const { getDigest, saveDigests, dayKey } = require('./digests');

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

// The last n calendar days, oldest first. Stepped with setDate rather than by
// subtracting 24h at a time so the two days a year that are not 24 hours long
// cannot duplicate or skip a date. Midday for the same reason.
function lastNDays(n, now) {
  const base = new Date(now);
  base.setHours(12, 0, 0, 0);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(base.getDate() - i);
    out.push(dayKey(d));
  }
  return out;
}

function scanSessions() {
  const now = Date.now();
  if (sessionCache.data && now - sessionCache.ts < 15_000) return sessionCache.data;
  const overrides = loadOverrides();

  // model id -> tokens, plus 7/30-day windows, accumulated as we walk sessions
  const agg = { byModel: {}, usd: 0, usdReported: 0, sessions: 0, priced: 0 };
  const win = { d7: { usd: 0, sessions: 0 }, d30: { usd: 0, sessions: 0 } };
  // YYYY-MM-DD -> usd, for the windows above and the sparkline. Built from the
  // per-day buckets in each digest rather than from file mtimes: a session
  // opened three weeks ago and touched this morning used to drop its entire
  // cost into "last 7 days", which overstated exactly the number the panel
  // exists to report.
  const spendByDay = {};
  const days30 = lastNDays(30, now);
  const set30 = new Set(days30);
  const set7 = new Set(days30.slice(-7));

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
      const sessUsd = totalUsd(dg.reportedUsd, dg.hadMultiAttempt, dg.byModel, p);

      // Roll into the global summary while we are already here.
      agg.sessions++;
      if (sessUsd > 0) agg.priced++;
      agg.usd += sessUsd;
      // Only when sessUsd actually used it - a multi-attempt session falls
      // back to the computed estimate, and agg.usdReported must not claim
      // "not an estimate" about a figure it didn't contribute to.
      if (dg.reportedUsd && !dg.hadMultiAttempt) agg.usdReported += dg.reportedUsd;
      for (const [mid, u] of Object.entries(dg.byModel || {})) {
        const a = agg.byModel[mid] || (agg.byModel[mid] = {
          in: 0, out: 0, cacheR: 0, cacheW: 0, cacheW1h: 0, usd: 0, sessions: 0 });
        a.in += u.in; a.out += u.out; a.cacheR += u.cacheR;
        a.cacheW += u.cacheW; a.cacheW1h += u.cacheW1h || 0;
        a.usd += priceUsage({ [mid]: u }, p);
        a.sessions++;
      }
      // Spend lands on the days it actually happened. A digest written before
      // byDay existed, or a transcript whose timestamps are unusable, has
      // nothing to place - fall back to the old mtime attribution for that one
      // session rather than dropping it out of the windows entirely.
      const days = dg.byDay && Object.keys(dg.byDay).length ? dg.byDay : null;
      let in7 = false, in30 = false;
      const place = (dk, usd) => {
        spendByDay[dk] = (spendByDay[dk] || 0) + usd;
        if (set7.has(dk)) in7 = true;
        if (set30.has(dk)) in30 = true;
      };
      if (days) {
        for (const [dk, d] of Object.entries(days)) {
          place(dk, totalUsd(d.reported, d.multi, d.models, p));
        }
      } else {
        place(dayKey(st.mtimeMs), sessUsd);
      }
      if (in7) win.d7.sessions++;
      if (in30) win.d30.sessions++;

      // Prefer the actual opening prompt as the title; Claude Code's generated
      // summary is a better "about" line than a second title.
      const title = head.firstUser || idx.summary || idx.title || head.summary || '(no prompt captured)';
      projects[key].sessions.push({
        about: dg.about || '',
        usd: sessUsd,
        usdReported: !!dg.reportedUsd && !dg.hadMultiAttempt,
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

  const daily = days30.map((d) => ({ day: d, usd: spendByDay[d] || 0 }));
  win.d7.usd = daily.slice(-7).reduce((a, d) => a + d.usd, 0);
  win.d30.usd = daily.reduce((a, d) => a + d.usd, 0);

  lastSummary = {
    sessions: agg.sessions,
    daily,
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

/*
 * Tell someone when a transcript changes, so the list can stop being a snapshot
 * of whenever it was last loaded. Claude Code appends to the .jsonl of a live
 * session continuously, so this is heavily rate-limited on two axes: a debounce
 * that waits for a burst of writes to settle, and a floor between notifications,
 * because acting on one means a rescan that re-digests whatever changed.
 *
 * Nothing starts at require time - server.js calls this, like everything else
 * that runs. setTimeout rather than an interval, deliberately: the timer only
 * exists while a change is pending, and lib/ is not allowed a heartbeat.
 *
 * Best-effort throughout. Recursive watching is not available everywhere and a
 * watch can die on its own; the Rescan button and the 15s cache remain the
 * contract, and this is only ever an improvement on top of them.
 */
function watchProjects(onChange) {
  const SETTLE_MS = 2500;
  const FLOOR_MS = 10_000;
  let timer = null, lastFired = 0, watcher = null;

  const fire = () => {
    timer = null;
    const wait = FLOOR_MS - (Date.now() - lastFired);
    if (wait > 0) { timer = setTimeout(fire, wait); if (timer.unref) timer.unref(); return; }
    lastFired = Date.now();
    try { onChange(); } catch { /* a watcher must never take the server down */ }
  };

  try {
    watcher = fs.watch(PROJECTS_DIR, { recursive: true }, (ev, name) => {
      // Digest caches and index files churn without changing what is listed.
      if (name && !String(name).endsWith('.jsonl')) return;
      invalidateSessionCache();
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, SETTLE_MS);
      if (timer.unref) timer.unref();
    });
    watcher.on('error', () => { /* watch died; the Rescan button still works */ });
  } catch {
    return () => {};   // no recursive watch here: not an error, just no live list
  }
  return () => {
    if (timer) clearTimeout(timer);
    try { watcher.close(); } catch { /* already gone */ }
  };
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
  loadOverrides, saveOverrides, knownProjects, watchProjects,
};
