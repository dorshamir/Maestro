/*
 * The library: commands, agents and skills as files under ~/.claude or a
 * project's .claude, listed and edited in place.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { CLAUDE_DIR } = require('./constants');
const { safeJoin } = require('./util');

const ASSET_KINDS = { commands: 'commands', agents: 'agents', skills: 'skills' };

function assetRoot(kind, scope, dir) {
  if (!ASSET_KINDS[kind]) throw new Error('unknown asset kind');
  if (scope === 'user') return path.join(CLAUDE_DIR, kind);
  if (scope === 'project') {
    if (!dir || !path.isAbsolute(dir)) throw new Error('project directory required');
    return path.join(dir, '.claude', kind);
  }
  throw new Error('scope must be user or project');
}

function frontmatterMeta(file) {
  // Pull description out of YAML frontmatter without a YAML parser.
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 2048);
    const m = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (m) {
      const d = m[1].match(/^description:\s*(.+)$/m);
      if (d) return d[1].trim().replace(/^["']|["']$/g, '').slice(0, 160);
    }
  } catch { /* ignore */ }
  return null;
}

function walkMd(root, base) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkMd(full, rel));
    else if (e.name.endsWith('.md')) {
      const st = fs.statSync(full);
      out.push({ rel, mtime: st.mtimeMs, size: st.size, description: frontmatterMeta(full) });
    }
  }
  return out;
}

function listAssets(kind, scope, dir) {
  const root = assetRoot(kind, scope, dir);
  if (kind === 'skills') {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { root, items: [] }; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skillMd = path.join(root, e.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const st = fs.statSync(skillMd);
      const extras = fs.readdirSync(path.join(root, e.name)).filter((f) => f !== 'SKILL.md').length;
      out.push({ rel: e.name, mtime: st.mtimeMs, size: st.size, description: frontmatterMeta(skillMd), extras });
    }
    return { root, items: out.sort((a, b) => a.rel.localeCompare(b.rel)) };
  }
  return { root, items: walkMd(root, '').sort((a, b) => a.rel.localeCompare(b.rel)) };
}

function assetFile(kind, scope, dir, rel) {
  const root = assetRoot(kind, scope, dir);
  if (!rel || rel.includes('..')) throw new Error('invalid path');
  if (kind === 'skills') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rel)) throw new Error('skill name: letters, digits, dots, dashes only');
    return safeJoin(root, path.join(rel, 'SKILL.md'));
  }
  if (!rel.endsWith('.md')) rel += '.md';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*\.md$/.test(rel)) throw new Error('file name: letters, digits, dots, dashes, subfolders only');
  return safeJoin(root, rel);
}

const ASSET_TEMPLATES = {
  commands: (name) => `---\ndescription: What /${name} does (shown in the slash menu)\nargument-hint: "[arguments]"\n---\n\nYour prompt here. $ARGUMENTS is replaced with whatever follows the command.\n`,
  agents: (name) => `---\nname: ${name}\ndescription: When Claude should delegate to this agent\ntools: Read, Grep, Glob\n---\n\nYou are the ${name} agent. System prompt goes here.\n`,
  skills: (name) => `---\nname: ${name}\ndescription: When Claude should reach for this skill - be specific, this line triggers it\n---\n\nInstructions Claude loads when the skill triggers.\n`,
};

/* ------------------------------------------- session -> playbook extraction */
/*
 * Turns a session's own tool-call sequence into a scaffolded Library
 * command - the missing bridge between "a session that worked" and "a
 * reusable asset." No LLM call to generalize it: this is a literal replay
 * of what ran, in order, which is why it is offered as a "playbook" to
 * review and edit, not a finished skill. Pure over the transcript's raw
 * text, not a file path, so the route can reuse transcripts.js's existing
 * path-containment check (readTranscript) rather than a second one here.
 */
const PLAYBOOK_MAX_STEPS = 60;

function extractPlaybook(raw) {
  const steps = [];
  for (const line of String(raw || '').split('\n')) {
    if (steps.length >= PLAYBOOK_MAX_STEPS) break;
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.isMeta || o.type !== 'assistant') continue;
    const content = o.message && o.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (steps.length >= PLAYBOOK_MAX_STEPS) break;
      if (!b || b.type !== 'tool_use') continue;
      const input = b.input || {};
      let step = null;
      if ((b.name === 'Bash' || b.name === 'PowerShell') && input.command) {
        step = { kind: 'command', text: String(input.command) };
      } else if (['Write', 'Edit', 'MultiEdit'].includes(b.name) && input.file_path) {
        step = { kind: 'file', text: String(input.file_path) };
      }
      if (!step) continue;
      // Iterative work re-touches the same file or reruns the same command
      // several times in a row - collapse those into one step so the
      // playbook reads as a procedure, not a literal transcript.
      const last = steps[steps.length - 1];
      if (last && last.kind === step.kind && last.text === step.text) continue;
      steps.push(step);
    }
  }
  return steps;
}

function playbookMarkdown(steps, opts = {}) {
  const title = opts.title || 'Extracted playbook';
  const lines = [
    '---',
    'description: Playbook extracted from a Claude Code session - review before reuse',
    'argument-hint: ""',
    '---',
    '',
    `# ${title}`,
    '',
    "_Extracted automatically from a session's own tool calls, in the order they ran. " +
      'This is a literal record of what happened, not an AI-generalized skill - edit it ' +
      'before treating it as a repeatable procedure._',
    '',
  ];
  if (!steps.length) {
    lines.push('_No commands or file edits were found in this session._');
  } else {
    steps.forEach((s, i) => {
      lines.push(`${i + 1}. ${s.kind === 'command' ? `Run: \`${s.text}\`` : `Edit: \`${s.text}\``}`);
    });
  }
  return lines.join('\n') + '\n';
}

module.exports = { ASSET_TEMPLATES, assetFile, listAssets, extractPlaybook, playbookMarkdown };
