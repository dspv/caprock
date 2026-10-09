package ingest

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The exact shape seen on 2026-10-09: the main checkout on master, a
// background agent's linked worktree under .claude/worktrees on its own
// branch, and the PARENT's transcript line — no agentId, not a sidechain,
// cwd the main checkout — reporting the worktree's branch.
func TestLineBranchTrustsTheCheckoutNotTheTranscript(t *testing.T) {
	root := t.TempDir()
	write := func(p, s string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	main := filepath.Join(root, "caprock")
	wt := filepath.Join(main, ".claude", "worktrees", "agent-a3142d41398d6ca79")
	write(filepath.Join(main, ".git", "HEAD"), "ref: refs/heads/master\n")
	write(filepath.Join(main, ".git", "worktrees", "agent-a3142d41398d6ca79", "HEAD"), "ref: refs/heads/feat/cockpit-scrub\n")
	write(filepath.Join(wt, ".git"), "gitdir: "+filepath.Join(main, ".git", "worktrees", "agent-a3142d41398d6ca79")+"\n")
	write(filepath.Join(root, "detached", ".git", "HEAD"), "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n")

	now := time.Date(2026, 10, 9, 17, 35, 0, 0, time.UTC)
	line := func(cwd, branch string, at time.Time) *Line {
		raw := `{"type":"assistant","sessionId":"a2ef22a8","isSidechain":false,"cwd":` + q(cwd) + `,"gitBranch":` + q(branch) + `,"timestamp":` + q(at.Format(time.RFC3339Nano)) + `,"message":{"id":"m","model":"claude-opus-5-5","content":[]}}`
		l, err := ParseLine([]byte(raw))
		if err != nil {
			t.Fatal(err)
		}
		return l
	}

	if got := lineBranch(line(main, "feat/cockpit-scrub", now.Add(-time.Second)), now, now); got != "master" {
		t.Errorf("parent's live line in the main checkout = %q, want master", got)
	}
	if got := lineBranch(line(filepath.Join(main, "internal", "store"), "feat/cockpit-scrub", now), now, now); got != "master" {
		t.Errorf("a subdirectory of the main checkout = %q, want master", got)
	}
	if got := lineBranch(line(wt, "master", now), now, now); got != "feat/cockpit-scrub" {
		t.Errorf("a line in the worktree = %q, want its own branch", got)
	}
	if got := lineBranch(line(main, "feat/old", now.Add(-48*time.Hour)), now, now); got != "feat/old" {
		t.Errorf("an old line = %q, want what it says: today's HEAD says nothing about it", got)
	}
	if got := lineBranch(line(filepath.Join(root, "detached"), "topic", now), now, now); got != "topic" {
		t.Errorf("a detached checkout = %q, want the transcript's", got)
	}
	if got := lineBranch(line(filepath.Join(root, "gone"), "topic", now), now, now); got != "topic" {
		t.Errorf("no checkout = %q, want the transcript's", got)
	}
}

func q(s string) string { return `"` + filepath.ToSlash(s) + `"` }
