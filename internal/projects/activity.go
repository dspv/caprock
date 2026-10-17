package projects

import (
	"bytes"
	"context"
	"errors"
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
	// Branch is the branch checked out at the root, "" when detached or
	// not read.
	Branch string `json:"branch,omitempty"`
	// Days are the local calendar days covered, oldest first, "2006-01-02".
	Days []string `json:"days"`
	// Commits, Added and Deleted are per day, on every branch, merges left
	// out: `git log --all --no-merges`, the lines from each commit's
	// `--shortstat`.
	Commits []int `json:"commits"`
	Added   []int `json:"added"`
	Deleted []int `json:"deleted"`
	// LinesPartial says some commits' lines are not counted yet: diffing
	// them ran past activityLineBudget, and the next read goes on from
	// where this one stopped.
	LinesPartial bool `json:"lines_partial,omitempty"`
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
	// activityPartialKept is how long an answer with lines still to count
	// is reused: the next minute's ask goes on counting.
	activityPartialKept = time.Minute
	// activityLog bounds the commits one read lists.
	activityLog = 5000
	// activityRoots bounds the answers kept.
	activityRoots = 64
	// activityLineBudget is how long one read may spend diffing commits
	// for their lines. Listing the commits is cheap and stays under the
	// projects' git timeout; diffing them is not: on the owner's caprock
	// checkout (961 refs, 1,048 commits in 14 days, a rebuilt minified
	// bundle renamed in many of them) one `git log --all --shortstat` took
	// 12 s on an idle machine (measured 2026-10-17), past the 5 s timeout,
	// so the whole row read "git could not be read" for 10 minutes at a
	// time. Lines are now counted per commit, kept, and only new commits
	// are diffed.
	activityLineBudget = 10 * time.Second
)

// activityStatBatch is how many commits one diffing git is handed: a batch
// that runs out of time loses only itself, the ones before it are kept.
// A variable so a test can make batches small.
var activityStatBatch = 100

// errLineBudget is the line budget spent before git was asked.
var errLineBudget = errors.New("the time for counting lines ran out")

// lineStat is one commit's lines added and deleted.
type lineStat struct{ added, deleted int }

type activityEntry struct {
	a  RepoActivity
	at time.Time
	// lines are the commits of the window already diffed, by hash.
	lines map[string]lineStat
}

// activityCache holds the answers; a Service field so tests do not share it.
type activityCache struct {
	sync.Mutex
	m map[string]activityEntry
}

// Activity is root's figures, read from git at most once per activityKept
// (activityPartialKept while lines are still being counted). A git that
// fails or times out listing the commits is an answer with Error set, kept
// like the others, so a broken repository is not asked every minute.
func (s *Service) Activity(ctx context.Context, root string) RepoActivity {
	now := time.Now()
	if s.Now != nil {
		now = s.Now()
	}
	s.repoActivity.Lock()
	e, ok := s.repoActivity.m[root]
	kept := activityKept
	if e.a.LinesPartial {
		kept = activityPartialKept
	}
	if ok && now.Sub(e.at) < kept {
		s.repoActivity.Unlock()
		return e.a
	}
	known := e.lines
	s.repoActivity.Unlock()

	timeout := s.GitTimeout
	if timeout <= 0 {
		timeout = DefaultGitTimeout
	}
	// The read outlives the request that asked for it, under the git
	// timeout: a page that reloads mid-read cancels its request, and a
	// killed git kept as "could not be read" for 10 minutes would be a lie.
	gctx := context.WithoutCancel(ctx)
	deadline := time.Now().Add(activityLineBudget)
	a, lines := readActivity(gctx, root, now,
		func(args ...string) ([]byte, error) { return runGit(gctx, timeout, root, args...) },
		func(args ...string) ([]byte, error) {
			left := time.Until(deadline)
			if left <= 0 {
				return nil, errLineBudget
			}
			return runGit(gctx, left, root, args...)
		}, known)

	s.repoActivity.Lock()
	defer s.repoActivity.Unlock()
	if s.repoActivity.m == nil {
		s.repoActivity.m = map[string]activityEntry{}
	}
	if _, had := s.repoActivity.m[root]; !had && len(s.repoActivity.m) >= activityRoots {
		var oldest string
		var at time.Time
		for k, e := range s.repoActivity.m {
			if oldest == "" || e.at.Before(at) {
				oldest, at = k, e.at
			}
		}
		delete(s.repoActivity.m, oldest)
	}
	s.repoActivity.m[root] = activityEntry{a: a, at: now, lines: lines}
	return a
}

