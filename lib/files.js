/*
 * The file explorer: a deliberately narrow window onto ~/.claude and a
 * project's .claude. Everything outside that window is refused by path.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { CLAUDE_DIR } = require('./constants');
const { safeJoin } = require('./util');

const TEXT_EXT = new Set(['.md', '.json', '.jsonl', '.txt', '.sh', '.ps1', '.bat', '.cmd',
  '.js', '.mjs', '.cjs', '.ts', '.py', '.yaml', '.yml', '.toml', '.local', '.gitignore']);
// System-managed dirs hidden from the tree (sessions have their own tab); credentials never exposed.
const USER_SKIP = new Set(['projects', 'todos', 'shell-snapshots', 'statsig', 'file-history', 'downloads', 'cache', 'ide', 'plugins']);
const BLOCKED_FILES = new Set(['.credentials.json']);
const PROJECT_ROOT_FILES = ['CLAUDE.md', 'CLAUDE.local.md', '.mcp.json'];

function isTextFile(name) {
  const ext = path.extname(name).toLowerCase();
  return TEXT_EXT.has(ext) || name === 'CLAUDE.md' || (!ext && name.startsWith('.'));
}

function fileRel(scope, dir, rel) {
  rel = String(rel || '').replace(/\\/g, '/');
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) throw new Error('invalid path');
  if (BLOCKED_FILES.has(path.basename(rel))) throw new Error('credentials are never exposed through Maestro');
  if (rel.includes('.maestro-bak.')) throw new Error('backups are restored by copying manually');
  if (scope === 'user') {
    if (USER_SKIP.has(rel.split('/')[0])) throw new Error('system-managed folder');
    return safeJoin(CLAUDE_DIR, rel);
  }
  if (scope === 'project') {
    if (!dir || !path.isAbsolute(dir)) throw new Error('project directory required');
    if (!PROJECT_ROOT_FILES.includes(rel) && !rel.startsWith('.claude/')) {
      throw new Error('project scope covers .claude/, CLAUDE.md, CLAUDE.local.md and .mcp.json only');
    }
    return safeJoin(dir, rel);
  }
  throw new Error('unknown scope');
}

function walkFiles(root, base, depth, out) {
  if (depth > 6 || out.length > 600) return;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.includes('.maestro-bak.') || BLOCKED_FILES.has(e.name)) continue;
    if (!base && root === CLAUDE_DIR && USER_SKIP.has(e.name)) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      out.push({ rel, dir: true, depth: rel.split('/').length - 1 });
      walkFiles(full, rel, depth + 1, out);
    } else {
      let st; try { st = fs.statSync(full); } catch { continue; }
      out.push({ rel, dir: false, depth: rel.split('/').length - 1, size: st.size, mtime: st.mtimeMs, text: isTextFile(e.name) });
    }
  }
}

function listFiles(scope, dir) {
  const out = [];
  if (scope === 'user') {
    walkFiles(CLAUDE_DIR, '', 0, out);
    return { root: CLAUDE_DIR, items: out, hidden: [...USER_SKIP] };
  }
  if (!dir || !path.isAbsolute(dir)) throw new Error('project directory required');
  for (const f of PROJECT_ROOT_FILES) {
    const full = path.join(dir, f);
    if (fs.existsSync(full)) {
      const st = fs.statSync(full);
      out.push({ rel: f, dir: false, depth: 0, size: st.size, mtime: st.mtimeMs, text: true });
    }
  }
  const cdir = path.join(dir, '.claude');
  if (fs.existsSync(cdir)) {
    out.push({ rel: '.claude', dir: true, depth: 0 });
    walkFiles(cdir, '.claude', 1, out);
  }
  return { root: dir, items: out, hidden: [] };
}

module.exports = { fileRel, listFiles };
