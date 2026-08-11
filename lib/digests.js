/*
 * A one-line "what happened" derived from the transcript itself: files edited,
 * commands run, duration. Cached by (mtime,size) so a rescan is nearly free.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { CLAUDE_DIR } = require('./constants');
const { readJsonSafe } = require('./util');

const DIGEST_CACHE = path.join(CLAUDE_DIR, '.maestro-digests.json');
const DIGEST_MAX_BYTES = 24 * 1024 * 1024;
let digests = null;

function loadDigests() {
  if (!digests) digests = readJsonSafe(DIGEST_CACHE) || {};
  return digests;
}
function saveDigests() {
  try {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.writeFileSync(DIGEST_CACHE, JSON.stringify(digests));
  } catch { /* cache is an optimization, never fatal */ }
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Local calendar day, because "last 7 days" is a question about the user's
// week, not about UTC. Timestamps are ISO; anything unparseable buckets
// nowhere rather than landing on 1970.
function dayKey(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function computeDigest(file) {
  const st = fs.statSync(file);
  if (st.size > DIGEST_MAX_BYTES) return { about: 'transcript too large to summarize', partial: true };

  const edited = new Map(); // basename -> times touched
  const cmds = new Map();   // first word of each Bash command -> count
  let edits = 0, reads = 0, bashes = 0, agents = 0, aiTurns = 0, outTok = 0;
  let firstTs = null, lastTs = null, summary = null;
  let customTitle = null;    // /rename, or Claude Code's generated name
  const byModel = {};        // model id -> token counters
  // Same counters again, split by the local calendar day the response landed
  // on. The rolled-up 7/30-day windows used to attribute a session's *whole*
  // cost to its file mtime, so a session opened three weeks ago and touched
  // this morning put all three weeks of spend inside "last 7 days". A session
  // spans a handful of days, so this stays small; the cap is only there so a
  // pathological months-long transcript cannot grow the cache without bound.
  const byDay = {};          // YYYY-MM-DD -> { reported, models: { id: counters } }
  const MAX_DAYS = 120;
  let peakCtx = 0;           // largest single-turn context we ever sent
  let reportedUsd = 0;       // costUSD, when the transcript records it
  const countedResponses = new Set(); // message.id|requestId already counted

  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'summary' && o.summary) { summary = o.summary; continue; }

    // A renamed session stores its name in the transcript, not in the index.
    // Claude Code has used several shapes for this, so accept all of them and
    // keep the last one written.
    const kind = String(o.type || '') + ' ' + String(o.subtype || '');
    if (/custom-title|agent-name|session-meta/.test(kind)) {
      const v = o.title || o.name || o.customTitle || o.content;
      if (typeof v === 'string' && v.trim()) { customTitle = v.trim(); continue; }
    }
    if (typeof o.title === 'string' && o.title.trim() && !customTitle) customTitle = o.title.trim();

    // Older builds record the rename as a slash-command entry instead.
    const raw = typeof o.content === 'string' ? o.content
      : (o.message && typeof o.message.content === 'string') ? o.message.content : '';
    if (raw.includes('/rename')) {
      const m = raw.match(/<command-args>([\s\S]*?)<\/command-args>/);
      if (m && m[1].trim()) { customTitle = m[1].trim(); continue; }
    }
    if (o.timestamp) { if (!firstTs) firstTs = o.timestamp; lastTs = o.timestamp; }
    const msg = o.message;
    if (!msg) continue;
    if (o.type === 'assistant') {
      // Claude Code writes ONE LINE PER CONTENT BLOCK of a single API response -
      // a turn with thinking + text + tool_use is three lines - and every one of
      // them repeats the *same* complete usage object. Summing each line counted
      // most turns two or three times (measured: +84% to +125% on real
      // transcripts). Count each API response exactly once, keyed by the id the
      // API assigned it.
      const respKey = (msg.id || '') + '|' + (o.requestId || '');
      const seenResp = respKey !== '|' && countedResponses.has(respKey);
      if (!seenResp && respKey !== '|') countedResponses.add(respKey);
      if (!seenResp) aiTurns++;
      // The day this response landed on, so the windows below can be built from
      // when the spend happened rather than from when the file was last touched.
      const dk = seenResp ? null : dayKey(o.timestamp);
      const day = dk && (byDay[dk] || (Object.keys(byDay).length < MAX_DAYS
        ? (byDay[dk] = { reported: 0, models: {} })
        : null));
      if (typeof o.costUSD === 'number' && !seenResp) {
        reportedUsd += o.costUSD;
        if (day) day.reported += o.costUSD;
      }
      const u = seenResp ? null : msg.usage;
      // "<synthetic>" is Claude Code's own error/notice message (e.g. "Prompt is
      // too long"), not an API call. Its usage is all zeros, but leaving it in
      // puts a phantom model in every affected session's model list.
      if (u && msg.model !== '<synthetic>') {
        const model = (msg.model || 'unknown') + (u.speed === 'fast' ? '|fast' : '');
        const m = byModel[model] || (byModel[model] = { in: 0, out: 0, cacheR: 0, cacheW: 0, cacheW1h: 0 });
        const inp = u.input_tokens || 0;
        const out = u.output_tokens || 0;
        const cr = u.cache_read_input_tokens || 0;
        // cache_creation may be a flat count or split by TTL depending on version
        let cw = u.cache_creation_input_tokens || 0, cw1h = 0;
        if (u.cache_creation && typeof u.cache_creation === 'object') {
          cw = u.cache_creation.ephemeral_5m_input_tokens || 0;
          cw1h = u.cache_creation.ephemeral_1h_input_tokens || 0;
        }
        m.in += inp; m.out += out; m.cacheR += cr; m.cacheW += cw; m.cacheW1h += cw1h;
        if (day) {
          const dm = day.models[model] || (day.models[model] = { in: 0, out: 0, cacheR: 0, cacheW: 0, cacheW1h: 0 });
          dm.in += inp; dm.out += out; dm.cacheR += cr; dm.cacheW += cw; dm.cacheW1h += cw1h;
        }
        outTok += out;
        // everything fed to the model on this turn - cached or not - is context
        peakCtx = Math.max(peakCtx, inp + cr + cw + cw1h);
      }
      if (!Array.isArray(msg.content)) continue;
      for (const b of msg.content) {
        if (b.type !== 'tool_use') continue;
        const inp = b.input || {};
        if (EDIT_TOOLS.has(b.name)) {
          edits++;
          const f = inp.file_path || inp.notebook_path;
          if (f) { const n = path.basename(String(f)); edited.set(n, (edited.get(n) || 0) + 1); }
        } else if (b.name === 'Read') { reads++; }
        else if (b.name === 'Bash' || b.name === 'PowerShell') {
          bashes++;
          const w = String(inp.command || '').trim().split(/\s+/)[0];
          if (w && /^[A-Za-z._/-]+$/.test(w)) {
            const k = path.basename(w);
            cmds.set(k, (cmds.get(k) || 0) + 1);
          }
        } else if (b.name === 'Task') { agents++; }
      }
    }
  }

  const topFiles = [...edited.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const topCmds = [...cmds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);
  const mins = firstTs && lastTs ? Math.round((Date.parse(lastTs) - Date.parse(firstTs)) / 60000) : null;

  const bits = [];
  if (edits) {
    const shown = topFiles.slice(0, 2).join(', ');
    const more = topFiles.length > 2 ? ` +${topFiles.length - 2}` : '';
    bits.push(`${edits} edit${edits > 1 ? 's' : ''}${shown ? ` - ${shown}${more}` : ''}`);
  } else if (reads) {
    bits.push(`read-only (${reads} file read${reads > 1 ? 's' : ''})`);
  }
  if (bashes) bits.push(`${bashes} cmd${bashes > 1 ? 's' : ''}${topCmds.length ? ` (${topCmds.join(', ')})` : ''}`);
  if (agents) bits.push(`${agents} subagent${agents > 1 ? 's' : ''}`);
  if (mins != null && mins >= 1) bits.push(mins >= 90 ? `${(mins / 60).toFixed(1)}h` : `${mins}m`);

  return {
    about: bits.join(' · ') || (aiTurns ? 'conversation only, no tool use' : 'no activity recorded'),
    summary, edits, reads, bashes, agents, aiTurns, outTok,
    files: topFiles.slice(0, 6), cmds: topCmds, minutes: mins,
    byModel, byDay, peakCtx, reportedUsd, customTitle,
  };
}

function getDigest(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const cache = loadDigests();
  // v4: count each API response once instead of once per content block
  // v5: byDay, so spend windows follow when the work happened, not file mtime
  const DIGEST_VERSION = 5;
  const hit = cache[file];
  if (hit && hit.v === DIGEST_VERSION && hit.m === st.mtimeMs && hit.s === st.size) return hit.d;
  let d;
  try { d = computeDigest(file); } catch (e) { d = { about: 'could not read transcript' }; }
  cache[file] = { v: DIGEST_VERSION, m: st.mtimeMs, s: st.size, d };
  return d;
}

function pruneDigests() {
  const cache = loadDigests();
  let changed = false;
  for (const f of Object.keys(cache)) if (!fs.existsSync(f)) { delete cache[f]; changed = true; }
  if (changed) saveDigests();
}

module.exports = { computeDigest, getDigest, saveDigests, pruneDigests, dayKey };
