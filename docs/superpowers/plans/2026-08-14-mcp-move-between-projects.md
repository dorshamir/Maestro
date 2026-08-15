# MCP move-between-projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user move an MCP server's config from one `{scope, dir}` location to
another (any of `user`/`project`/`local`, across projects) from the MCP tab, instead of
hand-editing JSON.

**Architecture:** One new backend function `moveServer(from, to, name)` in `lib/mcp.js`,
exposed as `POST /api/mcp-move`, plus a per-row "Move" control in the MCP tab's existing
render function. Same-file moves (`user`↔`local`, both live in `~/.claude.json`) are one
atomic read-modify-write; anything touching `project` scope (`.mcp.json`, a different
file) writes the target first and only then deletes the source, so a mid-failure leaves
a duplicate rather than losing the config.

**Tech Stack:** Node.js (no new dependencies), the existing `lib/` module style, vanilla
inline JS in `public/index.html`.

**Spec:** `docs/superpowers/specs/2026-08-14-mcp-move-between-projects-design.md`

## Global Constraints

- Move only — no copy mode, no overwrite-on-collision, no rename-during-move, no bulk
  move (see spec's "Out of scope").
- `npm test` must stay green after every task.
- No new npm dependencies; `lib/` files still may not call `setInterval` (this feature
  doesn't need it, but the test suite greps for it across every `lib/` file).
- Every write to `~/.claude.json` goes through `editClaudeJson()` (backup-then-write,
  refuses a document that won't parse); every write to a `.mcp.json` goes through
  `editMcpJson()`. `moveServer` must not bypass either.
- Reuse `projectKey()` for local-scope lookups — do not reimplement Windows/POSIX path
  normalization.
- Errors propagate as thrown `Error`s and become `500 { error: message }` via
  `server.js`'s existing request loop — there is no 400 path in this codebase. Only the
  partial-failure case gets special handling (caught in the route, turned into `200
  { ok: true, partial: true, ... }`).
- **Do not commit anything in this session.** Leave every task's changes as an
  uncommitted diff in the working tree for the user to review. Skip the "Commit" step
  that would otherwise end each task.

---

## File Map

- `lib/mcp.js` — add `claudeJsonSlot()`, `getServerConfig()`, `moveServer()`; refactor
  `saveServer`/`deleteServer`'s `user`/`local` branches onto `claudeJsonSlot()`; export
  `moveServer`.
- `lib/routes.js` — add `POST /api/mcp-move`.
- `public/index.html` — add a "Move" button + inline target-picker panel per server row
  in the `MC` (MCP tab) code; extract `projectOptionsHtml()` out of `fillProjectSelects()`
  so the panel can reuse the same project list.
- `selftest.js` — new `mcp (isolated ~/.claude.json)` test group: a `mcpCall()` helper
  that runs `lib/mcp.js` in a child process with `HOME`/`USERPROFILE` pointed at a temp
  directory (never touches the real `~/.claude.json`), characterization tests for the
  `saveServer`/`deleteServer` refactor, and full coverage of `moveServer`.
- `README.md` — one paragraph in the existing "MCP servers" section.

---

### Task 1: Isolated test harness + `claudeJsonSlot()` refactor

**Files:**
- Modify: `lib/mcp.js` (add `claudeJsonSlot`, rewire `saveServer`/`deleteServer`)
- Modify: `selftest.js` (new test group, added near the end, after the `guardrail hook`
  group and before `request guards`)

**Interfaces:**
- Produces: `claudeJsonSlot(doc, scope, dir, create = true)` → the `mcpServers` object
  for `'user'`/`'local'` scope inside an already-loaded `~/.claude.json` document, or
  `null` when `create` is `false` and the structure doesn't exist yet. Used by Task 2's
  `moveServer` and `getServerConfig`.
- Produces (test-only): `mcpCall(homeDir, fnName, args)` in `selftest.js` — spawns a
  child Node process with `HOME`/`USERPROFILE` set to `homeDir`, calls
  `require('./lib/mcp')[fnName](...args)`, and returns
  `{ ok: true, result }` or `{ ok: false, message, partial, file }`. Reused by Task 2.

Today `saveServer` and `deleteServer` each inline the "walk to `doc.mcpServers` for
`user`, or `doc.projects[projectKey(doc,dir)].mcpServers` for `local`, creating structure
along the way" logic separately. `moveServer` (Task 2) needs that same walk twice inside
one transaction (source and target), so this task pulls it out first — and locks in with
characterization tests that the refactor changes nothing observable, including the
easy-to-get-wrong case: deleting a name that was never configured must stay a pure no-op
and must not leave behind an empty `projects[dir]` scaffold entry.

- [ ] **Step 1: Write the characterization tests against the current (pre-refactor) code**

Add near the end of `selftest.js`, after the `guardrail hook (executed for real)` group
(after the `fs.rmSync(dir, { recursive: true, force: true });` that closes it, before the
`/* -------------------------------------------------------------- security */` comment):

```js
/* ------------------------------------------------------------------ mcp */
group('mcp (isolated ~/.claude.json)');
{
  const { readJsonSafe } = require('./lib/util');
  const keyOf = (dir) => path.resolve(dir).replace(/\\/g, '/');

  // Runs one lib/mcp.js call in a fresh child process with HOME/USERPROFILE
  // pointed at a throwaway directory, so this suite never touches the real
  // ~/.claude.json. lib/mcp.js computes CLAUDE_JSON = path.join(HOME, ...) at
  // require time, so isolation has to happen before that require, in a
  // process of its own - an in-process HOME swap plus a require-cache bust
  // would be fragile and easy to get wrong.
  function mcpCall(homeDir, fnName, args) {
    const mcpPath = path.join(ROOT, 'lib', 'mcp');
    const script = `
      const mcp = require(${JSON.stringify(mcpPath)});
      try {
        const result = mcp[${JSON.stringify(fnName)}](${args.map((a) => JSON.stringify(a)).join(',')});
        process.stdout.write(JSON.stringify({ ok: true, result }));
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, message: err.message, partial: !!err.partial, file: err.file || null }));
      }
    `;
    const r = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    });
    const out = (r.stdout || '').trim();
    if (!out) throw new Error('mcp child produced no output - stderr: ' + r.stderr);
    return JSON.parse(out);
  }

  // user-scope save + delete round trip.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    try {
      let r = mcpCall(home, 'saveServer', ['user', null, 'srv1', { command: 'foo' }]);
      check('user save reports ok', r.ok === true, JSON.stringify(r));
      let doc = readJsonSafe(path.join(home, '.claude.json'));
      check('user save writes mcpServers.srv1',
        !!(doc && doc.mcpServers && doc.mcpServers.srv1 && doc.mcpServers.srv1.command === 'foo'), JSON.stringify(doc));

      r = mcpCall(home, 'deleteServer', ['user', null, 'srv1']);
      check('user delete reports ok', r.ok === true, JSON.stringify(r));
      doc = readJsonSafe(path.join(home, '.claude.json'));
      check('user delete removes srv1', !doc.mcpServers || !doc.mcpServers.srv1, JSON.stringify(doc));
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }

  // local-scope save + delete round trip.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-proj-'));
    try {
      let r = mcpCall(home, 'saveServer', ['local', projA, 'srv1', { command: 'bar' }]);
      check('local save reports ok', r.ok === true, JSON.stringify(r));
      let doc = readJsonSafe(path.join(home, '.claude.json'));
      check('local save writes projects[dir].mcpServers.srv1',
        doc.projects[keyOf(projA)].mcpServers.srv1.command === 'bar', JSON.stringify(doc));

      r = mcpCall(home, 'deleteServer', ['local', projA, 'srv1']);
      check('local delete reports ok', r.ok === true, JSON.stringify(r));
      doc = readJsonSafe(path.join(home, '.claude.json'));
      check('local delete removes srv1', !doc.projects[keyOf(projA)].mcpServers.srv1, JSON.stringify(doc));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(projA, { recursive: true, force: true });
    }
  }

  // Deleting a name that was never configured must be a pure no-op - no
  // ~/.claude.json scaffold left behind for a project that was never touched.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    const projB = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-proj-'));
    try {
      const r = mcpCall(home, 'deleteServer', ['local', projB, 'ghost']);
      check('deleting a never-configured name reports ok', r.ok === true, JSON.stringify(r));
      const doc = readJsonSafe(path.join(home, '.claude.json'));
      check('and leaves no project/mcpServers scaffold behind',
        doc !== null && Object.keys(doc).length === 0, JSON.stringify(doc));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(projB, { recursive: true, force: true });
    }
  }
}
```

