package daemon

import (
	"slices"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/hooks"
)

// hooksOnEvery is how often whether the hooks are registered is read again:
// a settings file read per session summary would be a read per row.
const hooksOnEvery = time.Minute

// hookState caches whether Caprock's SessionStart hook is registered in
// Claude Code's user settings.
type hookState struct {
	mu sync.Mutex
	at time.Time
	on bool
}

// hooksOn reports whether Caprock's hooks are registered in Claude Code's
// user settings, read at most once a minute. With them off (`--no-hooks`,
// or removed by hand) a session of Caprock's sends no hook by design, and
// its silence says nothing about a prompt (api Deps.HooksOn, #1118).
func (d *Daemon) hooksOn() bool {
	d.hookSt.mu.Lock()
	defer d.hookSt.mu.Unlock()
	if !d.hookSt.at.IsZero() && time.Since(d.hookSt.at) < hooksOnEvery {
		return d.hookSt.on
	}
	d.hookSt.at = time.Now()
	d.hookSt.on = false
	sp, err := hooks.DefaultSettingsPath()
	if err != nil {
		return false
	}
	st, err := hooks.Inspect(sp, hooks.ShimCommand(d.opt.DataDir))
	if err != nil {
		return false
	}
	d.hookSt.on = slices.Contains(st.Installed, "SessionStart")
	return d.hookSt.on
}
