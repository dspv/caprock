package daemon

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/board"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/hive"
	"github.com/dspv/caprock/internal/hookd"
	"github.com/dspv/caprock/internal/orchestrator"
	"github.com/dspv/caprock/internal/store"
)

// fakeSpawner is a no-op Spawner so the orchestrator can register a worker
// mapping without launching a process.
type fakeSpawner struct{ n int }

func (f *fakeSpawner) Spawn(context.Context, agents.SpawnRequest) (*agents.Agent, error) {
	f.n++
	return &agents.Agent{SessionID: "sess-w"}, nil
}
func (f *fakeSpawner) Get(id string) (*agents.Agent, bool) { return &agents.Agent{SessionID: id}, true }
func (f *fakeSpawner) ClaudeAvailable() bool               { return true }
func (f *fakeSpawner) Input(string, []byte) error          { return nil }

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

// stopDecision must resolve a worker session to its hive agent, and — when that
// agent's inbox has unread mail — return a block decision that forces the worker
// to keep going. This exercises the composed Decide closure end to end
// (AgentIDForSession → StopDecision), which the individual unit tests don't.
func TestStopDecisionResolvesWorkerAndBlocksOnMail(t *testing.T) {
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	h, err := hive.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	b := board.New(h, st, bus.New(), log)
	orch := orchestrator.New(h, st, &fakeSpawner{}, t.TempDir(), log)
	// Register a worker so AgentIDForSession(sess-w) → "worker-1".
	sid, err := orch.SpawnWorker(context.Background(), "worker-1")
	if err != nil {
		t.Fatal(err)
	}
	// Put unread mail in worker-1's inbox.
	if _, err := h.Send(hive.Message{From: "orchestrator", To: "worker-1", Kind: hive.KindAssign, Body: "do it"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Deliver(); err != nil {
		t.Fatal(err)
	}

	d := &Daemon{store: st, log: log, bus: bus.New(), board: b, orch: orch}
	// A Stop from the worker's session (AgentID empty ⇒ resolved via the orch map).
	body := d.stopDecision(context.Background(), hookd.Payload{SessionID: sid})
	if body == nil || !strings.Contains(string(body), `"decision":"block"`) {
		t.Fatalf("expected a block decision for a worker with unread mail, got %s", body)
	}
	// A session with no agent mapping (a top-level Claude session) is always
	// allowed to stop — the resolve returns "" and StopDecision returns nil.
	if d.stopDecision(context.Background(), hookd.Payload{SessionID: "unknown"}) != nil {
		t.Fatal("a top-level/unknown session should be allowed to stop")
	}
}
