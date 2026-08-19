package orchestrator

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/hive"
	"github.com/dspv/caprock/internal/store"
)

// fakeSpawner records spawn requests without starting a process.
type fakeSpawner struct {
	avail    bool
	spawns   []agents.SpawnRequest
	nextID   int
	sessions map[string]bool
	mu       sync.Mutex
	input    map[string][]byte // session id → concatenated kick bytes
}

func (f *fakeSpawner) ClaudeAvailable() bool { return f.avail }
func (f *fakeSpawner) Spawn(_ context.Context, req agents.SpawnRequest) (*agents.Agent, error) {
	f.nextID++
	id := "sess-" + string(rune('a'+f.nextID))
	f.spawns = append(f.spawns, req)
	if f.sessions == nil {
		f.sessions = map[string]bool{}
	}
	f.sessions[id] = true
	return &agents.Agent{SessionID: id, Cwd: req.Cwd}, nil
}
func (f *fakeSpawner) Get(id string) (*agents.Agent, bool) {
	if f.sessions[id] {
		return &agents.Agent{SessionID: id}, true
	}
	return nil, false
}
func (f *fakeSpawner) Input(id string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.input == nil {
		f.input = map[string][]byte{}
	}
	f.input[id] = append(f.input[id], data...)
	return nil
}
func (f *fakeSpawner) kickBytes(id string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return string(f.input[id])
}

func newOrch(t *testing.T) (*Orchestrator, *fakeSpawner, *hive.Hive) {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	h, err := hive.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	sp := &fakeSpawner{avail: true}
	o := New(h, st, sp, t.TempDir(), nil)
	return o, sp, h
}

func TestStartSpawnsOrchestratorWithPrompt(t *testing.T) {
	o, sp, h := newOrch(t)
	sid, err := o.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if sid == "" || o.AgentIDForSession(sid) != OrchestratorID {
		t.Fatalf("session mapping: %q → %q", sid, o.AgentIDForSession(sid))
	}
	if len(sp.spawns) != 1 {
		t.Fatalf("spawns: %d", len(sp.spawns))
	}
	args := strings.Join(sp.spawns[0].Args, " ")
	if !strings.Contains(args, "--append-system-prompt-file") || !strings.Contains(args, "--add-dir") {
		t.Fatalf("args: %q", args)
	}
	// The prompt file exists and names the orchestrator's hive home.
	promptPath := filepath.Join(h.Root, ".orchestrator-prompt.md")
	b, err := os.ReadFile(promptPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "orchestrator") || !strings.Contains(string(b), filepath.Join(h.Root, "agents", OrchestratorID)) {
		t.Fatalf("prompt missing home: %s", b)
	}
	// The orchestrator agent is registered in the hive.
	if _, err := os.Stat(filepath.Join(h.Root, "agents", OrchestratorID, "inbox")); err != nil {
		t.Fatalf("orchestrator not registered: %v", err)
	}
}

func TestSpawnWorkerIdempotentAndMapped(t *testing.T) {
	o, sp, h := newOrch(t)
	sid1, err := o.SpawnWorker(context.Background(), "worker-1")
	if err != nil {
		t.Fatal(err)
	}
	sid2, _ := o.SpawnWorker(context.Background(), "worker-1")
	if sid1 != sid2 {
		t.Fatalf("worker respawned: %s vs %s", sid1, sid2)
	}
	if len(sp.spawns) != 1 {
		t.Fatalf("spawned twice: %d", len(sp.spawns))
	}
	if o.AgentIDForSession(sid1) != "worker-1" {
		t.Fatalf("worker mapping: %q", o.AgentIDForSession(sid1))
	}
	if sp.spawns[0].Worktree != "worker-1" {
		t.Fatalf("worker not in worktree: %+v", sp.spawns[0])
	}
	if _, err := os.Stat(filepath.Join(h.Root, "agents", "worker-1", "outbox")); err != nil {
		t.Fatalf("worker not registered: %v", err)
	}
}

func TestRouterLoopDeliversMail(t *testing.T) {
	o, _, h := newOrch(t)
	o.RouterTick = 50 * time.Millisecond
	_ = h.RegisterAgent("orchestrator", "o")
	_ = h.RegisterAgent("worker-1", "w")
	_, _ = h.Send(hive.Message{From: "orchestrator", To: "worker-1", Kind: hive.KindAssign, Body: "do it"})
	ctx, cancel := context.WithCancel(context.Background())
	go o.routerLoop(ctx)
	deadline := time.After(3 * time.Second)
	for h.InboxCount("worker-1") == 0 {
		select {
		case <-deadline:
			cancel()
			t.Fatal("mail not delivered by router loop")
		case <-time.After(20 * time.Millisecond):
		}
	}
	cancel()
}

