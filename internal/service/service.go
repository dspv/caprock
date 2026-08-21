// Package service registers the Caprock daemon with the operating system's own
// login-time supervisor, so it comes back after a reboot without the user
// running `caprock up` by hand.
//
// Why this exists: a monitoring tool you have to restart manually is a tool you
// stop trusting. The daemon already survives a closed terminal (`caprock up`
// detaches), but nothing brings it back after a reboot.
//
// Three mechanisms, one per OS, all of them user-level — nothing here needs
// root, an installer, or a system-wide daemon, and nothing is written outside
// the user's own config/home locations (never `~/.claude/`):
//
//   - macOS  — a LaunchAgent plist in ~/Library/LaunchAgents, loaded with
//     `launchctl bootstrap gui/<uid>`.
//   - Linux  — a systemd *user* unit in ~/.config/systemd/user, enabled with
//     `systemctl --user enable --now`.
//   - Windows — a .cmd script in the per-user Startup folder. See
//     windowsStartupDir for why not a Scheduled Task.
//
// The generated file always runs the daemon in the *foreground*: every one of
// these supervisors tracks the process it started, so the double-fork that
// `caprock up` normally does would make the supervisor think the daemon exited
// immediately and restart it forever.
//
// Layering: this package generates and inspects the definition files (pure
// functions over a Plan, testable on every OS) and shells out to the platform
// tool only in Load/Unload/Running. The command layer in cmd/caprock owns the
// printing.
package service

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Label is the reverse-DNS identifier used by launchd and, as a stem, by the
// systemd unit and the Windows startup script. Changing it orphans existing
// installs, so it is a constant, not a setting.
const Label = "dev.caprock.daemon"

// Plan is everything the generated definition needs. It is resolved once by
// NewPlan and then passed to the pure generator functions, which is what makes
// the file contents testable on an OS other than the one they target.
type Plan struct {
	// Exe is the absolute path of the caprock binary to run. Always
	// os.Executable() in production — a bare "caprock" would depend on a PATH
	// that login agents do not reliably have.
	Exe string
	// DataDir is the resolved Caprock data directory. It is passed to the
	// daemon through CAPROCK_DATA_DIR so a user who runs with a custom data
	// dir keeps it after a reboot.
	DataDir string
	// Port is the port the service listens on, taken from the user's
	// config.json (or --port at install time).
	Port int
	// HiveDir, when non-empty, enables Phase 2 orchestration at login.
	HiveDir string
	// Home is the user's home directory. Injected rather than looked up so
	// tests never touch the real home.
	Home string
	// GOOS selects the mechanism. Defaults to runtime.GOOS; tests set it to
	// generate every platform's file from one machine.
	GOOS string
}

// os returns the target OS, defaulting to the one we are running on.
func (p Plan) os() string {
	if p.GOOS != "" {
		return p.GOOS
	}
	return runtime.GOOS
}

// OS is the target OS this plan generates for. Exported so the command layer
// can tailor its output (the Windows caveat) without duplicating the default.
func (p Plan) OS() string { return p.os() }

// NewPlan resolves a plan from the running process. exe is normally
// os.Executable(); it is a parameter so tests do not depend on the test binary's
// own path.
func NewPlan(exe, dataDir string, port int, hiveDir string) (Plan, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Plan{}, fmt.Errorf("resolve home directory: %w", err)
	}
	abs, err := filepath.Abs(exe)
	if err != nil {
		return Plan{}, fmt.Errorf("resolve %s: %w", exe, err)
	}
	return Plan{Exe: abs, DataDir: dataDir, Port: port, HiveDir: hiveDir, Home: home}, nil
}

// Args is the argument vector the installed service runs, after the binary
// itself. --foreground because the supervisor does the supervising; --no-open
// because nobody wants a browser tab at every login; --no-hooks because hook
// and statusline registration is a consent decision that belongs to an
// interactive `caprock up`, not to a login agent.
func (p Plan) Args() []string {
	args := []string{"up", "--foreground", "--no-open", "--no-hooks"}
	if p.Port > 0 {
		args = append(args, "--port", fmt.Sprint(p.Port))
	}
	if p.HiveDir != "" {
		args = append(args, "--hive", p.HiveDir)
	}
	return args
}

