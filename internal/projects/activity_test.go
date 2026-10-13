package projects

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestParseShortstat(t *testing.T) {
	loc := time.FixedZone("UTC+3", 3*3600)
	now := time.Date(2026, 10, 13, 15, 0, 0, 0, loc)
	start := activityStart(now, 14)
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
	start := activityStart(now, 14)
	var asked []string
	git := func(args ...string) ([]byte, error) {
		asked = append(asked, args[0])
		switch args[0] {
		case "log":
			return []byte(fmt.Sprintf("\x1e%d\r\n\r\n 1 file changed, 2 insertions(+)\r\n", start.AddDate(0, 0, 13).Unix())), nil
		case "status":
			return []byte(" M a.go\r\n?? new.txt\r\n M dir\\b.go\r\n"), nil
		}
		return nil, errors.New("unexpected")
	}
	a := readActivity(context.Background(), `C:\dev\app`, now, 14, git)
	if a.Name != "app" || a.Commits[13] != 1 || a.Added[13] != 2 || a.Dirty != 3 || a.Error != "" {
		t.Fatalf("got %+v", a)
	}
	if a.Days[0] != "2026-09-30" || a.Days[13] != "2026-10-13" {
		t.Fatalf("days %v", a.Days)
	}
	if strings.Join(asked, ",") != "log,status" {
		t.Fatalf("asked %v", asked)
	}

	broken := readActivity(context.Background(), "/x", now, 14, func(...string) ([]byte, error) { return nil, errors.New("not a git repository") })
	if broken.Error == "" || len(broken.Commits) != 14 {
		t.Fatalf("a failed git: %+v", broken)
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
