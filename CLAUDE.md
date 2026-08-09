# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
node server.js          # or: npm start   → http://localhost:4144
MAESTRO_PORT=4145 node server.js          # port 4144 taken
npm test                # static checks + a real run of the guardrail hook; no server needed
npm run build:icon      # assets/maestro.svg → maestro.ico + PWA PNGs (Node zlib only)
npm run build:exe       # tools/Launcher.cs → Maestro.exe (Windows csc.exe; no SDK)
```

`selftest.js` takes no filter flag — the whole suite runs in a couple of seconds and needs no
server. To exercise one module in isolation, `require` it directly (`node -e "..."`); that is
safe precisely because lib modules have no side effects at require time (see below).

Do not open `public/index.html` as a file:// URL — the page detects it and shows a "needs its
server" panel instead of failing per-panel.

## Architecture

A zero-dependency local web app that manages everything Claude Code reads from disk. It never
embeds the CLI: it launches the user's real terminal instead (see "Why there is no terminal
inside Maestro" in README.md — that boundary is deliberate and keeps the install dependency-free).

- **`server.js` is the entry point and nothing else**: process handlers, the request loop,
  `listen()`. All work lives in `lib/`.
- **`lib/routes.js`** is a flat table keyed `"METHOD /path"` → handler. Adding an endpoint means
  adding a key here; nothing else registers routes.
- **`public/index.html` is the entire frontend** — one ~100 KB file, inline `<script>`, no build
  step, no framework. Per-view state lives in plain objects near each view's code: `S` (sessions +
  settings), `G` (guardrails), `L` (library), `F` (files). Views are shown/hidden by `showView()`.

Data flow for the main feature: `sessions.js` walks `~/.claude/projects/<encoded-path>/<id>.jsonl`,
takes the real working directory from the `cwd` field *inside* each transcript (the encoded folder
name is ambiguous), and rolls up cost via `pricing.js`. `digests.js` derives the per-session "what
happened" line and caches it by `(mtime, size)` in `~/.claude/.maestro-digests.json`. `launch.js`
builds the `claude --resume <id>` argv and opens a terminal in the original folder.

State Maestro writes outside the repo, all under `~/.claude/`: `.maestro-digests.json` (cache),
`.maestro-overrides.json` (pins, custom names, archived flags), `.maestro.log`, and
`*.maestro-bak.*` copies next to any settings/library file it overwrites (last 3 kept).

## Invariants `npm test` enforces

These are all regressions that shipped once. The tests grep `server.js` **and every `lib/` file**,
so moving code between modules will not quiet them.

- **No side effects at require time.** Everything that *runs* — process handlers, `pruneDigests()`,
  `listen()` — stays in `server.js`. `selftest.js` requires lib modules directly; a module that
  starts work on require makes the suite hang or open a port.
- **Bundled files resolve from `ROOT`, never `__dirname`.** Handlers live in `lib/`, so
  `__dirname` silently 404s the whole UI. The test invokes `GET /` and the icon route against a
  stub response rather than grepping for the mistake.
- **No `shell: true` spawn, no synchronous `exec`, loopback bind only.** `shell: true` +
  `detached: true` on Windows tied the server's life to the launched terminal; a sync exec froze
  the event loop behind a macOS permission prompt.
- **`keepAliveTimeout` ≥ 60s and `headersTimeout` above it.** Node's 5s default closes sockets the
  browser is still reusing — the symptom is "Failed to fetch" after any pause.
- **Zero dependencies**, `bin` still points at `./server.js`, `files` still lists `lib`.
- **UI wiring**: every `$('#id')` in the page must match a real element (one dead selector once
  threw at startup and silently stopped every listener below it from attaching), every `role="tab"`
  needs its panel, the inline script must parse, and every `/api/...` path the page fetches must
  exist in the route table — a dead endpoint is a dead button.

## Security model (all of it is load-bearing)

Binding to `127.0.0.1` is not a boundary: the browser on this machine can be aimed at the port by
any page the user visits. `lib/http-guard.js` therefore refuses requests whose `Host` is not a
loopback name (DNS rebinding), refuses cross-origin/cross-site requests, and requires mutations to
declare `Content-Type: application/json` — which forces a preflight an attacker's page cannot
satisfy. Without that last rule a `text/plain` POST could write a `PreToolUse` hook into
`settings.json`, i.e. arbitrary code execution on the next Claude Code run.

Every file endpoint resolves through `safeJoin()`, which rejects anything escaping its root.
`.credentials.json` and `.maestro-bak.*` are blocked by name; user scope hides system-managed dirs
(`USER_SKIP` in `files.js`); project scope covers only `.claude/`, `CLAUDE.md`, `CLAUDE.local.md`
and `.mcp.json`. Terminal launches pass argv arrays — never a shell string — with session ids,
permission modes and model names checked against allowlists and shell metacharacters rejected in
extra flags. There is no authentication, by design; anything running as this user can talk to the
server while it is up.

## Conventions

- Comments explain *why*, usually naming the bug that motivated the code. Match that register —
  a comment restating the line adds nothing here.
- Transcript parsing is defensive by contract: session file formats are internal to Claude Code and
  change between versions, so the parser degrades to filename + timestamps rather than throwing.
- Caches and backups are best-effort — wrap them so they can never take a request down.
- Token accounting dedups by API response, not by line: one response is written across several
  content-block lines and counting per line roughly doubles every total.
- Non-Claude model ids must stay *unpriced* rather than inheriting a Claude rate; unknown Claude
  ids resolve by family prefix so future models still price themselves.
- `npm test` must pass before anything ships; the guardrail hook in `guardrails.js` is a template
  literal carrying three levels of escaping, so it is executed for real against crafted
  `PreToolUse` events — eyeballing it is not a test.
