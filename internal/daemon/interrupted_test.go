package daemon

import (
	"context"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// The case from FB-038: an OS update restarts the machine with sessions open.
// The next start has to name those sessions — not the ones closed hours
// before, not one that survived the stop, not an imported Codex session.
func TestARestartNamesTheSessionsItCutOff(t *testing.T) {
	ctx := context.Background()
	stop := time.Now().Add(-time.Hour)
	d := handoffDaemon(t, time.Now())
	db := d.store.DB()
	put := func(id string, p store.SessionPatch) {
		t.Helper()
		if p.Cwd == "" {
			p.Cwd = "/w"
		}
		if err := store.UpsertSession(ctx, db, id, p); err != nil {
			t.Fatal(err)
		}
	}
	ms := func(t time.Time) int64 { return t.UnixMilli() }
	// Open at the stop, process gone since (pid 0 and quiet: the sweep ends it).
	put("cut", store.SessionPatch{StartedAt: ms(stop.Add(-2 * time.Hour)), LastEventAt: ms(stop.Add(-20 * time.Minute)), WorkedAt: ms(stop.Add(-20 * time.Minute))})
	// Closed by the stop itself: its end arrived with the shutdown.
	put("closed-by-stop", store.SessionPatch{StartedAt: ms(stop.Add(-3 * time.Hour)), LastEventAt: ms(stop.Add(30 * time.Second)), WorkedAt: ms(stop.Add(-time.Hour)), Status: store.StatusEnded})
	// Finished long before the stop.
	put("done-earlier", store.SessionPatch{StartedAt: ms(stop.Add(-5 * time.Hour)), LastEventAt: ms(stop.Add(-4 * time.Hour)), WorkedAt: ms(stop.Add(-4 * time.Hour)), Status: store.StatusEnded})
	// Outlived the stop: its process is still here, and has been heard from
	// since — after this machine booted, which on a fresh CI runner is minutes
	// ago, so a session last heard from an hour back would be ended by that.
	put("survived", store.SessionPatch{StartedAt: ms(stop.Add(-time.Hour)), LastEventAt: ms(time.Now()), WorkedAt: ms(stop.Add(-time.Minute)), PID: os.Getpid()})
	// Imported history has no process to lose.
	put("codex", store.SessionPatch{StartedAt: ms(stop.Add(-time.Hour)), LastEventAt: ms(stop.Add(-time.Minute)), WorkedAt: ms(stop.Add(-time.Minute)), Agent: "codex"})
	if err := d.store.SetMeta(ctx, store.MetaAliveAt, strconv.FormatInt(ms(stop), 10)); err != nil {
		t.Fatal(err)
	}

	at := d.lastAlive(ctx)
	running, err := store.RunningAt(ctx, db, at, maxInterrupted)
	if err != nil {
		t.Fatal(err)
	}
	if err := d.rec.MarkIdle(ctx, time.Minute, 10*time.Minute); err != nil {
		t.Fatal(err)
	}
	d.recordInterrupted(ctx, at, running)

	got := d.interrupted(ctx)
	if got == nil || got.StoppedAt != ms(stop) {
		t.Fatalf("interrupted = %+v, want a record dated at the stop", got)
	}
	want := map[string]bool{"cut": true, "closed-by-stop": true}
	if len(got.IDs) != len(want) {
		t.Fatalf("ids = %v, want %v", got.IDs, want)
	}
	for _, id := range got.IDs {
		if !want[id] {
			t.Fatalf("ids = %v: %q was not cut off by the stop", got.IDs, id)
		}
	}

	// A second restart with nothing running keeps the record.
	d.recordInterrupted(ctx, ms(time.Now()), nil)
	if d.interrupted(ctx) == nil {
		t.Fatal("a quiet restart erased the sessions the reboot before it cut off")
	}

	// Continuing one takes it off the list; continuing both clears it.
	put("cut", store.SessionPatch{Status: store.StatusActive, LastEventAt: ms(time.Now())})
	if got := d.interrupted(ctx); got == nil || len(got.IDs) != 1 || got.IDs[0] != "closed-by-stop" {
		t.Fatalf("after continuing one: %+v", got)
	}
	put("closed-by-stop", store.SessionPatch{Status: store.StatusActive, LastEventAt: ms(time.Now())})
	if got := d.interrupted(ctx); got != nil {
		t.Fatalf("after continuing both: %+v, want nothing", got)
	}
}
