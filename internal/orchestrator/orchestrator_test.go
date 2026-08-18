package orchestrator

import (
	"context"
	"os"
	"path/filepath"
	"strings"
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
