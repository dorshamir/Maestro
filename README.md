# Maestro 𝄆

A local control panel for Claude Code. One small web UI, two jobs:

1. **Sessions** - every past Claude Code session on your machine, grouped by the *real* project folder it ran in. One click opens a terminal **in that folder** and runs `claude --resume <session-id>`. No more hunting for "which directory was that session in?"
2. **Settings** - edit `settings.json` at all three scopes (User `~/.claude/settings.json`, Project `.claude/settings.json`, Local `.claude/settings.local.json`) with structured editors for **permissions (allow / ask / deny)**, **hooks**, and **env vars**, plus a raw JSON tab for everything else. An **Effective config** view shows the merged result with per-key provenance (which scope each value came from).

Zero npm dependencies. Binds to `127.0.0.1` only. Nothing leaves your machine.

## Running it

> **Do not open `public/index.html` directly.** It needs the local server that reads your
> sessions and settings; opened as a file it reports "Failed to fetch" on every panel.

```bash
node server.js          # or: npm start
```

It prints an address - `http://localhost:4144` by default - and opens your browser there.
If the port is taken: `MAESTRO_PORT=4145 node server.js`.

**On Windows, double-click `Maestro.exe` instead.** It starts the server with no
console window, waits for it to answer, and opens the UI in app mode - no address
bar, no tab strip, and a **Quit** button in the header to stop the server at once
(there is no terminal to Ctrl+C). Closing the window stops it too.
macOS/Linux run **`./start.sh`**.

**On a managed work machine, use `start.cmd` and delete `Maestro.exe`.** Corporate
antivirus and EDR quarantine `Maestro.exe` on sight, and they are not wrong to: it
is an unsigned binary, compiled locally, that spawns a hidden process - the exact
shape of a dropper. Nothing about that can be argued with heuristically, so the fix
is not to need it. If you would rather keep the exe, the only real options are an
IT allowlist entry (by SHA-256, which changes on every rebuild, or by path) or a
code-signing certificate - both are their call, not yours.

`start.cmd` does everything the exe did, minus the binary: it starts the server
with no window, waits for it to answer, opens the UI in app mode (Chrome first,
then Edge, else your default browser as an ordinary tab), and closes itself.
Double-clicking it while Maestro is already running just opens the UI again
instead of colliding on the port. Nothing in the project reads `Maestro.exe` at
run time, so deleting it costs you nothing.

Because there is no console left behind, there is nothing to Ctrl+C. **Closing the
window stops the server**, about ten seconds later; the **Quit** button in the
header stops it immediately. `start.cmd` sets the same `MAESTRO_NO_OPEN` flag the
exe does, which is what shows the button and what arms the shutdown - started from
a terminal, Ctrl+C is the way out and Maestro never exits on its own.

The window close is not a click handler: the page holds one `/api/presence` stream
open for as long as it is on screen, and the server exits once the last one has
been gone for its grace period. A socket rather than a goodbye message, because a
window also dies by Alt+F4, by Task Manager, and by Windows restarting for updates
- and because timers in a minimised window get throttled. A refresh reconnects far
inside the grace period, and a second window is simply a second stream. A server
whose browser never appears at all gives up after two minutes. This is the fix for
a real failure: two servers were found still holding ports 4144 and 4188 hours
after the folder they were launched from had been moved, each serving `ENOENT ...
public\index.html` to a launcher that had health-checked the port and concluded
Maestro was already up.
Override the browser with `MAESTRO_BROWSER=<full path to a Chromium browser>`.
If the server does not come up, `start.cmd` re-runs it in the foreground so the
error is on screen rather than swallowed by the hidden window.

`Maestro.exe` is a 110 KB launcher, not a bundled runtime: it still runs your
`node server.js`. Node is already a Claude Code prerequisite, so nothing new is
required. Rebuild it after changing the launcher or the logo:

```bash
npm run build:icon   # assets/maestro.svg -> maestro.ico + PWA PNGs
npm run build:exe    # tools/Launcher.cs  -> Maestro.exe
```

