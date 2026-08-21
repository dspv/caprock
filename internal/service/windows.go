package service

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Why the Startup folder and not a Scheduled Task.
//
// Both were candidates. `schtasks /create` can register a per-user logon task
// without elevation, but it has three properties that make it the wrong choice
// here:
//
//  1. It is not testable without side effects. Verifying a Scheduled Task means
//     actually creating one in the user's (or the CI runner's) Task Scheduler
//     store — there is no "generate the definition into a temp dir" mode, and a
//     test that leaves a real logon task behind on a CI runner is a test that
//     eventually breaks someone else's job. Rule 2 says Windows CI never goes
//     red; a test that mutates machine state is how that happens.
//  2. Its XML/argument quoting is a known footgun (`/tr` takes one string, and
//     a path with spaces — `C:\Program Files\…` — needs nested quoting that
//     differs between schtasks versions).
//  3. It buys us restart-on-crash, but only via /RI-style repetition, which is
//     a poll, not supervision.
//
// The Startup folder is a plain file in a plain directory the user owns. It is
// generated, inspected, and removed with ordinary file I/O, which means the
// generation logic is unit-tested on all three OSes exactly like the plist and
// the unit, and installing it is the same idempotent "write the file" as
// everywhere else.
//
// What we give up: Windows has no per-user crash supervisor available without
// elevation, so the script restarts the daemon at each logon but does not
// resurrect it mid-session. `caprock up` already writes runtime.json and the
// daemon is long-lived; the reboot case — the one that actually loses users —
// is covered. This is stated plainly in the README rather than papered over.
//
// windowsStartupDir resolves the per-user Startup folder. APPDATA is the
// documented location; the literal fallback keeps a stripped environment (a
// service account, a bare CI shell) working.
func windowsStartupDir(home string) (string, error) {
	if home == "" && os.Getenv("APPDATA") == "" {
		return "", errors.New("cannot resolve the Windows Startup folder: neither %APPDATA% nor a home directory is set")
	}
	base := os.Getenv("APPDATA")
	if base == "" {
		base = filepath.Join(home, "AppData", "Roaming")
	}
	return filepath.Join(base, "Microsoft", "Windows", "Start Menu", "Programs", "Startup"), nil
}

// renderStartupCmd writes the logon script. `start ""` launches the daemon
// without holding a console window open; the first empty argument is the window
// title, which `start` requires whenever the command itself is quoted —
// omitting it makes `start "C:\path with spaces\caprock.exe"` open an empty
// console titled after the path instead of running anything.
//
// The daemon runs with --foreground here for the same reason as on the other
// platforms: `start /b` already backgrounds it, and letting caprock double-fork
// on top would leave the script unable to say anything useful about it. Output
// is redirected into the data dir so a logon-time failure is diagnosable.
//
// CRLF line endings: cmd.exe tolerates LF in most cases but not all (a trailing
// LF-only line has been observed to swallow the last command), and a .cmd in
// the Startup folder is not somewhere to be clever.
func renderStartupCmd(p Plan) string {
	var b strings.Builder
	b.WriteString("@echo off\n")
	b.WriteString("REM Caprock autostart — created by `caprock service install`.\n")
	b.WriteString("REM Remove it with `caprock service uninstall`, or just delete this file.\n")
	if p.DataDir != "" {
		b.WriteString("set \"CAPROCK_DATA_DIR=" + p.DataDir + "\"\n")
	}
	b.WriteString("start \"\" /b " + cmdQuote(p.Exe) + " " + cmdArgs(p) + " >> " + cmdQuote(p.LogPath()) + " 2>&1\n")
	return strings.ReplaceAll(b.String(), "\n", "\r\n")
}

func cmdArgs(p Plan) string {
	parts := make([]string, 0, len(p.Args()))
	for _, a := range p.Args() {
		parts = append(parts, cmdQuote(a))
	}
	return strings.Join(parts, " ")
}

// cmdQuote quotes an argument for cmd.exe. Paths are the only thing we pass, and
// a Windows path cannot contain `"`, so quoting on whitespace is sufficient and
// there is no escape sequence to get wrong.
func cmdQuote(s string) string {
	if strings.ContainsAny(s, " \t") {
		return `"` + s + `"`
	}
	return s
}

// windowsRegistered is "is the logon script in place" — for the Startup folder
// there is no separate registry the way launchd and systemd have one, so
// presence of the file *is* the registration. Path() already reports where.
func windowsRegistered(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
