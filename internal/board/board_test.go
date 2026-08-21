package board

import (
	"context"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/hive"
	"github.com/dspv/caprock/internal/store"
)

func newBoard(t *testing.T) *Board {
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
	b := New(h, st, bus.New(), nil)
	b.Now = func() time.Time { return time.Unix(1_700_000_000, 0) }
	return b
}

func TestCreateMirrorAndRescan(t *testing.T) {
	ctx := context.Background()
	b := newBoard(t)
	out, err := b.Create(ctx, map[string]any{"title": "Add /healthz", "budget_usd": 3.0, "done_criteria": []string{"go test ./..."}, "body": "notes"})
	if err != nil {
		t.Fatal(err)
	}
	m := out.(map[string]any)
	row := m["task"].(store.TaskRow)
	if row.Title != "Add /healthz" || row.Status != hive.StatusInbox || m["body"].(string) != "notes" {
		t.Fatalf("create: %+v", m)
	}
	rows, _ := store.ListTasks(ctx, b.Store.DB())
	if len(rows) != 1 {
		t.Fatalf("mirror: %+v", rows)
	}
	// Wipe the mirror and rebuild from files.
	_, _ = b.Store.DB().Exec(`DELETE FROM tasks`)
	if err := b.Rescan(ctx); err != nil {
		t.Fatal(err)
	}
	if rows, _ := store.ListTasks(ctx, b.Store.DB()); len(rows) != 1 {
		t.Fatalf("rescan: %+v", rows)
	}
}

func TestStopDecisionForceContinueAndGuard(t *testing.T) {
	ctx := context.Background()
	b := newBoard(t)
	_ = b.Hive.RegisterAgent("worker-1", "w")
	_ = b.Hive.RegisterAgent("orchestrator", "o")
	// Empty inbox → allow stop.
	if body := b.StopDecision(ctx, "sess", "worker-1", "t1"); body != nil {
		t.Fatalf("empty inbox should allow: %s", body)
	}
	// Non-empty inbox → block.
	_, _ = b.Hive.Send(hive.Message{From: "orchestrator", To: "worker-1", Kind: hive.KindAssign, TaskID: "t1", Body: "do it"})
	_, _ = b.Hive.Deliver()
	body := b.StopDecision(ctx, "sess", "worker-1", "t1")
	if body == nil || !contains(string(body), `"decision":"block"`) || !contains(string(body), "inbox") {
		t.Fatalf("block expected: %s", body)
	}
	// Top-level session (no agent id) is never forced.
	if b.StopDecision(ctx, "sess", "", "t1") != nil {
		t.Fatal("top-level session forced")
	}
	// Guard: after MaxForcedContinues, escalate (allow stop) and move task to needs_you.
	_ = b.Hive.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusInbox})
	_, _ = b.Hive.UpdateTask("t1", func(x *hive.Task) error { x.Status = hive.StatusAssigned; return nil })
	_, _ = b.Hive.UpdateTask("t1", func(x *hive.Task) error { x.Status = hive.StatusInProgress; return nil })
	var last []byte
	for i := 0; i < MaxForcedContinues+2; i++ {
		last = b.StopDecision(ctx, "sess", "worker-1", "t1")
	}
	if last != nil {
		t.Fatalf("guard should allow stop after limit: %s", last)
	}
	tk, _ := b.Hive.GetTask("t1")
	if tk.Status != hive.StatusNeedsYou {
		t.Fatalf("task not escalated: %s", tk.Status)
	}
}

