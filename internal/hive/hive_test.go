package hive

import (
	"path/filepath"
	"testing"
)

func TestAgentsTasksMailboxLedger(t *testing.T) {
	h, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := h.RegisterAgent("orchestrator", "# Orchestrator\n"); err != nil {
		t.Fatal(err)
	}
	if err := h.RegisterAgent("worker-1", "# Worker\n"); err != nil {
		t.Fatal(err)
	}
	// Idempotent identity: re-register keeps identity.md.
	if err := h.RegisterAgent("worker-1", "# CHANGED\n"); err != nil {
		t.Fatal(err)
	}
	// Invalid ids are rejected (path traversal).
	if err := h.RegisterAgent("../evil", "x"); err == nil {
		t.Fatal("accepted traversal id")
	}

	task := Task{ID: "t-2026-0001", Title: "Add /healthz: return 200", BudgetUSD: 3, DoneCriteria: []string{"go test ./...", "go vet ./..."}, Body: "Free-form acceptance notes.\n"}
	if err := h.CreateTask(task); err != nil {
		t.Fatal(err)
	}
	got, err := h.GetTask("t-2026-0001")
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "Add /healthz: return 200" || got.BudgetUSD != 3 || len(got.DoneCriteria) != 2 || got.Status != StatusInbox || got.Body != "Free-form acceptance notes." {
		t.Fatalf("task round-trip: %+v", got)
	}
	// Duplicate rejected.
	if err := h.CreateTask(task); err == nil {
		t.Fatal("duplicate task accepted")
	}
	// Legal transition inbox → assigned.
	if _, err := h.UpdateTask("t-2026-0001", func(x *Task) error { x.Status = StatusAssigned; x.Assignee = "worker-1"; return nil }); err != nil {
		t.Fatal(err)
	}
	// Illegal transition assigned → done rejected.
	if _, err := h.UpdateTask("t-2026-0001", func(x *Task) error { x.Status = StatusDone; return nil }); err == nil {
		t.Fatal("illegal transition accepted")
	}
	tasks, _ := h.ListTasks()
	if len(tasks) != 1 || tasks[0].Status != StatusAssigned || tasks[0].Assignee != "worker-1" {
		t.Fatalf("list: %+v", tasks)
	}

	// Mailbox round-trip: orchestrator assigns → router delivers → worker inbox.
	if _, err := h.Send(Message{From: "orchestrator", To: "worker-1", Kind: KindAssign, TaskID: "t-2026-0001", Body: "Please do t-2026-0001."}); err != nil {
		t.Fatal(err)
	}
	if h.InboxCount("worker-1") != 0 {
		t.Fatal("delivered before router ran")
	}
	n, err := h.Deliver()
	if err != nil || n != 1 {
		t.Fatalf("deliver: %d %v", n, err)
	}
	if h.InboxCount("worker-1") != 1 {
		t.Fatalf("inbox count %d", h.InboxCount("worker-1"))
	}
	msgs, _ := h.Inbox("worker-1")
	if len(msgs) != 1 || msgs[0].Kind != KindAssign || msgs[0].TaskID != "t-2026-0001" || msgs[0].From != "orchestrator" {
		t.Fatalf("inbox: %+v", msgs)
	}
	// Delivering again is a no-op (outbox is empty).
	if n, _ := h.Deliver(); n != 0 {
		t.Fatal("re-deliver moved messages")
	}

	// Ledger records the whole story.
	led, err := h.Ledger()
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]int{}
	for _, e := range led {
		kinds[e.Kind]++
	}
	if kinds["agent.registered"] < 2 || kinds["task.created"] != 1 || kinds["task.status"] != 1 || kinds["mail.sent"] != 1 || kinds["mail.delivered"] != 1 {
		t.Fatalf("ledger kinds: %v", kinds)
	}

	// The task file is human-readable markdown.
	b, _ := readFile(t, filepath.Join(h.Root, "tasks", "t-2026-0001.md"))
	if !contains(b, "status: assigned") || !contains(b, "- go test ./...") {
		t.Fatalf("task file:\n%s", b)
	}
}

func TestTransitions(t *testing.T) {
	if !CanTransition(StatusInProgress, StatusVerifying) || CanTransition(StatusInbox, StatusDone) || !CanTransition(StatusDone, StatusDone) {
		t.Fatal("transition table wrong")
	}
}

func TestArchiveInbox(t *testing.T) {
	h, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := h.RegisterAgent("worker-1", "w"); err != nil {
		t.Fatal(err)
	}
	// Deliver an assign (task t1) and a result (task t2) into the worker's inbox.
	for _, m := range []Message{
		{From: "orchestrator", To: "worker-1", Kind: KindAssign, TaskID: "t1", Body: "do t1"},
		{From: "peer", To: "worker-1", Kind: KindResult, TaskID: "t2", Body: "fyi"},
	} {
		if _, err := h.Send(m); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.Deliver(); err != nil {
		t.Fatal(err)
	}
	if h.InboxCount("worker-1") != 2 {
		t.Fatalf("setup inbox: %d", h.InboxCount("worker-1"))
	}
	// Archive only the assign for t1 (keep everything else).
	n, err := h.ArchiveInbox("worker-1", func(m Message) bool {
		return m.Kind != KindAssign || m.TaskID != "t1"
	})
	if err != nil || n != 1 {
		t.Fatalf("archive: n=%d err=%v", n, err)
	}
	if h.InboxCount("worker-1") != 1 {
		t.Fatalf("inbox after archive: %d, want 1", h.InboxCount("worker-1"))
	}
	msgs, _ := h.Inbox("worker-1")
	if len(msgs) != 1 || msgs[0].Kind != KindResult {
		t.Fatalf("wrong message kept: %+v", msgs)
	}
	// The archived assign is preserved under processed/ (audit trail, not a delete).
	proc, err := listDir(filepath.Join(h.Root, "agents", "worker-1", "processed"))
	if err != nil || len(proc) != 1 {
		t.Fatalf("processed dir: %v %v", proc, err)
	}
	// Idempotent: archiving again moves nothing (the assign is gone).
	if n, _ := h.ArchiveInbox("worker-1", func(m Message) bool {
		return m.Kind != KindAssign || m.TaskID != "t1"
	}); n != 0 {
		t.Fatalf("re-archive moved %d", n)
	}
}
