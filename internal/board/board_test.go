package board

import (
	"context"
	"os"
	"path/filepath"
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

// Defect regression (panel finding 1): a task with no done_criteria used to be
// an unconditional pass — `res.Passed = true` with the comment "trust the
// worker" — which made the product's central claim ("nothing reaches Done until
// its done_criteria pass") false for the easiest task to create. Unverifiable
// must never read as verified: the task is parked in needs_you and the human is
// told why.
func TestVerifyNoCriteriaEscalatesInsteadOfPassing(t *testing.T) {
	ctx := context.Background()
	b := newBoard(t)
	_ = b.Hive.RegisterAgent("orchestrator", "o")
	_ = b.Hive.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusInbox})
	for _, st := range []string{hive.StatusAssigned, hive.StatusInProgress, hive.StatusVerifying} {
		_, _ = b.Hive.UpdateTask("t1", func(x *hive.Task) error { x.Status = st; return nil })
	}
	res, err := b.Verify(ctx, "t1", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if res.Passed {
		t.Fatalf("a task with no done_criteria passed verification: %+v", res)
	}
	if res.Status != hive.StatusNeedsYou || !res.Escalated || !res.Unverifiable {
		t.Fatalf("no-criteria task not escalated: %+v", res)
	}
	if tk, _ := b.Hive.GetTask("t1"); tk.Status == hive.StatusDone {
		t.Fatalf("unverifiable task reached done: %q", tk.Status)
	}
	_, _ = b.Hive.Deliver()
	if b.Hive.InboxCount("orchestrator") < 1 {
		t.Fatal("nobody was told the task cannot be verified")
	}
}

// Defect regression (panel finding 6): when the worker's worktree is missing,
// runCommand used to leave cmd.Dir empty, so the done_criteria ran in the
// daemon's own working directory — verifying a clean main repo instead of the
// agent's work, and passing for the wrong reason. Unverifiable is never
// verified: no worktree, no pass.
func TestVerifyMissingWorktreeDoesNotPass(t *testing.T) {
	ctx := context.Background()
	b := newBoard(t)
	_ = b.Hive.RegisterAgent("orchestrator", "o")
	// A criterion that would pass anywhere — including the daemon's cwd. Only
	// refusing to run it at all can keep this task out of `done`.
	_ = b.Hive.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusInbox, DoneCriteria: []string{"true"}})
	for _, st := range []string{hive.StatusAssigned, hive.StatusInProgress, hive.StatusVerifying} {
		_, _ = b.Hive.UpdateTask("t1", func(x *hive.Task) error { x.Status = st; x.Assignee = "worker-1"; return nil })
	}
	gone := filepath.Join(t.TempDir(), "worktree-that-was-removed")
	res, err := b.Verify(ctx, "t1", gone)
	if err != nil {
		t.Fatal(err)
	}
	if res.Passed {
		t.Fatalf("verified against a missing worktree: %+v", res)
	}
	if res.Status != hive.StatusNeedsYou || !res.Unverifiable {
		t.Fatalf("missing worktree not escalated: %+v", res)
	}
	if len(res.Commands) != 0 {
		t.Fatalf("commands ran despite having nowhere to run them: %+v", res.Commands)
	}
	if tk, _ := b.Hive.GetTask("t1"); tk.Status == hive.StatusDone {
		t.Fatalf("task reached done with no worktree: %q", tk.Status)
	}
	// An empty cwd is the same hazard (it would run wherever the daemon sits).
	_, _ = b.Hive.UpdateTask("t1", func(x *hive.Task) error { x.Status = hive.StatusInProgress; return nil })
	_, _ = b.Hive.UpdateTask("t1", func(x *hive.Task) error { x.Status = hive.StatusVerifying; return nil })
	res2, err := b.Verify(ctx, "t1", "")
	if err != nil {
		t.Fatal(err)
	}
	if res2.Passed {
		t.Fatalf("verified with no directory at all: %+v", res2)
	}
}

