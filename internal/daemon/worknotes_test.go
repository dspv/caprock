package daemon

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// notesGit runs git in dir with a fixed identity and date, global and
// system config kept out.
func notesGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cfg := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(cfg, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("git", append([]string{"-C", dir, "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"}, args...)...)
	stamp := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC).Format(time.RFC3339)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
		"GIT_AUTHOR_DATE="+stamp, "GIT_COMMITTER_DATE="+stamp, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+cfg)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// Owner, 2026-11-19: before the batch pull request merges, the release
// section had no entries and no version. The fragments its branch adds are
// read from origin/<head> as the clone knows it, never fetched; one the
// branch only kept from before a release is not its own; the CHANGELOG's
// newest released section is the notes of the release just cut.
func TestReadRepoGitAddsTheBatchBranch(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	ctx := context.Background()
	root := t.TempDir()
	up := filepath.Join(root, "up")
	frag := filepath.Join(up, "changes", "unreleased")
	if err := os.MkdirAll(frag, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(up, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	commit := func(msg string) {
		t.Helper()
		notesGit(t, up, "add", "-A")
		notesGit(t, up, "commit", "-q", "-m", msg)
	}
	notesGit(t, up, "init", "-q", "-b", "master")
	write("CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n## [0.183.0] - 2026-11-19\n\n### Fixed\n\n- **ui:** shipped *yesterday*.\n")
	write("changes/unreleased/shipped.md", "---\nkind: Fixed\n---\n- **ui:** released already.\n")
	commit("base")
	notesGit(t, up, "tag", "v0.183.0")
	notesGit(t, up, "checkout", "-q", "-b", "feat/batch")
	write("changes/unreleased/foreign.md", "---\nkind: Fixed\n---\n- **ui:** PR from another repo no longer\n  shows as this one's.\n")
	write("changes/unreleased/fold.md", "---\nkind: Changed\n---\n- **ui:** folded CI second line under the word *CI*.\n")
	commit("batch")
	notesGit(t, up, "checkout", "-q", "master")
	// The release took the fragment off the default branch; the batch
	// branch still has it from where it started.
	if err := os.Remove(filepath.Join(frag, "shipped.md")); err != nil {
		t.Fatal(err)
	}
	write("changes/unreleased/on-master.md", "---\nkind: Fixed\n---\n- **db:** merged already.\n")
	commit("master moves")
	notesGit(t, root, "clone", "-q", up, "clone")
	clone := filepath.Join(root, "clone")
	notesGit(t, clone, "remote", "set-url", "origin", "https://github.com/o/r.git")

	asked := 0
	batch := func(_ context.Context, remote string) (store.GitHubPR, bool) {
		asked++
		if remote != "o/r" {
			t.Errorf("asked for %q", remote)
		}
		return store.GitHubPR{Number: 949, Head: "feat/batch", State: "open"}, true
	}
	g := readRepoGit(ctx, clone, nil, batch)
	u := g.unreleased
	if u == nil || u.Count != 3 || u.Kinds["Fixed"] != 2 || u.Kinds["Changed"] != 1 {
		t.Fatalf("unreleased = %+v", u)
	}
	if u.Via == nil || u.Via.Number != 949 || u.Via.Head != "feat/batch" || len(u.Via.SHA) < 40 {
		t.Fatalf("via = %+v", u.Via)
	}
	got := map[string]string{}
	for _, e := range u.Entries {
		got[e.Text] = e.Source + " " + e.Kind + " " + e.Scope
	}
	want := map[string]string{
		"merged already.":                                     "master Fixed db",
		"folded CI second line under the word CI.":            "pr Changed ui",
		"PR from another repo no longer shows as this one's.": "pr Fixed ui",
	}
	if len(got) != len(want) {
		t.Fatalf("entries = %+v", u.Entries)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("entry %q = %q, want %q", k, got[k], v)
		}
	}
	if r := g.released; r == nil || r.Version != "0.183.0" || r.Count != 1 || r.Entries[0].Text != "shipped yesterday." || r.Entries[0].Kind != "Fixed" {
		t.Fatalf("released = %+v", g.released)
	}

	// Kept while neither branch moves.
	again := readRepoGit(ctx, clone, &g, batch)
	if again.unreleased != g.unreleased || asked != 2 {
		t.Fatalf("not reused: %p vs %p, asked %d", again.unreleased, g.unreleased, asked)
	}

	// A branch the clone never fetched is not read, and nothing is fetched.
	none := readRepoGit(ctx, clone, nil, func(context.Context, string) (store.GitHubPR, bool) {
		return store.GitHubPR{Number: 950, Head: "feat/not-fetched", State: "open"}, true
	})
	if none.unreleased == nil || none.unreleased.Count != 1 || none.unreleased.Via != nil || none.unreleased.Entries[0].Source != "master" {
		t.Fatalf("not fetched: %+v", none.unreleased)
	}
}

// The batch pull request comes from the lists already read: the newest
// open one that is not a release pull request.
func TestWorkBoardBatchPR(t *testing.T) {
	w, _, d, now := newTestWork(t)
	if err := d.store.UpsertGitHubPRs(context.Background(), "o/r", []store.GitHubPR{
		{Number: 949, URL: "https://github.com/o/r/pull/949", Title: "fix: the batch", Head: "feat/batch", State: "open", UpdatedAt: 1},
		{Number: 950, URL: "https://github.com/o/r/pull/950", Title: "chore(release): 0.183.1", Head: "release", State: "open", UpdatedAt: 1},
	}, now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	p, ok := w.batchPR(context.Background(), "o/r")
	if !ok || p.Number != 949 {
		t.Fatalf("batch %+v ok %v", p, ok)
	}
	w.now = func() time.Time { return now.Add(workBatchSeen + time.Hour) }
	if _, ok := w.batchPR(context.Background(), "o/r"); ok {
		t.Fatal("a list read days ago still named the batch")
	}
}
