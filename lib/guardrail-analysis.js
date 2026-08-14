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
const { HOOK_SCRIPT } = require('./guardrails');

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

module.exports = { testRule, testFile, testCommand };
