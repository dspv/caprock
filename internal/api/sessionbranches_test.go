package api

import (
	"context"
	"os"
	"os/exec"
	"testing"
	"time"
)

// The deck's Branches view: the session's repository's branches from local
// git, the current one first and then by last activity, each with what
// Caprock's sessions on it cost, and the stale mark; nothing asked of GitHub
// while it is not connected.
func TestSessionBranches(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	e := newEnv(t)
	ctx := context.Background()
	dir := t.TempDir()
	now := time.Now().UTC()
	run := func(ago time.Duration, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=Ada", "-c", "user.email=ada@example.com", "-c", "commit.gpgsign=false"}, args...)...)
		date := now.Add(-ago).Format(time.RFC3339)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run(60*24*time.Hour, "init", "-q", "-b", "main")
	run(60*24*time.Hour, "remote", "add", "origin", "git@github.com:dspv/caprock.git")
	run(60*24*time.Hour, "commit", "-q", "--allow-empty", "-m", "one")
	run(45*24*time.Hour, "checkout", "-q", "-b", "old")
	run(45*24*time.Hour, "commit", "-q", "--allow-empty", "-m", "old")
	run(3*time.Hour, "checkout", "-q", "-b", "spent", "main")
	run(3*time.Hour, "commit", "-q", "--allow-empty", "-m", "spent")
	run(2*time.Hour, "checkout", "-q", "-b", "feat/now", "main")
	run(2*time.Hour, "commit", "-q", "--allow-empty", "-m", "now")
	run(2*time.Hour, "commit", "-q", "--allow-empty", "-m", "now 2")
	e.seed(t, dir)
	db := e.st.DB()
	if _, err := db.ExecContext(ctx, `UPDATE sessions SET git_branch = 'spent', last_event_at = ? WHERE session_id = 's1'`, now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE session_stats SET cost_usd = 4.5 WHERE session_id = 's1'`); err != nil {
		t.Fatal(err)
	}

	var out SessionBranches
	if code := e.get(t, "/v1/sessions/s1/branches", &out); code != 200 {
		t.Fatalf("branches: %d", code)
	}
	if out.Connected || out.Repo != "dspv/caprock" || out.Default != "main" || out.Current != "feat/now" || out.Error != nil {
		t.Fatalf("head = %+v", out)
	}
	var names []string
	for _, b := range out.Branches {
		names = append(names, b.Name)
	}
	// Current first; then "spent", whose session is newer than any commit;
	// then old (45 days), then main (60 days).
	want := []string{"feat/now", "spent", "old", "main"}
	if len(names) != len(want) {
		t.Fatalf("order = %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("order = %v, want %v", names, want)
		}
	}
	cur, spent, old, main := out.Branches[0], out.Branches[1], out.Branches[2], out.Branches[3]
	if !cur.Current || cur.Ahead == nil || *cur.Ahead != 2 || *cur.Behind != 0 || cur.Stale || cur.PR != nil {
		t.Fatalf("current = %+v", cur)
	}
	if spent.CostUSD != 4.5 || spent.Sessions != 1 || len(spent.Agents) != 1 || spent.ActivityAt != now.UnixMilli() {
		t.Fatalf("spent = %+v", spent)
	}
	if !old.Stale || old.Sessions != 0 || old.Agents == nil {
		t.Fatalf("old = %+v", old)
	}
	// Sixty days without a commit, but the default branch is never stale.
	if !main.Default || main.Stale {
		t.Fatalf("main = %+v", main)
	}
	if code := e.get(t, "/v1/sessions/nope/branches", nil); code != 404 {
		t.Fatalf("unknown session: %d", code)
	}
}

func TestOrderBranches(t *testing.T) {
	bs := []SessionBranch{{ActivityAt: 5}, {ActivityAt: 9}, {ActivityAt: 1}, {ActivityAt: 9}}
	bs[0].Name, bs[1].Name, bs[2].Name, bs[3].Name = "e", "b", "cur", "a"
	bs[2].Current = true
	OrderBranches(bs)
	got := bs[0].Name + bs[1].Name + bs[2].Name + bs[3].Name
	if got != "curabe" {
		t.Fatalf("order = %s", got)
	}
}
