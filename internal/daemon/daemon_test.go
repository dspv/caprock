package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/board"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/hive"
	"github.com/dspv/caprock/internal/hookd"
	"github.com/dspv/caprock/internal/loop"
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

// Turning the task runner on used to require restarting the daemon with a flag,
// which is why the Tasks screen could only offer a command to paste into a
// terminal. Everything the board needs — the store, the bus, the session
// manager, the logger — is already running, so enabling it live must produce a
// board that actually works: the task endpoints answer, the hive directory is
// created and seeded, and the Stop-loop starts consulting it.
func TestEnableHiveTurnsTheRunnerOnWithoutARestart(t *testing.T) {
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx := context.Background()
	d := &Daemon{
		store: st, log: log, bus: bus.New(), baseCtx: ctx,
		mgr: agents.NewManager(st, t.TempDir(), "", log),
		opt: Options{Config: config.Defaults()},
		// status() reads both unconditionally.
		table: &cost.Table{}, det: loop.New(5, time.Minute),
	}
	ad := &boardAdapter{d: d}

	// Off: the API reports it off, and the Stop hook has no board to consult.
	if ad.Enabled() {
		t.Fatal("the task runner reports itself on before anything enabled it")
	}
	if reply := d.stopDecision(ctx, hookd.Payload{SessionID: "s1"}); reply != nil {
		t.Fatalf("the Stop hook decided something with no board: %s", reply)
	}
	if _, err := ad.List(ctx); err == nil {
		t.Fatal("the board answered a list request while the runner was off")
	}

	// On — over the running daemon, no restart.
	dir := filepath.Join(t.TempDir(), "queue")
	repo := t.TempDir()
	out, err := ad.Enable(ctx, dir, repo)
	if err != nil {
		t.Fatalf("enable: %v", err)
	}
	if m, _ := out.(map[string]string); m["hive"] != dir || m["repo"] != repo {
		t.Fatalf("enable did not report what it opened: %v", out)
	}
	if !ad.Enabled() {
		t.Fatal("the runner is still off after being enabled")
	}
	// The queue directory is created for the user, seeded so it explains itself.
	if _, err := os.Stat(filepath.Join(dir, "README.md")); err != nil {
		t.Fatalf("the queue directory was not created and seeded: %v", err)
	}
	// The board is live: it answers, and it can take a task.
	if _, err := ad.Create(ctx, map[string]any{
		"title": "x", "done_criteria": []any{"go test ./..."},
	}); err != nil {
		t.Fatalf("create on a runner enabled at runtime: %v", err)
	}
	list, err := ad.List(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	// The seeded example task is there too — the point is that the new one is.
	rows, _ := list.([]store.TaskRow)
	var found bool
	for _, r := range rows {
		if r.Title == "x" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the board does not hold the task it just created: %#v", rows)
	}
	// /v1/status must follow, or the dashboard keeps rendering the off state.
	if s, _ := d.status(ctx).(Status); !s.Orchestration || s.Hive != dir || s.Repo != repo {
		t.Fatalf("status still reports the runner off: %+v", s)
	}
	// And the Stop hook consults the board now, without the daemon restarting —
	// it is wired unconditionally precisely so this works.
	if d.board == nil {
		t.Fatal("no board after enabling")
	}
}

// A second Enable over a different directory would leave the first board's
// router running against task files nobody is looking at.
func TestEnableHiveRefusesASecondHive(t *testing.T) {
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx := context.Background()
	d := &Daemon{
		store: st, log: log, bus: bus.New(), baseCtx: ctx,
		mgr: agents.NewManager(st, t.TempDir(), "", log),
		opt: Options{Config: config.Defaults()},
	}
	first := filepath.Join(t.TempDir(), "one")
	if _, err := (&boardAdapter{d: d}).Enable(ctx, first, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	_, err = (&boardAdapter{d: d}).Enable(ctx, filepath.Join(t.TempDir(), "two"), t.TempDir())
	if err == nil {
		t.Fatal("a second hive was opened over a running one")
	}
	if !strings.Contains(err.Error(), "already on") {
		t.Fatalf("the refusal does not say why: %v", err)
	}
	// The first hive is still the one in force.
	d.hiveMu.RLock()
	inForce := d.opt.HiveDir
	d.hiveMu.RUnlock()
	if inForce != first {
		t.Fatalf("hive in force = %q, want the first one %q", inForce, first)
	}
}

// The suggestion the dashboard shows in its confirmation must be a real
// absolute path under the user's home, not a relative name that would create a
// queue directory wherever the daemon happens to have been started.
func TestSuggestedHiveIsUnderHome(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("no home directory on this machine")
	}
	got := suggestedHive()
	if want := filepath.Join(home, "caprock-tasks"); got != want {
		t.Fatalf("suggestedHive() = %q, want %q", got, want)
	}
}

// A fatal ingest error used to be swallowed into a log line: the daemon
// reported healthy, `caprock status` printed "backfill done", and the dashboard
// told the user to start `claude` and wait for sessions that could never
// arrive. Reproduced with a read-only ~/.claude. The terminal error must reach
// /v1/status so the CLI and the Now screen can say so.
func TestStatusReportsATerminalIngestError(t *testing.T) {
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx := context.Background()
	d := &Daemon{
		store: st, log: log, bus: bus.New(), baseCtx: ctx,
		mgr:   agents.NewManager(st, t.TempDir(), "", log),
		opt:   Options{Config: config.Defaults(), DataDir: t.TempDir()},
		table: &cost.Table{}, det: loop.New(5, time.Minute),
		start: time.Now(),
	}

	// While ingest is alive, status says nothing about it.
	if s := d.status(ctx).(Status); s.IngestError != "" {
		t.Fatalf("a healthy daemon reported an ingest error: %q", s.IngestError)
	}

	// The tailer goroutine dies — exactly what a read-only ~/.claude produces.
	d.setIngestErr(errors.New("mkdir /home/u/.claude: permission denied"))

	s := d.status(ctx).(Status)
	if s.IngestError == "" {
		t.Fatal("a dead tailer left /v1/status reporting a healthy daemon; the dashboard would tell the user to wait forever")
	}
	if !strings.Contains(s.IngestError, "permission denied") {
		t.Fatalf("the error does not say what went wrong: %q", s.IngestError)
	}

	// It must survive the JSON round trip the CLI and the UI both read.
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	var back Status
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if back.IngestError != s.IngestError {
		t.Fatalf("ingest_error did not survive the wire: %q vs %q", back.IngestError, s.IngestError)
	}
	if !strings.Contains(string(b), `"ingest_error"`) {
		t.Fatalf("the status payload has no ingest_error field:\n%s", b)
	}
}
