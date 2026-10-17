package projects

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseShortstat(t *testing.T) {
	loc := time.FixedZone("UTC+3", 3*3600)
	now := time.Date(2026, 10, 13, 15, 0, 0, 0, loc)
	start := activityStart(now)
	at := func(day, hour int) int64 { return start.AddDate(0, 0, day).Add(time.Duration(hour) * time.Hour).Unix() }
	rec := func(sec int64, stat string) string { return fmt.Sprintf("\x1e%d\n\n%s\n", sec, stat) }
	out := rec(at(13, 14), " 3 files changed, 120 insertions(+), 4 deletions(-)") +
		rec(at(13, 1), " 1 file changed, 1 insertion(+)") +
		rec(at(12, 23), " 2 files changed, 7 deletions(-)") +
		rec(at(0, 0), " 1 file changed, 5 insertions(+), 5 deletions(-)") +
		fmt.Sprintf("\x1e%d\n", at(5, 2)) + // an empty commit: no shortstat line
		rec(at(-1, 23), " 9 files changed, 900 insertions(+)") // the day before the window

	for _, eol := range []string{"\n", "\r\n"} {
		t.Run(fmt.Sprintf("eol %q", eol), func(t *testing.T) {
			commits, added, deleted, last := ParseShortstat([]byte(strings.ReplaceAll(out, "\n", eol)), start, 14)
			if commits[13] != 2 || added[13] != 121 || deleted[13] != 4 {
				t.Fatalf("today: %d commits +%d -%d", commits[13], added[13], deleted[13])
			}
			if commits[12] != 1 || added[12] != 0 || deleted[12] != 7 {
				t.Fatalf("yesterday: %d commits +%d -%d", commits[12], added[12], deleted[12])
			}
			if commits[0] != 1 || added[0] != 5 || deleted[0] != 5 {
				t.Fatalf("first day: %d commits +%d -%d", commits[0], added[0], deleted[0])
			}
			if commits[5] != 1 || added[5] != 0 {
				t.Fatalf("empty commit: %d commits +%d", commits[5], added[5])
			}
			total := 0
			for _, c := range commits {
				total += c
			}
			if total != 5 {
				t.Fatalf("commits in the window = %d, want 5 (the one before it left out)", total)
			}
			if want := at(13, 14) * 1000; last != want {
				t.Fatalf("last = %d, want %d", last, want)
			}
		})
	}
}

