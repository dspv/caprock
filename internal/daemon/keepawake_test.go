package daemon

import (
	"context"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/keepawake"
	"github.com/dspv/caprock/internal/store"
)

// lastSaid records a session whose newest event is `kind`, said at `at`.
func lastSaid(t *testing.T, d *Daemon, id string, kind event.Kind, at time.Time, status string) {
	t.Helper()
	ctx := context.Background()
	if err := store.UpsertSession(ctx, d.store.DB(), id, store.SessionPatch{Project: "p", LastEventAt: at.UnixMilli(), Status: status}); err != nil {
		t.Fatal(err)
	}
	ev := &event.Event{SessionID: id, Source: event.SourceHook, Kind: kind, Tool: "Bash", Key: "k-" + id, Ts: at}
	if _, err := store.InsertEvent(ctx, d.store.DB(), ev); err != nil {
		t.Fatal(err)
	}
}

func TestWorkingSessionsCountsOnlyWorkInProgress(t *testing.T) {
	now := time.Now()
	d := handoffDaemon(t, now)
	lastSaid(t, d, "tool-running", event.KindToolPre, now.Add(-20*time.Minute), store.StatusIdle)
	lastSaid(t, d, "asking", event.KindPermissionPrompt, now.Add(-time.Minute), store.StatusActive)
	lastSaid(t, d, "turn-over", event.KindAgentStop, now.Add(-time.Minute), store.StatusActive)
	lastSaid(t, d, "silent", event.KindToolPre, now.Add(-keepawake.Silence-time.Minute), store.StatusIdle)
	lastSaid(t, d, "gone", event.KindToolPre, now.Add(-time.Minute), store.StatusEnded)

	n, err := d.workingSessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// A twenty-minute tool call and an open approval keep the machine awake;
	// a finished turn, half an hour of silence and an ended session do not.
	if n != 2 {
		t.Fatalf("working = %d, want 2", n)
	}
}

func TestKeepAwakeSettingDefaultsAndPersists(t *testing.T) {
	dir := t.TempDir()
	d := &Daemon{log: quietLog(), opt: Options{DataDir: dir}, baseCtx: context.Background()}
	a := &settingsAdapter{d: d}

	if got := a.Get().KeepAwake; got != keepawake.ModeWorking {
		t.Fatalf("default keep_awake = %q, want working", got)
	}
	// Writing back what was read must not write the default down.
	if err := a.Set(a.Get()); err != nil {
		t.Fatal(err)
	}
	if d.opt.Config.KeepAwake != "" {
		t.Fatalf("an unchanged default was stored as %q", d.opt.Config.KeepAwake)
	}
	in := a.Get()
	in.KeepAwake = keepawake.ModeOff
	if err := a.Set(in); err != nil {
		t.Fatal(err)
	}
	saved, err := config.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if saved.KeepAwake != keepawake.ModeOff || a.Get().KeepAwake != keepawake.ModeOff {
		t.Fatalf("off did not persist: disk %q, get %q", saved.KeepAwake, a.Get().KeepAwake)
	}
	// A settings write that does not name it keeps it.
	if err := a.Set(api.Settings{KeepAwake: ""}); err != nil {
		t.Fatal(err)
	}
	if a.Get().KeepAwake != keepawake.ModeOff {
		t.Fatal("an empty keep_awake reset the choice")
	}
}

// The quick replies are the defaults until changed, and writing back what
// was read never writes the defaults down; an emptied list stays empty.
func TestQuickRepliesDefaultsAndPersist(t *testing.T) {
	dir := t.TempDir()
	d := &Daemon{log: quietLog(), opt: Options{DataDir: dir}, baseCtx: context.Background()}
	a := &settingsAdapter{d: d}
	if got := a.Get().QuickReplies; len(got) != len(config.DefaultQuickReplies) {
		t.Fatalf("defaults = %+v", got)
	}
	if err := a.Set(a.Get()); err != nil {
		t.Fatal(err)
	}
	if d.opt.Config.QuickReplies != nil {
		t.Fatal("unchanged defaults were stored")
	}
	in := a.Get()
	in.QuickReplies = []config.QuickReply{}
	if err := a.Set(in); err != nil {
		t.Fatal(err)
	}
	saved, err := config.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if saved.QuickReplies == nil || len(*saved.QuickReplies) != 0 || len(a.Get().QuickReplies) != 0 {
		t.Fatalf("an emptied list did not persist: %+v", saved.QuickReplies)
	}
}

func TestKeepAwakeStatusWithoutAHolder(t *testing.T) {
	now := time.Now()
	d := handoffDaemon(t, now)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	d.startKeepAwake(ctx)
	st, ok := d.keepAwakeStatus().(keepawake.Status)
	if !ok {
		t.Fatalf("status is %T", d.keepAwakeStatus())
	}
	if st.Available || st.Holding || st.Mode != keepawake.ModeWorking {
		t.Fatalf("a daemon with no holder must report unavailable: %+v", st)
	}
}
