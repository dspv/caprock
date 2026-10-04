package codex

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/sessionlink"
	"github.com/dspv/caprock/internal/store"
)

// putAs writes the fixture rollout as if a given program wrote it, at a given
// thread start. The fixture is Codex Desktop's; the TUI's differs only in
// originator and source (measured on 0.154–0.160 rollouts: "codex-tui", "cli").
func (h *harness) putAs(name, originator, source, started string) {
	h.t.Helper()
	b, err := os.ReadFile(fixture)
	if err != nil {
		h.t.Fatal(err)
	}
	const who, when = `"originator": "Codex Desktop", "source": "vscode"`, `"timestamp": "2026-09-06T08:32:41.828Z"`
	if !strings.Contains(string(b), who) || !strings.Contains(string(b), when) {
		h.t.Fatal("fixture shape changed; the rewrite would match nothing")
	}
	s := strings.Replace(string(b), who, `"originator": "`+originator+`", "source": "`+source+`"`, 1)
	s = strings.Replace(s, when, `"timestamp": "`+started+`"`, 1)
	sub := filepath.Join(h.dir, "2026", "09", "06")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		h.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, name), []byte(s), 0o600); err != nil {
		h.t.Fatal(err)
	}
}

const fixtureThread = "01a075d9-2b63-7200-b3e2-bfeac9416f15"

// spawned records a session Caprock started, as agents.Manager does, and tells
// the linker to expect its thread.
func (h *harness) spawned(id string, at time.Time) {
	h.t.Helper()
	ctx := context.Background()
	st := h.in.rec.Store
	if err := store.UpsertSession(ctx, st.DB(), id, store.SessionPatch{Cwd: "/Users/dev/proj", Agent: Agent}); err != nil {
		h.t.Fatal(err)
	}
	if err := store.MarkOwned(ctx, st.DB(), id, "", "codex --no-daemon", 4242); err != nil {
		h.t.Fatal(err)
	}
	l := sessionlink.New(st, nil)
	l.Expect(Agent, id, "/Users/dev/proj", at, true)
	h.in.Link = l
}

func mustTime(t *testing.T, s string) time.Time {
	t.Helper()
	v, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// A thread the TUI Caprock started is filed under Caprock's session, so the
// terminal and the cost are one page; the agent's own id is kept for resume.
func TestASpawnedTUIThreadIsStoredUnderTheSessionThatStartedIt(t *testing.T) {
	h := newHarness(t)
	h.spawned("cap-1", mustTime(t, "2026-09-06T08:32:40Z"))
	h.putAs("rollout-a.jsonl", "codex-tui", "cli", "2026-09-06T08:32:41.828Z")
	h.poll()

	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE session_id='cap-1' AND kind='turn.assistant'`); n != 2 {
		t.Errorf("%d turns under the spawned session, want 2", n)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM sessions WHERE session_id='`+fixtureThread+`'`); n != 0 {
		t.Error("the thread was also stored under its own id: one session shown twice")
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM sessions WHERE session_id='cap-1' AND native_id='`+fixtureThread+`'`); n != 1 {
		t.Error("the link was not stored, so resume and a restart cannot find the thread")
	}
	// A re-read after the link is in the store, with a fresh in-memory cache,
	// still goes to the same place.
	h.in.Link = sessionlink.New(h.in.rec.Store, nil)
	h.in.seen = map[string]fileState{}
	h.poll()
	if n := count(t, h.out, `SELECT COUNT(*) FROM sessions WHERE agent='codex'`); n != 1 {
		t.Errorf("%d codex sessions after a re-read, want 1", n)
	}
}

// What makes the match a heuristic, pinned case by case: only the TUI, only
// the folder, only a thread that started with the spawn.
func TestOnlyAMatchingThreadIsTaken(t *testing.T) {
	for name, tc := range map[string]struct{ originator, source, started string }{
		"desktop app in the same folder": {"Codex Desktop", "vscode", "2026-09-06T08:32:41.828Z"},
		"a thread started minutes later": {"codex-tui", "cli", "2026-09-06T08:40:00Z"},
		"a thread from before the spawn": {"codex-tui", "cli", "2026-09-06T08:30:00Z"},
		"the TUI under its older name":   {"codex_cli_rs", "cli", "2026-09-06T08:32:41.828Z"},
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			h.spawned("cap-1", mustTime(t, "2026-09-06T08:32:40Z"))
			h.putAs("rollout-a.jsonl", tc.originator, tc.source, tc.started)
			h.poll()
			linked := count(t, h.out, `SELECT COUNT(*) FROM events WHERE session_id='cap-1'`) > 0
			want := tc.originator == "codex_cli_rs"
			if linked != want {
				t.Fatalf("linked=%v, want %v", linked, want)
			}
		})
	}
}

// With nothing waiting, the importer behaves exactly as it always has.
func TestNoLinkerChangesNothing(t *testing.T) {
	h := newHarness(t)
	h.putAs("rollout-a.jsonl", "codex-tui", "cli", "2026-09-06T08:32:41.828Z")
	h.poll()
	if n := count(t, h.out, `SELECT COUNT(*) FROM sessions WHERE session_id='`+fixtureThread+`'`); n != 1 {
		t.Fatal("an ordinary TUI thread was not stored under its own id")
	}
}
