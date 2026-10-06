package store

import (
	"context"
	"testing"
)

func TestPendingPermissionsArePrunedToTheRunningSessions(t *testing.T) {
	ctx := context.Background()
	st := openTest(t)
	err := st.WithTx(ctx, func(q Querier) error {
		for _, id := range []string{"running", "ended"} {
			if err := SavePendingPermission(ctx, q, PendingPermission{SessionID: id, PromptID: "p-" + id, Tool: "Bash", SinceMs: 1}); err != nil {
				return err
			}
		}
		// A second prompt queues behind the first: Claude Code shows the
		// oldest and keeps the rest.
		return SavePendingPermission(ctx, q, PendingPermission{SessionID: "running", PromptID: "p2", Tool: "Write", SinceMs: 2, ToolUseID: "toolu_2", AgentID: "a1"})
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.WithTx(ctx, func(q Querier) error {
		return PrunePendingPermissions(ctx, q, map[string]bool{"running": true})
	}); err != nil {
		t.Fatal(err)
	}
	ps, err := ListPendingPermissions(ctx, st.DB(), "running")
	if err != nil || len(ps) != 2 || ps[0].PromptID != "p-running" || ps[1].PromptID != "p2" || ps[1].ToolUseID != "toolu_2" || ps[1].AgentID != "a1" {
		t.Fatalf("running: %+v %v", ps, err)
	}
	if ps, _ := ListPendingPermissions(ctx, st.DB(), "ended"); len(ps) != 0 {
		t.Fatal("a prompt of a session that is not running was kept")
	}
}

func TestReplacingTheQueueKeepsItsOrder(t *testing.T) {
	ctx := context.Background()
	st := openTest(t)
	want := []PendingPermission{
		{PromptID: "b", Tool: "Bash", SinceMs: 5},
		{PromptID: "a", Tool: "Write", SinceMs: 5},
	}
	for range 2 { // twice: replacing is idempotent
		if err := st.WithTx(ctx, func(q Querier) error { return ReplacePendingPermissions(ctx, q, "s", want) }); err != nil {
			t.Fatal(err)
		}
	}
	ps, err := ListPendingPermissions(ctx, st.DB(), "s")
	if err != nil || len(ps) != 2 || ps[0].PromptID != "b" || ps[1].PromptID != "a" {
		t.Fatalf("got %+v %v", ps, err)
	}
	if err := st.WithTx(ctx, func(q Querier) error { return ReplacePendingPermissions(ctx, q, "s", nil) }); err != nil {
		t.Fatal(err)
	}
	if ps, _ := ListPendingPermissions(ctx, st.DB(), "s"); len(ps) != 0 {
		t.Fatalf("left %+v", ps)
	}
}
