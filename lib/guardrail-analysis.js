/*
 * Read-only analysis over guardrails: does this sample get blocked, which
 * projects are missing a rule a sibling has, which past commands would have
 * been caught. None of this writes a hook or touches settings.json - that
 * stays in lib/guardrails.js. Kept apart because these features scan every
 * project's transcripts/config rather than mutate one project's own guard
 * state, which is a different kind of operation than the rest of that file.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { HOOK_SCRIPT, readGuard } = require('./guardrails');
const { scanSessions } = require('./sessions');

// Same shape as lib/util.js's run(): never spawnSync/execFileSync here - a
// synchronous child process would freeze every other request on this
// single-threaded server for as long as node takes to start and exit, and
// npm test enforces that ban across every server-side file. Unlike run(),
// this needs to write an event to the child's stdin and read its stderr +
// exit code rather than stdout, so it is not a fit for run() itself.
function runHook(hookPath, evt, timeout = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let child;
    try {
      child = execFile(process.execPath, [hookPath], { timeout, windowsHide: true },
        (err, stdout, stderr) => finish({ blocked: !!err && err.code === 2, reason: String(stderr || '').trim() }));
    } catch { return finish({ blocked: false, reason: '' }); }
    child.on('error', () => finish({ blocked: false, reason: '' }));
    try { child.stdin.write(JSON.stringify(evt)); child.stdin.end(); } catch { /* best effort */ }
    setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish({ blocked: false, reason: 'timed out' }); }, timeout + 500);
  });
}

// Runs a synthetic PreToolUse event through the *real* generated hook, so a
// "would this be blocked" answer can never drift from what a live session
// actually does - no matching logic is duplicated here. `cfg` is whatever
// draft {files, commands} the caller passes, which lets the UI test rules
// that have not been Applied (saved to disk) yet.
async function testRule(cfg, evt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-guard-test-'));
  try {
    const hook = path.join(dir, 'maestro-guard.js');
    fs.writeFileSync(hook, HOOK_SCRIPT);
    fs.writeFileSync(path.join(dir, 'maestro-guardrails.json'), JSON.stringify({
      files: (cfg.files || []).map(String).filter(Boolean),
      commands: (cfg.commands || []).map(String).filter(Boolean),
    }));
    return await runHook(hook, evt);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The two things the UI lets someone sanity-check before trusting a new rule:
// would reading this path get blocked, would running this command.
function testFile(cfg, filePath) {
  return testRule(cfg, { tool_name: 'Read', tool_input: { file_path: String(filePath || '') } });
}
function testCommand(cfg, command) {
  return testRule(cfg, { tool_name: 'Bash', tool_input: { command: String(command || '') } });
}

/* --------------------------------------------------- near-miss synthesis */
/*
 * Mines transcript history for the commands and file touches that were
 * NOT blocked, so a rule can be proposed from something that actually
 * almost happened rather than a hypothetical. Deliberately narrow,
 * pattern-based signatures - no LLM call, matching the rest of this
 * project's no-network constraint - so this stays a short, auditable list
 * rather than a fuzzy classifier that both over- and under-fires.
 */
// `suggest` is the reusable token/glob Add-rule proposes - not the observed
// text (`seen`) - because a guard command rule matches a literal substring
// anywhere in a command line: adding the whole observed line as the rule
// would only ever re-match that one exact line again.
const RISK_COMMANDS = [
  { re: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\b/i, label: 'recursive force delete', suggest: 'rm -rf' },
  { re: /\brm\s+-[a-z]*f[a-z]*r[a-z]*\b/i, label: 'recursive force delete', suggest: 'rm -rf' },
  { re: /\bgit\s+push\s+(--force(-with-lease)?|-f)\b/i, label: 'force push', suggest: 'git push --force' },
  { re: /\bgit\s+reset\s+--hard\b/i, label: 'hard reset (discards local work)', suggest: 'git reset --hard' },
  { re: /\bDROP\s+(TABLE|DATABASE)\b/i, label: 'drop table/database', suggest: 'DROP TABLE' },
  { re: /\bTRUNCATE\s+TABLE\b/i, label: 'truncate table', suggest: 'TRUNCATE TABLE' },
  { re: /\bchmod\s+-R\s+777\b/i, label: 'world-writable recursive chmod', suggest: 'chmod -R 777' },
];
const RISK_FILES = [
  { re: /\.env(\.|$)/i, label: 'env file', suggest: '.env' },
  { re: /\.pem$/i, label: 'private key', suggest: '*.pem' },
  { re: /id_rsa/i, label: 'ssh private key', suggest: 'id_rsa' },
  { re: /\.ssh\//i, label: 'ssh directory', suggest: '.ssh/**' },
  { re: /credentials\.json$/i, label: 'credentials file', suggest: 'credentials.json' },
];
const RISK_MAX_FILE = 12 * 1024 * 1024; // matches transcripts.js's search cap

// Pure and file-scoped, like digests.js's computeDigest - reads one
// transcript, returns the risky tool calls it contains, independent of
// what is currently guarded. Never throws: a missing/corrupt/oversized
// file just yields no hits, the same "degrade, don't break" contract every
// transcript reader in this codebase holds.
function scanTranscriptForRisks(file) {
  const hits = [];
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return hits; }
  if (raw.length > RISK_MAX_FILE) return hits;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.isMeta || o.type !== 'assistant') continue;
    const content = o.message && o.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || b.type !== 'tool_use') continue;
      const input = b.input || {};
      if ((b.name === 'Bash' || b.name === 'PowerShell') && input.command) {
        for (const risk of RISK_COMMANDS) {
          if (risk.re.test(input.command)) {
            hits.push({ kind: 'command', seen: input.command, suggest: risk.suggest, label: risk.label, ts: o.timestamp || null });
            break;
          }
        }
      }
      const filePath = input.file_path || input.notebook_path;
      if (filePath && ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(b.name)) {
        for (const risk of RISK_FILES) {
          if (risk.re.test(filePath)) {
            hits.push({ kind: 'file', seen: filePath, suggest: risk.suggest, label: risk.label, ts: o.timestamp || null });
            break;
          }
        }
      }
    }
  }
  return hits;
}

