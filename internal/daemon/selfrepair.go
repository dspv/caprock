package daemon

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/dspv/caprock/internal/hooks"
	"github.com/dspv/caprock/internal/version"
)

// releaseVersion is a tagged release's version, with or without the v.
var releaseVersion = regexp.MustCompile(`^v?[0-9]+\.[0-9]+\.[0-9]+$`)

// isRelease reports whether v is a released build's version (`0.147.0`,
// `v0.147.0`), not `dev` or a `git describe` of an untagged commit.
func isRelease(v string) bool { return releaseVersion.MatchString(v) }

// repairHookPaths is the start-up self-repair of what Caprock itself wrote
// for Claude Code: the data-dir shim brought up to this binary
// (hooks.EnsureShim), then our hook and statusLine commands in
// ~/.claude/settings.json pointed at this install when they run a binary
// that is gone or is another one (hooks.RepairPaths). A user's 0.147.0 daemon
// was fed by a 0.31.2 shim and its status line ran an uninstalled Homebrew
// caprock; nothing had replaced either since August.
//
// Only a released caprock binary does this. A test binary, a renamed
// preview build, or a development build (`make dev`, a worktree's daemon:
// version `dev` or a `git describe` with a suffix) must not rewrite anyone's
// settings.json: it would point the machine's hooks at a binary that goes
// away with the worktree.
func (d *Daemon) repairHookPaths() {
	self, err := os.Executable()
	if err != nil || strings.TrimSuffix(filepath.Base(self), ".exe") != "caprock" || !isRelease(version.Version) {
		return
	}
	if err := hooks.EnsureShim(d.opt.DataDir); err != nil {
		d.log.Warn("hook shim not refreshed", "component", "hooks", "err", err)
	}
	sp, err := hooks.DefaultSettingsPath()
	if err != nil {
		return
	}
	statusline := hooks.ShellCommand(stablePath(self)) + " statusline"
	r, err := hooks.RepairPaths(sp, hooks.ShimCommand(d.opt.DataDir), statusline)
	if err != nil {
		d.log.Warn("hook paths not repaired", "component", "hooks", "settings", sp, "err", err)
		return
	}
	if r.Changed() {
		d.log.Info("hook paths repaired", "component", "hooks", "settings", sp, "hooks", r.Hooks, "statusline", r.Statusline)
	}
}