// readActivity asks git: git under the projects' timeout lists the commits,
// reads the branch and the working tree; stat, under what is left of the
// line budget, diffs the commits known does not hold yet, a batch at a
// time. It returns the figures and the lines of every commit in the window
// it knows, for the next read to start from. A test answers for both.
func readActivity(ctx context.Context, root string, now time.Time, git, stat func(args ...string) ([]byte, error), known map[string]lineStat) (RepoActivity, map[string]lineStat) {
	start := activityStart(now)
	a := RepoActivity{Root: root, Name: RepoName(root), Days: make([]string, ActivityDays), CheckedMs: now.UnixMilli()}
	for i := range a.Days {
		a.Days[i] = start.AddDate(0, 0, i).Format("2006-01-02")
	}
	a.Commits, a.Added, a.Deleted = make([]int, ActivityDays), make([]int, ActivityDays), make([]int, ActivityDays)
	out, err := git("log", "--all", "--no-merges", "-n", strconv.Itoa(activityLog),
		"--since="+strconv.FormatInt(start.Unix(), 10), "--format=%x1e%H %ct")
	if err != nil {
		a.Error = err.Error()
		return a, known
	}
	type commit struct {
		hash string
		day  int
	}
	var list []commit
	for _, r := range parseRecords(out) {
		hash, sec, ok := strings.Cut(r.head, " ")
		n, err := strconv.ParseInt(sec, 10, 64)
		if !ok || err != nil || hash == "" {
			continue
		}
		at := time.Unix(n, 0).In(start.Location())
		if ms := at.UnixMilli(); ms > a.LastCommitAt {
			a.LastCommitAt = ms
		}
		i := activityDay(at, start, ActivityDays)
		if i < 0 {
			continue
		}
		a.Commits[i]++
		list = append(list, commit{hash, i})
	}

	// The lines: what earlier reads counted is kept; the rest is diffed in
	// batches until the budget runs out.
	lines := make(map[string]lineStat, len(list))
	var missing []string
	for _, c := range list {
		if l, ok := known[c.hash]; ok {
			lines[c.hash] = l
		} else {
			missing = append(missing, c.hash)
		}
	}
	for len(missing) > 0 && ctx.Err() == nil {
		n := min(activityStatBatch, len(missing))
		batch := missing[:n]
		out, err := stat(append([]string{"log", "--no-walk=unsorted", "--format=%x1e%H", "--shortstat"}, batch...)...)
		if err != nil {
			break
		}
		for _, h := range batch {
			lines[h] = lineStat{} // an empty commit has no shortstat line
		}
		for _, r := range parseRecords(out) {
			if _, ok := lines[r.head]; ok {
				lines[r.head] = lineStat{r.added, r.deleted}
			}
		}
		missing = missing[n:]
	}
	a.LinesPartial = len(missing) > 0
	for _, c := range list {
		l := lines[c.hash]
		a.Added[c.day] += l.added
		a.Deleted[c.day] += l.deleted
	}
	if ctx.Err() != nil {
		return a, lines
	}
	if b, err := git("branch", "--show-current"); err == nil {
		a.Branch = strings.TrimSpace(string(b))
	}
	if st, err := git("status", "--porcelain=v1", "--untracked-files=normal"); err == nil {
		a.Dirty = nonEmptyLines(st)
	}
	return a, lines
}

// record is one entry of `git log --format=%x1e<head> --shortstat`: its
// first line, and the lines its shortstat counts.
type record struct {
	head           string
	added, deleted int
}

// parseRecords splits git's output at the 0x1e that starts each entry.
// Line endings may be CRLF: Git for Windows writes them through some
// configurations, and a stray \r must not hide a number.
func parseRecords(out []byte) []record {
	var recs []record
	for _, rec := range bytes.Split(out, []byte{0x1e}) {
		text := strings.ReplaceAll(string(rec), "\r", "")
		lines := strings.Split(strings.TrimSpace(text), "\n")
		if len(lines) == 0 || lines[0] == "" {
			continue
		}
		r := record{head: strings.TrimSpace(lines[0])}
		for _, l := range lines[1:] {
			if !strings.Contains(l, "changed") {
				continue
			}
			if m := insertions.FindStringSubmatch(l); m != nil {
				n, _ := strconv.Atoi(m[1])
				r.added += n
			}
			if m := deletions.FindStringSubmatch(l); m != nil {
				n, _ := strconv.Atoi(m[1])
				r.deleted += n
			}
		}
		recs = append(recs, r)
	}
	return recs
}

// activityStart is the first day's midnight, in now's location.
func activityStart(now time.Time) time.Time {
	y, m, d := now.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, now.Location()).AddDate(0, 0, -(ActivityDays - 1))
}

var (
	insertions = regexp.MustCompile(`(\d+) insertions?\(\+\)`)
	deletions  = regexp.MustCompile(`(\d+) deletions?\(-\)`)
)

// ParseShortstat reads `git log --format=%x1e%ct --shortstat` into per-day
// commits, lines added and lines deleted over the days days from start,
// and the newest commit's time (unix ms). A commit outside the window is
// left out; a commit with no shortstat line (an empty one) still counts.
// CRLF is read like LF (parseRecords).
func ParseShortstat(out []byte, start time.Time, days int) (commits, added, deleted []int, last int64) {
	commits, added, deleted = make([]int, days), make([]int, days), make([]int, days)
	for _, r := range parseRecords(out) {
		sec, err := strconv.ParseInt(r.head, 10, 64)
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
		added[i] += r.added
		deleted[i] += r.deleted
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
