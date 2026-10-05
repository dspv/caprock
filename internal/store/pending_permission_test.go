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
		// A newer prompt replaces the older one: one dialog at a time.
		return SavePendingPermission(ctx, q, PendingPermission{SessionID: "running", PromptID: "p2", Tool: "Write", SinceMs: 2})
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.WithTx(ctx, func(q Querier) error {
		return PrunePendingPermissions(ctx, q, map[string]bool{"running": true})
	}); err != nil {
		t.Fatal(err)
	}
	p, ok, err := GetPendingPermission(ctx, st.DB(), "running")
	if err != nil || !ok || p.PromptID != "p2" || p.Tool != "Write" {
		t.Fatalf("running: %+v %v %v", p, ok, err)
	}
	if _, ok, _ := GetPendingPermission(ctx, st.DB(), "ended"); ok {
		t.Fatal("a prompt of a session that is not running was kept")
	}
}
