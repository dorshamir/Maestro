/*
 * MCP servers, across the three places Claude Code reads them from.
 *
 *   user     ~/.claude.json            → mcpServers          every project
 *   project  <dir>/.mcp.json           → mcpServers          checked in, shared
 *   local    ~/.claude.json            → projects[dir].mcpServers   this machine
 *
 * Two of those live inside ~/.claude.json, which is Claude Code's own state file
 * and holds a great deal besides - onboarding flags, per-project counters, the
 * last session id. Every write here reads the whole document, changes only the
 * mcpServers subtree, and writes it back, after rotateBackups() has put a copy
 * aside. A file that will not parse is refused rather than replaced: overwriting
 * it would cost the user everything else in it.
 *
 * A `.mcp.json` server does not run until it is approved for that project, which
 * Claude Code records in projects[dir].enabledMcpjsonServers / disabled...; a
 * server listed nowhere is still pending. That is why the project scope here
 * reports approval state instead of a bare list - "configured" and "will
 * actually start" are different questions and the file alone answers only one.
 *
 * Adding a server is arranging for a command to run on the next Claude Code
 * start. That is the same class of change as writing a hook, and it is exactly
 * what lib/http-guard.js exists to keep a web page from doing.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { HOME } = require('./constants');
const { readJsonSafe, rotateBackups } = require('./util');

const CLAUDE_JSON = path.join(HOME, '.claude.json');

// Claude Code stores project keys with forward slashes on Windows, while
// everything else in Maestro carries native separators. Compare both ways or a
// project's own servers are invisible on the platform that needs them most.
function projectKey(doc, dir) {
  const want = path.resolve(dir);
  const alts = [want, want.replace(/\\/g, '/'), want.replace(/\//g, '\\')];
  const projects = (doc && doc.projects) || {};
  for (const k of Object.keys(projects)) {
    const rk = path.resolve(k);
    if (alts.includes(k) || alts.some((a) => path.resolve(a) === rk)) return k;
  }
  return want.replace(/\\/g, '/');   // Claude Code's own spelling for a new entry
}

// The mcpServers object inside an already-loaded ~/.claude.json document, for
// 'user' or 'local' scope - creating the surrounding structure the first time
// a scope is used, unless create is false, in which case a scope that has
// never been written to reports null instead of manufacturing an empty one.
// Shared by saveServer/deleteServer (one scope) and moveServer (Task 2, which
// touches two scopes inside a single read-modify-write).
function claudeJsonSlot(doc, scope, dir, create = true) {
  if (scope === 'user') {
    if (!doc.mcpServers || typeof doc.mcpServers !== 'object') {
      if (!create) return null;
      doc.mcpServers = {};
    }
    return doc.mcpServers;
  }
  if (scope === 'local') {
    if (!doc.projects || typeof doc.projects !== 'object') {
      if (!create) return null;
      doc.projects = {};
    }
    const k = projectKey(doc, dir);
    if (!doc.projects[k] || typeof doc.projects[k] !== 'object') {
      if (!create) return null;
      doc.projects[k] = {};
    }
    const p = doc.projects[k];
    if (!p.mcpServers || typeof p.mcpServers !== 'object') {
      if (!create) return null;
      p.mcpServers = {};
    }
    return p.mcpServers;
  }
  throw new Error('claudeJsonSlot: not a ~/.claude.json scope');
}

function mcpJsonPath(dir) {
  if (!dir || !path.isAbsolute(dir)) throw new Error('project directory required for this scope');
  return path.join(dir, '.mcp.json');
}

// A server entry, normalised enough for the UI to describe it in one line
// without having to know every transport Claude Code supports.
function describe(name, cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const kind = c.type || (c.url ? 'http' : 'stdio');
  const detail = c.url ? String(c.url)
    : [c.command, ...(Array.isArray(c.args) ? c.args : [])].filter(Boolean).join(' ');
  return {
    name,
    kind,
    detail: String(detail || '').slice(0, 300),
    envKeys: c.env && typeof c.env === 'object' ? Object.keys(c.env) : [],
    config: c,
  };
}

function serversFrom(obj) {
  const out = [];
  const servers = (obj && obj.mcpServers && typeof obj.mcpServers === 'object') ? obj.mcpServers : {};
  for (const [name, cfg] of Object.entries(servers)) out.push(describe(name, cfg));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function listMcp(dir) {
  const doc = readJsonSafe(CLAUDE_JSON);
  const claudeJsonBroken = doc === null && fs.existsSync(CLAUDE_JSON);
  const pkey = doc && dir ? projectKey(doc, dir) : null;
  const proj = (doc && pkey && doc.projects && doc.projects[pkey]) || {};

  const scopes = [
    { scope: 'user', file: CLAUDE_JSON, servers: serversFrom(doc), shared: false },
  ];

  if (dir) {
    const file = mcpJsonPath(dir);
    const json = readJsonSafe(file);
    const enabled = Array.isArray(proj.enabledMcpjsonServers) ? proj.enabledMcpjsonServers : [];
    const disabled = Array.isArray(proj.disabledMcpjsonServers) ? proj.disabledMcpjsonServers : [];
    scopes.push({
      scope: 'project',
      file,
      exists: fs.existsSync(file),
      broken: json === null && fs.existsSync(file),
      shared: true,
      servers: serversFrom(json).map((s) => ({
        ...s,
        // "in the file" is not "running". Anything neither approved nor refused
        // is still waiting for the prompt Claude Code shows on first start.
        approval: enabled.includes(s.name) ? 'enabled'
          : disabled.includes(s.name) ? 'disabled' : 'pending',
      })),
    });
    scopes.push({ scope: 'local', file: CLAUDE_JSON, servers: serversFrom(proj), shared: false });
  }

  return { dir: dir || null, claudeJsonBroken, scopes };
}

/* ------------------------------------------------------------------ writes */

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

