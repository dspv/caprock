package daemon

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/board"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/hive"
	"github.com/dspv/caprock/internal/store"
)

func testBoard(t *testing.T) (*board.Board, *store.Store) {
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
	b := board.New(h, st, bus.New(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	b.RepoCwd = "/repo"
	return b, st
}

// adapterFor wraps a board the way the running daemon does. The adapter resolves
// the board off the daemon per call (so the runner can be turned on at runtime),
// so a test cannot hand it a bare board any more.
func adapterFor(b *board.Board) *boardAdapter {
	return &boardAdapter{d: &Daemon{board: b}}
}

// The task card was a title, an id and a dollar figure. Where a worker's output
// actually went — the branch and the worktree — was constructed at spawn time
// and then never told to anyone, so the only way to find a finished worker's
// work was to already know the naming scheme. The detail endpoint has to name
// both, and they have to be the strings `git worktree add` was actually given.
func TestTaskDetailNamesTheBranchAndWorktree(t *testing.T) {
	b, _ := testBoard(t)
	if err := b.Hive.CreateTask(hive.Task{ID: "t-1", Title: "x", Status: hive.StatusInbox, DoneCriteria: []string{"go test ./..."}}); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Hive.UpdateTask("t-1", func(x *hive.Task) error {
		x.Assignee, x.Status = "worker-1", hive.StatusAssigned
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := b.Rescan(context.Background()); err != nil {
		t.Fatal(err)
	}

	out, err := adapterFor(b).Get(context.Background(), "t-1")
	if err != nil {
		t.Fatal(err)
	}
	m := out.(map[string]any)
	work, ok := m["work"].(map[string]any)
	if !ok {
		t.Fatalf("no work block on the task detail: %#v", m)
	}
	// internal/agents/worktree.go: `git worktree add -B caprock/<name> <repo>/.caprock-worktrees/<name>`.
	if work["branch"] != "caprock/worker-1" {
		t.Errorf("branch = %v, want caprock/worker-1", work["branch"])
	}
	wt, _ := work["worktree"].(string)
	if !strings.Contains(wt, ".caprock-worktrees") || !strings.HasSuffix(wt, "worker-1") {
		t.Errorf("worktree = %q, want <repo>/.caprock-worktrees/worker-1", wt)
	}
	if work["repo"] != "/repo" {
		t.Errorf("repo = %v, want /repo", work["repo"])
	}
}

// The SQLite mirror drops done_criteria, so nothing the API returned could tell
// a user what "done" was going to mean for a task. The card has to be able to
// show the checks before they run, not only after.
func TestTaskDetailCarriesDoneCriteria(t *testing.T) {
	b, _ := testBoard(t)
	if err := b.Hive.CreateTask(hive.Task{ID: "t-2", Title: "x", Status: hive.StatusInbox, DoneCriteria: []string{"go test ./...", "go vet ./..."}}); err != nil {
		t.Fatal(err)
	}
	if err := b.Rescan(context.Background()); err != nil {
		t.Fatal(err)
	}
	out, err := adapterFor(b).Get(context.Background(), "t-2")
	if err != nil {
		t.Fatal(err)
	}
	crit, _ := out.(map[string]any)["done_criteria"].([]string)
	if len(crit) != 2 || crit[0] != "go test ./..." {
		t.Fatalf("done_criteria = %#v, want the two commands the task declares", crit)
	}
}

// A green task with no visible evidence is indistinguishable from one that was
// never checked. The verification rows were written and never read back by
// anything, so the proof existed and was unreachable.
func TestTaskDetailReturnsTheRecordedChecks(t *testing.T) {
	b, st := testBoard(t)
	if err := b.Hive.CreateTask(hive.Task{ID: "t-3", Title: "x", Status: hive.StatusInbox, DoneCriteria: []string{"go test ./..."}}); err != nil {
		t.Fatal(err)
	}
	if err := b.Rescan(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := store.RecordVerification(ctx, st.DB(), "t-3", 1, "go test ./...", 0, "/hive/verifications/t-3/round-1-cmd-0.log"); err != nil {
		t.Fatal(err)
	}
	out, err := adapterFor(b).Get(ctx, "t-3")
	if err != nil {
		t.Fatal(err)
	}
	work, _ := out.(map[string]any)["work"].(map[string]any)
	runs, _ := work["verifications"].([]store.VerificationRow)
	if len(runs) != 1 {
		t.Fatalf("verifications = %#v, want the one recorded run", work["verifications"])
	}
	if runs[0].Command != "go test ./..." || runs[0].ExitCode != 0 {
		t.Fatalf("verification row lost its content: %#v", runs[0])
	}
}

// The diff endpoint is keyed on a session id, and the board only ever knew the
// hive agent id — which is exactly why no task card could link to a diff. The
// detail has to hand the UI the session that did the work.
func TestTaskDetailLinksTheSessionThatDidTheWork(t *testing.T) {
	b, st := testBoard(t)
	ctx := context.Background()
	if err := b.Hive.CreateTask(hive.Task{ID: "t-4", Title: "x", Status: hive.StatusInbox, DoneCriteria: []string{"go test ./..."}}); err != nil {
		t.Fatal(err)
	}
	if err := b.Rescan(ctx); err != nil {
		t.Fatal(err)
	}
	if err := store.OpenAssignment(ctx, st.DB(), "t-4", "sess-abc", 1000); err != nil {
		t.Fatal(err)
	}
	out, err := adapterFor(b).Get(ctx, "t-4")
	if err != nil {
		t.Fatal(err)
	}
	work, _ := out.(map[string]any)["work"].(map[string]any)
	sessions, _ := work["sessions"].([]store.TaskSession)
	if len(sessions) != 1 || sessions[0].SessionID != "sess-abc" {
		t.Fatalf("sessions = %#v, want the session attributed to the task", work["sessions"])
	}
}

// A task nobody has picked up has no branch to report. Inventing one would send
// a user looking for a worktree that was never created.
func TestTaskDetailReportsNoBranchBeforeAssignment(t *testing.T) {
	b, _ := testBoard(t)
	if err := b.Hive.CreateTask(hive.Task{ID: "t-5", Title: "x", Status: hive.StatusInbox, DoneCriteria: []string{"go test ./..."}}); err != nil {
		t.Fatal(err)
	}
	if err := b.Rescan(context.Background()); err != nil {
		t.Fatal(err)
	}
	out, err := adapterFor(b).Get(context.Background(), "t-5")
	if err != nil {
		t.Fatal(err)
	}
	work, _ := out.(map[string]any)["work"].(map[string]any)
	if _, ok := work["branch"]; ok {
		t.Fatalf("an unassigned task reported a branch: %#v", work)
	}
}
