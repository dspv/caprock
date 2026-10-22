package daemon

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
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

// A print-mode run caught by the stop is finished work, not interrupted work:
// four `claude -p` jobs another tool started filled the owner's banner with
// Continue buttons (2026-10-22). The transcript says how the session was
// started (`"entrypoint":"sdk-cli"`); an interactive one (`"cli"`) and one
// whose transcript is gone stay. A record written before this, holding a
// print run, drops it on read.
func TestAPrintModeRunIsNotInterrupted(t *testing.T) {
	ctx := context.Background()
	stop := time.Now().Add(-time.Hour)
	d := handoffDaemon(t, time.Now())
	db := d.store.DB()
	ms := func(t time.Time) int64 { return t.UnixMilli() }
	fixture := func(name string) string {
		p, err := filepath.Abs(filepath.Join("..", "..", "testdata", "transcripts", name))
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	for id, p := range map[string]store.SessionPatch{
		"print":       {Cwd: "/", TranscriptPath: fixture("print_mode.jsonl")},
		"interactive": {Cwd: "/w", TranscriptPath: fixture("normal.jsonl")},
		"no-file":     {Cwd: "/w", TranscriptPath: filepath.Join(t.TempDir(), "gone.jsonl")},
	} {
		p.StartedAt, p.LastEventAt, p.WorkedAt = ms(stop.Add(-time.Hour)), ms(stop.Add(-20*time.Minute)), ms(stop.Add(-20*time.Minute))
		p.Status = store.StatusEnded
		if err := store.UpsertSession(ctx, db, id, p); err != nil {
			t.Fatal(err)
		}
	}
	if got := transcriptEntrypoint(fixture("print_mode.jsonl")); got != "sdk-cli" {
		t.Fatalf("print-mode entrypoint = %q, want sdk-cli", got)
	}
	if got := transcriptEntrypoint(fixture("normal.jsonl")); got != "cli" {
		t.Fatalf("interactive entrypoint = %q, want cli", got)
	}

	d.recordInterrupted(ctx, ms(stop), []string{"print", "interactive", "no-file"})
	got := d.interrupted(ctx)
	if got == nil || len(got.IDs) != 2 || got.IDs[0] != "interactive" || got.IDs[1] != "no-file" {
		t.Fatalf("interrupted = %+v, want interactive and no-file", got)
	}

	// The record an older daemon wrote, print run included.
	b, _ := json.Marshal(Interrupted{StoppedAt: ms(stop), IDs: []string{"print", "interactive"}})
	if err := d.store.SetMeta(ctx, store.MetaInterrupted, string(b)); err != nil {
		t.Fatal(err)
	}
	if got := d.interrupted(ctx); got == nil || len(got.IDs) != 1 || got.IDs[0] != "interactive" {
		t.Fatalf("old record read as %+v, want interactive only", got)
	}
}
