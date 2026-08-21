//go:build smoke

package board

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/hive"
	"github.com/dspv/caprock/internal/store"
)

// TestPhase2EndToEnd scripts the DoD scenario with a fake agent (no real claude):
// task → assign → worker "does" it (badly) → verification fails once → bounce →
// worker fixes → verification passes → done, with cost attributed to the task.
func TestPhase2EndToEnd(t *testing.T) {
	ctx := context.Background()
	b := newBoard(t)

	// A fixture repo with a failing build.
	repo := t.TempDir()
	git(t, repo, "init", "-q")
	git(t, repo, "config", "user.email", "t@t")
	git(t, repo, "config", "user.name", "t")
	write(t, filepath.Join(repo, "go.mod"), "module e2e\n\ngo 1.26\n")
	write(t, filepath.Join(repo, "main.go"), "package main\nfunc main() { undefined() }\n")
	git(t, repo, "add", "-A")
	git(t, repo, "commit", "-q", "-m", "init")
	b.RepoCwd = repo

	// Orchestrator + worker exist; a task with a real done_criteria.
	_ = b.Hive.RegisterAgent(orchestratorAgentID, "o")
	_ = b.Hive.RegisterAgent("worker-1", "w")
	if _, err := b.Create(ctx, map[string]any{"id": "t-e2e", "title": "make it build", "budget_usd": 5, "done_criteria": []string{"go build ./..."}}); err != nil {
		t.Fatal(err)
	}

	// Orchestrator assigns the task to worker-1 (status inbox → assigned → in_progress).
	assign(t, b, "t-e2e", "worker-1")
	// Attribute some spend to the worker's session while it works.
	openAssignmentWithCost(t, b, "t-e2e", "worker-1", 0.42)

	// Worker reports done → orchestrator moves it to verifying → we verify.
	toVerifying(t, b, "t-e2e")
	res, err := b.VerifyTask(ctx, "t-e2e")
	if err != nil {
		t.Fatal(err)
	}
	if res.Passed || res.Escalated || res.Status != hive.StatusInProgress {
		t.Fatalf("round 1 should fail and bounce: %+v", res)
	}
	if n, _ := b.Hive.Deliver(); n < 1 || b.Hive.InboxCount("worker-1") < 1 {
		t.Fatalf("worker not bounced with failure output")
	}

	// Worker fixes the build.
	write(t, filepath.Join(repo, "main.go"), "package main\nfunc main() {}\n")

	// Re-verify → passes → done, with cost attributed.
	toVerifying(t, b, "t-e2e")
	res, err = b.VerifyTask(ctx, "t-e2e")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Passed || res.Status != hive.StatusDone {
		t.Fatalf("round 2 should pass: %+v", res)
	}
	row, _ := store.GetTask(ctx, b.Store.DB(), "t-e2e")
	if row.Status != hive.StatusDone {
		t.Fatalf("task not done in mirror: %+v", row)
	}
	if row.CostUSD < 0.41 || row.CostUSD > 0.43 {
		t.Fatalf("cost not attributed: %v", row.CostUSD)
	}
}

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	c := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if out, err := c.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func write(t *testing.T, p, content string) {
	t.Helper()
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func assign(t *testing.T, b *Board, taskID, worker string) {
	t.Helper()
	for _, st := range []string{hive.StatusAssigned, hive.StatusInProgress} {
		if _, err := b.Hive.UpdateTask(taskID, func(x *hive.Task) error { x.Status = st; x.Assignee = worker; return nil }); err != nil {
			t.Fatal(err)
		}
	}
	_ = b.mirror(context.Background(), mustTask(t, b, taskID))
}

func toVerifying(t *testing.T, b *Board, taskID string) {
	t.Helper()
	if _, err := b.Hive.UpdateTask(taskID, func(x *hive.Task) error {
		if x.Status == hive.StatusInProgress {
			x.Status = hive.StatusVerifying
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

// openAssignmentWithCost books spend the way production does: the window and the
// events are keyed on the worker's *session* id, which is never equal to its hive
// agent id. Passing the agent id as both (as this helper once did) made the
// task_assignments ⋈ events join succeed on a key production never uses, and hid
// the fact that verification closed the window on the wrong identifier.
func openAssignmentWithCost(t *testing.T, b *Board, taskID, worker string, cost float64) {
	t.Helper()
	ctx := context.Background()
	base := b.Now().UnixMilli()
	sessionID := "sess-" + worker
	_ = store.UpsertSession(ctx, b.Store.DB(), sessionID, store.SessionPatch{Cwd: "/repo"})
	if err := store.OpenAssignment(ctx, b.Store.DB(), taskID, sessionID, base-1000); err != nil {
		t.Fatal(err)
	}
	c := cost
	ev := &event.Event{SessionID: sessionID, Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Model: "claude-opus-5", CostUSD: &c, Key: "e2e", Ts: time.UnixMilli(base)}
	if _, err := store.InsertEvent(ctx, b.Store.DB(), ev); err != nil {
		t.Fatal(err)
	}
}

func mustTask(t *testing.T, b *Board, id string) hive.Task {
	t.Helper()
	tk, err := b.Hive.GetTask(id)
	if err != nil {
		t.Fatal(err)
	}
	return tk
}