// Defect regression (panel finding 7): RecordVerification was called with "" for
// output_path, so a green result carried no evidence — .ai/05-orchestration.md
// promised the path was recorded and it never was. The output is now persisted
// and the path stored, so a human can audit a pass after the fact.
func TestVerifyPersistsCommandOutput(t *testing.T) {
	ctx := context.Background()
	b := newBoard(t)
	marker := "caprock-verify-evidence-marker"
	_ = b.Hive.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusInbox, DoneCriteria: []string{"echo " + marker}})
	for _, st := range []string{hive.StatusAssigned, hive.StatusInProgress, hive.StatusVerifying} {
		_, _ = b.Hive.UpdateTask("t1", func(x *hive.Task) error { x.Status = st; return nil })
	}
	res, err := b.Verify(ctx, "t1", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if !res.Passed || len(res.Commands) != 1 {
		t.Fatalf("verify: %+v", res)
	}
	path := res.Commands[0].OutputPath
	if path == "" {
		t.Fatal("no output_path on the command run: a green result has no evidence")
	}
	blob, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("output file not written: %v", err)
	}
	if !contains(string(blob), marker) {
		t.Fatalf("output not captured in %s: %q", path, blob)
	}
	// And the path is in the verifications row, which is what the doc promises.
	var stored string
	if err := b.Store.DB().QueryRowContext(ctx,
		`SELECT COALESCE(output_path,'') FROM verifications WHERE task_id = ? AND round = ?`, "t1", res.Round).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != path {
		t.Fatalf("verifications.output_path = %q, want %q", stored, path)
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
	if _, err := b.Create(ctx, map[string]any{"id": "t1", "title": "x", "budget_usd": 5, "done_criteria": []string{"true"}}); err != nil {
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
	if _, err := b.Create(ctx, map[string]any{"id": "t1", "title": "x", "budget_usd": 1.0, "body": "brief", "done_criteria": []string{"true"}}); err != nil {
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

// Defect regression (panel finding 2): the forced-continue guard was armed per
// (session, task), and the orchestrator has no task — TaskForAgent returns ""
// for it — so `n` stayed at 1 and `n > MaxForcedContinues` was never true. One
// escalation it could not clear pinned an unattended
// --dangerously-skip-permissions session in an unbounded forced-continue loop.
// The bound must apply to a session with no task too, and it must actually stop.
func TestStopDecisionBoundsSessionWithNoTask(t *testing.T) {
	ctx := context.Background()
	b := newBoard(t)
	_ = b.Hive.RegisterAgent("orchestrator", "o")
	// Mail the orchestrator can never clear by stopping.
	_, _ = b.Hive.Send(hive.Message{From: "worker-1", To: "orchestrator", Kind: hive.KindEscalation, Body: "stuck"})
	_, _ = b.Hive.Deliver()
	// Far more attempts than the limit: the loop must end, not merely be slow.
	blocks := 0
	var last []byte
	for i := 0; i < MaxForcedContinues*5; i++ {
		last = b.StopDecision(ctx, "orch-sess", "orchestrator", "")
		if last != nil {
			blocks++
		}
	}
	if last != nil {
		t.Fatalf("orchestrator still being forced to continue after %d attempts: %s", MaxForcedContinues*5, last)
	}
	if blocks > MaxForcedContinues {
		t.Fatalf("forced the orchestrator %d times; the bound is %d", blocks, MaxForcedContinues)
	}
	if blocks == 0 {
		t.Fatal("orchestrator was never forced to continue at all; the Stop-loop is off")
	}
}

// Defect regression (panel finding 5): the escalation was guarded with
// `if hive.CanTransition(x.Status, needs_you)`, so an illegal hop (assigned →
// needs_you) was silently dropped: the status change vanished, the task stayed
// live, and the router kept the worker alive and kept waking it. moveTo walks a
// legal route instead — the lesson the codebase already learned in verify.go.
func TestStopDecisionGuardEscalatesFromAssigned(t *testing.T) {
	ctx := context.Background()
	b := newBoard(t)
	_ = b.Hive.RegisterAgent("worker-1", "w")
	_ = b.Hive.RegisterAgent("orchestrator", "o")
	// `assigned` cannot reach needs_you in one hop; that is the whole point.
	_ = b.Hive.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusInbox})
	_, _ = b.Hive.UpdateTask("t1", func(x *hive.Task) error { x.Status = hive.StatusAssigned; x.Assignee = "worker-1"; return nil })
	if hive.CanTransition(hive.StatusAssigned, hive.StatusNeedsYou) {
		t.Fatal("precondition gone: assigned → needs_you is now legal, so this test proves nothing")
	}
	_, _ = b.Hive.Send(hive.Message{From: "orchestrator", To: "worker-1", Kind: hive.KindAssign, TaskID: "t1", Body: "do it"})
	_, _ = b.Hive.Deliver()
	for i := 0; i < MaxForcedContinues+2; i++ {
		_ = b.StopDecision(ctx, "sess", "worker-1", "t1")
	}
	tk, _ := b.Hive.GetTask("t1")
	if tk.Status != hive.StatusNeedsYou {
		t.Fatalf("guard silently dropped the escalation: task is %q, want needs_you", tk.Status)
	}
	row, _ := store.GetTask(ctx, b.Store.DB(), "t1")
	if row.Status != hive.StatusNeedsYou {
		t.Fatalf("mirror not updated: %+v", row)
	}
}

// Defect regression (panel finding 4, creation half): a task created with no
// budget defaulted to 0, and 0 meant unlimited — the safe default was the unsafe
// one. A task created without a budget now gets a finite ceiling.
func TestCreateAppliesDefaultBudget(t *testing.T) {
	b := newBoard(t)
	out, err := b.Create(context.Background(), map[string]any{"title": "x", "done_criteria": []string{"true"}})
	if err != nil {
		t.Fatal(err)
	}
	row := out.(map[string]any)["task"].(store.TaskRow)
	if row.BudgetUSD <= 0 {
		t.Fatalf("task created with an unlimited budget: budget_usd = %v", row.BudgetUSD)
	}
	if row.BudgetUSD != DefaultBudgetUSD {
		t.Fatalf("budget_usd = %v, want DefaultBudgetUSD %v", row.BudgetUSD, DefaultBudgetUSD)
	}
	// The hive file (the source of truth) carries it too, so the router enforces it.
	tk, err := b.Hive.GetTask(row.ID)
	if err != nil {
		t.Fatal(err)
	}
	if tk.BudgetUSD != DefaultBudgetUSD {
		t.Fatalf("hive file budget_usd = %v, want %v", tk.BudgetUSD, DefaultBudgetUSD)
	}
}

// Defect regression (panel finding 6, the subtler half): VerifyTask fell back to
// RepoCwd when the assigned worker's worktree was missing. RepoCwd *exists*, so
// no downstream check could tell anything was wrong — the done_criteria ran
// against a clean main repo and the task passed for work nobody inspected. An
// assigned task is verified in its worker's worktree or not at all.
func TestVerifyTaskDoesNotFallBackToTheMainRepo(t *testing.T) {
	ctx := context.Background()
	b := newBoard(t)
	_ = b.Hive.RegisterAgent("orchestrator", "o")
	// A real repo cwd that exists and would pass the criteria — the trap.
	repo := t.TempDir()
	if err := os.WriteFile(filepath.Join(repo, "clean.txt"), []byte("main repo"), 0o644); err != nil {
		t.Fatal(err)
	}
	b.RepoCwd = repo
	// The worker's worktree is NOT created, so it is missing.
	if dirExists(WorktreePath(repo, "worker-1")) {
		t.Fatal("precondition: the worktree exists, so this proves nothing")
	}
	_ = b.Hive.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusInbox, DoneCriteria: []string{"test -f clean.txt"}})
	for _, st := range []string{hive.StatusAssigned, hive.StatusInProgress, hive.StatusVerifying} {
		_, _ = b.Hive.UpdateTask("t1", func(x *hive.Task) error { x.Status = st; x.Assignee = "worker-1"; return nil })
	}
	res, err := b.VerifyTask(ctx, "t1")
	if err != nil {
		t.Fatal(err)
	}
	if res.Passed {
		t.Fatalf("task verified against the main repo instead of the missing worktree: %+v", res)
	}
	if !res.Unverifiable || res.Status != hive.StatusNeedsYou {
		t.Fatalf("missing worktree not escalated: %+v", res)
	}
	if tk, _ := b.Hive.GetTask("t1"); tk.Status == hive.StatusDone {
		t.Fatalf("task reached done without its worktree: %q", tk.Status)
	}
}

// An UNASSIGNED task (no worker, so no worktree) still verifies in the repo —
// the refusal above must not overshoot into blocking ordinary verification.
func TestVerifyTaskUsesRepoForUnassignedTask(t *testing.T) {
	ctx := context.Background()
	b := newBoard(t)
	repo := t.TempDir()
	if err := os.WriteFile(filepath.Join(repo, "clean.txt"), []byte("main repo"), 0o644); err != nil {
		t.Fatal(err)
	}
	b.RepoCwd = repo
	_ = b.Hive.CreateTask(hive.Task{ID: "t1", Title: "x", Status: hive.StatusInbox, DoneCriteria: []string{"test -f clean.txt"}})
	for _, st := range []string{hive.StatusAssigned, hive.StatusInProgress, hive.StatusVerifying} {
		_, _ = b.Hive.UpdateTask("t1", func(x *hive.Task) error { x.Status = st; return nil })
	}
	res, err := b.VerifyTask(ctx, "t1")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Passed || res.Status != hive.StatusDone {
		t.Fatalf("an unassigned task can no longer be verified in the repo: %+v", res)
	}
}
