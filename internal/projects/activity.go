package projects

import (
	"bytes"
	"context"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// RepoActivity is what a repository's own git says about its last
// ActivityDays days: the Now screen's Repos section (.ai/04-ui.md § Repos).
// Read from the local checkout only — nothing is sent anywhere (rule 4).
type RepoActivity struct {
	Root string `json:"root"`
	Name string `json:"name"`
	// Days are the local calendar days covered, oldest first, "2006-01-02".
	Days []string `json:"days"`
	// Commits, Added and Deleted are per day, on every branch, merges left
	// out: `git log --all --no-merges --shortstat`.
	Commits []int `json:"commits"`
	Added   []int `json:"added"`
	Deleted []int `json:"deleted"`
	// LastCommitAt is the newest commit's time (unix ms), 0 when none in
	// the window.
	LastCommitAt int64 `json:"last_commit_at,omitempty"`
	// Dirty is how many files `git status` lists as changed or new.
	Dirty int `json:"dirty"`
	// CheckedMs is when git was read; the answer is kept activityKept.
	CheckedMs int64  `json:"checked_ms"`
	Error     string `json:"error,omitempty"`
}

const (
	// ActivityDays is the window the Repos section counts.
	ActivityDays = 14
	// activityKept is how long one repository's answer is reused: the
	// section asks every minute while it is open, git is asked at most
	// this often.
	activityKept = 10 * time.Minute
	// activityLog bounds the commits one read parses.
	activityLog = 5000
	// activityRoots bounds the answers kept.
	activityRoots = 64
)

type activityEntry struct {
	a  RepoActivity
	at time.Time
}

// activityCache holds the answers; a Service field so tests do not share it.
type activityCache struct {
	sync.Mutex
	m map[string]activityEntry
}

// Activity is root's figures, read from git at most once per activityKept.
// A git that fails or times out is an answer with Error set, kept like the
// others, so a broken repository is not asked every minute.
func (s *Service) Activity(ctx context.Context, root string) RepoActivity {
	now := time.Now()
	if s.Now != nil {
		now = s.Now()
	}
	s.repoActivity.Lock()
	if e, ok := s.repoActivity.m[root]; ok && now.Sub(e.at) < activityKept {
		s.repoActivity.Unlock()
		return e.a
	}
	s.repoActivity.Unlock()

	timeout := s.GitTimeout
	if timeout <= 0 {
		timeout = DefaultGitTimeout
	}
	// The read outlives the request that asked for it, under the git
	// timeout: a page that reloads mid-read cancels its request, and a
	// killed git kept as "could not be read" for 10 minutes would be a lie.
	gctx := context.WithoutCancel(ctx)
	a := readActivity(gctx, root, now, ActivityDays, func(args ...string) ([]byte, error) {
		return runGit(gctx, timeout, root, args...)
	})

	s.repoActivity.Lock()
	defer s.repoActivity.Unlock()
	if s.repoActivity.m == nil {
		s.repoActivity.m = map[string]activityEntry{}
	}
	if len(s.repoActivity.m) >= activityRoots {
		var oldest string
		var at time.Time
		for k, e := range s.repoActivity.m {
			if oldest == "" || e.at.Before(at) {
				oldest, at = k, e.at
			}
		}
		delete(s.repoActivity.m, oldest)
	}
	s.repoActivity.m[root] = activityEntry{a: a, at: now}
	return a
}

// readActivity asks git (through git, so a test can answer instead).
func readActivity(ctx context.Context, root string, now time.Time, days int, git func(args ...string) ([]byte, error)) RepoActivity {
	start := activityStart(now, days)
	a := RepoActivity{Root: root, Name: RepoName(root), Days: make([]string, days), CheckedMs: now.UnixMilli()}
	for i := range a.Days {
		a.Days[i] = start.AddDate(0, 0, i).Format("2006-01-02")
	}
	out, err := git("log", "--all", "--no-merges", "-n", strconv.Itoa(activityLog),
		"--since="+strconv.FormatInt(start.Unix(), 10), "--format=%x1e%ct", "--shortstat")
	if err != nil {
		a.Commits, a.Added, a.Deleted = make([]int, days), make([]int, days), make([]int, days)
		a.Error = err.Error()
		return a
	}
	a.Commits, a.Added, a.Deleted, a.LastCommitAt = ParseShortstat(out, start, days)
	if ctx.Err() != nil {
		return a
	}
	if st, err := git("status", "--porcelain=v1", "--untracked-files=normal"); err == nil {
		a.Dirty = nonEmptyLines(st)
	}
	return a
}

// activityStart is the first day's midnight, in now's location.
func activityStart(now time.Time, days int) time.Time {
	y, m, d := now.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, now.Location()).AddDate(0, 0, -(days - 1))
}