- [ ] **Step 2: Run the tests to confirm they pass against the current code**

Run: `npm test`
Expected: the new `mcp (isolated ~/.claude.json)` group's checks all print `ok` — this
task is a refactor, so nothing should be red yet. If any of them fail here, the test
itself is wrong (fix the test, not `lib/mcp.js`) before moving on.

- [ ] **Step 3: Add `claudeJsonSlot()` and rewire `saveServer`/`deleteServer`**

In `lib/mcp.js`, add this function right after `projectKey()` (after line 46, before
`function mcpJsonPath(dir) {`):

```js
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
```

Then replace `saveServer` (lines 162-182 of the original file) with:

```js
function saveServer(scope, dir, name, config) {
  validate(name, config);
  if (scope === 'project') return editMcpJson(dir, (doc) => { doc.mcpServers[name] = config; });
  if (scope === 'user' || scope === 'local') {
    return editClaudeJson((doc) => { claudeJsonSlot(doc, scope, dir)[name] = config; });
  }
  throw new Error('unknown scope');
}
```

And replace `deleteServer` (lines 184-196 of the original file) with:

```js
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
```

- [ ] **Step 4: Run the tests again to confirm the refactor changed nothing observable**

Run: `npm test`
Expected: same result as Step 2 — everything in the `mcp` group still `ok`, and every
other group unaffected (123+ passed, 0 failed).