Both use only what Windows already ships (`csc.exe`) and Node's built-in `zlib` -
no toolchain, no npm packages.

> One rough edge, stated plainly: in app mode the **taskbar icon is the browser's**,
> not Maestro's. A `--app=` window still belongs to the browser process; only
> installing the page as a desktop app changes that, and that path is not wired up
> yet. The window title, title-bar icon and favicon are all Maestro's.

## Install (team-friendly)

Requires Node 18+ - which you already have, because Claude Code needs it.

```bash
git clone <your-internal-repo>/claude-maestro
cd claude-maestro
npm link          # optional: makes the `claude-maestro` command available everywhere
claude-maestro    # or just: node server.js
```

Opens `http://localhost:4144` automatically. Change the port with `MAESTRO_PORT=5000`.

## How it works

- **Session discovery**: reads `~/.claude/projects/<encoded-path>/<id>.jsonl` transcripts. The real working directory comes from the `cwd` field inside each transcript (the encoded folder name is ambiguous), with titles from `sessions-index.json` summaries when available, else the first user prompt. Session file formats are internal to Claude Code and can change between versions - the parser is defensive and degrades to filename + timestamps.
- **Resume**: launches your platform terminal in the session's original folder - Windows Terminal (fallback `cmd`), macOS Terminal.app, or the first available Linux terminal - and runs `claude --resume <id>`. Running it from the original folder works on *all* Claude Code versions (older CLIs only find sessions from the current directory). A copy-command fallback is always available.
- **Settings saves**: files are pretty-printed, unknown keys are preserved untouched, and the previous version is backed up next to the file (`*.maestro-bak.*`, last 3 kept). Claude Code hot-reloads settings files, so permission and hook edits apply to already-running sessions.
- **Effective view**: merges user → project → local the way Claude Code does for the common cases - scalars overridden by the higher scope, permission rules merged across scopes. Managed (enterprise) policies and CLI flags sit above these and aren't modeled.

## Code layout

`server.js` is the entry point and nothing else - process wiring, the request
loop, `listen()`. Everything else lives in `lib/`, one module per concern, and
requiring any of them has no side effects (that is what lets `npm test` import
them directly instead of evaluating the server):

| file | what is in it |
| --- | --- |
| `lib/constants.js` | paths and limits every other module agrees on |
| `lib/util.js` | logging, JSON reads, HTTP replies, child processes, backups |
| `lib/http-guard.js` | who may talk to this server (DNS rebinding / CSRF) |
| `lib/routes.js` | every route, keyed `"METHOD /path"` |
| `lib/sessions.js` | the `~/.claude/projects` scan and its cost roll-up |
| `lib/digests.js` | per-transcript "what happened" summaries, cached |
| `lib/pricing.js` | model rate table and cost arithmetic |
| `lib/transcripts.js` | the viewer feed, export capsules, import |
| `lib/launch.js` | building the `claude` command line, opening a terminal |
| `lib/settings.js` | `settings.json` across scopes, plus the effective merge |
| `lib/guardrails.js` | the generated PreToolUse hook and its deny-rule mirror |
| `lib/library.js` | commands / agents / skills as files |
| `lib/files.js` | the narrow file explorer over `~/.claude` |

Routing is an exact-match lookup in a plain object - no pattern matching, no
middleware stack. `server.js` awaits the handler inside one `try`/`catch`, so a
throw anywhere below becomes a 500 with the message rather than a hung request.

## Nice extras

- "New session here" button per project folder.
- One-click **safety pack**: adds common deny rules (`rm -rf`, `git push --force`, `.env` / secrets reads).
- Hook builder covers `command` hooks for all lifecycle events; other hook types (`http`, `prompt`, `agent`) via the Raw JSON tab.
- `$schema` button adds the official JSON schema line so VS Code validates the file too.

## Security notes