var (
	insertions = regexp.MustCompile(`(\d+) insertions?\(\+\)`)
	deletions  = regexp.MustCompile(`(\d+) deletions?\(-\)`)
)

// ParseShortstat reads `git log --format=%x1e%ct --shortstat` into per-day
// commits, lines added and lines deleted over the days days from start,
// and the newest commit's time (unix ms). A commit outside the window is
// left out; a commit with no shortstat line (an empty one) still counts.
// Line endings may be CRLF: Git for Windows writes them through some
// configurations, and a stray \r must not hide a number.
func ParseShortstat(out []byte, start time.Time, days int) (commits, added, deleted []int, last int64) {
	commits, added, deleted = make([]int, days), make([]int, days), make([]int, days)
	for _, rec := range bytes.Split(out, []byte{0x1e}) {
		text := strings.ReplaceAll(string(rec), "\r", "")
		lines := strings.Split(strings.TrimSpace(text), "\n")
		if len(lines) == 0 || lines[0] == "" {
			continue
		}
		sec, err := strconv.ParseInt(strings.TrimSpace(lines[0]), 10, 64)
		if err != nil {
			continue
		}
		at := time.Unix(sec, 0).In(start.Location())
		if ms := at.UnixMilli(); ms > last {
			last = ms
		}
		i := activityDay(at, start, days)
		if i < 0 {
			continue
		}
		commits[i]++
		for _, l := range lines[1:] {
			if !strings.Contains(l, "changed") {
				continue
			}
			if m := insertions.FindStringSubmatch(l); m != nil {
				n, _ := strconv.Atoi(m[1])
				added[i] += n
			}
			if m := deletions.FindStringSubmatch(l); m != nil {
				n, _ := strconv.Atoi(m[1])
				deleted[i] += n
			}
		}
	}
	return commits, added, deleted, last
}

// activityDay is which of the days at falls on, by the calendar (a day
// with a clock change is 23 or 25 hours), -1 outside the window.
func activityDay(at, start time.Time, days int) int {
	if at.Before(start) {
		return -1
	}
	d := int(at.Sub(start) / (24 * time.Hour))
	for d > 0 && at.Before(start.AddDate(0, 0, d)) {
		d--
	}
	for d+1 < days && !at.Before(start.AddDate(0, 0, d+1)) {
		d++
	}
	if d >= days {
		return -1
	}
	return d
}

// nonEmptyLines counts the non-empty lines of git's output, CRLF or LF.
func nonEmptyLines(out []byte) int {
	n := 0
	for _, l := range strings.Split(strings.ReplaceAll(string(out), "\r", ""), "\n") {
		if strings.TrimSpace(l) != "" {
			n++
		}
	}
	return n
}

// RepoName is the last segment of a repository root, with either
// separator: a root from Windows may arrive as C:\dev\app or C:/dev/app.
func RepoName(root string) string {
	r := strings.TrimRight(strings.ReplaceAll(root, `\`, "/"), "/")
	if i := strings.LastIndex(r, "/"); i >= 0 {
		r = r[i+1:]
	}
	if r == "" || strings.HasSuffix(r, ":") {
		return root
	}
	return r
}