- [ ] **Step 5: Leave uncommitted**

Do not run `git add`/`git commit`. The diff (`lib/mcp.js`, `selftest.js`) stays in the
working tree for review.

---

### Task 2: `getServerConfig()` and `moveServer()`

**Files:**
- Modify: `lib/mcp.js` (add `getServerConfig`, `moveServer`; export `moveServer`)
- Modify: `selftest.js` (extend the `mcp (isolated ~/.claude.json)` group from Task 1)

**Interfaces:**
- Consumes: `claudeJsonSlot(doc, scope, dir, create)`, `mcpCall(homeDir, fnName, args)`
  from Task 1; `editClaudeJson`, `saveServer`, `deleteServer`, `validate`, `projectKey`,
  `mcpJsonPath`, `readJsonSafe` (already imported in `lib/mcp.js`).
- Produces: `getServerConfig(scope, dir, name)` → the raw config object at that location,
  or `null`. `moveServer(from, to, name)` → the target file path on success; throws
  `Error` on validation failure, or an `Error` with `.partial = true` and `.file = <target
  file path>` when the target write succeeded but the source delete failed.

- [ ] **Step 1: Write the failing tests**

Append to the same `mcp (isolated ~/.claude.json)` group in `selftest.js` (after the
"never-configured name" block from Task 1, still inside that group's `{ ... }`):

```js
  // user -> local: single ~/.claude.json transaction.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-proj-'));
    try {
      mcpCall(home, 'saveServer', ['user', null, 'srv1', { command: 'foo' }]);
      const r = mcpCall(home, 'moveServer', [{ scope: 'user', dir: null }, { scope: 'local', dir: projA }, 'srv1']);
      check('user->local move reports ok', r.ok === true, JSON.stringify(r));
      const doc = readJsonSafe(path.join(home, '.claude.json'));
      check('user->local removes it from user scope', !doc.mcpServers || !doc.mcpServers.srv1, JSON.stringify(doc));
      check('user->local lands it in local scope',
        doc.projects[keyOf(projA)].mcpServers.srv1.command === 'foo', JSON.stringify(doc));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(projA, { recursive: true, force: true });
    }
  }

  // local -> user: same transaction, the other direction.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-proj-'));
    try {
      mcpCall(home, 'saveServer', ['local', projA, 'srv1', { command: 'foo' }]);
      const r = mcpCall(home, 'moveServer', [{ scope: 'local', dir: projA }, { scope: 'user', dir: null }, 'srv1']);
      check('local->user move reports ok', r.ok === true, JSON.stringify(r));
      const doc = readJsonSafe(path.join(home, '.claude.json'));
      check('local->user removes it from local scope', !doc.projects[keyOf(projA)].mcpServers.srv1, JSON.stringify(doc));
      check('local->user lands it in user scope', doc.mcpServers.srv1.command === 'foo', JSON.stringify(doc));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(projA, { recursive: true, force: true });
    }
  }

  // local(A) -> local(B): same file, different project - still one transaction.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-proj-'));
    const projB = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-proj-'));
    try {
      mcpCall(home, 'saveServer', ['local', projA, 'srv1', { command: 'foo' }]);
      const r = mcpCall(home, 'moveServer', [{ scope: 'local', dir: projA }, { scope: 'local', dir: projB }, 'srv1']);
      check('local(A)->local(B) reports ok', r.ok === true, JSON.stringify(r));
      const doc = readJsonSafe(path.join(home, '.claude.json'));
      check('gone from project A', !(doc.projects[keyOf(projA)] && doc.projects[keyOf(projA)].mcpServers.srv1), JSON.stringify(doc));
      check('present in project B', doc.projects[keyOf(projB)].mcpServers.srv1.command === 'foo', JSON.stringify(doc));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(projA, { recursive: true, force: true });
      fs.rmSync(projB, { recursive: true, force: true });
    }
  }

  // project -> local: cross-file, straightforward direction.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-proj-'));
    const projB = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-proj-'));
    try {
      mcpCall(home, 'saveServer', ['project', projA, 'srv1', { command: 'foo' }]);
      const r = mcpCall(home, 'moveServer', [{ scope: 'project', dir: projA }, { scope: 'local', dir: projB }, 'srv1']);
      check('project->local reports ok', r.ok === true, JSON.stringify(r));
      const mcpJson = readJsonSafe(path.join(projA, '.mcp.json'));
      check('gone from source .mcp.json', !(mcpJson && mcpJson.mcpServers && mcpJson.mcpServers.srv1), JSON.stringify(mcpJson));
      const doc = readJsonSafe(path.join(home, '.claude.json'));
      check('present in target local scope', doc.projects[keyOf(projB)].mcpServers.srv1.command === 'foo', JSON.stringify(doc));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(projA, { recursive: true, force: true });
      fs.rmSync(projB, { recursive: true, force: true });
    }
  }

  // local -> project, with the source delete forced to fail: the write to the
  // target must still have happened, and the failure must come back as a
  // partial success (config safe in both places), never a silent loss.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-proj-'));
    const claudeJson = path.join(home, '.claude.json');
    try {
      mcpCall(home, 'saveServer', ['local', projA, 'srv1', { command: 'foo' }]);
      fs.chmodSync(claudeJson, 0o444);
      const r = mcpCall(home, 'moveServer', [{ scope: 'local', dir: projA }, { scope: 'project', dir: projA }, 'srv1']);
      check('local->project reports partial when the source delete fails',
        r.ok === false && r.partial === true, JSON.stringify(r));
      check('partial response names the target file',
        typeof r.file === 'string' && r.file.endsWith('.mcp.json'), JSON.stringify(r));
      const mcpJson = readJsonSafe(path.join(projA, '.mcp.json'));
      check('target write happened despite the later failure', mcpJson.mcpServers.srv1.command === 'foo', JSON.stringify(mcpJson));
      fs.chmodSync(claudeJson, 0o666);
      const doc = readJsonSafe(claudeJson);
      check('source still has it too - nothing was silently lost',
        doc.projects[keyOf(projA)].mcpServers.srv1.command === 'foo', JSON.stringify(doc));
    } finally {
      try { fs.chmodSync(claudeJson, 0o666); } catch { /* already restored */ }
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(projA, { recursive: true, force: true });
    }
  }

  // Collision at the target: refuse, mutate nothing.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-proj-'));
    try {
      mcpCall(home, 'saveServer', ['user', null, 'srv1', { command: 'foo' }]);
      mcpCall(home, 'saveServer', ['local', projA, 'srv1', { command: 'already-here' }]);
      const before = readJsonSafe(path.join(home, '.claude.json'));
      const r = mcpCall(home, 'moveServer', [{ scope: 'user', dir: null }, { scope: 'local', dir: projA }, 'srv1']);
      check('collision reports failure', r.ok === false, JSON.stringify(r));
      check('collision message says already exists', /already exists/.test(r.message), r.message);
      const after = readJsonSafe(path.join(home, '.claude.json'));
      check('neither side was mutated', JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(projA, { recursive: true, force: true });
    }
  }

  // Same location: refuse, mutate nothing.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mcp-'));
    try {
      mcpCall(home, 'saveServer', ['user', null, 'srv1', { command: 'foo' }]);
      const before = readJsonSafe(path.join(home, '.claude.json'));
      const r = mcpCall(home, 'moveServer', [{ scope: 'user', dir: null }, { scope: 'user', dir: null }, 'srv1']);
      check('same-location reports failure', r.ok === false, JSON.stringify(r));
      check('same-location message says so', /same/.test(r.message), r.message);
      const after = readJsonSafe(path.join(home, '.claude.json'));
      check('doc untouched', JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }));
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `mcp.moveServer is not a function` (or `TypeError`) surfacing inside the
`mcpCall` results, since `moveServer` doesn't exist yet.

- [ ] **Step 3: Implement `getServerConfig()` and `moveServer()`**

In `lib/mcp.js`, add both functions right after `deleteServer` (before the `setApproval`
function):

```js
// Read-only counterpart to saveServer/deleteServer's scope dispatch - what is
// on disk right now for one (scope, dir, name), or null. Used by moveServer to
// read the source and to check for a name collision at the target.
function getServerConfig(scope, dir, name) {
  if (scope === 'project') {
    const doc = readJsonSafe(mcpJsonPath(dir));
    return (doc && doc.mcpServers && doc.mcpServers[name]) || null;
  }
  if (scope === 'user' || scope === 'local') {
    const doc = readJsonSafe(CLAUDE_JSON);
    if (!doc) return null;
    const slot = claudeJsonSlot(doc, scope, dir, false);
    return (slot && slot[name]) || null;
  }
  throw new Error('unknown scope');
}

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
  if (to.scope !== 'user' && !(to.dir && path.isAbsolute(to.dir))) {
    throw new Error('target project required for that scope');
  }
  const cfg = getServerConfig(from.scope, from.dir, name);
  if (!cfg) throw new Error(`"${name}" was not found in the source scope - it may have changed on disk`);
  if (getServerConfig(to.scope, to.dir, name)) {
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
```

Then update the exports at the bottom of the file:

```js
module.exports = { listMcp, saveServer, deleteServer, moveServer, setApproval, CLAUDE_JSON };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: every check in the `mcp (isolated ~/.claude.json)` group passes; 130+ passed,
0 failed overall (exact count depends on Task 1's tally).

- [ ] **Step 5: Leave uncommitted**

Do not run `git add`/`git commit`.

---

### Task 3: `POST /api/mcp-move` route

**Files:**
- Modify: `lib/routes.js`

**Interfaces:**
- Consumes: `moveServer(from, to, name)` from Task 2, `log`, `send`, `readBody` (already
  imported in `lib/routes.js`).
- Produces: route `POST /api/mcp-move`, body `{ from: {scope, dir}, to: {scope, dir},
  name }`, response `{ ok: true, file }` or `{ ok: true, partial: true, file, warning }`.

- [ ] **Step 1: Add the import**

In `lib/routes.js`, change line 32 from:

```js
const { listMcp, saveServer, deleteServer, setApproval } = require('./mcp');
```

to:

```js
const { listMcp, saveServer, deleteServer, moveServer, setApproval } = require('./mcp');
```

- [ ] **Step 2: Add the route**

In `lib/routes.js`, add this route right after the existing `'DELETE /api/mcp'` handler
(after its closing `},` around line 319, before the `mcp-approval` route):

```js
  // Move, not copy - see lib/mcp.js's moveServer() for why the two scopes
  // inside ~/.claude.json get one atomic transaction while anything crossing
  // into/out of .mcp.json does not. A "partial" error means the config landed
  // at the target but could not be removed from the source, which this
  // reports as a 200-with-warning rather than a hard failure: the data is
  // safe, just duplicated, and the UI should say so plainly rather than
  // implying the move failed outright.
  'POST /api/mcp-move': async (req, res) => {
    const b = JSON.parse(await readBody(req) || '{}');
    try {
      const file = moveServer(b.from, b.to, b.name);
      log('mcp move', JSON.stringify({ from: b.from, to: b.to, name: b.name, file }));
      return send(res, 200, { ok: true, file });
    } catch (err) {
      if (!err.partial) throw err;
      log('mcp move partial', JSON.stringify({ from: b.from, to: b.to, name: b.name, file: err.file }));
      return send(res, 200, { ok: true, partial: true, file: err.file, warning: err.message });
    }
  },
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: `route table` group's checks still pass (route key matches the `METHOD /path`
format, handler is a function), and everything else unaffected.

- [ ] **Step 4: Manual smoke test**

Run: `node server.js` (or `npm start`), open the MCP tab, and with the dev tools console
open, run:

```js
fetch('/api/mcp-move', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ from: { scope: 'user', dir: null }, to: { scope: 'user', dir: null }, name: 'nonexistent' }) })
  .then((r) => r.json()).then(console.log)