Maestro reads and writes your `~/.claude` tree and can launch terminals, so the
threat model is worth stating plainly.

**Binding to `127.0.0.1` is not by itself a security boundary.** It keeps other
machines out; it does not keep out the browser already running on this machine,
and any web page you visit can aim requests at a local port. Two attacks follow,
and both are now blocked with a test each:

- **DNS rebinding.** `evil.com` answers first with its own IP, serves a page,
  then re-answers with `127.0.0.1`. The page is now same-origin with Maestro and
  can *read* every response - `settings.json` including any API keys in `env`,
  any file under `~/.claude`, whole transcripts. Maestro now serves a request
  only if its `Host` header is a loopback name, so a request addressed to
  `evil.com:4144` is refused even though it arrived on the right socket.
- **Cross-site writes.** A page cannot read our responses without CORS, but it
  can still *send*. `Content-Type: text/plain` is CORS-safelisted, so it sends
  with no preflight - and the server used to `JSON.parse` the body whatever the
  content type claimed. That was enough to write a `PreToolUse` hook into
  `settings.json`, which is arbitrary code execution the next time Claude Code
  runs, or to drive `POST /api/launch`. Mutations must now be same-origin *and*
  declared `application/json`, which forces a preflight an attacker's page
  cannot satisfy.

The rest of the surface:

- **Path containment.** Every file endpoint resolves through `safeJoin`, which
  rejects anything that escapes its root; `..`, absolute paths, and backslash
  variants are refused before that. `.credentials.json`, `~/.claude.json` and the
  transcript store are never reachable by path. Project scope is limited to
  `.claude/`, `CLAUDE.md`, `CLAUDE.local.md` and `.mcp.json`.
- **No shell.** Terminal launches pass argv arrays, never a shell string.
  Session ids, permission modes and model names are matched against allowlists,
  and extra flags are rejected if they contain shell metacharacters.
- **Import limits.** A shared session file is capped at 256 MB decompressed -
  gzip reaches roughly 1000:1 on repetitive input, so a few hundred KB could
  otherwise inflate until the process died.
- **Export warns, never silently redacts.** Transcripts are scanned for
  Anthropic/generic API keys, GitHub and Slack tokens, AWS keys, private key
  blocks and inline passwords, and you are shown counts before anything leaves
  the machine. A transcript quietly rewritten but still claiming to be complete
  is more dangerous than an honest warning.
- **Still true, and still your call:** there is no authentication. Anything
  running as your user on this machine can talk to the server while it is up.
  Don't port-forward it, and quit it when you are done.

One residual, stated rather than hidden: on macOS the Terminal.app launch path
builds an AppleScript string that includes the project directory, so a directory
whose *name* contains AppleScript syntax is a theoretical injection. It requires
an attacker who can already create directories on your machine.

## Guardrails (hard blocks)

Deny rules block silently without asking - but they're skipped entirely in `bypassPermissions` mode, and Bash deny rules are prefix-matched (`Bash(rm *)` misses `cd x && rm`). The **Guardrails** tab closes both gaps:

- Add a **file/glob** (`.env`, `secrets/**`, `*.pem`) or a **command token** (`rm -rf`, `git push --force`, `DROP TABLE`).
- Maestro writes a generated **PreToolUse hook** (`maestro-guard.js`, Node, cross-platform) plus a `maestro-guardrails.json` blocklist it reads on every tool call. The hook exits with code 2 on a match, which the Claude Code docs define as *"blocks the tool call"* for `PreToolUse`, and feeds stderr back to Claude as the reason.
  Hooks run ahead of the permission prompt rather than through it, which is why this catches cases a deny rule does not. **An earlier version of this README claimed the block holds in every permission mode, `bypassPermissions` included. The published hook documentation does not actually state that**, and it explicitly cautions that hooks are a policy mechanism rather than a hard allow/deny - so treat bypass-mode coverage as unverified until you test it yourself in your own setup. Use the `disableBypassPermissionsMode` switch below if you need bypass mode ruled out with certainty.
