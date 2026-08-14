# MCP move-between-projects — design

Status: approved for planning
Date: 2026-08-14

## Problem

Maestro's MCP tab (`lib/mcp.js` + the `MC` code in `public/index.html`) can add, remove,
and approve MCP servers, but moving one from where it's currently configured (e.g. a
project's local scope) to a *different* project, or to a different scope, means the user
hand-copies the JSON. This adds that as a first-class operation.

## Scope

- **Move only.** No copy mode in v1 — a user who wants a copy can re-add manually. Keeps
  the write/delete transaction and the UI to one control instead of two.
- Three scopes carry over unchanged from the existing model: `user` (`~/.claude.json`
  `mcpServers`), `project` (`<dir>/.mcp.json`, shared/checked in), `local`
  (`~/.claude.json` `projects[dir].mcpServers`, this machine only).
- A move is between two `{scope, dir}` locations (`dir` meaningless for `user`). Either
  side of the pair can be any scope, including project→project (different repos),
  local→local (different projects), or crossing scopes on the same project.

## Data model / backend (`lib/mcp.js`)

### Reading the source: `getServerConfig(scope, dir, name)`

A read-only counterpart to `saveServer`/`deleteServer`'s scope dispatch: loads the
relevant file with the existing `readJsonSafe()`, walks to the right `mcpServers` object
(`projectKey()` for `local`), and returns the raw config or `null`. Used to fetch the
config being moved and to check for a collision at the target.

### Shared doc-navigation: `claudeJsonSlot(doc, scope, dir)`

`saveServer`, `deleteServer`, and the new same-file move path all need "the
`mcpServers` object inside this already-loaded `~/.claude.json` doc for `user` or
`local` scope, creating structure as needed." Today `saveServer`/`deleteServer`
duplicate that walk inline for each scope; this extracts it once so the move
transaction (which needs to touch *two* slots in one document) doesn't triplicate the
logic a third time. `saveServer`/`deleteServer` are refactored to call it for their
`user`/`local` branches; their `project` branch is unchanged (different file, goes
through `editMcpJson`).

### `moveServer(from, to, name)`

`from`/`to` are `{scope, dir}`. Steps:

1. Reject if `from` and `to` name the same location (same scope, and same resolved
   `dir` when the scope takes one) — `"source and target are the same"`.
2. Reject if `to.scope !== 'user'` and `to.dir` is missing/not absolute —
   `"target project required for that scope"`.
3. `cfg = getServerConfig(from.scope, from.dir, name)`; reject if not found — the row
   the UI is acting on should always exist, but the file may have changed on disk since
   the page last loaded it.
4. Reject if `getServerConfig(to.scope, to.dir, name)` already returns something —
   `'"<name>" already exists in <to.scope> scope - remove or rename it there first'`.
   No overwrite path in v1.
5. `validate(name, cfg)` — same validation `saveServer` already applies, run here too so
   a move can't smuggle through something that would fail on direct add.
6. **Both endpoints are `user` or `local` (same physical file, `~/.claude.json`):** one
   `editClaudeJson()` transaction — `delete claudeJsonSlot(doc, from)[name]` then
   `claudeJsonSlot(doc, to)[name] = cfg`, single `fs.writeFileSync`, backup rotated once.
   Genuinely atomic: either both sides happen or (on a read/parse failure before the
   callback ever runs) neither does.
7. **Either endpoint is `project` scope (`.mcp.json`, a different file):** not atomic
   across two files by construction. Write the target first —
   `saveServer(to.scope, to.dir, name, cfg)` — then `deleteServer(from.scope, from.dir,
   name)`. If the write throws, nothing has changed at the source; the server config
   never existed only-nowhere. If the *delete* throws after a successful write, catch it,
   tag the error `partial = true` and `file = <target file>`, and rethrow — the route
   layer turns that into a 200-with-warning instead of a 500, because from the data's
   perspective this is a success with visible leftover state, not a failure.

Exported alongside the existing four: `moveServer`.

### Route (`lib/routes.js`)

```
POST /api/mcp-move   body: { from: {scope, dir}, to: {scope, dir}, name }
```

