package board

import (
	"context"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
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
