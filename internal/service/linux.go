package service

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// linuxUserUnitDir is ~/.config/systemd/user, honouring XDG_CONFIG_HOME the way
// systemd itself does — a user who has moved their config dir would otherwise
// get a unit systemd never reads.
func linuxUserUnitDir(home string) string {
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, "systemd", "user")
	}
	return filepath.Join(home, ".config", "systemd", "user")
}

// renderUnit writes the systemd *user* unit. Notes on the choices:
//
//   - Type=simple + --foreground: systemd tracks the process it started, so the
//     daemon must not detach.
//   - Restart=on-failure, not always: `caprock down` exits 0 and must stay
//     down. This is the systemd equivalent of launchd's SuccessfulExit=false.
//   - WantedBy=default.target: the user-session equivalent of multi-user; this
//     is what `systemctl --user enable` links against.
//   - No [Install] Alias, no RestartSec heroics: a failing daemon that restarts
//     every 5s is loud enough to notice, and StartLimit stops a crash loop.
//
// The daemon logs to its own file in the data dir; systemd's journal gets
// stdout/stderr as well, which is where a start failure shows up
// (`journalctl --user -u caprock`).
func renderUnit(p Plan) string {
	var b strings.Builder
	b.WriteString("[Unit]\n")
	b.WriteString("Description=Caprock — mission control for Claude Code\n")
	b.WriteString("Documentation=https://github.com/dspv/caprock\n")
	b.WriteString("After=default.target\n")
	// StartLimit* live in [Unit], not [Service] — they moved there in systemd
	// v229 and a v229+ systemd *ignores* them under [Service] with only a log
	// warning, which would leave a daemon that cannot bind its port restarting
	// every five seconds forever.
	b.WriteString("StartLimitIntervalSec=300\n")
	b.WriteString("StartLimitBurst=5\n\n")

	b.WriteString("[Service]\n")
	b.WriteString("Type=simple\n")
	b.WriteString("ExecStart=" + unitEscape(p.Exe) + " " + unitArgs(p) + "\n")
	if p.DataDir != "" {
		b.WriteString("Environment=CAPROCK_DATA_DIR=" + unitEscape(p.DataDir) + "\n")
	}
	b.WriteString("Restart=on-failure\n")
	b.WriteString("RestartSec=5\n")
	// This is a watcher, not the user's foreground work.
	b.WriteString("Nice=5\n")
	b.WriteString("IOSchedulingClass=idle\n\n")

	b.WriteString("[Install]\n")
	b.WriteString("WantedBy=default.target\n")
	return b.String()
}

func unitArgs(p Plan) string {
	parts := make([]string, 0, len(p.Args()))
	for _, a := range p.Args() {
		parts = append(parts, unitEscape(a))
	}
	return strings.Join(parts, " ")
}

// unitEscape quotes a value for a systemd unit line. systemd splits ExecStart on
// whitespace and treats `%` as a specifier, so a path with a space (or a `%`)
// would otherwise produce a unit that fails to start with an unhelpful message.
func unitEscape(s string) string {
	s = strings.ReplaceAll(s, "%", "%%")
	if strings.ContainsAny(s, " \t\"\\") {
		s = strings.ReplaceAll(s, `\`, `\\`)
		s = strings.ReplaceAll(s, `"`, `\"`)
		return `"` + s + `"`
	}
	return s
}

// errNoSystemd is what every systemd entry point returns when this machine
// cannot run a user unit: no systemctl on PATH, or a session that is not a
// systemd user session (a container, a bare X session, WSL1, some minimal
// distros). The message says what to do instead rather than leaking a
// "connection refused to /run/user/1000/systemd/private" from systemctl.
var errNoSystemd = errors.New(
	"systemd user sessions are not available here (no `systemctl --user`)\n" +
		"Add `caprock up` to your desktop session's autostart, or your shell profile, instead")

// haveSystemdUser reports whether a user unit can actually be managed. Both
// halves matter: systemctl can exist while the user manager does not run.
func haveSystemdUser() bool {
	if _, err := exec.LookPath("systemctl"); err != nil {
		return false
	}
	return exec.Command("systemctl", "--user", "is-system-running").Run() == nil ||
		exec.Command("systemctl", "--user", "show", "--property=Version").Run() == nil //nolint:gosec // fixed argv
}

// linuxLoad reloads the unit files and enables + starts the unit. `enable --now`
// is idempotent: re-running it on an enabled unit relinks and leaves it running.
func linuxLoad() error {
	if !haveSystemdUser() {
		return errNoSystemd
	}
	if out, err := exec.Command("systemctl", "--user", "daemon-reload").CombinedOutput(); err != nil { //nolint:gosec // fixed argv
		return fmt.Errorf("systemctl --user daemon-reload: %w: %s", err, strings.TrimSpace(string(out)))
	}
	if out, err := exec.Command("systemctl", "--user", "enable", "--now", "caprock.service").CombinedOutput(); err != nil { //nolint:gosec // fixed argv
		return fmt.Errorf("systemctl --user enable --now caprock.service: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// linuxUnload stops and disables the unit. Every step is best-effort: uninstall
// must succeed even when systemd never knew about the unit (the file was
// written but `enable` failed, say).
func linuxUnload() error {
	if !haveSystemdUser() {
		return nil // nothing systemd-side to undo; the file removal still happens
	}
	_ = exec.Command("systemctl", "--user", "disable", "--now", "caprock.service").Run() //nolint:gosec // fixed argv
	_ = exec.Command("systemctl", "--user", "daemon-reload").Run()                       //nolint:gosec // fixed argv
	return nil
}

// linuxRegistered reports whether systemd has the unit enabled — i.e. whether it
// will actually come back at the next login, which is the question `service
// status` is really asking.
func linuxRegistered() bool {
	if !haveSystemdUser() {
		return false
	}
	out, err := exec.Command("systemctl", "--user", "is-enabled", "caprock.service").Output() //nolint:gosec // fixed argv
	if err != nil {
		return false
	}
	switch strings.TrimSpace(string(out)) {
	case "enabled", "enabled-runtime", "linked", "linked-runtime", "static":
		return true
	}
	return false
}