// User-scope rules apply to every project; project/local scope only to this
// one - so "would this actually be blocked here" has to check all three
// scopes that could cover a given directory, not just one.
function effectiveGuardConfig(dir) {
  const scopes = [readGuard('user', null)];
  if (dir) { scopes.push(readGuard('project', dir), readGuard('local', dir)); }
  return {
    files: [...new Set(scopes.flatMap((s) => s.files))],
    commands: [...new Set(scopes.flatMap((s) => s.commands))],
  };
}

const NEAR_MISS_BUDGET_MS = 6000; // same order as searchTranscripts's budget
const NEAR_MISS_LIMIT = 40;

// Walks every session in `dir` (or every session on the machine, when dir is
// omitted - user-scope rules apply everywhere), same bounding shape as
// transcripts.js's searchTranscripts: a per-file size skip and an overall
// time budget, because this reads real files inside a request.
async function findNearMisses(dir) {
  const cfg = effectiveGuardConfig(dir);
  const sessions = [];
  for (const proj of scanSessions()) {
    if (dir && proj.cwd !== dir) continue;
    for (const s of proj.sessions) sessions.push(s);
  }
  const started = Date.now();
  const seenSuggest = new Set(); // dedup by the rule that would actually be added
  const candidates = [];
  let scanned = 0, partial = false;
  for (const s of sessions) {
    if (Date.now() - started > NEAR_MISS_BUDGET_MS) { partial = true; break; }
    if (s.sizeBytes > RISK_MAX_FILE) continue;
    scanned++;
    for (const hit of scanTranscriptForRisks(s.file)) {
      const key = hit.kind + ' ' + hit.suggest;
      if (seenSuggest.has(key)) continue;
      seenSuggest.add(key);
      candidates.push({ ...hit, sessionId: s.id, file: s.file });
    }
  }
  const results = [];
  for (const c of candidates) {
    if (results.length >= NEAR_MISS_LIMIT) { partial = true; break; }
    if (Date.now() - started > NEAR_MISS_BUDGET_MS) { partial = true; break; }
    // Tests the proposed rule itself, not the raw observed text: the real
    // question is "is `suggest` already covered," since that is what Add
    // rule would add.
    const r = c.kind === 'command' ? await testCommand(cfg, c.suggest) : await testFile(cfg, c.suggest);
    if (!r.blocked) results.push(c);
  }
  return { results, scanned, partial };
}

module.exports = { testRule, testFile, testCommand, scanTranscriptForRisks, findNearMisses };