```

Expected: `{ error: "source and target are the same" }` — confirms the route is wired
and reachable before the UI in Task 4 depends on it. Stop the server after.

- [ ] **Step 5: Leave uncommitted**

Do not run `git add`/`git commit`.

---

### Task 4: MCP tab UI — Move button and target picker

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `POST /api/mcp-move` from Task 3; existing `MC` state object, `esc()`,
  `toast()`, `api()`, `$()` helpers; `S.meta.projects` (already loaded by `loadMeta()`).
- Produces: `projectOptionsHtml()`, extracted from `fillProjectSelects()` so the new
  per-row target-project `<select>` can reuse the exact same project list rendering.

- [ ] **Step 1: Extract `projectOptionsHtml()`**

In `public/index.html`, replace the `fillProjectSelects` function (around line 826-835):

```js
function fillProjectSelects() {
  const opts = S.meta.projects.map((p) =>
    `<option value="${esc(p.path)}"${p.exists ? '' : ' disabled'}>${esc(p.path)}${p.exists ? '' : '  (missing)'}</option>`).join('');
  $('#projsel').innerHTML = '<option value="">- choose project -</option>' + opts;
  $('#effsel').innerHTML = '<option value="">- choose project -</option>' + opts;
  $('#gprojsel').innerHTML = '<option value="">- choose project -</option>' + opts;
  $('#lprojsel').innerHTML = '<option value="">- choose project -</option>' + opts;
  $('#fprojsel').innerHTML = '<option value="">- choose project -</option>' + opts;
  $('#mprojsel').innerHTML = '<option value="">- choose project (for .mcp.json and local servers) -</option>' + opts;
}
```

with:

```js
function projectOptionsHtml() {
  return S.meta.projects.map((p) =>
    `<option value="${esc(p.path)}"${p.exists ? '' : ' disabled'}>${esc(p.path)}${p.exists ? '' : '  (missing)'}</option>`).join('');
}
function fillProjectSelects() {
  const opts = projectOptionsHtml();
  $('#projsel').innerHTML = '<option value="">- choose project -</option>' + opts;
  $('#effsel').innerHTML = '<option value="">- choose project -</option>' + opts;
  $('#gprojsel').innerHTML = '<option value="">- choose project -</option>' + opts;
  $('#lprojsel').innerHTML = '<option value="">- choose project -</option>' + opts;
  $('#fprojsel').innerHTML = '<option value="">- choose project -</option>' + opts;
  $('#mprojsel').innerHTML = '<option value="">- choose project (for .mcp.json and local servers) -</option>' + opts;
}
```

- [ ] **Step 2: Add the Move button and inline panel to each row**

In `public/index.html`'s `renderMcp()` function, replace the per-row template (the `rows`
map inside `j.scopes.map(...)`, currently ending in the `Remove` button):

```js
      return `
        <div class="mcp-row">
          <div class="mcp-main">
            <span class="mcp-name">${esc(s.name)}</span>
            <span class="badge">${esc(s.kind)}</span>
            ${s.envKeys.length ? `<span class="badge" title="Values are not shown here - edit the file directly to see them">env: ${esc(s.envKeys.join(', '))}</span>` : ''}
            ${s.approval === 'pending' ? '<span class="badge" style="color:var(--brass);border-color:var(--brass)" title="Configured but not yet approved, so Claude Code will not start it">not started</span>' : ''}
          </div>
          <div class="mcp-detail">${esc(s.detail) || '<span style="color:var(--faint)">no command or url recorded</span>'}</div>
          <div class="mcp-acts">${appr}
            <button class="btn sm" data-mcp-move-toggle="${esc(s.name)}" data-scope="${esc(sc.scope)}">Move</button>
            <button class="btn sm danger" data-mcp-del="${esc(s.name)}" data-scope="${esc(sc.scope)}">Remove</button>
          </div>
          <div class="mcp-move-panel hidden">
            <select class="mcp-move-toscope" aria-label="Target scope for ${esc(s.name)}">
              <option value="user">User - every project</option>
              <option value="project">Project - .mcp.json, shared with the repo</option>
              <option value="local">Local - this project, this machine only</option>
            </select>
            <select class="mcp-move-todir hidden" aria-label="Target project for ${esc(s.name)}">
              <option value="">- choose project -</option>${projectOptionsHtml()}
            </select>
            <button class="btn sm amber" data-mcp-move-confirm="${esc(s.name)}" data-scope="${esc(sc.scope)}" data-env="${s.envKeys.length ? '1' : '0'}">Confirm move</button>
            <button class="btn sm" data-mcp-move-cancel="1">Cancel</button>
          </div>
        </div>`;
