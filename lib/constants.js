/*
 * Values every other module agrees on. No logic, no I/O, no requires beyond
 * node builtins - so nothing can create a cycle by reaching for a constant.
 */
'use strict';

const os = require('os');
const path = require('path');

const HOME = os.homedir();
// Claude Code honours CLAUDE_CONFIG_DIR, and managed/corporate machines do set
// it - roaming profiles, redirected home directories. Reading ~/.claude anyway
// makes Maestro list an empty Library while the CLI is happily loading skills
// from somewhere else, with nothing on screen to explain the mismatch.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR
  ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
  : path.join(HOME, '.claude');

module.exports = {
  PORT: parseInt(process.env.MAESTRO_PORT || '4144', 10),
  HOME,
  CLAUDE_DIR,
  PROJECTS_DIR: path.join(CLAUDE_DIR, 'projects'),
  // Install root - the folder holding server.js, one level above this one.
  // Everything that serves a bundled file (public/index.html, assets/*) must
  // resolve from here, not from __dirname, now that the code lives in lib/.
  ROOT: path.resolve(__dirname, '..'),
  LOG_FILE: path.join(CLAUDE_DIR, '.maestro.log'),
  SESSION_ID_RE: /^[A-Za-z0-9_-]{4,80}$/,
  BACKUP_KEEP: 3,
};