func TestApproveFlow(t *testing.T) {
	ctx := context.Background()
	b := newBoard(t)
	_ = b.Hive.RegisterAgent("orchestrator", "o")
	_ = b.Hive.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusInbox})
	for _, st := range []string{hive.StatusAssigned, hive.StatusInProgress, hive.StatusNeedsYou} {
		if _, err := b.Hive.UpdateTask("t1", func(x *hive.Task) error { x.Status = st; return nil }); err != nil {
			t.Fatal(err)
		}
	}
	_ = b.mirror(ctx, hive.Task{ID: "t1", Title: "x", Status: hive.StatusNeedsYou})
	appr, _ := b.Approvals(ctx)
	if len(appr.([]store.TaskRow)) != 1 {
		t.Fatalf("approvals: %+v", appr)
	}
	if err := b.Approve(ctx, "t1", true); err != nil {
		t.Fatal(err)
	}
	tk, _ := b.Hive.GetTask("t1")
	if tk.Status != hive.StatusInProgress {
		t.Fatalf("after approve: %s", tk.Status)
	}
	// Orchestrator got a result message in its outbox (pre-delivery).
	if _, err := b.Hive.Deliver(); err != nil {
		t.Fatal(err)
	}
	if b.Hive.InboxCount("orchestrator") != 1 {
		t.Fatal("orchestrator not notified")
	}
}

func contains(s, sub string) bool { return len(s) >= len(sub) && (s == sub || indexOf(s, sub) >= 0) }
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func TestVerifyPassMovesToDone(t *testing.T) {
	ctx := context.Background()
	b := newBoard(t)
	_ = b.Hive.RegisterAgent("worker-1", "w")
	_ = b.Hive.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusInbox, DoneCriteria: []string{"true", "true"}})
	for _, st := range []string{hive.StatusAssigned, hive.StatusInProgress, hive.StatusVerifying} {
		if _, err := b.Hive.UpdateTask("t1", func(x *hive.Task) error { x.Status = st; x.Assignee = "worker-1"; return nil }); err != nil {
			t.Fatal(err)
		}
	}
	res, err := b.Verify(ctx, "t1", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if !res.Passed || res.Status != hive.StatusDone || len(res.Commands) != 2 {
		t.Fatalf("verify pass: %+v", res)
	}
	tk, _ := b.Hive.GetTask("t1")
	if tk.Status != hive.StatusDone {
		t.Fatalf("task not done: %s", tk.Status)
	}
}

func TestVerifyFailBouncesThenEscalates(t *testing.T) {
	ctx := context.Background()
	b := newBoard(t)
	_ = b.Hive.RegisterAgent("worker-1", "w")
	_ = b.Hive.RegisterAgent("orchestrator", "o")
	_ = b.Hive.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusInbox, DoneCriteria: []string{"false"}})
	for _, st := range []string{hive.StatusAssigned, hive.StatusInProgress, hive.StatusVerifying} {
		_, _ = b.Hive.UpdateTask("t1", func(x *hive.Task) error { x.Status = st; x.Assignee = "worker-1"; return nil })
	}
	// Rounds 1 and 2: bounce back to in_progress, worker gets the failing output.
	for round := 1; round <= 2; round++ {
		_, _ = b.Hive.UpdateTask("t1", func(x *hive.Task) error {
			if x.Status == hive.StatusInProgress {
				x.Status = hive.StatusVerifying
			}
			return nil
		})
		res, err := b.Verify(ctx, "t1", t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		if res.Passed || res.Escalated || res.Status != hive.StatusInProgress {
			t.Fatalf("round %d: %+v", round, res)
		}
	}
	n, _ := b.Hive.Deliver()
	if n < 1 || b.Hive.InboxCount("worker-1") < 1 {
		t.Fatalf("worker not bounced: %d", n)
	}
	// Round 3: escalate to needs_you, orchestrator notified.
	_, _ = b.Hive.UpdateTask("t1", func(x *hive.Task) error { x.Status = hive.StatusVerifying; return nil })
	res, err := b.Verify(ctx, "t1", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if !res.Escalated || res.Status != hive.StatusNeedsYou {
		t.Fatalf("round 3 should escalate: %+v", res)
	}
	tk, _ := b.Hive.GetTask("t1")
	if tk.Status != hive.StatusNeedsYou || tk.VerifyRoundsUsed != 3 {
		t.Fatalf("task: %+v", tk)
	}
	_, _ = b.Hive.Deliver()
	if b.Hive.InboxCount("orchestrator") < 1 {
		t.Fatal("orchestrator not notified of escalation")
	}
}

func TestVerifyNoCriteriaTrustsWorker(t *testing.T) {
	ctx := context.Background()
	b := newBoard(t)
	_ = b.Hive.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusInbox})
	for _, st := range []string{hive.StatusAssigned, hive.StatusInProgress, hive.StatusVerifying} {
		_, _ = b.Hive.UpdateTask("t1", func(x *hive.Task) error { x.Status = st; return nil })
	}
	res, _ := b.Verify(ctx, "t1", t.TempDir())
	if !res.Passed || res.Status != hive.StatusDone {
		t.Fatalf("no-criteria: %+v", res)
	}
}