function validate(name, config) {
  if (!NAME_RE.test(String(name || ''))) {
    throw new Error('server name must be 1-64 chars: letters, digits, space, dot, dash, underscore');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('server config must be a JSON object');
  }
  const hasUrl = typeof config.url === 'string' && config.url.trim();
  const hasCmd = typeof config.command === 'string' && config.command.trim();
  if (!hasUrl && !hasCmd) throw new Error('needs either a "command" (stdio) or a "url" (http/sse)');
  if (hasUrl && !/^https?:\/\//i.test(config.url.trim())) throw new Error('url must be http:// or https://');
  if (config.args !== undefined && !Array.isArray(config.args)) throw new Error('"args" must be an array');
  if (config.env !== undefined && (typeof config.env !== 'object' || Array.isArray(config.env))) {
    throw new Error('"env" must be an object');
  }
  return config;
}

// Read-modify-write of ~/.claude.json. Refuses a document it cannot parse:
// rewriting it from scratch would drop everything Claude Code keeps in there.
function editClaudeJson(fn) {
  const doc = readJsonSafe(CLAUDE_JSON);
  if (doc === null && fs.existsSync(CLAUDE_JSON)) {
    throw new Error('~/.claude.json is not valid JSON - fix it before editing MCP servers here');
  }
  const next = doc || {};
  fn(next);
  rotateBackups(CLAUDE_JSON);
  fs.writeFileSync(CLAUDE_JSON, JSON.stringify(next, null, 2));
  return CLAUDE_JSON;
}

function editMcpJson(dir, fn) {
  const file = mcpJsonPath(dir);
  const doc = readJsonSafe(file);
  if (doc === null && fs.existsSync(file)) {
    throw new Error(`${file} is not valid JSON - fix it in the Files tab first`);
  }
  const next = doc || {};
  if (!next.mcpServers || typeof next.mcpServers !== 'object') next.mcpServers = {};
  fn(next);
  rotateBackups(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return file;
}

function saveServer(scope, dir, name, config) {
  validate(name, config);
  if (scope === 'project') return editMcpJson(dir, (doc) => { doc.mcpServers[name] = config; });
  if (scope === 'user' || scope === 'local') {
    return editClaudeJson((doc) => { claudeJsonSlot(doc, scope, dir)[name] = config; });
  }
  throw new Error('unknown scope');
}

function deleteServer(scope, dir, name) {
  if (!name) throw new Error('server name required');
  if (scope === 'project') return editMcpJson(dir, (doc) => { delete doc.mcpServers[name]; });
  if (scope === 'user' || scope === 'local') {
    return editClaudeJson((doc) => {
      const slot = claudeJsonSlot(doc, scope, dir, false);
      if (slot) delete slot[name];
    });
  }
  throw new Error('unknown scope');
}

// Read-only counterpart to saveServer/deleteServer's scope dispatch - what is
// on disk right now for one (scope, dir, name), or undefined if that name is
// not present at all. The sentinel for "absent" is undefined, not null: JSON
// can hold a literal `null` config (someone hand-edited the file), and if that
// read as "nothing here" the same way an actually-missing name does, moveServer
// could silently overwrite it - `||` coalescing did exactly that before this
// used hasOwnProperty. `undefined` never appears in parsed JSON, so it stays
// unambiguous as the "not present" answer while a stored null still comes back
// as null.
function getServerConfig(scope, dir, name) {
  if (scope === 'project') {
    const doc = readJsonSafe(mcpJsonPath(dir));
    const slot = doc && doc.mcpServers;
    return slot && Object.prototype.hasOwnProperty.call(slot, name) ? slot[name] : undefined;
  }
  if (scope === 'user' || scope === 'local') {
    const doc = readJsonSafe(CLAUDE_JSON);
    if (!doc) return undefined;
    const slot = claudeJsonSlot(doc, scope, dir, false);
    return slot && Object.prototype.hasOwnProperty.call(slot, name) ? slot[name] : undefined;
  }
  throw new Error('unknown scope');
}

// path.resolve() with no case-folding or symlink resolution is enough here
// even though two different-looking paths can name the same directory on a
// case-insensitive filesystem: this function only decides "same scope + same
// dir" for the same-location refusal below, and anything it wrongly calls
// "different" still lands on the collision check in moveServer (getServerConfig,
// which resolves through the OS's own case-folding for 'project' scope reads,
// and through the delete-before-set ordering for the same-file 'user'/'local'
// transaction) - so a false "different" here is caught downstream rather than
// silently overwriting something.
function sameLocation(a, b) {
  if (a.scope !== b.scope) return false;
  if (a.scope === 'user') return true;
  return path.resolve(a.dir || '') === path.resolve(b.dir || '');
}

// Move a server's config from one {scope, dir} location to another, writing
// the target before touching the source - see the module comment for why the
// two scopes inside ~/.claude.json get one atomic transaction while anything
// touching .mcp.json (a different file) does not.
function moveServer(from, to, name) {
  if (!name) throw new Error('server name required');
  if (sameLocation(from, to)) throw new Error('source and target are the same');
  if (from.scope !== 'user' && !(from.dir && path.isAbsolute(from.dir))) {
    throw new Error('source project required for that scope');
  }
  if (to.scope !== 'user' && !(to.dir && path.isAbsolute(to.dir))) {
    throw new Error('target project required for that scope');
  }
  const cfg = getServerConfig(from.scope, from.dir, name);
  if (cfg === undefined) throw new Error(`"${name}" was not found in the source scope - it may have changed on disk`);
  if (getServerConfig(to.scope, to.dir, name) !== undefined) {
    throw new Error(`"${name}" already exists in ${to.scope} scope - remove or rename it there first`);
  }
  validate(name, cfg);

  const inClaudeJson = (loc) => loc.scope === 'user' || loc.scope === 'local';
  if (inClaudeJson(from) && inClaudeJson(to)) {
    return editClaudeJson((doc) => {
      const src = claudeJsonSlot(doc, from.scope, from.dir, false);
      if (src) delete src[name];
      claudeJsonSlot(doc, to.scope, to.dir, true)[name] = cfg;
    });
  }

  const file = saveServer(to.scope, to.dir, name, cfg);
  try {
    deleteServer(from.scope, from.dir, name);
  } catch (err) {
    const wrapped = new Error(
      `moved to ${to.scope} scope, but could not remove it from ${from.scope} scope: ${err.message} - remove it there manually`);
    wrapped.partial = true;
    wrapped.file = file;
    throw wrapped;
  }
  return file;
}

// Approve or refuse a .mcp.json server for one project. Claude Code keeps this
// as two lists rather than a flag, so a name must be removed from one before it
// goes into the other or it ends up in both and the result is anyone's guess.
function setApproval(dir, name, approval) {
  if (!['enabled', 'disabled', 'pending'].includes(approval)) throw new Error('unknown approval state');
  if (!name) throw new Error('server name required');
  return editClaudeJson((doc) => {
    if (!doc.projects || typeof doc.projects !== 'object') doc.projects = {};
    const k = projectKey(doc, dir);
    if (!doc.projects[k] || typeof doc.projects[k] !== 'object') doc.projects[k] = {};
    const p = doc.projects[k];
    const drop = (key) => {
      if (Array.isArray(p[key])) p[key] = p[key].filter((n) => n !== name);
    };
    drop('enabledMcpjsonServers');
    drop('disabledMcpjsonServers');
    if (approval === 'pending') return;
    const key = approval === 'enabled' ? 'enabledMcpjsonServers' : 'disabledMcpjsonServers';
    if (!Array.isArray(p[key])) p[key] = [];
    p[key].push(name);
  });
}

module.exports = { listMcp, saveServer, deleteServer, moveServer, setApproval, CLAUDE_JSON };