// Path is where this platform's definition file lives.
func (p Plan) Path() (string, error) {
	switch p.os() {
	case "darwin":
		return filepath.Join(p.Home, "Library", "LaunchAgents", Label+".plist"), nil
	case "windows":
		dir, err := windowsStartupDir(p.Home)
		if err != nil {
			return "", err
		}
		return filepath.Join(dir, "caprock.cmd"), nil
	case "linux":
		return filepath.Join(linuxUserUnitDir(p.Home), "caprock.service"), nil
	default:
		return "", fmt.Errorf("caprock service is not supported on %s — start the daemon with `caprock up` instead", p.os())
	}
}

// LogPath is where the supervisor's own stdout/stderr for the daemon goes. It
// sits in the data dir next to caprock.log, so `caprock service` never writes
// outside the user's Caprock directory.
func (p Plan) LogPath() string { return filepath.Join(p.DataDir, "service.log") }

// Render produces the exact bytes of the definition file for this platform,
// plus the mode to write it with. It is a pure function of the plan — no
// filesystem, no subprocess — which is what lets one machine's tests assert all
// three platforms' output.
func (p Plan) Render() ([]byte, os.FileMode, error) {
	switch p.os() {
	case "darwin":
		return []byte(renderPlist(p)), 0o644, nil
	case "linux":
		return []byte(renderUnit(p)), 0o644, nil
	case "windows":
		return []byte(renderStartupCmd(p)), 0o644, nil
	default:
		_, err := p.Path() // reuse the one unsupported-OS message
		return nil, 0, err
	}
}

// Installed reports whether a definition file written by Caprock is present,
// and whether its contents already match what this plan would write. A file
// that exists but differs (an upgrade moved the binary, the port changed) is
// "installed but stale" — install rewrites it, which is what makes install
// idempotent without duplicating anything.
func (p Plan) Installed() (present, current bool, path string, err error) {
	path, err = p.Path()
	if err != nil {
		return false, false, "", err
	}
	have, err := os.ReadFile(path) //nolint:gosec // a path we composed from the user's own home
	if os.IsNotExist(err) {
		return false, false, path, nil
	}
	if err != nil {
		return false, false, path, err
	}
	want, _, err := p.Render()
	if err != nil {
		return false, false, path, err
	}
	return true, normalizeEOL(have) == normalizeEOL(want), path, nil
}

// Write creates the definition file (and its directory), replacing any previous
// version. Writing the same plan twice leaves exactly one file with the same
// contents — the whole of install's idempotency, since the load step below is
// itself idempotent per platform.
func (p Plan) Write() (string, error) {
	path, err := p.Path()
	if err != nil {
		return "", err
	}
	body, mode, err := p.Render()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", fmt.Errorf("create %s: %w", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, body, mode); err != nil {
		return "", fmt.Errorf("write %s: %w", path, err)
	}
	return path, nil
}

// Remove deletes the definition file. A missing file is not an error — that is
// the clean no-op uninstall promises.
func (p Plan) Remove() (removed bool, path string, err error) {
	path, err = p.Path()
	if err != nil {
		return false, "", err
	}
	err = os.Remove(path)
	if os.IsNotExist(err) {
		return false, path, nil
	}
	if err != nil {
		return false, path, err
	}
	return true, path, nil
}

// normalizeEOL makes the installed-vs-rendered comparison immune to a file that
// picked up CRLF (the Windows .cmd is written with CRLF deliberately; an editor
// or a git checkout may normalize either way). Without this, `service status`
// on Windows would report a correct install as stale forever.
func normalizeEOL(b []byte) string {
	return strings.ReplaceAll(string(b), "\r\n", "\n")
}