- File rules block Read/Edit/Write/MultiEdit/NotebookEdit on matching paths, **and** `Grep`/`Glob` against them, **and** any Bash/PowerShell command that mentions the file name (`cat .env | grep KEY` → blocked). Command rules match the token anywhere in the command line, across chains, pipes, quotes and redirections.
- `Grep` and `Glob` were the real hole here: `Grep` with `output_mode: "content"` prints the matching lines of a file it was never allowed to `Read`, and `Glob` confirms a guarded file exists. Blocking the file tools alone left both wide open. `npm test` now executes the hook against crafted events for every one of these paths.
- Optional: mirror every guardrail as permission deny rules (defense in depth, visible in `/permissions`; removed automatically when you remove the guardrail), and a switch to forbid `bypassPermissions` mode entirely.
- The hook fails open on a corrupt config so a typo can never brick every session.

Scope works like settings: **User** = enforced for you everywhere; **Project** = committed with the repo, whole team gets it (hook command uses `$CLAUDE_PROJECT_DIR`; on Windows this expansion needs Git Bash, which ships alongside most Claude Code installs - otherwise prefer User scope, which uses an absolute path).

Known limits, stated plainly: a deliberately broad search (`Glob **/*`) can still enumerate a guarded file's existence, a `Grep` over a parent *directory* is not blocked on the strength of one guarded file inside it, and a determined agent can find encodings no static filter catches. Guardrails raise the bar hard; they don't replace managed policies for compliance-grade enforcement.

## Settings catalog

The Settings tab now shows two things per scope: **Defined in this file** - every key present in the JSON with a type-aware editor (booleans, enums, numbers, strings, JSON objects) and one-click removal - and **Add a setting**, a searchable catalog of 45+ documented settings.json keys (statusLine, model, memory, auto-compact, MCP approval, update channel, fallback models, attribution, and more) with plain-language descriptions. Pick one, it lands in the file with a sensible example value, adjust, save. Unknown/custom keys are always preserved and editable in Raw JSON.

## Library - commands, skills, agents

The CLI's slash menus are fine for *running* these, weak for *managing* them. The Library tab is a two-pane editor over the actual files, per scope (User `~/.claude/…` or Project `.claude/…`, committed):

- **Commands** - `commands/*.md`, subfolders namespace (`git/pr.md` → `/git:pr`). New files start from a working template with frontmatter.
- **Skills** - one folder per skill; Maestro edits the `SKILL.md` and shows how many extra files the folder carries. Deleting removes `SKILL.md` (backed up) and only removes the folder when nothing else is inside.
- **Agents** - `agents/*.md` with name/description/tools frontmatter templates.

Descriptions from frontmatter show in the list, so the team can scan what exists before creating duplicates. Saves are backed up like settings; new sessions pick files up immediately.