Mirrors the existing `PUT`/`DELETE /api/mcp` handlers: parse body, call `moveServer`,
log `mcp move`. On a thrown error with `.partial`, catch it and respond `200 { ok: true,
partial: true, file, warning: err.message }` instead of letting it propagate. Any other
thrown error (collision, same-location, validation) is left to propagate - `server.js`'s
request loop already turns any thrown `Error` into `500 { error: err.message }`, exactly
like every other mutation route (there is no 400 path anywhere in this codebase). The
frontend's `api()` helper reads `.message` off the thrown error the same way regardless
of status code, so no special-casing is needed for the error side.

## UI (`public/index.html`, the `MC` code + MCP tab)

- Each server row (`.mcp-row`, built in `renderMcp()`) gets a `Move` button next to the
  existing `Remove` button: `<button class="btn sm" data-mcp-move="${esc(s.name)}"
  data-scope="${esc(sc.scope)}">Move</button>`.
- Clicking it toggles an inline panel appended right after that row (plain DOM
  show/hide, consistent with the rest of the page — no modal system exists here and
  this doesn't need one). The panel has:
  - a target-scope `<select>`: `user` / `project` / `local`
  - a target-project `<select>`, populated from `S.meta.projects` (the same list every
    other project picker in the page already uses), hidden/disabled when target scope
    is `user`
  - `Confirm move` and `Cancel` buttons
- Only one panel open at a time — opening a second closes the first (same interaction
  weight as the rest of the tab; avoids stacked half-finished forms).
- On `Confirm move`:
  - if `s.envKeys.length && targetScope === 'project'`, show a `confirm()`:
    `` `This server has env values (${envKeys.join(', ')}). Moving it into .mcp.json
    checks those into git and shares them with anyone who clones the project.
    Continue?` `` — cancel aborts before any request fires.
  - `POST /api/mcp-move` with `{ from: { scope: sc.scope, dir: MC.dir }, to: { scope:
    targetScope, dir: targetScope === 'user' ? '' : targetDir }, name: s.name }`.
  - success: toast. If `to.scope === 'project'`, the toast says the server lands
    **pending** approval in the target project and won't start until approved there
    (mirrors the existing "not started" badge language) rather than implying it's
    immediately active.
  - `partial: true` response: a distinct warning toast — config is now in both places,
    telling the user the source copy needs manual removal and why (the message from the
    server already says why).
  - ordinary error: toast `err.message` (collision / same-location / validation
    messages are already human-readable from the backend).
  - `loadMcp()` refreshes afterward either way, so the source row reflects the current
    on-disk state.

No change to `GET /api/mcp`'s response shape — the target-project list comes from
`S.meta.projects`, already loaded for every other picker on the page.

## Error handling summary

| Condition | Response |
|---|---|
| source === target location | 500 `{error}`, no write attempted |
| target missing/relative dir for non-user scope | 500 `{error}`, no write attempted |
| source server not found (stale UI state) | 500 `{error}`, no write attempted |
| name collision at target | 500 `{error}`, no write attempted |
| write to target fails (bad JSON, permissions) | 500 `{error}` from the existing `editClaudeJson`/`editMcpJson` error paths, no write attempted, source untouched |
| write to target succeeds, delete from source fails | 200 with `partial: true` — never reported as a hard failure, because the data is safe, just duplicated |

(500 here matches every other mutation route in this codebase — there is no 400 path;
see the Route section above.)

## Testing

`selftest.js` gets cases for `moveServer()` directly (no server needed, matching how the
rest of the suite exercises `lib/` modules):
- user→local and local→user via the single-transaction path — assert one file write,
  both slots correct afterward.
- local(project A)→local(project B) — same-file, different `dir` — the case the atomic
  transaction exists for.
- local→project and project→local — assert two operations, target written even if the
  test forces a delete failure (stub or a second call proving the config still exists at
  target).
- collision at target — assert no mutation of either file.
- same-location — assert no mutation.
- env-keys-into-project is a UI-only warning (`confirm()`), not a backend rule — no
  backend test needed for it, but note it here so the boundary is explicit and doesn't
  drift into "should the server also block this" later.

`npm test` must stay green; this feature does not touch any of the invariants the test
suite greps for (no `setInterval`, no `__dirname`, no `shell: true`, etc.) since it's
pure `lib/mcp.js` + `lib/routes.js` + inline-script additions.

## Out of scope (this pass)

- Copy mode (explicitly deferred, see Scope).
- Overwrite-on-collision.
- Bulk/multi-server move.
- Renaming during a move (name is fixed; a rename is a separate delete+add the user can
  already do).
