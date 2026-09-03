package daemon

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/hookd"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// A daemon with a store and a fixed clock, enough to answer a SessionStart.
func handoffDaemon(t *testing.T, now time.Time) *Daemon {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	tb, err := cost.Load("")
	if err != nil {
		t.Fatal(err)
	}
	rec := rollup.New(st, tb, nil, nil)
	rec.Now = func() time.Time { return now }
	return &Daemon{log: quietLog(), store: st, rec: rec}
}

// Put one assistant passage in a repository, said `ago` before now.
func said(t *testing.T, d *Daemon, project, text string, at time.Time) {
	t.Helper()
	ctx := context.Background()
	id := project + at.Format("150405.000")
	if err := store.UpsertSession(ctx, d.store.DB(), id, store.SessionPatch{Project: project}); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]string{"text": text})
	ev := &event.Event{
		SessionID: id, Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
		Key: "k" + id, Ts: at, Payload: payload,
	}
	if _, err := store.InsertEvent(ctx, d.store.DB(), ev); err != nil {
		t.Fatal(err)
	}
}

func contextOf(t *testing.T, reply []byte) string {
	t.Helper()
	if len(reply) == 0 {
		return ""
	}
	var out struct {
		H struct {
			Event string `json:"hookEventName"`
			Ctx   string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal(reply, &out); err != nil {
		t.Fatalf("reply is not the shape Claude Code reads: %v (%s)", err, reply)
	}
	if out.H.Event != "SessionStart" {
		t.Fatalf("hookEventName = %q, want SessionStart — Claude Code ignores anything else", out.H.Event)
	}
	return out.H.Ctx
}

// The whole point: a session opening where work already happened is handed what
// was left there. Verified against a live Claude Code session before this was
// written — the shape below is the one it actually reads.
func TestASessionOpeningKnownGroundIsHandedIt(t *testing.T) {
	now := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	d := handoffDaemon(t, now)
	said(t, d, "caprock", strings.Repeat("We settled on process liveness rather than a timeout. ", 12), now.Add(-2*time.Hour))

	got := contextOf(t, d.handoff(context.Background(), hookd.Payload{
		HookEventName: "SessionStart", Source: "startup", Cwd: "/home/u/caprock",
	}))
	if !strings.Contains(got, "process liveness") {
		t.Fatalf("nothing about the last session came back: %q", got)
	}
	// It must be marked as a record rather than something the user said, or the
	// agent will answer it as if it were an instruction.
	if !strings.Contains(got, "the user has not said this to you") {
		t.Errorf("the handoff does not say where it came from: %q", got)
	}
}

// SessionStart also fires on resume, on /clear and after compaction. Only a
// genuinely new session gets a handoff: a resume already holds the
// conversation, and re-injecting the same passage after every compaction turns
// a useful note into noise that grows with the session.
func TestOnlyAGenuinelyNewSessionIsHandedAnything(t *testing.T) {
	now := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	for _, source := range []string{"resume", "clear", "compact", "fork", ""} {
		d := handoffDaemon(t, now)
		said(t, d, "caprock", strings.Repeat("something substantial was decided here. ", 15), now.Add(-time.Hour))
		if reply := d.handoff(context.Background(), hookd.Payload{
			HookEventName: "SessionStart", Source: source, Cwd: "/home/u/caprock",
		}); len(reply) > 0 {
			t.Errorf("source %q was handed a briefing; only \"startup\" should be", source)
		}
	}
}

func TestHandoffStaysSilentWhenItHasNothingWorthSaying(t *testing.T) {
	now := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name  string
		setup func(d *Daemon)
		cwd   string
	}{
		{
			// A repository nobody has worked in. Silence, not an error.
			name: "no history at all", setup: func(*Daemon) {}, cwd: "/home/u/brand-new",
		},
		{
			// "Done." is true and says nothing about where the work stood.
			name:  "only one-liners",
			setup: func(d *Daemon) { said(t, d, "caprock", "Done.", now.Add(-time.Hour)) },
			cwd:   "/home/u/caprock",
		},
		{
			// Beyond a fortnight the last thing said is usually not what you
			// are returning to, and presenting it as context misleads.
			name: "too old to be context",
			setup: func(d *Daemon) {
				said(t, d, "caprock", strings.Repeat("a decision from another month entirely. ", 15), now.Add(-30*24*time.Hour))
			},
			cwd: "/home/u/caprock",
		},
		{
			// No cwd means no repository, so there is nothing to be about.
			name: "no working directory",
			setup: func(d *Daemon) {
				said(t, d, "caprock", strings.Repeat("plenty to say. ", 40), now.Add(-time.Hour))
			},
			cwd: "",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := handoffDaemon(t, now)
			tc.setup(d)
			if reply := d.handoff(context.Background(), hookd.Payload{
				HookEventName: "SessionStart", Source: "startup", Cwd: tc.cwd,
			}); len(reply) > 0 {
				t.Errorf("said something when it should have stayed quiet: %s", reply)
			}
		})
	}
}

// A handoff sits in front of a prompt and costs the session context window, so
// it is bounded — and Claude Code is reported to drop an oversized reply
// silently, which would make a too-long briefing worse than none.
func TestAHandoffIsBounded(t *testing.T) {
	now := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	d := handoffDaemon(t, now)
	said(t, d, "caprock", strings.Repeat("a very long conclusion indeed. ", 4000), now.Add(-time.Hour))

	got := contextOf(t, d.handoff(context.Background(), hookd.Payload{
		HookEventName: "SessionStart", Source: "startup", Cwd: "/home/u/caprock",
	}))
	if n := len([]rune(got)); n > handoffMaxRunes+300 { // +300 for the framing sentence
		t.Fatalf("handoff is %d runes; the passage alone is capped at %d", n, handoffMaxRunes)
	}
}

// The newest passage wins, and only from this repository.
func TestTheHandoffIsThisRepositorysMostRecent(t *testing.T) {
	now := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	d := handoffDaemon(t, now)
	said(t, d, "caprock", strings.Repeat("the older conclusion here. ", 20), now.Add(-5*time.Hour))
	said(t, d, "caprock", strings.Repeat("the newest conclusion here. ", 20), now.Add(-1*time.Hour))
	said(t, d, "elsewhere", strings.Repeat("a different repository entirely. ", 20), now.Add(-time.Minute))

	got := contextOf(t, d.handoff(context.Background(), hookd.Payload{
		HookEventName: "SessionStart", Source: "startup", Cwd: "/home/u/caprock",
	}))
	if !strings.Contains(got, "newest conclusion") {
		t.Errorf("did not hand back the most recent passage: %q", got)
	}
	if strings.Contains(got, "different repository") {
		t.Error("handed back another repository's work")
	}
}