```

- [ ] **Step 3: Add the CSS for the panel**

In the `<style>` block, right after the existing `.mcp-acts` rule (the one ending
`@media (max-width:620px){.mcp-row{grid-template-columns:1fr}.mcp-acts{grid-row:auto;grid-column:1/2}}`),
add:

```css
.mcp-move-panel{grid-column:1/3;display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap;margin-top:var(--sp-2)}
```

- [ ] **Step 4: Wire up the toggle/cancel/confirm handlers**

In `public/index.html`, replace the existing `$('#mcplist').addEventListener('click', ...)`
block (the one handling `data-mcp-del`) with:

```js
$('#mcplist').addEventListener('click', async (e) => {
  const toggle = e.target.closest('[data-mcp-move-toggle]');
  if (toggle) {
    const panel = toggle.closest('.mcp-row').querySelector('.mcp-move-panel');
    const wasOpen = !panel.classList.contains('hidden');
    // Only one panel open at a time - close every other one first.
    $('#mcplist').querySelectorAll('.mcp-move-panel').forEach((p) => p.classList.add('hidden'));
    panel.classList.toggle('hidden', wasOpen);
    return;
  }
  const cancel = e.target.closest('[data-mcp-move-cancel]');
  if (cancel) { cancel.closest('.mcp-move-panel').classList.add('hidden'); return; }

  const confirmMove = e.target.closest('[data-mcp-move-confirm]');
  if (confirmMove) {
    const panel = confirmMove.closest('.mcp-move-panel');
    const name = confirmMove.dataset.mcpMoveConfirm;
    const fromScope = confirmMove.dataset.scope;
    const toScope = panel.querySelector('.mcp-move-toscope').value;
    const toDir = toScope === 'user' ? '' : panel.querySelector('.mcp-move-todir').value;
    if (toScope !== 'user' && !toDir) return toast('Choose a target project first', 'err');
    if (confirmMove.dataset.env === '1' && toScope === 'project') {
      const ok = confirm(`This server has env values. Moving it into .mcp.json checks those into git and shares them with anyone who clones the project. Continue?`);
      if (!ok) return;
    }
    try {
      const j = await api('/api/mcp-move', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: { scope: fromScope, dir: MC.dir }, to: { scope: toScope, dir: toDir }, name }) });
      if (j.partial) toast(j.warning, 'err');
      else toast(`${name} moved${toScope === 'project' ? ' - pending approval in the target project before Claude Code will start it' : ''}`);
      await loadMcp();
    } catch (err) { toast(err.message, 'err'); }
    return;
  }

  const del = e.target.closest('[data-mcp-del]');
  if (!del) return;
  const name = del.dataset.mcpDel;
  if (!confirm(`Remove the MCP server "${name}" from ${del.dataset.scope} scope?`)) return;
  try {
    await api('/api/mcp', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: del.dataset.scope, dir: MC.dir, name }) });
    toast(`${name} removed`);
    await loadMcp();
  } catch (err) { toast(err.message, 'err'); }
});
```

Then add a small `change` handler for the target-scope select, right after the existing
`$('#mcplist').addEventListener('change', ...)` block (the one handling `.mcp-appr`) —
extend that same listener rather than adding a second one:

```js
$('#mcplist').addEventListener('change', async (e) => {
  const toscope = e.target.closest('.mcp-move-toscope');
  if (toscope) {
    toscope.closest('.mcp-move-panel').querySelector('.mcp-move-todir').classList.toggle('hidden', toscope.value === 'user');
    return;
  }
  const sel = e.target.closest('.mcp-appr');
  if (!sel) return;
  try {
    await api('/api/mcp-approval', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: MC.dir, name: sel.dataset.name, approval: sel.value }) });
    toast(`${sel.dataset.name}: ${sel.value === 'enabled' ? 'approved' : sel.value === 'disabled' ? 'blocked' : 'left undecided'}`);
    await loadMcp();
  } catch (err) { toast(err.message, 'err'); }
});
```

- [ ] **Step 5: Run the static checks**

Run: `npm test`
Expected: `UI wiring` group still passes (every `$('#id')` resolves, since this task adds
no new `id`-based lookups — the new controls are matched by class/data-attribute through
delegation) and `index.html inline script parses`.

- [ ] **Step 6: Manual browser test**

Run: `node server.js`, open the MCP tab.
1. Add a test server in `user` scope (name `movetest`, command `echo`).
2. Click its `Move` button - the panel should expand under that row, with only that
   panel open.
3. Click `Move` on a different row - the first panel should close.
4. Reopen `movetest`'s panel, pick target scope `local`, choose a project, click
   `Confirm move` - it should disappear from `user` scope and appear under `local` for
   that project.
5. Add another server with an `env` value in some scope, try moving it to `project`
   scope - a confirm() dialog about secrets should appear before the request fires;
   cancelling it must leave the server untouched.
6. Try moving a server to a scope/project where a same-named server already exists -
   expect an error toast, no change to either side.

- [ ] **Step 7: Leave uncommitted**

Do not run `git add`/`git commit`.

---

### Task 5: README + final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the feature**

In `README.md`'s "MCP servers" section, after the existing paragraph ending "...and lets
you change it, because "configured" and "will actually start" are different questions
and the file alone answers only one." (before the "Two of those scopes live inside..."
paragraph), add:

```markdown
Each row also has a **Move** button to relocate a server to a different scope or a
different project entirely - user, project, or local, picked from the same list of
known projects the rest of Maestro uses. Moving a server that has `env` values into
`.mcp.json` warns first, since that file is typically checked into git. A server moved
into project scope lands **pending** approval, same as one added there directly.
```

- [ ] **Step 2: Run the full test suite one final time**

Run: `npm test`
Expected: all groups pass, 0 failed, no change in behavior for anything except the new
`mcp (isolated ~/.claude.json)` group and the route/UI-wiring checks that now also cover
`/api/mcp-move`.

- [ ] **Step 3: Leave uncommitted**

Do not run `git add`/`git commit`. At this point the working tree has the full feature
(`lib/mcp.js`, `lib/routes.js`, `public/index.html`, `selftest.js`, `README.md`) plus the
still-uncommitted pricing fixes from the prior session, ready for the user to review as a
whole.
