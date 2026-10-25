package api

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/github"
	"github.com/dspv/caprock/internal/store"
)

// github_prs holds the pull request lists the Pipeline read, its newest 50
// at a time, from the day the table was made: a period reaching before that,
// or one busier than 50 between two reads, counted short of GitHub (owner,
// 2026-10-25: the card said 48 merged in a week GitHub merged 59, and he
// shares the figure publicly). So when a Week counts a repository whose
// record does not reach the period's start, the missing part is read from
// GitHub once, page by page (github.Service.PullsSince), and kept in
// github_prs. The card shows the count it has meanwhile and the next one
// the complete count.
//
// What was read is remembered in meta, per repository, as the span read
// whole: "prs_read:<owner/name>" = "<from>,<at>" (unix ms). A period whose
// start is on or after from needs only what changed since at, read at most
// every prsTopUpEvery, in one page as a rule; an earlier start reads back to
// it.
const (
	prsReadKey = "prs_read:"
	// prsTopUpEvery is how often the newest pull requests are read again
	// for a repository whose period is already covered: the Pipeline's own
	// reads keep the newest 50 between.
	prsTopUpEvery = 30 * time.Minute
	// prsRetryAfter is the wait after a failed read (GitHub refused it, the
	// repository is not readable with this token).
	prsRetryAfter = 30 * time.Minute
	// prsCappedRetryAfter is the wait after a read that stopped at
	// github.PullsSinceMaxPages pages short of the period's start.
	prsCappedRetryAfter = 6 * time.Hour
	// prsReadOverlap reaches back past the last read, for a pull request
	// updated during it.
	prsReadOverlap = 5 * time.Minute
)

// prsBackfill keeps the reads in flight and the waits after a failure, in
// memory: a restart may try once more, the meta record keeps the rest.
type prsBackfill struct {
	mu      sync.Mutex
	running map[string]bool
	wait    map[string]time.Time // slug -> not before
	wg      sync.WaitGroup
}

// prsRead is a repository's record of what was read whole.
type prsRead struct{ from, at int64 }

func parsePRsRead(v string) (prsRead, bool) {
	a, b, ok := strings.Cut(v, ",")
	if !ok {
		return prsRead{}, false
	}
	from, err1 := strconv.ParseInt(a, 10, 64)
	at, err2 := strconv.ParseInt(b, 10, 64)
	if err1 != nil || err2 != nil {
		return prsRead{}, false
	}
	return prsRead{from: from, at: at}, true
}

// fillWeekPRs starts, in the background, the reads that make github_prs
// cover from (unix ms) for each repository in slugs. It never waits on
// GitHub and sends nothing while GitHub is not connected.
func (s *Server) fillWeekPRs(ctx context.Context, slugs []string, from int64) {
	if !s.githubConnected() || len(slugs) == 0 {
		return
	}
	now := s.d.Now()
	type job struct {
		slug  string
		since int64
		read  prsRead
		whole bool // reading back to from, not only what changed
	}
	var jobs []job
	f := &s.prsFill
	for _, slug := range slugs {
		v, err := s.d.Store.GetMeta(ctx, prsReadKey+slug)
		if err != nil {
			continue
		}
		read, ok := parsePRsRead(v)
		j := job{slug: slug, read: read}
		switch {
		case !ok || read.from > from:
			j.since, j.whole = from, true
		case now.Sub(time.UnixMilli(read.at)) >= prsTopUpEvery:
			j.since = read.at - prsReadOverlap.Milliseconds()
		default:
			continue
		}
		f.mu.Lock()
		if f.running == nil {
			f.running, f.wait = map[string]bool{}, map[string]time.Time{}
		}
		busy := f.running[slug] || now.Before(f.wait[slug])
		if !busy {
			f.running[slug] = true
		}
		f.mu.Unlock()
		if !busy {
			jobs = append(jobs, j)
		}
	}
	if len(jobs) == 0 {
		return
	}
	gh := s.d.GitHub
	f.wg.Add(1)
	go func() {
		defer f.wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		added := false
		for _, j := range jobs {
			kept, wait := s.readPRsSince(ctx, gh, j.slug, j.since, j.read, j.whole)
			added = added || kept
			f.mu.Lock()
			delete(f.running, j.slug)
			if wait > 0 {
				f.wait[j.slug] = s.d.Now().Add(wait)
			}
			f.mu.Unlock()
		}
		if added {
			// github_prs is not the events the caches watch: the next card
			// is counted afresh.
			s.week.forget()
			s.weekLong.forget()
		}
	}()
}

// readPRsSince reads one repository's pull requests updated since `since`,
// keeps them and records the span read whole. It reports whether any were
// kept and how long to wait before trying again (0: no wait).
func (s *Server) readPRsSince(ctx context.Context, gh *github.Service, slug string, since int64, read prsRead, whole bool) (bool, time.Duration) {
	owner, name, ok := strings.Cut(slug, "/")
	if !ok {
		return false, prsCappedRetryAfter
	}
	at := s.d.Now().UnixMilli()
	prs, complete, e := gh.PullsSince(ctx, github.Repo{Owner: owner, Name: name}, since, github.PullsSinceMaxPages)
	kept := false
	if len(prs) > 0 {
		rows := make([]store.GitHubPR, 0, len(prs))
		for _, p := range prs {
			rows = append(rows, store.GitHubPR{Number: p.Number, URL: p.URL, Title: p.Title, Head: p.Head, State: p.State,
				CreatedAt: p.CreatedAt, MergedAt: p.MergedAt, ClosedAt: p.ClosedAt, UpdatedAt: p.UpdatedAt})
		}
		if err := s.d.Store.UpsertGitHubPRs(ctx, slug, rows, at); err != nil {
			s.d.Log.Warn("github: keeping the older pull requests failed", "component", "api", "repo", slug, "err", err)
			return false, prsRetryAfter
		}
		kept = true
	}
	if e != nil {
		s.d.Log.Info("github: reading the older pull requests failed", "component", "api", "repo", slug, "kind", e.Kind)
		return kept, prsRetryAfter
	}
	if !complete {
		return kept, prsCappedRetryAfter
	}
	from := read.from
	if whole {
		from = since
	}
	if err := s.d.Store.SetMeta(ctx, prsReadKey+slug, strconv.FormatInt(from, 10)+","+strconv.FormatInt(at, 10)); err != nil {
		s.d.Log.Warn("github: recording the pull requests read failed", "component", "api", "repo", slug, "err", err)
	}
	return kept, 0
}
