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

// A burst of lines from one folder reads HEAD once; the answer stands for two
// seconds, then a switched checkout is read again. Folders are cached apart.
func TestBranchCacheReadsAFolderOncePerTwoSeconds(t *testing.T) {
	reads := map[string]int{}
	branch := "master"
	c := &branchCache{read: func(dir string) (string, bool) { reads[dir]++; return branch, true }}
	t0 := time.Date(2026, 10, 9, 17, 35, 0, 0, time.UTC)

	for i := 0; i < 50; i++ {
		if b, ok := c.at("/w/caprock", t0.Add(time.Duration(i)*30*time.Millisecond)); !ok || b != "master" {
			t.Fatalf("line %d: %q %v", i, b, ok)
		}
	}
	if reads["/w/caprock"] != 1 {
		t.Fatalf("a 1.5 s burst read HEAD %d times, want 1", reads["/w/caprock"])
	}

	branch = "feat/x"
	if b, _ := c.at("/w/caprock", t0.Add(1900*time.Millisecond)); b != "master" {
		t.Errorf("within the TTL = %q, want the cached master", b)
	}
	if b, _ := c.at("/w/caprock", t0.Add(2*time.Second)); b != "feat/x" {
		t.Errorf("after the TTL = %q, want the switched branch", b)
	}
	if reads["/w/caprock"] != 2 {
		t.Errorf("reads = %d, want 2", reads["/w/caprock"])
	}

	c.at("/w/other", t0.Add(2*time.Second))
	if reads["/w/other"] != 1 {
		t.Errorf("another folder was answered from the first one's entry")
	}
	// A clock that went backwards does not keep a stale entry alive.
	c.at("/w/other", t0)
	if reads["/w/other"] != 2 {
		t.Errorf("an entry from the future was trusted")
	}
}