func TestStartFailsWithoutClaude(t *testing.T) {
	o, sp, _ := newOrch(t)
	sp.avail = false
	if _, err := o.Start(context.Background()); err == nil {
		t.Fatal("started without claude")
	}
}

// The router spawns a worker session for a task the orchestrator assigned (set
// assignee + status=assigned) — the missing link that makes SpawnWorker fire.
func TestTickSpawnsAssignedWorker(t *testing.T) {
	o, sp, h := newOrch(t)
	if err := h.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusAssigned, Assignee: "worker-1"}); err != nil {
		t.Fatal(err)
	}
	o.tick(context.Background())
	if len(sp.spawns) != 1 || sp.spawns[0].Worktree != "worker-1" {
		t.Fatalf("worker not spawned for assigned task: %+v", sp.spawns)
	}
	// Idempotent: a second tick does not respawn the live worker.
	o.tick(context.Background())
	if len(sp.spawns) != 1 {
		t.Fatalf("respawned live worker: %d", len(sp.spawns))
	}
}

// An inbox-status task (no assignee yet) does not spawn anything.
func TestTickDoesNotSpawnForUnassigned(t *testing.T) {
	o, sp, h := newOrch(t)
	if err := h.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusInbox}); err != nil {
		t.Fatal(err)
	}
	o.tick(context.Background())
	if len(sp.spawns) != 0 {
		t.Fatalf("spawned for unassigned task: %+v", sp.spawns)
	}
}

// The router runs verification exactly once for a task scribed to `verifying`,
// even across many ticks while the (slow) check is in flight.
func TestTickVerifiesOncePerVerifying(t *testing.T) {
	o, _, h := newOrch(t)
	if err := h.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusVerifying, Assignee: "worker-1"}); err != nil {
		t.Fatal(err)
	}
	var calls int32
	release := make(chan struct{})
	o.Verify = func(_ context.Context, id string) error {
		atomic.AddInt32(&calls, 1)
		<-release // hold the verification "in flight" across several ticks
		return nil
	}
	for i := 0; i < 5; i++ {
		o.tick(context.Background())
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("verify fired %d times while in flight, want 1", got)
	}
	close(release)
}

// A live agent with unread mail gets re-kicked (woken), throttled so a
// still-working agent is not spammed each tick.
func TestTickWakesIdleAgentWithMail(t *testing.T) {
	o, sp, h := newOrch(t)
	sid, err := o.SpawnWorker(context.Background(), "worker-1")
	if err != nil {
		t.Fatal(err)
	}
	// A delivered message sits in worker-1's inbox.
	if err := h.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusInProgress, Assignee: "worker-1"}); err != nil {
		t.Fatal(err)
	}
	_, _ = h.Send(hive.Message{From: "verifier", To: "worker-1", Kind: hive.KindResult, Body: "fix this"})
	base := time.Unix(1_700_000_000, 0)
	o.Now = func() time.Time { return base }
	o.tick(context.Background())
	first := sp.kickBytes(sid)
	if !strings.Contains(first, "\r") {
		t.Fatalf("worker not woken (no submit): %q", first)
	}
	// A second tick within the throttle window does not re-kick.
	o.tick(context.Background())
	if sp.kickBytes(sid) != first {
		t.Fatalf("woke again within throttle window")
	}
	// After the throttle window, and with mail still unread, it wakes again.
	o.Now = func() time.Time { return base.Add(30 * time.Second) }
	o.tick(context.Background())
	if sp.kickBytes(sid) == first {
		t.Fatal("did not re-wake after throttle window")
	}
}

// TaskForAgent arms the Stop guard by resolving a worker's live task; the
// orchestrator itself never owns a task.
func TestTaskForAgent(t *testing.T) {
	o, _, h := newOrch(t)
	_ = h.CreateTask(hive.Task{ID: "t1", Status: hive.StatusInProgress, Assignee: "worker-1"})
	_ = h.CreateTask(hive.Task{ID: "t2", Status: hive.StatusDone, Assignee: "worker-2"})
	if got := o.TaskForAgent("worker-1"); got != "t1" {
		t.Fatalf("worker-1 task = %q, want t1", got)
	}
	if got := o.TaskForAgent("worker-2"); got != "" {
		t.Fatalf("done task should not arm guard: %q", got)
	}
	if got := o.TaskForAgent(OrchestratorID); got != "" {
		t.Fatalf("orchestrator should own no task: %q", got)
	}
}
