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
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/hive"
	"github.com/dspv/caprock/internal/store"
)

// fakeSpawner records spawn requests without starting a process.
type fakeSpawner struct {
	avail    bool
	spawns   []agents.SpawnRequest
	nextID   int
	sessions map[string]bool
	ids      []string // session ids handed out, in spawn order
	mu       sync.Mutex
	input    map[string][]byte // session id → concatenated kick bytes
}

func (f *fakeSpawner) ClaudeAvailable() bool { return f.avail }
func (f *fakeSpawner) Spawn(_ context.Context, req agents.SpawnRequest) (*agents.Agent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	id := "sess-" + string(rune('a'+f.nextID))
	f.spawns = append(f.spawns, req)
	if f.sessions == nil {
		f.sessions = map[string]bool{}
	}
	f.sessions[id] = true
	f.ids = append(f.ids, id)
	return &agents.Agent{SessionID: id, Cwd: req.Cwd}, nil
}

// lastSession is the session id of the most recent spawn.
func (f *fakeSpawner) lastSession() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.ids) == 0 {
		return ""
	}
	return f.ids[len(f.ids)-1]
}
func (f *fakeSpawner) Get(id string) (*agents.Agent, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
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

// Spawning a worker for an assigned task opens its cost-attribution window in
// the store. This is the wiring that makes per-task cost non-zero in a real run;
// without it, task_assignments stays empty and every task costs $0. The test
// drives the real tick (not a helper that opens the window), so it catches the
// regression where OpenAssignment has no production caller.
func TestTickOpensAssignmentWindow(t *testing.T) {
	o, sp, h := newOrch(t)
	if err := h.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusAssigned, Assignee: "worker-1"}); err != nil {
		t.Fatal(err)
	}
	o.tick(context.Background())
	// A row must now exist in task_assignments keyed on the worker's *session*
	// id — the column AttributeTaskCost joins events.session_id on. Keying it on
	// the hive agent id ("worker-1") would join nothing and cost $0 forever.
	sid := sp.lastSession()
	if sid == "" {
		t.Fatal("spawner did not report a session id")
	}
	var got string
	row := o.Store.DB().QueryRowContext(context.Background(),
		`SELECT session_id FROM task_assignments WHERE task_id = ? AND to_ts IS NULL`, "t1")
	if err := row.Scan(&got); err != nil {
		t.Fatalf("assignment window not opened for t1: %v", err)
	}
	if got != sid {
		t.Fatalf("assignment keyed on %q, want the session id %q", got, sid)
	}
	var n int
	// Idempotent: a second tick does not open a duplicate window.
	o.tick(context.Background())
	_ = o.Store.DB().QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM task_assignments WHERE task_id = ?`, "t1").Scan(&n)
	if n != 1 {
		t.Fatalf("duplicate assignment window: %d", n)
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
	entered := make(chan struct{}, 8) // signals each real entry into Verify
	release := make(chan struct{})
	o.Verify = func(_ context.Context, id string) error {
		atomic.AddInt32(&calls, 1)
		entered <- struct{}{}
		<-release // hold the verification "in flight" across several ticks
		return nil
	}
	// First tick launches the verify goroutine; wait until it has actually
	// entered Verify before ticking again, so the in-flight guard is under test
	// (not a race between the goroutine starting and the assertion).
	o.tick(context.Background())
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("verify never started after the first tick")
	}
	// Further ticks while the first verify is in flight must not start another.
	for i := 0; i < 4; i++ {
		o.tick(context.Background())
	}
	// Give any (erroneously) launched extra goroutine a chance to enter.
	select {
	case <-entered:
		t.Fatal("verify started a second time while one was in flight")
	case <-time.After(200 * time.Millisecond):
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

// Once a task moves past `assigned` (the orchestrator scribed it to in_progress
// or beyond), the router retires the worker's fire-once assign message from its
// inbox. This is the fix for workers stuck in a re-kick/poll loop: a lingering
// assign kept InboxCount non-zero forever, so the Stop-loop never released. A
// `result` message for other live work must survive the drain.
func TestTickDrainsConsumedAssignment(t *testing.T) {
	o, _, h := newOrch(t)
	if err := h.RegisterAgent("worker-1", "w"); err != nil {
		t.Fatal(err)
	}
	// worker-1 is a known worker (as if spawned).
	o.mu.Lock()
	o.workers["worker-1"] = "sess-w1"
	o.mu.Unlock()
	// Task picked up (in_progress) + an assign and an unrelated result in inbox.
	if err := h.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusInProgress, Assignee: "worker-1"}); err != nil {
		t.Fatal(err)
	}
	for _, m := range []hive.Message{
		{From: "orchestrator", To: "worker-1", Kind: hive.KindAssign, TaskID: "t1", Body: "do t1"},
		{From: "peer", To: "worker-1", Kind: hive.KindResult, TaskID: "t9", Body: "fyi"},
	} {
		if _, err := h.Send(m); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.Deliver(); err != nil {
		t.Fatal(err)
	}
	o.drainConsumedAssignments()
	if h.InboxCount("worker-1") != 1 {
		t.Fatalf("inbox after drain: %d, want 1 (assign retired, result kept)", h.InboxCount("worker-1"))
	}
	msgs, _ := h.Inbox("worker-1")
	if len(msgs) != 1 || msgs[0].Kind != hive.KindResult {
		t.Fatalf("wrong survivor: %+v", msgs)
	}
}

// While a task is still `assigned` (not yet picked up), its assign stays put —
// draining it early would drop the instruction before the worker acts.
func TestTickKeepsUnpickedAssignment(t *testing.T) {
	o, _, h := newOrch(t)
	if err := h.RegisterAgent("worker-1", "w"); err != nil {
		t.Fatal(err)
	}
	o.mu.Lock()
	o.workers["worker-1"] = "sess-w1"
	o.mu.Unlock()
	if err := h.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusAssigned, Assignee: "worker-1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Send(hive.Message{From: "orchestrator", To: "worker-1", Kind: hive.KindAssign, TaskID: "t1", Body: "do t1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Deliver(); err != nil {
		t.Fatal(err)
	}
	o.drainConsumedAssignments()
	if h.InboxCount("worker-1") != 1 {
		t.Fatalf("assign dropped before pickup: inbox %d", h.InboxCount("worker-1"))
	}
}

// A second Start on a live orchestrator does not spawn a duplicate session (which
// would leak the first and start a second racing router loop); it re-kicks the
// existing one so it re-reads its inbox and picks up newly-queued tasks.
func TestStartIdempotent(t *testing.T) {
	o, sp, _ := newOrch(t)
	sid1, err := o.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(sp.spawns) != 1 {
		t.Fatalf("first start spawns: %d", len(sp.spawns))
	}
	sid2, err := o.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if sid2 != sid1 {
		t.Fatalf("second start returned a new session: %q != %q", sid2, sid1)
	}
	if len(sp.spawns) != 1 {
		t.Fatalf("second start spawned a duplicate orchestrator: %d spawns", len(sp.spawns))
	}
	// After a session dies, Start spawns a fresh one.
	sp.mu.Lock()
	delete(sp.sessions, sid1)
	sp.mu.Unlock()
	sid3, err := o.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if sid3 == sid1 || len(sp.spawns) != 2 {
		t.Fatalf("dead orchestrator not replaced: sid3=%q spawns=%d", sid3, len(sp.spawns))
	}
}

// keepWorkerMail is the drain predicate; it must retire consumed assign AND
// consumed verify-bounce results, while keeping live mail. Table-drives every
// branch so a future edit that drops (or over-drops) a message kind is caught.
func TestKeepWorkerMail(t *testing.T) {
	cases := []struct {
		name   string
		m      hive.Message
		status string
		keep   bool
	}{
		{"assign, task assigned → keep", hive.Message{Kind: hive.KindAssign, TaskID: "t"}, hive.StatusAssigned, true},
		{"assign, task inbox → keep", hive.Message{Kind: hive.KindAssign, TaskID: "t"}, hive.StatusInbox, true},
		{"assign, task in_progress → drain", hive.Message{Kind: hive.KindAssign, TaskID: "t"}, hive.StatusInProgress, false},
		{"assign, task done → drain", hive.Message{Kind: hive.KindAssign, TaskID: "t"}, hive.StatusDone, false},
		{"verifier bounce, in_progress → keep", hive.Message{Kind: hive.KindResult, From: hive.VerifierAgentID, TaskID: "t"}, hive.StatusInProgress, true},
		{"verifier bounce, verifying → drain", hive.Message{Kind: hive.KindResult, From: hive.VerifierAgentID, TaskID: "t"}, hive.StatusVerifying, false},
		{"verifier bounce, done → drain", hive.Message{Kind: hive.KindResult, From: hive.VerifierAgentID, TaskID: "t"}, hive.StatusDone, false},
		{"peer result → always keep", hive.Message{Kind: hive.KindResult, From: "peer", TaskID: "t"}, hive.StatusDone, true},
		{"question → always keep", hive.Message{Kind: hive.KindQuestion, TaskID: "t"}, hive.StatusDone, true},
		{"unknown task → keep", hive.Message{Kind: hive.KindAssign, TaskID: "t"}, "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := keepWorkerMail(c.m, c.status); got != c.keep {
				t.Fatalf("keepWorkerMail(%+v, %q) = %v, want %v", c.m, c.status, got, c.keep)
			}
		})
	}
}

// A verify-bounce (KindResult from the verifier) is retired once the worker has
// acted on it and the task left in_progress. Without this the bounce lingered in
// the inbox and re-introduced the Stop-loop after every failed verification.
func TestTickDrainsConsumedBounce(t *testing.T) {
	o, _, h := newOrch(t)
	if err := h.RegisterAgent("worker-1", "w"); err != nil {
		t.Fatal(err)
	}
	o.mu.Lock()
	o.workers["worker-1"] = "sess-w1"
	o.mu.Unlock()
	// Task is back in verifying after the worker fixed the bounce.
	if err := h.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusVerifying, Assignee: "worker-1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Send(hive.Message{From: hive.VerifierAgentID, To: "worker-1", Kind: hive.KindResult, TaskID: "t1", Body: "tests failed"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Deliver(); err != nil {
		t.Fatal(err)
	}
	o.drainConsumedAssignments()
	if h.InboxCount("worker-1") != 0 {
		t.Fatalf("consumed bounce not drained: inbox %d", h.InboxCount("worker-1"))
	}
}

// A bounce the worker has NOT yet acted on (task still in_progress) stays put.
func TestTickKeepsLiveBounce(t *testing.T) {
	o, _, h := newOrch(t)
	if err := h.RegisterAgent("worker-1", "w"); err != nil {
		t.Fatal(err)
	}
	o.mu.Lock()
	o.workers["worker-1"] = "sess-w1"
	o.mu.Unlock()
	if err := h.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusInProgress, Assignee: "worker-1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Send(hive.Message{From: hive.VerifierAgentID, To: "worker-1", Kind: hive.KindResult, TaskID: "t1", Body: "fix this"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Deliver(); err != nil {
		t.Fatal(err)
	}
	o.drainConsumedAssignments()
	if h.InboxCount("worker-1") != 1 {
		t.Fatalf("live bounce dropped: inbox %d", h.InboxCount("worker-1"))
	}
}

// Two concurrent Start calls must not both spawn — the `starting` guard closes
// the check-then-spawn race. Exactly one spawns; the other is rejected or
// re-kicks. Run under -race to catch the data race the guard prevents.
func TestStartConcurrentNoDuplicate(t *testing.T) {
	o, sp, _ := newOrch(t)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = o.Start(context.Background()) }()
	}
	wg.Wait()
	// Allow at most one real spawn regardless of how the 8 racers interleave.
	sp.mu.Lock()
	n := len(sp.spawns)
	sp.mu.Unlock()
	if n != 1 {
		t.Fatalf("concurrent Start spawned %d orchestrators, want 1", n)
	}
}

// budgetTask stands a task up as live work with a budget, spends `cost` inside
// its assignment window, and ticks the router once.
func budgetTask(t *testing.T, o *Orchestrator, h *hive.Hive, budget, cost float64) {
	t.Helper()
	ctx := context.Background()
	if err := h.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusAssigned, Assignee: "worker-1", BudgetUSD: budget}); err != nil {
		t.Fatal(err)
	}
	o.tick(ctx) // spawns the worker and opens the assignment window
	sid := o.workerSession(t, "worker-1")
	base := o.now().UnixMilli()
	if err := store.UpsertSession(ctx, o.Store.DB(), sid, store.SessionPatch{Cwd: "/repo"}); err != nil {
		t.Fatal(err)
	}
	c := cost
	ev := &event.Event{SessionID: sid, Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
		Model: "claude-opus-5", CostUSD: &c, Key: "burn", Ts: time.UnixMilli(base + 1)}
	if _, err := store.InsertEvent(ctx, o.Store.DB(), ev); err != nil {
		t.Fatal(err)
	}
	o.tick(ctx) // the tick that must notice the overspend
}

// workerSession is the session id the router mapped a worker to.
func (o *Orchestrator) workerSession(t *testing.T, agentID string) string {
	t.Helper()
	o.mu.Lock()
	defer o.mu.Unlock()
	sid := o.workers[agentID]
	if sid == "" {
		t.Fatalf("no session for %s", agentID)
	}
	return sid
}

// budget_usd was decorative: validated, stored and rendered, but nothing ever
// compared it to spend. The router now re-attributes cost on the tick and parks
// an overspending task in needs_you.
func TestTickEscalatesTaskOverBudget(t *testing.T) {
	o, _, h := newOrch(t)
	budgetTask(t, o, h, 1.0, 2.5)
	tk, err := h.GetTask("t1")
	if err != nil {
		t.Fatal(err)
	}
	if tk.Status != hive.StatusNeedsYou {
		t.Fatalf("over-budget task not escalated: status %q", tk.Status)
	}
	// The orchestrator is told why.
	_, _ = h.Deliver()
	if h.InboxCount(OrchestratorID) < 1 {
		t.Fatal("orchestrator not notified of the over-budget escalation")
	}
	// And the attributed cost is on the mirrored row, not 0.
	row, err := store.GetTask(context.Background(), o.Store.DB(), "t1")
	if err == nil && row.CostUSD < 2.4 {
		t.Fatalf("cost not attributed on the tick: %v", row.CostUSD)
	}
}

// Spend inside the budget leaves the task alone.
func TestTickLeavesTaskUnderBudgetAlone(t *testing.T) {
	o, _, h := newOrch(t)
	budgetTask(t, o, h, 5.0, 0.5)
	if tk, _ := h.GetTask("t1"); tk.Status != hive.StatusAssigned {
		t.Fatalf("under-budget task disturbed: status %q", tk.Status)
	}
}

// A budget of 0 (or unset) means no limit — any spend is fine.
func TestTickZeroBudgetMeansNoLimit(t *testing.T) {
	o, _, h := newOrch(t)
	budgetTask(t, o, h, 0, 99.0)
	if tk, _ := h.GetTask("t1"); tk.Status != hive.StatusAssigned {
		t.Fatalf("zero budget enforced as a limit: status %q", tk.Status)
	}
}

// The router routes the escalation through the injected OverBudget seam (which
// the daemon wires to the board, so the SQLite mirror and the UI follow).
func TestTickOverBudgetUsesInjectedSeam(t *testing.T) {
	o, _, h := newOrch(t)
	var got string
	o.OverBudget = func(_ context.Context, taskID, reason string) error {
		got = taskID + ": " + reason
		return nil
	}
	budgetTask(t, o, h, 1.0, 2.5)
	if !strings.Contains(got, "t1") || !strings.Contains(got, "budget") {
		t.Fatalf("OverBudget seam not used: %q", got)
	}
}
