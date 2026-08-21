package service

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// renderPlist writes the LaunchAgent. The shape follows the reference agent that
// was already working on the author's machine before this command existed; each
// key here is load-bearing:
//
//   - RunAtLoad          — start at login, which is the whole point.
//   - KeepAlive/SuccessfulExit=false — restart the daemon when it *crashes*,
//     but leave it alone when it exits 0. `caprock down` shuts down cleanly, so
//     without this launchd would fight the user and restart it immediately.
//   - ProcessType=Adaptive — the daemon is a watcher most of the time, but it
//     also serves the dashboard, and that half is interactive. Background plus
//     LowPriorityIO looked right for a watcher and was measured to be wrong:
//     macOS throttled the I/O of a process it had been told was batch work, and
//     the same binary answering the same query took 1.2s under launchd against
//     185ms from a terminal. Adaptive lets a process that starts serving
//     requests be promoted out of the background band.
//   - StandardOutPath/StandardErrorPath — into the data dir, so a login-time
//     failure is diagnosable instead of vanishing into launchd's void.
//
// EnvironmentVariables carries CAPROCK_DATA_DIR because a login agent inherits
// almost nothing from a shell profile: a user with a custom data dir would
// otherwise get a *second*, empty database after every reboot.
func renderPlist(p Plan) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n")
	b.WriteString(`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">` + "\n")
	b.WriteString("<plist version=\"1.0\">\n<dict>\n")
	b.WriteString("  <key>Label</key>\n  <string>" + plistEscape(Label) + "</string>\n\n")

	b.WriteString("  <key>ProgramArguments</key>\n  <array>\n")
	for _, a := range append([]string{p.Exe}, p.Args()...) {
		b.WriteString("    <string>" + plistEscape(a) + "</string>\n")
	}
	b.WriteString("  </array>\n\n")

	if p.DataDir != "" {
		b.WriteString("  <key>EnvironmentVariables</key>\n  <dict>\n")
		b.WriteString("    <key>CAPROCK_DATA_DIR</key>\n    <string>" + plistEscape(p.DataDir) + "</string>\n")
		b.WriteString("  </dict>\n\n")
	}

	b.WriteString("  <key>RunAtLoad</key>\n  <true/>\n")
	b.WriteString("  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>\n\n")
	b.WriteString("  <key>ProcessType</key>\n  <string>Adaptive</string>\n\n")
	b.WriteString("  <key>StandardOutPath</key>\n  <string>" + plistEscape(p.LogPath()) + "</string>\n")
	b.WriteString("  <key>StandardErrorPath</key>\n  <string>" + plistEscape(p.LogPath()) + "</string>\n")
	b.WriteString("</dict>\n</plist>\n")
	return b.String()
}

// plistEscape escapes the five XML entities. A home directory can legitimately
// contain `&` (and a data dir path can contain almost anything), which would
// otherwise produce a plist launchd refuses to parse — a silent no-autostart.
func plistEscape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;")
	return r.Replace(s)
}

// launchctlDomain is the modern per-user domain: gui/<uid>. The legacy
// `launchctl load` verbs still work but are deprecated and silently no-op in
// some situations; bootstrap/bootout report real errors.
func launchctlDomain() string { return fmt.Sprintf("gui/%d", os.Getuid()) }

// darwinLoad registers the plist with launchd and starts it now. Bootstrapping
// an already-bootstrapped label fails with "service already loaded" (EEXIST,
// exit 5 / 17) — that is the idempotent case, not an error, so we boot it out
// first and bootstrap again, which also picks up a rewritten plist.
func darwinLoad(path string) error {
	domain := launchctlDomain()
	// Best-effort removal of a previous registration; a missing one errors and
	// is exactly what we want to ignore.
	_ = exec.Command("launchctl", "bootout", domain+"/"+Label).Run()                                   //nolint:gosec // fixed argv
	if out, err := exec.Command("launchctl", "bootstrap", domain, path).CombinedOutput(); err != nil { //nolint:gosec // fixed argv
		return fmt.Errorf("launchctl bootstrap: %w: %s", err, strings.TrimSpace(string(out)))
	}
	// bootstrap honours RunAtLoad, but kickstart makes "started now" explicit
	// and is a no-op when it is already running.
	_ = exec.Command("launchctl", "kickstart", domain+"/"+Label).Run() //nolint:gosec // fixed argv
	return nil
}

// darwinUnload deregisters the label. A label that is not loaded is not an
// error here: uninstall must be a clean no-op.
func darwinUnload() error {
	_ = exec.Command("launchctl", "bootout", launchctlDomain()+"/"+Label).Run() //nolint:gosec // fixed argv
	return nil
}

// darwinRegistered asks launchd whether the label is known to it, which is a
// different question from "is the plist file on disk" — a user can delete a
// plist while the agent stays loaded until logout.
func darwinRegistered() bool {
	return exec.Command("launchctl", "print", launchctlDomain()+"/"+Label).Run() == nil //nolint:gosec // fixed argv
}
