/*
 * Building the `claude` command line and opening a terminal on it, per
 * platform. The comments here are all scar tissue - read them before changing
 * how a window is spawned.
 */
'use strict';

const { spawn } = require('child_process');
const { SESSION_ID_RE } = require('./constants');
const { run, binExists, hasWindowsTerminal, shQuote } = require('./util');

// Launch options are user-supplied; keep them free of shell metacharacters.
const SAFE_FLAG_RE = /^[A-Za-z0-9 _.,=@:/+-]*$/;
const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];

function buildCommand(opts) {
  const parts = ['claude'];
  if (opts.sessionId) {
    if (!SESSION_ID_RE.test(opts.sessionId)) throw new Error('invalid session id');
    parts.push('--resume', opts.sessionId);
  } else if (opts.continueLast) {
    parts.push('--continue');
  }
  if (opts.mode) {
    if (!MODES.includes(opts.mode)) throw new Error('invalid permission mode');
    parts.push('--permission-mode', opts.mode);
  }
  if (opts.model) {
    if (!/^[A-Za-z0-9._-]+$/.test(opts.model)) throw new Error('invalid model name');
    parts.push('--model', opts.model);
  }
  if (opts.extraFlags) {
    const f = String(opts.extraFlags).trim();
    if (!SAFE_FLAG_RE.test(f)) throw new Error('extra flags contain characters that are not allowed');
    if (f) parts.push(f);
  }
  return parts.join(' ');
}

// spawn() with detached+ignore reports failures asynchronously, so a launch that
// never happened used to look like success. Wait briefly for an 'error' event.
function spawnDetached(bin, args, opts) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bin, args, { detached: true, stdio: 'ignore', ...opts }); }
    catch (e) { return reject(e); }
    let settled = false;
    child.on('error', (e) => { if (!settled) { settled = true; reject(new Error(`${bin}: ${e.message}`)); } });
    child.on('exit', (code) => {
      if (!settled && code && code !== 0) { settled = true; reject(new Error(`${bin} exited with code ${code}`)); }
    });
    setTimeout(() => { if (!settled) { settled = true; try { child.unref(); } catch {} resolve(); } }, 600);
  });
}

async function launchTerminal(cwd, cmdline, newTab) {
  const plat = process.platform;

  if (plat === 'win32') {
    // Never combine shell:true with detached:true here. That made the child share
    // this process's console, so closing the Claude Code window took the Maestro
    // server down with it. Go through `cmd /c start` instead: start hands the new
    // window to the console subsystem, the intermediate cmd exits immediately, and
    // nothing links the terminal's lifetime to ours.
    const startWindow = async (line, label) => {
      return new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn('cmd.exe', ['/c', line], {
            cwd,
            detached: true,
            stdio: 'ignore',
            windowsVerbatimArguments: true, // pass the line to cmd exactly as written
          });
        } catch (e) { return reject(e); }
        let settled = false;
        const finish = (ok, err) => { if (!settled) { settled = true; ok ? resolve(label) : reject(err); } };
        child.on('error', (e) => finish(false, new Error(`cmd.exe: ${e.message}`)));
        setTimeout(() => { try { child.unref(); } catch {} finish(true); }, 200);
      });
    };

    if (await hasWindowsTerminal()) {
      if (newTab) {
        try {
          return await startWindow(`start "" wt.exe -w 0 nt -d "${cwd}" cmd /k ${cmdline}`, 'Windows Terminal (tab)');
        } catch { /* no window to attach to - open a fresh one below */ }
      }
      return await startWindow(`start "" wt.exe -d "${cwd}" cmd /k ${cmdline}`, 'Windows Terminal');
    }
    return await startWindow(`start "Claude Code" cmd /k ${cmdline}`, 'cmd - install Windows Terminal for tabs');
  }

  if (plat === 'darwin') {
    const script = `cd ${shQuote(cwd)} && ${cmdline}`;
    const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (newTab) {
      // iTerm2 makes real tabs via AppleScript. Terminal.app would need a synthetic
      // keystroke and Accessibility permission, so it gets a window instead.
      // Ask iTerm directly. Probing via System Events needs Accessibility
      // permission and can block on a dialog, which would freeze the server.
      const probe = await run('osascript', ['-e', 'application "iTerm2" is running'], 3000);
      if (probe.ok && probe.out.trim() === 'true') {
        const tabScript = [
          'tell application "iTerm2"',
          '  activate',
          '  if (count of windows) = 0 then',
          '    create window with default profile',
          '  else',
          '    tell current window to create tab with default profile',
          '  end if',
          '  tell current session of current window to write text "' + esc(script) + '"',
          'end tell',
        ].join('\n');
        const r = await run('osascript', ['-e', tabScript], 6000);
        if (r.ok) return 'iTerm2 (tab)';
      }
    }
    await spawnDetached('osascript', [
      '-e', `tell application "Terminal" to do script "${esc(script)}"`,
      '-e', 'tell application "Terminal" to activate',
    ]);
    return 'Terminal.app (window)';
  }

  // Linux: a tmux window is the closest thing to a tab and survives a closed GUI.
  if (newTab && await binExists('tmux')) {
    const has = await run('tmux', ['has-session', '-t', 'maestro'], 3000);
    if (!has.ok) await spawnDetached('tmux', ['new-session', '-d', '-s', 'maestro', '-c', cwd]);
    await spawnDetached('tmux', ['new-window', '-t', 'maestro', '-c', cwd, cmdline]);
    return 'tmux window in session "maestro" - attach with: tmux attach -t maestro';
  }
  const inner = `cd ${shQuote(cwd)} && ${cmdline}; exec bash`;
  const candidates = [
    ['gnome-terminal', [...(newTab ? ['--tab'] : []), `--working-directory=${cwd}`, '--', 'bash', '-lc', `${cmdline}; exec bash`]],
    ['konsole', [...(newTab ? ['--new-tab'] : []), '--workdir', cwd, '-e', 'bash', '-lc', `${cmdline}; exec bash`]],
    ['xfce4-terminal', [...(newTab ? ['--tab'] : []), `--working-directory=${cwd}`, '-e', `bash -lc "${cmdline}; exec bash"`]],
    ['x-terminal-emulator', ['-e', 'bash', '-lc', inner]],
    ['xterm', ['-e', 'bash', '-lc', inner]],
  ];
  const errors = [];
  for (const [bin, args] of candidates) {
    if (!(await binExists(bin))) continue;
    try {
      await spawnDetached(bin, args);
      return bin + (newTab ? ' (tab)' : '');
    } catch (e) {
      // Installed but broken (or refuses a tab flag) - keep trying the rest.
      errors.push(e.message);
    }
  }
  throw new Error(errors.length
    ? `every terminal found failed to launch - ${errors.join('; ')}`
    : 'No terminal emulator found. Use the copy-command button instead.');
}

module.exports = { buildCommand, launchTerminal };