**Why the Library can be empty on a machine where Claude Code clearly has skills.** Only file-based skills live in `~/.claude/skills` (or a project's `.claude/skills`). Skills bundled with Claude Code itself, and skills that arrive through a plugin, are not files in those folders and never appear in the Library - a machine can list a dozen skills in the CLI while both scopes here are empty, and nothing is broken. The folder Maestro is actually reading is printed under the Library's kind/scope rails, so the two can be compared directly. If that path is not the one you expect, check `CLAUDE_CONFIG_DIR`: Claude Code relocates its whole config tree when that variable is set - common on managed machines with redirected home directories - and Maestro follows it.

## What Maestro deliberately is not

No chat UI, no session spawning, no usage analytics dashboards. Maestro manages everything Claude Code reads from disk; the terminal stays where you run it. That boundary is what keeps it a 3-file, zero-dependency install.

## Files tab

A tree of everything Claude Code reads from disk, editable in place with the same backup-on-write as settings:

- **User scope**: the whole `~/.claude` tree - `CLAUDE.md`, `settings.json`, `hooks/*.sh|js|py`, statusline scripts, commands, skills, agents.
- **Project scope**: `CLAUDE.md`, `CLAUDE.local.md`, `.mcp.json`, and the whole `.claude/` folder.

Shell and Python files get the executable bit on save, so a status line or hook script you write here runs immediately. Never exposed: `.credentials.json`, `~/.claude.json` (your login session), the transcript store, and other system-managed folders - attempts to reach them by path or traversal are rejected.

## Launching sessions in tabs

The Sessions tab has a launch bar and per-row checkboxes. Pick several sessions, press **Open N in tabs**, and each one opens as a tab in your real terminal, in its own original folder:

| Platform | Behavior |
|---|---|
| Windows | Windows Terminal tabs (`wt -w 0 nt`); falls back to a `cmd` window |
| macOS | iTerm2 tabs when it's running; otherwise a Terminal.app window |
| Linux | a `tmux` window in a session named `maestro` (`tmux attach -t maestro`), else `gnome-terminal --tab` / konsole / xfce4-terminal |

Launch options apply to everything you open: permission mode (`--permission-mode`, including **plan** for read-only review), model, and free-text extra flags. Mode and model are validated against allowlists and extra flags are rejected if they contain shell metacharacters, so a typo can't become a shell injection.

## Why there is no terminal inside Maestro

Embedding the CLI would need a PTY bridge (`node-pty`), which is a native module requiring a compiler toolchain on every machine - that alone ends the "clone and run" install. It would also put Maestro in the critical path of real work: a crash in a config tool would take your session with it. And Claude Code's TUI (fullscreen rendering, Shift+Tab mode cycling, dictation, ctrl-key bindings) is built for a real terminal and degrades in a browser emulator. Maestro launches into the terminal you already have instead - you keep your shell, profile, fonts, and keybindings, and Maestro stays optional.

## Session summaries

Each session row now has two columns: the **opening prompt** (what you asked) and **what happened** (what the session actually did), because the first prompt alone rarely tells you which session you want.

The "what happened" line is derived from the transcript itself - no model call, no tokens, no network:

- files edited, most-touched first (`6 edits - auth.service.ts, routes.ts +3`)
- commands run, grouped by binary (`14 cmds (npm, git, docker)`)
- subagents dispatched, and wall-clock duration
- read-only sessions are labelled as such, so exploration is distinguishable from work

When Claude Code has generated its own session summary, that appears above the derived line. The filter box searches both, plus the names of files touched - so "which session touched `auth.guard.ts`?" is now one query.

Digests are cached in `~/.claude/.maestro-digests.json`, keyed by each transcript's size and modification time. A cold scan of ~9 MB of transcripts takes about 340 ms; a cached rescan is around 13 ms. Appending to a session invalidates just that entry, and entries for deleted transcripts are pruned at startup.

**Why not have Claude write the summary?** Running `claude -p --resume <id>` would produce nicer prose, but it costs tokens per session and appends to the transcript you are trying to summarize, mutating the very history you wanted to inspect. Deriving from tool calls is free, instant, side-effect-free, and answers the question people actually ask ("which session touched this file?").

## Session columns

| Column | Source |
|---|---|
| Opening prompt | first real user message in the transcript |
| Session name | the name Claude Code stored, else its generated summary |
| Cost · in→out | estimated list API cost, with input→output tokens beneath |

Hovering the name shows the derived activity for that session (files edited, commands run, duration), and hovering the cost cell breaks it into input / output / cache write / cache read with the models used.

**Folders start closed.** A folder header shows its session count, cost and token total, and clicking anywhere on that header - or the chevron - opens it to every session inside; **Expand all** in the toolbar does the lot. Which folders you left open survives a refresh, as does the tab you were on. Typing in the filter box overrides all of it and opens every folder with a match, because a result hidden behind a closed folder reads as a broken search.

## Usage and cost

A collapsible **Usage** panel sits above the session list: total estimated cost, the last 7 and 30 days, tokens in→out, cache read volume, a per-model cost breakdown, and the folders you spend the most in. Previously the totals existed only as a single number in the header and nothing was summarised anywhere.

### The token column used to be wrong

Claude Code writes **one JSONL line per content block**, so a single API response
that produced thinking + text + a tool call is three lines - and every one of them
repeats the *same complete* `usage` object. Summing every line counted most turns
two or three times. Measured across real transcripts the inflation was **84% to
125%**. Maestro now counts each response once, keyed by `message.id` + `requestId`.
`npm test` pins this with a synthetic transcript so it cannot regress.

Two smaller fixes came with it: `<synthetic>` entries (Claude Code's own notices,
like *"Prompt is too long"*) are no longer counted as a model, and the turn count
is now responses rather than lines.

### Why the column shows cost, not a token total

The old column summed `in + out + cache write + cache read`. Cache reads outnumber
real tokens by 10-100x - on a typical transcript here, **158x** - so that single
number was dominated by cache traffic and told you nothing about how much work a
session did. Cost is the only figure that weighs the four token classes correctly,
because that is exactly what the price multipliers encode. Input→output sits
underneath it, and the full breakdown is in the tooltip.

### Where the dollars come from

In priority order:

1. `costUSD` recorded in the transcript, when Claude Code wrote one. Not an estimate.
2. Otherwise, the exact token counts multiplied by a rate table.

```
usd = in/1M           × rateIn
    + out/1M          × rateOut
    + cacheWrite/1M   × rateIn × 1.25   (5-minute)
    + cacheWrite1h/1M × rateIn × 2.0    (1-hour)
    + cacheRead/1M    × rateIn × 0.1
```

**The cache multipliers are not per-model constants.** Anthropic prices cache
traffic as a fixed ratio of whatever that model's own input rate is, and the ratio
is the same for Haiku as for Fable. Writing them as multipliers of `rateIn` rather
than absolute dollars is what keeps them off the maintenance list - they follow the
input rate automatically.

**Rates are keyed by model family, not by exact model id.** `claude-opus`,
`claude-sonnet`, `claude-haiku`, `claude-fable`, `claude-mythos` - five lines. Every
Opus point release starts with `claude-opus-`, so a model released tomorrow prices
itself with no edit. Only a genuinely new *tier* needs a line, and anything that
matches nothing is shown as **unpriced** rather than silently costing $0.

Fast mode (`usage.speed === "fast"`) is priced from its own premium table and
labelled separately.

Override any rate - or, if a tier ever diverges, any multiplier - in
`~/.claude/.maestro-pricing.json`. It is merged *over* the built-in table, so
pinning one model does not un-price the rest:

```json
{
  "models": {
    "claude-opus": { "in": 5, "out": 25 },
    "claude-sonnet-4-5": { "in": 3, "out": 15, "cacheReadMult": 0.1 }
  }
}
```

Two things to keep in mind: this is **list API price**, so on a Pro or Max plan you
are not billed these amounts - treat it as a way to compare sessions, not an
invoice. And the transcript does not capture every request Claude Code makes, so
totals are a solid floor rather than a perfectly exact accounting.


## When something goes wrong

Maestro writes `~/.claude/.maestro.log` with every launch attempt and any background error, and it no longer exits on an uncaught error. If the page loses contact with the server it polls `/api/health` and recovers by itself instead of stranding you.

Every external command (terminal probes, AppleScript, `which`) runs asynchronously with a timeout. An earlier build used synchronous calls, so a single slow probe - notably macOS asking for Accessibility permission - froze the whole server and made every request after the first launch fail. Nothing in a request path can block the event loop now.

## Session names

The **Session name** column shows the name Claude Code stores when you run `/rename` (or the name it generates for you). That name lives in the session transcript rather than in `sessions-index.json`, and Claude Code has written it in several shapes across versions - `custom-title`, `agent-name`, `session-meta`, and older `/rename` command entries. Maestro reads all of them and keeps the most recent, so renaming twice shows the latest name.

When a session was never named, the column falls back in order: Claude Code's generated summary → the index's `firstPrompt` → the opening prompt. It never shows a blank row.

## Tests

```bash
npm test    # static checks plus a real run of the guardrail hook; no server needed
```

It guards against a dead UI (a `$('#id')` with no matching element - which once
threw during startup and silently stopped every listener below it from attaching -
a tab with no panel, a syntax error in the inline script), against server
regressions (a `keepAliveTimeout` short enough for browsers to trip over, any
synchronous `exec`, a `shell: true` spawn, binding off loopback - all of them
scanned across `server.js` *and* every `lib/` file, so the rules cannot go quiet
by the code moving out from under them), and against the two accounting bugs
described above:

- **Wiring.** Loading the route table pulls in every module, so a broken
  `require` fails here rather than at the first HTTP request. Every key must
  parse as `"METHOD /path"`, every value must be callable, and every `/api/...`
  the page calls must have a route - a dead endpoint is a dead button. `GET /`
  and the icon route are then invoked against a stub response to prove bundled
  files still resolve from the install root rather than from `lib/`.

- **Pricing.** Every family prefix resolves, an invented future model
  (`claude-opus-9-20991231`) still prices itself, a non-Claude id stays unpriced
  rather than silently inheriting a Claude rate, and the arithmetic is pinned
  against known values (1M Opus output = $25, 1M cache reads = $0.50).
- **Token dedup.** A synthetic transcript writes one API response across three
  content-block lines, exactly as Claude Code does, and asserts it is counted
  once - the regression that had every total roughly doubled.
- **Guardrails.** The generated hook is written to a temp dir and actually
  executed against crafted `PreToolUse` events, asserting exit codes: guarded
  reads, `Grep -> content` and `Glob` on guarded paths, blocked tokens bare,
  after `&&`, inside quotes and in pipelines, plus the cases that must stay
  *allowed* so the filter is not just blocking everything. It also asserts the
  hook fails open on a corrupt config, so a typo can never brick every session.

That last group matters because the hook is a template literal carrying three
levels of escaping - reading it is not a test.

## Sharing a session

Each session row has a **share** button offering two files:

- **Session file** (`<name>.maestro.gz`) - the full transcript plus metadata, gzipped. A teammate uses **Import session**, picks one of their own project folders, and the session appears in their list ready to `claude --resume`. Maestro rewrites `cwd` and the session id on every entry so Claude Code resolves it against *their* checkout, not yours. If the id already exists locally a fresh one is minted, so an import never overwrites existing history.
- **Markdown** (`<name>.md`) - the conversation as prose with tool calls summarised, for a PR description or a Slack thread. Read-only.

Before either download, Maestro scans the transcript for credentials - Anthropic and generic API keys, GitHub and Slack tokens, AWS access keys, private key blocks, inline passwords - and warns you with counts. It does **not** silently redact them: a transcript that has been quietly rewritten but still looks complete is more dangerous than an honest warning. If something is flagged, share the Markdown export or clean the session first.

## Windows: why the terminal used to close Maestro

The earlier build spawned the fallback terminal with `shell: true` *and* `detached: true`. On Windows that made the launched `cmd` share this process's console, so closing the Claude Code window took the Maestro server down with it - the symptom was a session opening fine and every request afterwards failing with "Cannot reach the Maestro server".

Launches now go through `cmd /c start`, which hands the new window to the console subsystem and lets the helper `cmd` exit immediately; nothing ties the terminal's lifetime to the server. `npm test` fails if `shell: true` ever reappears.

Windows Terminal is also detected properly now: `where wt.exe` misses it when it is installed as a Store app execution alias, so Maestro checks `%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe` too. Force a choice with `MAESTRO_TERMINAL=wt` or `MAESTRO_TERMINAL=cmd`.

To see exactly what will run before running it: `http://localhost:4144/api/diagnose`.
