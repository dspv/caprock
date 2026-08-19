package daemon

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/store"
)

// maybeAutoPause must never pause a session Caprock did not spawn, and must do
// nothing when auto-pause is off — the "we never signal a process we did not
// start" rule at the auto-pause layer.
func TestMaybeAutoPauseRespectsOwnershipAndOptIn(t *testing.T) {
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	mgr := agents.NewManager(st, t.TempDir(), "", log)

	newD := func(autoPause bool) *Daemon {
		return &Daemon{
			store: st,
			log:   log,
			bus:   bus.New(),
			mgr:   mgr,
			opt:   Options{Config: config.Config{AutoPause: autoPause}},
		}
	}

	// Auto-pause off: never pauses.
	if newD(false).maybeAutoPause("whatever") {
		t.Fatal("paused while auto-pause is off")
	}
	// Auto-pause on but the session is not one Caprock spawned: must NOT pause
	// (mgr has no spawned sessions, so Get returns not-owned).
	if newD(true).maybeAutoPause("external-session") {
		t.Fatal("paused a session Caprock did not spawn")
	}
}
