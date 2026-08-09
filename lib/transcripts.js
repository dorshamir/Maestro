/*
 * Reading session transcripts: the viewer feed, plus export (capsule/markdown)
 * and import of a capsule shared by someone else.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PROJECTS_DIR, SESSION_ID_RE } = require('./constants');
const { extractText } = require('./util');
const { getDigest } = require('./digests');
const { invalidateSessionCache } = require('./sessions');

/* ------------------------------------------------------- share and import */

// Patterns that should never leave a laptop by accident. Export warns; it does
// not silently rewrite the transcript, because a redacted transcript that still
// claims to be complete is worse than an honest warning.
const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{16,}/g, 'Anthropic API key'],
  [/sk-[A-Za-z0-9]{32,}/g, 'API key'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, 'GitHub token'],
  [/AKIA[0-9A-Z]{16}/g, 'AWS access key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, 'private key'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'Slack token'],
  [/\b[Pp]assword\s*[:=]\s*\S{6,}/g, 'inline password'],
];

function scanSecrets(text) {
  const found = [];
  for (const [re, label] of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m) found.push({ kind: label, count: m.length });
  }
  return found;
}

function readTranscript(file) {
  if (!file || !file.startsWith(PROJECTS_DIR)) throw new Error('not a session transcript');
  if (!fs.existsSync(file)) throw new Error('transcript not found');
  return fs.readFileSync(file, 'utf8');
}

function buildCapsule(file) {
  const raw = readTranscript(file);
  const lines = raw.split('\n').filter((l) => l.trim());
  const dg = getDigest(file) || {};
  let cwd = null, sessionId = null, branch = null;
  for (const l of lines.slice(0, 50)) {
    try {
      const o = JSON.parse(l);
      cwd = cwd || o.cwd; sessionId = sessionId || o.sessionId; branch = branch || o.gitBranch;
    } catch { /* skip */ }
  }
  return {
    capsule: 'maestro-session',
    version: 1,
    exportedAt: new Date().toISOString(),
    meta: {
      name: dg.customTitle || dg.summary || '',
      originalCwd: cwd,
      originalSessionId: sessionId || path.basename(file, '.jsonl'),
      gitBranch: branch || null,
      messages: lines.length,
      about: dg.about || '',
    },
    warnings: scanSecrets(raw),
    transcript: lines,
  };
}

function transcriptToMarkdown(file) {
  const dg = getDigest(file) || {};
  const out = [`# ${dg.customTitle || dg.summary || 'Claude Code session'}`, ''];
  if (dg.about) out.push(`_${dg.about}_`, '');
  for (const line of readTranscript(file).split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const msg = o.message;
    if (!msg) continue;
    const text = extractText(msg.content);
    if (o.type === 'user' && text && !text.startsWith('<')) out.push(`### You`, '', text, '');
    else if (o.type === 'assistant') {
      if (text) out.push(`### Claude`, '', text, '');
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === 'tool_use') {
            const d = b.input && (b.input.file_path || b.input.command || b.input.pattern);
            out.push(`> \`${b.name}\`${d ? ' - ' + String(d).slice(0, 160) : ''}`, '');
          }
        }
      }
    }
  }
  return out.join('\n');
}

function encodeProjectDir(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

function importCapsule(capsule, targetDir) {
  if (!capsule || capsule.capsule !== 'maestro-session') throw new Error('not a Maestro session file');
  if (!Array.isArray(capsule.transcript) || !capsule.transcript.length) throw new Error('capsule has no transcript');
  const cwd = targetDir || capsule.meta.originalCwd;
  if (!cwd || !path.isAbsolute(cwd)) throw new Error('choose a project folder to import into');
  if (!fs.existsSync(cwd)) throw new Error(`folder does not exist: ${cwd}`);

  const dir = path.join(PROJECTS_DIR, encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });

  // Keep the original id when it is free, so a shared link stays stable; mint a
  // new one on collision rather than overwriting somebody's history.
  let sessionId = capsule.meta.originalSessionId;
  if (!SESSION_ID_RE.test(sessionId || '') || fs.existsSync(path.join(dir, sessionId + '.jsonl'))) {
    sessionId = crypto.randomUUID();
  }

  // Rewrite cwd and sessionId on every entry or Claude Code will not resolve it.
  const rewritten = capsule.transcript.map((line) => {
    try {
      const o = JSON.parse(line);
      if (o.cwd) o.cwd = cwd;
      if (o.sessionId) o.sessionId = sessionId;
      return JSON.stringify(o);
    } catch { return line; }
  });

  const out = path.join(dir, sessionId + '.jsonl');
  fs.writeFileSync(out, rewritten.join('\n') + '\n');
  invalidateSessionCache();
  return { sessionId, cwd, file: out, messages: rewritten.length, resume: `claude --resume ${sessionId}` };
}

/* --------------------------------------------------------- transcript viewer */

function parseTranscript(file) {
  const full = path.resolve(file);
  if (!full.startsWith(path.resolve(PROJECTS_DIR) + path.sep) || !full.endsWith('.jsonl')) {
    throw new Error('not a session transcript');
  }
  const st = fs.statSync(full);
  const MAX = 8_000_000;
  let raw = fs.readFileSync(full, 'utf8');
  let truncated = false;
  if (raw.length > MAX) { raw = raw.slice(-MAX); raw = raw.slice(raw.indexOf('\n') + 1); truncated = true; }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.isMeta) continue;
    const ts = o.timestamp || null;
    const side = !!o.isSidechain;
    if (o.type === 'summary' && o.summary) { entries.push({ r: 'sum', t: o.summary }); continue; }
    const msg = o.message;
    if (!msg) continue;
    const content = msg.content;
    if (o.type === 'user') {
      if (typeof content === 'string') { entries.push({ r: 'user', t: content, ts, side }); continue; }
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'text') entries.push({ r: 'user', t: b.text, ts, side });
          else if (b.type === 'tool_result') {
            let t = typeof b.content === 'string' ? b.content
              : Array.isArray(b.content) ? b.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '';
            entries.push({ r: 'toolres', t: String(t).slice(0, 1200), err: !!b.is_error, side });
          }
        }
      }
    } else if (o.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text' && b.text.trim()) entries.push({ r: 'ai', t: b.text, ts, side });
        else if (b.type === 'thinking' && b.thinking) entries.push({ r: 'think', t: String(b.thinking).slice(0, 800), side });
        else if (b.type === 'tool_use') {
          entries.push({ r: 'tool', name: b.name, t: JSON.stringify(b.input || {}).slice(0, 600), ts, side });
        }
      }
    }
    if (entries.length > 4000) { truncated = true; break; }
  }
  return { entries, truncated, sizeBytes: st.size };
}

module.exports = {
  readTranscript, buildCapsule, transcriptToMarkdown, importCapsule, parseTranscript,
};
