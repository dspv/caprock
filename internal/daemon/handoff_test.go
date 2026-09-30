package daemon

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

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

// Clipping must never cut a rune in half. Handoffs carry whatever the agent
// wrote — Russian, Japanese, emoji — and invalid UTF-8 in a JSON reply is a
// reply Claude Code drops, which would make the feature fail silently on
// exactly the sessions that had the most to say.
func TestClippingNeverBreaksARune(t *testing.T) {
	for _, name := range []string{"cyrillic", "japanese", "emoji"} {
		var src string
		switch name {
		case "cyrillic":
			src = strings.Repeat("привет мир ", 400)
		case "japanese":
			src = strings.Repeat("日本語のテキスト ", 400)
		case "emoji":
			src = strings.Repeat("🔥 emoji heavy ", 400)
		}
		t.Run(name, func(t *testing.T) {
			got := clipRunes(src, handoffMaxRunes)
			if !utf8.ValidString(got) {
				t.Fatal("clipping produced invalid UTF-8")
			}
			if n := utf8.RuneCountInString(got); n > handoffMaxRunes+1 {
				t.Fatalf("clipped to %d runes, cap is %d", n, handoffMaxRunes)
			}
		})
	}
}

// Switched off means silent, and it takes effect on the next session rather
// than the next restart.
//
// Vova's objection, and it is a real one: "иногда необходим контекст а иногда
// нет". He had been bitten by an assistant that remembered he works in MLOps
// and volunteered it while he was asking about Rust. Memory that arrives
// uninvited is worse than none.
func TestSwitchedOffMeansSilent(t *testing.T) {
	now := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	d := handoffDaemon(t, now)
	said(t, d, "caprock", strings.Repeat("plenty worth handing over here. ", 20), now.Add(-time.Hour))
	p := hookd.Payload{HookEventName: "SessionStart", Source: "startup", Cwd: "/home/u/caprock"}

	if len(d.handoff(context.Background(), p)) == 0 {
		t.Fatal("nothing came back with memory on, so this test proves nothing")
	}

	off := false
	d.opt.Config.Memory = &off
	if reply := d.handoff(context.Background(), p); len(reply) > 0 {
		t.Fatalf("spoke while switched off: %s", reply)
	}

	on := true
	d.opt.Config.Memory = &on
	if len(d.handoff(context.Background(), p)) == 0 {
		t.Fatal("stayed silent after being switched back on")
	}
}

// A config written before this feature existed has no such field, and must get
// the feature rather than silently missing it — while a config that says false
// keeps saying false. That is why it is a pointer.
func TestAnOlderConfigGetsTheFeature(t *testing.T) {
	now := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	d := handoffDaemon(t, now) // Memory is nil, as an old config decodes
	said(t, d, "caprock", strings.Repeat("something to say. ", 40), now.Add(-time.Hour))
	if len(d.handoff(context.Background(), hookd.Payload{
		HookEventName: "SessionStart", Source: "startup", Cwd: "/home/u/caprock",
	})) == 0 {
		t.Fatal("a config with no memory field was treated as off")
	}
}

// With a holdout set, a session that could have had the handoff either gets it
// or is held back as the control — and which one is recorded, because the
// comparison is the only way to learn whether the handoff helps. A session
// with nothing to hand over is in neither group.
func TestTheHoldoutRecordsWhoGotTheHandoffAndWhoDidNot(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	d := handoffDaemon(t, now)
	d.opt.Config.MemoryHoldoutPct = 25
	said(t, d, "caprock", strings.Repeat("We moved the heartbeat into the daemon. ", 15), now.Add(-time.Hour))
	open := func(id string, roll int) []byte {
		t.Helper()
		if err := store.UpsertSession(ctx, d.store.DB(), id, store.SessionPatch{Cwd: "/home/u/caprock", Project: "caprock", StartedAt: now.UnixMilli()}); err != nil {
			t.Fatal(err)
		}
		d.roll = func() int { return roll }
		return d.handoff(ctx, hookd.Payload{HookEventName: "SessionStart", Source: "startup", Cwd: "/home/u/caprock", SessionID: id})
	}
	if got := contextOf(t, open("lucky", 60)); got == "" {
		t.Fatal("a roll above the holdout was not handed anything")
	}
	if reply := open("control", 10); len(reply) > 0 {
		t.Fatal("a roll inside the holdout was handed the note anyway")
	}
	// Nothing in this folder: no group at all.
	if err := store.UpsertSession(ctx, d.store.DB(), "stranger", store.SessionPatch{Cwd: "/home/u/elsewhere"}); err != nil {
		t.Fatal(err)
	}
	d.handoff(ctx, hookd.Payload{HookEventName: "SessionStart", Source: "startup", Cwd: "/home/u/elsewhere", SessionID: "stranger"})

	// The lucky one edits after two looks and five minutes; the control after
	// four looks and fifteen.
	tool := func(id, name string, at time.Time) {
		t.Helper()
		ev := &event.Event{SessionID: id, Source: event.SourceHook, Kind: event.KindToolPre, Tool: name, Key: id + name + at.String(), Ts: at, Payload: json.RawMessage(`{}`)}
		if _, err := store.InsertEvent(ctx, d.store.DB(), ev); err != nil {
			t.Fatal(err)
		}
	}
	for id, p := range map[string]struct{ looks, mins int }{"lucky": {2, 5}, "control": {4, 15}} {
		for i := 0; i < p.looks; i++ {
			tool(id, "Read", now.Add(time.Duration(i+1)*time.Second))
		}
		tool(id, "Edit", now.Add(time.Duration(p.mins)*time.Minute))
	}
	ms := d.memoryStatus()
	if ms.HoldoutPct != 25 || ms.Served == nil || ms.Withheld == nil {
		t.Fatalf("memory status = %+v, want both groups and the holdout", ms)
	}
	if *ms.Served != (store.HandoffGroup{Sessions: 1, Reached: 1, MedianMin: 5, MedianCall: 2}) {
		t.Errorf("served = %+v", *ms.Served)
	}
	if *ms.Withheld != (store.HandoffGroup{Sessions: 1, Reached: 1, MedianMin: 15, MedianCall: 4}) {
		t.Errorf("withheld = %+v", *ms.Withheld)
	}
}