func TestRepoName(t *testing.T) {
	for in, want := range map[string]string{
		"/Users/u/dev/caprock":  "caprock",
		"/Users/u/dev/caprock/": "caprock",
		`C:\Users\u\dev\app`:    "app",
		`C:\Users\u\dev\app\`:   "app",
		"C:/Users/u/dev/app":    "app",
		`\\server\share\repo`:   "repo",
		`C:\`:                   `C:\`,
	} {
		if got := RepoName(in); got != want {
			t.Errorf("RepoName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestReadActivity(t *testing.T) {
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	start := activityStart(now)
	var asked []string
	git := func(args ...string) ([]byte, error) {
		asked = append(asked, args[0])
		switch args[0] {
		case "log":
			return []byte(fmt.Sprintf("\x1eaaa %d\r\n", start.AddDate(0, 0, 13).Unix())), nil
		case "branch":
			return []byte("main\r\n"), nil
		case "status":
			return []byte(" M a.go\r\n?? new.txt\r\n M dir\\b.go\r\n"), nil
		}
		return nil, errors.New("unexpected")
	}
	stat := func(args ...string) ([]byte, error) {
		asked = append(asked, "stat")
		return []byte("\x1eaaa\r\n\r\n 1 file changed, 2 insertions(+)\r\n"), nil
	}
	a, lines := readActivity(context.Background(), `C:\dev\app`, now, git, stat, nil)
	if a.Name != "app" || a.Commits[13] != 1 || a.Added[13] != 2 || a.Dirty != 3 || a.Error != "" || a.Branch != "main" || a.LinesPartial {
		t.Fatalf("got %+v", a)
	}
	if a.Days[0] != "2026-09-30" || a.Days[13] != "2026-10-13" {
		t.Fatalf("days %v", a.Days)
	}
	if strings.Join(asked, ",") != "log,stat,branch,status" {
		t.Fatalf("asked %v", asked)
	}
	// The next read diffs nothing it already counted.
	asked = nil
	if b, _ := readActivity(context.Background(), `C:\dev\app`, now, git, stat, lines); b.Added[13] != 2 || strings.Join(asked, ",") != "log,branch,status" {
		t.Fatalf("asked %v, got %+v", asked, b)
	}

	broken, _ := readActivity(context.Background(), "/x", now, func(...string) ([]byte, error) { return nil, errors.New("not a git repository") }, stat, nil)
	if broken.Error == "" || len(broken.Commits) != 14 {
		t.Fatalf("a failed git: %+v", broken)
	}
}

// Counting lines that runs out of time is not a repository that could not
// be read: the commits are counted, the batches diffed so far are kept, and
// the next read goes on from there. Before 2026-10-17 one
// `git log --all --shortstat` past the 5 s timeout (the owner's caprock and
// caprock-web) turned the whole row into "git could not be read".
func TestReadActivityLinesRunOut(t *testing.T) {
	defer func(n int) { activityStatBatch = n }(activityStatBatch)
	activityStatBatch = 2
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	start := activityStart(now)
	day := start.AddDate(0, 0, 13).Unix()
	git := func(args ...string) ([]byte, error) {
		if args[0] == "log" {
			return []byte(fmt.Sprintf("\x1ec1 %d\n\x1ec2 %d\n\x1ec3 %d\n\x1ec4 %d\n", day, day, day, day)), nil
		}
		return nil, nil
	}
	calls := 0
	stat := func(args ...string) ([]byte, error) {
		calls++
		if calls > 1 {
			return nil, errLineBudget
		}
		var b strings.Builder
		for _, h := range args[4:] {
			fmt.Fprintf(&b, "\x1e%s\n\n 1 file changed, 10 insertions(+), 1 deletion(-)\n", h)
		}
		return []byte(b.String()), nil
	}
	a, lines := readActivity(context.Background(), "/r", now, git, stat, nil)
	if a.Error != "" || a.Commits[13] != 4 || !a.LinesPartial || a.Added[13] != 20 || a.Deleted[13] != 2 || len(lines) != 2 {
		t.Fatalf("a budget run out: %+v, %d kept", a, len(lines))
	}
	calls = 0
	b, lines := readActivity(context.Background(), "/r", now, git, stat, lines)
	if b.LinesPartial || b.Added[13] != 40 || len(lines) != 4 || calls != 1 {
		t.Fatalf("the next read: %+v, %d kept, %d diffs", b, len(lines), calls)
	}
}

// The real git, in batches of two: lines per commit through
// `log --no-walk`, and the branch.
func TestActivityRealGit(t *testing.T) {
	needGit(t)
	defer func(n int) { activityStatBatch = n }(activityStatBatch)
	activityStatBatch = 2
	root := newRepo(t, filepath.Join(t.TempDir(), "app"))
	for i, body := range []string{"a\nb\n", "a\nb\nc\n", "c\n"} {
		if err := os.WriteFile(filepath.Join(root, "g"), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		git(t, root, "add", "g")
		git(t, root, "commit", "-q", "-m", fmt.Sprint("c", i))
	}
	s := &Service{}
	a := s.Activity(context.Background(), root)
	total := func(v []int) (n int) {
		for _, x := range v {
			n += x
		}
		return n
	}
	// f +1; g +2, then +1, then +0 -2.
	if a.Error != "" || a.Branch != "main" || a.LinesPartial || total(a.Commits) != 4 || total(a.Added) != 4 || total(a.Deleted) != 2 {
		t.Fatalf("got %+v", a)
	}
}

func TestActivityIsKept(t *testing.T) {
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	s := &Service{Now: func() time.Time { return now }}
	root := t.TempDir() // not a repository: git fails, and the failure is kept too
	a := s.Activity(context.Background(), root)
	if a.Error == "" {
		t.Fatalf("want an error from a folder that is not a repository, got %+v", a)
	}
	now = now.Add(time.Minute)
	if b := s.Activity(context.Background(), root); b.CheckedMs != a.CheckedMs {
		t.Fatalf("asked git again a minute later")
	}
	now = now.Add(activityKept)
	if c := s.Activity(context.Background(), root); c.CheckedMs == a.CheckedMs {
		t.Fatalf("kept past activityKept")
	}
}

// A request cancelled mid-read (a page reloading) does not leave a failure
// kept for 10 minutes: the read finishes under the git timeout alone.
func TestActivityOutlivesItsRequest(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	root := t.TempDir()
	if out, err := exec.Command("git", "init", "-q", root).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s := &Service{}
	if a := s.Activity(ctx, root); a.Error != "" {
		t.Fatalf("a cancelled request kept a failure: %q", a.Error)
	}
}
