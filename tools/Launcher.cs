// Maestro launcher - a Windows GUI-subsystem stub so double-clicking the app
// behaves like any other desktop program: no console window appears, and none
// is left behind afterwards.
//
// Built by tools/build-launcher.ps1 with csc.exe, which ships with Windows -
// there is no toolchain to install and nothing is added to node_modules.
//
// What it does:
//   1. if Maestro is already running on the port, just focus a window on it
//   2. otherwise start `node server.js` with no console window at all
//   3. wait for /api/health, then open the UI in app mode (no URL bar)
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Launcher {
    const string DefaultPort = "4144";

    static string Port {
        get {
            string p = Environment.GetEnvironmentVariable("MAESTRO_PORT");
            return string.IsNullOrEmpty(p) ? DefaultPort : p;
        }
    }
    static string Url { get { return "http://127.0.0.1:" + Port; } }

    static void Fail(string msg) {
        MessageBox.Show(msg, "Maestro", MessageBoxButtons.OK, MessageBoxIcon.Error);
        Environment.Exit(1);
    }

    /// <summary>Root of the install - the folder holding server.js.</summary>
    static string FindRoot() {
        string dir = Path.GetDirectoryName(Application.ExecutablePath);
        for (int i = 0; i < 4 && dir != null; i++) {
            if (File.Exists(Path.Combine(dir, "server.js"))) return dir;
            dir = Path.GetDirectoryName(dir);
        }
        return null;
    }

    static string Which(string exe) {
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in path.Split(';')) {
            if (dir.Length == 0) continue;
            try {
                string full = Path.Combine(dir.Trim('"'), exe);
                if (File.Exists(full)) return full;
            } catch { /* malformed PATH entry */ }
        }
        return null;
    }

    static bool ServerUp() {
        try {
            var req = (HttpWebRequest)WebRequest.Create(Url + "/api/health");
            req.Timeout = 1200;
            using ((HttpWebResponse)req.GetResponse()) return true;
        } catch { return false; }
    }

    /// <summary>Open the UI chromeless, so it reads as an app and not a tab.</summary>
    static void OpenUi() {
        string[] browsers = {
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) + @"\Microsoft\Edge\Application\msedge.exe",
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles) + @"\Microsoft\Edge\Application\msedge.exe",
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles) + @"\Google\Chrome\Application\chrome.exe",
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) + @"\Google\Chrome\Application\chrome.exe",
        };
        foreach (string b in browsers) {
            if (!File.Exists(b)) continue;
            try {
                // --app strips the address bar and tab strip; the window then
                // carries our own favicon and title rather than "localhost:4144".
                var psi = new ProcessStartInfo(b, "--app=" + Url + " --window-size=1280,900");
                psi.UseShellExecute = false;
                Process.Start(psi);
                return;
            } catch { /* try the next browser */ }
        }
        // No Chromium browser - fall back to whatever handles http.
        try { Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true }); } catch { }
    }

    [STAThread]
    static void Main(string[] args) {
        // Already running (or a stale instance on the port): just show the UI.
        if (ServerUp()) { OpenUi(); return; }

        string root = FindRoot();
        if (root == null) {
            Fail("Could not find server.js next to Maestro.exe.\n\n" +
                 "Keep the executable in the Maestro folder, or run: node server.js");
            return;
        }

        string node = Which("node.exe");
        if (node == null) {
            Fail("Node.js was not found on your PATH.\n\n" +
                 "Claude Code requires Node, so it is usually already installed - " +
                 "try reopening after a fresh sign-in, or install it from nodejs.org.");
            return;
        }

        try {
            var psi = new ProcessStartInfo(node, "\"" + Path.Combine(root, "server.js") + "\"");
            psi.WorkingDirectory = root;
            // The three settings that actually suppress the console window. A
            // plain `start node server.js` allocates one and keeps it open;
            // this hands Node no console at all, so nothing flashes and nothing
            // is left behind when the launcher exits.
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.EnvironmentVariables["MAESTRO_PORT"] = Port;
            // Server opens the browser itself only when run from a terminal;
            // the launcher owns that here so it can use app mode.
            psi.EnvironmentVariables["MAESTRO_NO_OPEN"] = "1";

            var proc = Process.Start(psi);
            // Drain the pipes. Redirected output with no reader fills the 4KB
            // buffer and blocks the server the first time it logs anything.
            var sb = new StringBuilder();
            proc.OutputDataReceived += (s, e) => { };
            proc.ErrorDataReceived += (s, e) => { if (e.Data != null) sb.AppendLine(e.Data); };
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();

            for (int i = 0; i < 100; i++) {           // up to ~20s
                if (ServerUp()) { OpenUi(); return; }
                if (proc.HasExited) {
                    Fail("Maestro could not start.\n\n" +
                         (sb.Length > 0 ? sb.ToString() : "node exited with code " + proc.ExitCode));
                    return;
                }
                Thread.Sleep(200);
            }
            Fail("Maestro started but did not answer on " + Url + " within 20 seconds.");
        } catch (Exception ex) {
            Fail("Could not start Maestro:\n\n" + ex.Message);
        }
    }
}