func TestVerifyEscalatesDestructiveCriteria(t *testing.T) {
	ctx := context.Background()
	b := newBoard(t)
	_ = b.Hive.RegisterAgent("orchestrator", "o")
	_ = b.Hive.CreateTask(hive.Task{ID: "t1", Title: "danger", Status: hive.StatusInbox, DoneCriteria: []string{"go test ./...", "sudo rm -rf /tmp/x"}})
	for _, st := range []string{hive.StatusAssigned, hive.StatusInProgress, hive.StatusVerifying} {
		_, _ = b.Hive.UpdateTask("t1", func(x *hive.Task) error { x.Status = st; return nil })
	}
	res, err := b.Verify(ctx, "t1", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if !res.Escalated || res.Status != hive.StatusNeedsYou {
		t.Fatalf("destructive not escalated: %+v", res)
	}
	// The command must NOT have run (no verification rows recorded for it).
	if len(res.Commands) != 0 {
		t.Fatalf("ran commands despite destructive policy: %+v", res.Commands)
	}
	_, _ = b.Hive.Deliver()
	if b.Hive.InboxCount("orchestrator") < 1 {
		t.Fatal("orchestrator not warned about destructive criteria")
	}
}

// Defect regression: the router opens the assignment window on the worker's
// *session* id (the column AttributeTaskCost joins events.session_id on), but
// verification closed it on the hive *agent* id, so the UPDATE matched nothing
// and the window stayed open forever. An open window has no upper bound — the
// join takes every event that session ever emits — so a finished task keeps
// absorbing the cost of whatever that session does next.
func TestVerifyClosesAssignmentWindowBySession(t *testing.T) {
	ctx := context.Background()
	b := newBoard(t)
	if _, err := b.Create(ctx, map[string]any{"id": "t1", "title": "x", "budget_usd": 5}); err != nil {
		t.Fatal(err)
	}
	for _, st := range []string{hive.StatusAssigned, hive.StatusInProgress, hive.StatusVerifying} {
		s := st
		if _, err := b.Hive.UpdateTask("t1", func(x *hive.Task) error { x.Status = s; x.Assignee = "worker-1"; return nil }); err != nil {
			t.Fatal(err)
		}
	}
	const sessionID = "sess-abc" // the session id, never equal to the agent id
	base := b.Now().UnixMilli()
	spend(t, b, "t1", sessionID, base-1000, base, 0.42)

	res, err := b.Verify(ctx, "t1", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if !res.Passed || res.Status != hive.StatusDone {
		t.Fatalf("verify: %+v", res)
	}
	// The window must be closed, so the task stops accruing.
	var open int
	if err := b.Store.DB().QueryRowContext(ctx,
		`SELECT COUNT(*) FROM task_assignments WHERE task_id = ? AND to_ts IS NULL`, "t1").Scan(&open); err != nil {
		t.Fatal(err)
	}
	if open != 0 {
		t.Fatalf("assignment window left open after done: %d", open)
	}
	row, err := store.GetTask(ctx, b.Store.DB(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if row.CostUSD < 0.41 || row.CostUSD > 0.43 {
		t.Fatalf("cost not attributed to task: got %v, want 0.42", row.CostUSD)
	}
	// The same session goes on to do unrelated work. A closed window ignores it;
	// an open one silently bills it to this finished task.
	c := 9.0
	ev := &event.Event{SessionID: sessionID, Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
		Model: "claude-opus-5", CostUSD: &c, Key: "after-done", Ts: time.UnixMilli(base + 60_000)}
	if _, err := store.InsertEvent(ctx, b.Store.DB(), ev); err != nil {
		t.Fatal(err)
	}
	after, err := store.AttributeTaskCost(ctx, b.Store.DB(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if after > 0.43 {
		t.Fatalf("finished task still accruing cost through an open window: %v", after)
	}
}

// spend opens an assignment window for (task, session) the way the router does
// and books one costed event inside it.
func spend(t *testing.T, b *Board, taskID, sessionID string, from, at int64, cost float64) {
	t.Helper()
	ctx := context.Background()
	if err := store.UpsertSession(ctx, b.Store.DB(), sessionID, store.SessionPatch{Cwd: "/repo"}); err != nil {
		t.Fatal(err)
	}
	if err := store.OpenAssignment(ctx, b.Store.DB(), taskID, sessionID, from); err != nil {
		t.Fatal(err)
	}
	c := cost
	ev := &event.Event{SessionID: sessionID, Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
		Model: "claude-opus-5", CostUSD: &c, Key: taskID + sessionID, Ts: time.UnixMilli(at)}
	if _, err := store.InsertEvent(ctx, b.Store.DB(), ev); err != nil {
		t.Fatal(err)
	}
}

// Defect regression: verifying a task from a status that cannot reach the target
// in one hop used to no-op both guarded transitions and strand the task where it
// was — after which the next verify hard-errored on "inbox → done". Verification
// now walks a legal route, so a task always lands somewhere the board can act on.
func TestVerifyFromIllegalStatusDoesNotStrand(t *testing.T) {
	ctx := context.Background()
	b := newBoard(t)
	_ = b.Hive.RegisterAgent("worker-1", "w")
	if err := b.Hive.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusInbox, DoneCriteria: []string{"exit 1"}}); err != nil {
		t.Fatal(err)
	}
	// Failing verification from `inbox`: it must bounce to in_progress, not stay.
	res, err := b.Verify(ctx, "t1", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != hive.StatusInProgress {
		t.Fatalf("failed verify from inbox stranded the task: status %q", res.Status)
	}
	if tk, _ := b.Hive.GetTask("t1"); tk.Status != hive.StatusInProgress {
		t.Fatalf("hive file stranded: %q", tk.Status)
	}
	// And a second (passing) verify must not hard-error on an illegal jump.
	if _, err := b.Hive.UpdateTask("t1", func(x *hive.Task) error { x.DoneCriteria = []string{"exit 0"}; return nil }); err != nil {
		t.Fatal(err)
	}
	res2, err := b.Verify(ctx, "t1", t.TempDir())
	if err != nil {
		t.Fatalf("second verify errored instead of routing: %v", err)
	}
	if !res2.Passed || res2.Status != hive.StatusDone {
		t.Fatalf("second verify: %+v", res2)
	}
}

// A task parked for going over budget lands in needs_you with the reason on the
// task, so the approvals column can explain the pause.
func TestOverBudgetParksTaskWithReason(t *testing.T) {
	ctx := context.Background()
	b := newBoard(t)
	if _, err := b.Create(ctx, map[string]any{"id": "t1", "title": "x", "budget_usd": 1.0, "body": "brief"}); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Hive.UpdateTask("t1", func(x *hive.Task) error { x.Status = hive.StatusAssigned; return nil }); err != nil {
		t.Fatal(err)
	}
	const reason = "Task t1 has spent $2.00 against a budget of $1.00 and is paused for your decision."
	if err := b.OverBudget(ctx, "t1", reason); err != nil {
		t.Fatal(err)
	}
	tk, _ := b.Hive.GetTask("t1")
	if tk.Status != hive.StatusNeedsYou {
		t.Fatalf("not parked: %q", tk.Status)
	}
	if !contains(tk.Body, reason) {
		t.Fatalf("reason not recorded on the task: %q", tk.Body)
	}
	row, _ := store.GetTask(ctx, b.Store.DB(), "t1")
	if row.Status != hive.StatusNeedsYou {
		t.Fatalf("mirror not updated: %+v", row)
	}
	// Idempotent: parking again neither errors nor duplicates the reason.
	if err := b.OverBudget(ctx, "t1", reason); err != nil {
		t.Fatal(err)
	}
}
