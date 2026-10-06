package github

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/alerts"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/projects"
)

// Check is one CI check on a pull request's head commit: a check run or a
// commit status.
type Check struct {
	Name  string `json:"name"`
	State string `json:"state"` // pass | fail | pending | skipped
	URL   string `json:"url,omitempty"`
}

// Checks sums a head commit's checks: fail when any failed, else pending
// when any is still running, else pass; none when there are none.
type Checks struct {
	State   string  `json:"state"`
	Passed  int     `json:"passed"`
	Failed  int     `json:"failed"`
	Pending int     `json:"pending"`
	Items   []Check `json:"items"`
}

// Review is one reviewer's latest verdict.
type Review struct {
	User  string `json:"user"`
	State string `json:"state"` // approved | changes_requested | commented | dismissed
	At    int64  `json:"at,omitempty"`
}

// PR is a worktree's pull request as the sidebar and the Changes view show it.
type PR struct {
	ProjectID int64  `json:"project_id"`
	Worktree  string `json:"worktree"`
	Branch    string `json:"branch"`
	Repo      string `json:"repo"`
	Number    int    `json:"number"`
	URL       string `json:"url"`
	Title     string `json:"title"`
	State     string `json:"state"` // open | closed | merged
	Draft     bool   `json:"draft"`
	Base      string `json:"base"`
	HeadSHA   string `json:"head_sha"`
	// Mergeable is null while GitHub is still working it out.
	Mergeable      *bool    `json:"mergeable"`
	MergeableState string   `json:"mergeable_state,omitempty"`
	Review         string   `json:"review"` // approved | changes_requested | review_required | commented | ""
	Reviews        []Review `json:"reviews"`
	Checks         Checks   `json:"checks"`
	At             int64    `json:"at"` // when it was last read, unix ms
	// Error is why the last read failed; the rest is the last good answer.
	Error *Error `json:"error,omitempty"`
}

// target is a worktree that may have a pull request: a branch other than
// the default, in a project whose remote is on github.com.
type target struct {
	projectID int64
	worktree  string
	branch    string
	base      string
	project   string
	repo      Repo
}

func keyOf(projectID int64, worktree string) string {
	return strconv.FormatInt(projectID, 10) + "/" + worktree
}

// followed is one target and what is known of its pull request.
type followed struct {
	t       target
	pr      *PR
	primed  bool // asked GitHub at least once
	lastAt  time.Time
	reviews map[string]string // reviewer -> last state notified about
}

// repoPoll is when a repository is next asked about.
type repoPoll struct {
	next     time.Time
	last     time.Time
	interval time.Duration
}

// tracker holds the followed worktrees.
type tracker struct {
	mu       sync.Mutex
	items    map[string]*followed
	repos    map[string]*repoPoll
	discover time.Time
}

func newTracker() *tracker {
	return &tracker{items: map[string]*followed{}, repos: map[string]*repoPoll{}}
}

func (t *tracker) count() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	n := 0
	for _, f := range t.items {
		if f.pr != nil {
			n++
		}
	}
	return n
}

// clear forgets everything and returns the keys that had a pull request.
func (t *tracker) clear() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := []string{}
	for k, f := range t.items {
		if f.pr != nil {
			out = append(out, k)
		}
	}
	t.items = map[string]*followed{}
	t.repos = map[string]*repoPoll{}
	return out
}

// PRs is every followed pull request.
func (s *Service) PRs() []PR {
	s.init()
	s.track.mu.Lock()
	defer s.track.mu.Unlock()
	out := []PR{}
	for _, k := range sortedKeys(s.track.items) {
		if f := s.track.items[k]; f.pr != nil {
			out = append(out, *f.pr)
		}
	}
	return out
}

// Kick asks about a project's pull requests soon (all projects for 0): a
// push, a new pull request, a reconnect. Never sooner than kickGap after the
// last time, so a burst of pushes is one request.
func (s *Service) Kick(projectID int64) {
	s.init()
	s.track.mu.Lock()
	now := s.Now()
	s.track.discover = time.Time{}
	for _, f := range s.track.items {
		if projectID != 0 && f.t.projectID != projectID {
			continue
		}
		if p := s.track.repos[f.t.repo.FullName()]; p != nil {
			p.next = maxTime(p.last.Add(kickGap), now)
			p.interval = MinPoll
		}
	}
	s.track.mu.Unlock()
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

// loop follows pull requests while connected: a check every few seconds of
// what is due, never a request more often than the bounds above.
func (s *Service) loop(ctx context.Context) {
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		case <-s.kick:
		}
		s.step(ctx)
	}
}

// step does what is due now.
func (s *Service) step(ctx context.Context) {
	if s.source() == "" {
		return
	}
	now := s.Now()
	s.mu.Lock()
	userDue := s.userAt.IsZero() || now.Sub(s.userAt) >= userEvery
	s.mu.Unlock()
	if userDue {
		s.mu.Lock()
		s.userAt = now // one attempt per period, whatever the outcome
		s.mu.Unlock()
		_ = s.refreshUser(ctx)
	}
	s.track.mu.Lock()
	discover := !now.Before(s.track.discover)
	if discover {
		s.track.discover = now.Add(discoverEvery)
	}
	s.track.mu.Unlock()
	if discover {
		s.reconcile(ctx)
	}
	for _, repo := range s.dueRepos(s.Now()) {
		s.pollRepo(ctx, repo)
	}
}

// targets lists the worktrees that may have a pull request.
func (s *Service) targets(ctx context.Context) ([]target, error) {
	if s.Projects == nil {
		return nil, nil
	}
	views, err := s.Projects.List(ctx)
	if err != nil {
		return nil, err
	}
	out := []target{}
	for _, v := range views {
		if v.Kind != "repo" || v.Git == nil || v.Archived {
			continue
		}
		repo, ok := ParseRemote(v.Git.RemoteURL)
		if !ok {
			continue
		}
		base := v.Git.DefaultBranch
		add := func(wt, branch string) {
			if branch == "" || branch == base {
				return
			}
			out = append(out, target{projectID: v.ID, worktree: wt, branch: branch, base: base, project: v.Name, repo: repo})
		}
		add("", v.Git.Branch)
		for _, w := range v.Worktrees {
			if !w.Missing {
				add(w.Name, w.Branch)
			}
		}
	}
	return out, nil
}

// reconcile brings the followed set in line with the worktrees on disk.
func (s *Service) reconcile(ctx context.Context) {
	ts, err := s.targets(ctx)
	if err != nil {
		s.Log.Warn("github: listing projects failed", "component", "github", "err", err)
		return
	}
	now := s.Now()
	seen := map[string]bool{}
	gone := []string{}
	s.track.mu.Lock()
	for _, t := range ts {
		k := keyOf(t.projectID, t.worktree)
		seen[k] = true
		f := s.track.items[k]
		if f == nil || f.t.branch != t.branch || f.t.repo != t.repo {
			if f != nil && f.pr != nil {
				gone = append(gone, k)
			}
			f = &followed{t: t, reviews: map[string]string{}}
			s.track.items[k] = f
		}
		f.t = t
		if s.track.repos[t.repo.FullName()] == nil {
			s.track.repos[t.repo.FullName()] = &repoPoll{next: now, interval: MinPoll}
		}
	}
	for k, f := range s.track.items {
		if !seen[k] {
			if f.pr != nil {
				gone = append(gone, k)
			}
			delete(s.track.items, k)
		}
	}
	used := map[string]bool{}
	for _, f := range s.track.items {
		used[f.t.repo.FullName()] = true
	}
	for r := range s.track.repos {
		if !used[r] {
			delete(s.track.repos, r)
		}
	}
	s.track.mu.Unlock()
	for _, k := range gone {
		s.publishGone(k)
	}
}

// dueRepos are the repositories whose time has come, oldest first.
func (s *Service) dueRepos(now time.Time) []string {
	s.track.mu.Lock()
	defer s.track.mu.Unlock()
	out := []string{}
	for _, name := range sortedKeys(s.track.repos) {
		if !s.track.repos[name].next.After(now) {
			out = append(out, name)
		}
	}
	return out
}

// apiPull is GitHub's pull request object, the part read.
type apiPull struct {
	Number  int    `json:"number"`
	HTMLURL string `json:"html_url"`
	Title   string `json:"title"`
	State   string `json:"state"`
	Draft   bool   `json:"draft"`
	Merged  bool   `json:"merged"`
	// MergedAt is set on a merged pull request in a list, where Merged is not.
	MergedAt       *string `json:"merged_at"`
	Mergeable      *bool   `json:"mergeable"`
	MergeableState string  `json:"mergeable_state"`
	Head           struct {
		Ref  string `json:"ref"`
		SHA  string `json:"sha"`
		Repo *struct {
			FullName string `json:"full_name"`
		} `json:"repo"`
	} `json:"head"`
	Base struct {
		Ref string `json:"ref"`
	} `json:"base"`
	RequestedReviewers []struct {
		Login string `json:"login"`
	} `json:"requested_reviewers"`
}

func (p apiPull) state() string {
	if p.Merged || p.MergedAt != nil {
		return "merged"
	}
	return p.State
}

// pollRepo asks about one repository's open pull requests, then each
// followed one's checks and reviews. Conditional throughout: an unchanged
// answer is a 304, and a repository where nothing changed is asked less
// often each time, up to MaxPoll.
func (s *Service) pollRepo(ctx context.Context, name string) {
	now := s.Now()
	s.track.mu.Lock()
	rp := s.track.repos[name]
	if rp == nil {
		s.track.mu.Unlock()
		return
	}
	rp.last = now
	var fs []*followed
	for _, k := range sortedKeys(s.track.items) {
		if f := s.track.items[k]; f.t.repo.FullName() == name {
			fs = append(fs, f)
		}
	}
	s.track.mu.Unlock()
	if len(fs) == 0 {
		return
	}
	repo := fs[0].t.repo
	doing := "Reading the pull requests of " + name
	res, e := s.call(ctx, request{method: http.MethodGet, path: repoPath(repo) + "/pulls?state=open&per_page=100", doing: doing})
	changed := e == nil && !res.notModded
	if e != nil {
		s.markError(fs, e)
		s.reschedule(name, false, e)
		return
	}
	var open []apiPull
	if e := decode(res, doing, &open); e != nil {
		s.markError(fs, e)
		s.reschedule(name, false, e)
		return
	}
	byBranch := map[string]apiPull{}
	for _, p := range open {
		if p.Head.Repo != nil && strings.EqualFold(p.Head.Repo.FullName, name) {
			byBranch[p.Head.Ref] = p
		}
	}
	for _, f := range fs {
		if p, ok := byBranch[f.t.branch]; ok {
			if s.refreshPull(ctx, f, p.Number) {
				changed = true
			}
			continue
		}
		s.track.mu.Lock()
		had := f.pr
		s.track.mu.Unlock()
		if had != nil && had.State == "open" {
			// Gone from the open list: merged or closed. Read it once.
			if s.refreshPull(ctx, f, had.Number) {
				changed = true
			}
		}
		s.track.mu.Lock()
		f.primed = true
		s.track.mu.Unlock()
	}
	s.reschedule(name, changed, nil)
}

// reschedule sets a repository's next poll: MinPoll after a change, longer
// each quiet time, and not before a rate limit lifts.
func (s *Service) reschedule(name string, changed bool, e *Error) {
	now := s.Now()
	s.track.mu.Lock()
	defer s.track.mu.Unlock()
	rp := s.track.repos[name]
	if rp == nil {
		return
	}
	if changed {
		rp.interval = MinPoll
	} else {
		rp.interval = min(rp.interval*2, MaxPoll)
	}
	rp.next = now.Add(rp.interval)
	if e != nil && e.RetryAt > 0 {
		rp.next = maxTime(rp.next, time.UnixMilli(e.RetryAt))
	}
}

// markError records a failed read on every followed pull request of a repository.
func (s *Service) markError(fs []*followed, e *Error) {
	for _, f := range fs {
		s.track.mu.Lock()
		var snap *PR
		if f.pr != nil {
			p := *f.pr
			p.Error = e
			f.pr = &p
			snap = &p
		}
		s.track.mu.Unlock()
		if snap != nil {
			s.publishPR(*snap)
		}
	}
}

func repoPath(r Repo) string {
	return "/repos/" + url.PathEscape(r.Owner) + "/" + url.PathEscape(r.Name)
}

// refreshPull reads one pull request, its checks and its reviews, stores the
// result, publishes it when it changed and notifies on a CI failure or a new
// review. It reports whether anything changed.
func (s *Service) refreshPull(ctx context.Context, f *followed, number int) bool {
	s.track.mu.Lock()
	t := f.t
	prev := f.pr
	s.track.mu.Unlock()
	base := repoPath(t.repo)
	doing := fmt.Sprintf("Reading pull request #%d of %s", number, t.repo.FullName())
	res, e := s.call(ctx, request{method: http.MethodGet, path: fmt.Sprintf("%s/pulls/%d", base, number), doing: doing})
	if e != nil {
		s.markError([]*followed{f}, e)
		return false
	}
	var p apiPull
	if e := decode(res, doing, &p); e != nil {
		s.markError([]*followed{f}, e)
		return false
	}
	changed := !res.notModded
	pr := &PR{ProjectID: t.projectID, Worktree: t.worktree, Branch: t.branch, Repo: t.repo.FullName(), Number: p.Number, URL: p.HTMLURL,
		Title: p.Title, State: p.state(), Draft: p.Draft, Base: p.Base.Ref, HeadSHA: p.Head.SHA, Mergeable: p.Mergeable,
		MergeableState: p.MergeableState, Reviews: []Review{}, Checks: Checks{State: "none", Items: []Check{}}, At: s.Now().UnixMilli()}
	var firstErr *Error
	checks, ch, e := s.readChecks(ctx, t.repo, p.Head.SHA)
	if e != nil {
		firstErr = e
		if prev != nil {
			checks = prev.Checks
		}
	}
	pr.Checks = checks
	changed = changed || ch
	reviews, ch, e := s.readReviews(ctx, t.repo, p.Number)
	if e != nil {
		if firstErr == nil {
			firstErr = e
		}
		if prev != nil {
			reviews = prev.Reviews
		}
	}
	pr.Reviews = reviews
	changed = changed || ch
	pr.Review = reviewState(reviews, len(p.RequestedReviewers) > 0)
	pr.Error = firstErr
	s.track.mu.Lock()
	f.pr, f.primed, f.lastAt = pr, true, s.Now()
	s.track.mu.Unlock()
	if changed || prev == nil || (prev.Error != nil) != (pr.Error != nil) {
		s.publishPR(*pr)
	}
	s.notifyChanges(f, prev, pr)
	return changed
}

// readChecks reads a commit's check runs and commit statuses.
func (s *Service) readChecks(ctx context.Context, repo Repo, sha string) (Checks, bool, *Error) {
	out := Checks{State: "none", Items: []Check{}}
	if sha == "" {
		return out, false, nil
	}
	base := repoPath(repo) + "/commits/" + url.PathEscape(sha)
	doing := "Reading the checks of " + repo.FullName()
	res, e := s.call(ctx, request{method: http.MethodGet, path: base + "/check-runs?per_page=100", doing: doing})
	if e != nil {
		return out, false, e
	}
	changed := !res.notModded
	var runs struct {
		CheckRuns []struct {
			Name       string `json:"name"`
			Status     string `json:"status"`
			Conclusion string `json:"conclusion"`
			HTMLURL    string `json:"html_url"`
		} `json:"check_runs"`
	}
	if e := decode(res, doing, &runs); e != nil {
		return out, false, e
	}
	for _, r := range runs.CheckRuns {
		out.Items = append(out.Items, Check{Name: r.Name, State: runState(r.Status, r.Conclusion), URL: r.HTMLURL})
	}
	res, e = s.call(ctx, request{method: http.MethodGet, path: base + "/status", doing: doing})
	if e != nil {
		return out, changed, e
	}
	changed = changed || !res.notModded
	var st struct {
		Statuses []struct {
			Context   string `json:"context"`
			State     string `json:"state"`
			TargetURL string `json:"target_url"`
		} `json:"statuses"`
	}
	if e := decode(res, doing, &st); e != nil {
		return out, changed, e
	}
	for _, x := range st.Statuses {
		out.Items = append(out.Items, Check{Name: x.Context, State: statusState(x.State), URL: x.TargetURL})
	}
	for _, c := range out.Items {
		switch c.State {
		case "pass", "skipped":
			out.Passed++
		case "fail":
			out.Failed++
		default:
			out.Pending++
		}
	}
	switch {
	case len(out.Items) == 0:
		out.State = "none"
	case out.Failed > 0:
		out.State = "fail"
	case out.Pending > 0:
		out.State = "pending"
	default:
		out.State = "pass"
	}
	return out, changed, nil
}

// runState maps a check run to pass, fail, pending or skipped.
func runState(status, conclusion string) string {
	if status != "completed" {
		return "pending"
	}
	switch conclusion {
	case "success", "neutral":
		return "pass"
	case "skipped":
		return "skipped"
	case "":
		return "pending"
	}
	return "fail" // failure, timed_out, cancelled, action_required, startup_failure, stale
}

// statusState maps a commit status.
func statusState(s string) string {
	switch s {
	case "success":
		return "pass"
	case "failure", "error":
		return "fail"
	}
	return "pending"
}

// readReviews reads each reviewer's latest verdict.
func (s *Service) readReviews(ctx context.Context, repo Repo, number int) ([]Review, bool, *Error) {
	doing := fmt.Sprintf("Reading the reviews of #%d", number)
	res, e := s.call(ctx, request{method: http.MethodGet, path: fmt.Sprintf("%s/pulls/%d/reviews?per_page=100", repoPath(repo), number), doing: doing})
	if e != nil {
		return []Review{}, false, e
	}
	var raw []struct {
		User struct {
			Login string `json:"login"`
		} `json:"user"`
		State       string    `json:"state"`
		SubmittedAt time.Time `json:"submitted_at"`
	}
	if e := decode(res, doing, &raw); e != nil {
		return []Review{}, false, e
	}
	latest := map[string]Review{}
	order := []string{}
	for _, r := range raw {
		st := strings.ToLower(r.State)
		if st == "pending" {
			continue
		}
		prev, seen := latest[r.User.Login]
		if !seen {
			order = append(order, r.User.Login)
		}
		// A comment after a verdict does not undo the verdict.
		if seen && st == "commented" && prev.State != "commented" {
			continue
		}
		latest[r.User.Login] = Review{User: r.User.Login, State: st, At: r.SubmittedAt.UnixMilli()}
	}
	out := make([]Review, 0, len(order))
	for _, u := range order {
		out = append(out, latest[u])
	}
	return out, !res.notModded, nil
}

// reviewState sums the verdicts: changes requested wins, then approved.
func reviewState(rs []Review, requested bool) string {
	approved, commented := false, false
	for _, r := range rs {
		switch r.State {
		case "changes_requested":
			return "changes_requested"
		case "approved":
			approved = true
		case "commented":
			commented = true
		}
	}
	switch {
	case approved:
		return "approved"
	case requested:
		return "review_required"
	case commented:
		return "commented"
	}
	return ""
}

// notifyChanges sends an OS notification when CI starts failing or a
// reviewer's verdict lands — not for what was already so when Caprock
// first looked.
func (s *Service) notifyChanges(f *followed, prev, pr *PR) {
	s.track.mu.Lock()
	newReviews := []Review{}
	for _, r := range pr.Reviews {
		if r.State != "approved" && r.State != "changes_requested" {
			continue
		}
		if f.reviews[r.User] != r.State {
			if prev != nil {
				newReviews = append(newReviews, r)
			}
			f.reviews[r.User] = r.State
		}
	}
	s.track.mu.Unlock()
	if s.Bus == nil || s.Config == nil || !s.Config.Notify() || prev == nil || pr.State != "open" {
		return
	}
	project := f.t.project
	if pr.Checks.State == "fail" && (prev.Checks.State != "fail" || prev.HeadSHA != pr.HeadSHA) {
		names := []string{}
		for _, c := range pr.Checks.Items {
			if c.State == "fail" {
				names = append(names, c.Name)
			}
		}
		s.Bus.Publish(bus.Frame{Type: bus.FrameNotify, Data: alerts.Notification{
			ID: fmt.Sprintf("gh-ci-%s-%d-%s", pr.Repo, pr.Number, short(pr.HeadSHA)), Kind: "ci", Project: project,
			Title: "CI failed · " + pr.Repo,
			Body:  fmt.Sprintf("#%d %s — %s failed", pr.Number, pr.Title, strings.Join(names, ", ")),
		}})
	}
	for _, r := range newReviews {
		verb := "Approved"
		if r.State == "changes_requested" {
			verb = "Changes requested"
		}
		s.Bus.Publish(bus.Frame{Type: bus.FrameNotify, Data: alerts.Notification{
			ID: fmt.Sprintf("gh-review-%s-%d-%s-%d", pr.Repo, pr.Number, r.User, r.At), Kind: "review", Project: project,
			Title: verb + " · " + pr.Repo,
			Body:  fmt.Sprintf("#%d %s — by @%s", pr.Number, pr.Title, r.User),
		}})
	}
}

func short(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

func (s *Service) publishPR(pr PR) {
	if s.Bus != nil {
		s.Bus.Publish(bus.Frame{Type: FrameGitHub, Data: map[string]any{"kind": "pr", "pr": pr}})
	}
}

func (s *Service) publishGone(key string) {
	if s.Bus == nil {
		return
	}
	id, wt, _ := strings.Cut(key, "/")
	pid, _ := strconv.ParseInt(id, 10, 64)
	s.Bus.Publish(bus.Frame{Type: FrameGitHub, Data: map[string]any{"kind": "pr_gone", "project_id": pid, "worktree": wt}})
}

// RepoRef is a worktree's repository on GitHub.
type RepoRef struct {
	Owner    string `json:"owner"`
	Name     string `json:"name"`
	FullName string `json:"full_name"`
	HTMLURL  string `json:"html_url"`
}

// Draft is a pull request's prefilled title and body: the one commit's
// subject, or the branch's name, and the commits' subjects.
type Draft struct {
	Title   string   `json:"title"`
	Body    string   `json:"body"`
	Commits []string `json:"commits"`
}

// WorktreeInfo is GET /v1/projects/{id}/github: whether the worktree can
// have a pull request, and the one it has.
type WorktreeInfo struct {
	Connected bool     `json:"connected"`
	Repo      *RepoRef `json:"repo"`
	// Reason says why there is no repository or no pull request to offer:
	// no_remote | not_github | detached | default_branch.
	Reason    string `json:"reason,omitempty"`
	Branch    string `json:"branch"`
	Base      string `json:"base"`
	Remote    string `json:"remote,omitempty"`
	Published bool   `json:"published"`
	Ahead     int    `json:"ahead"`
	PR        *PR    `json:"pr"`
	Draft     *Draft `json:"draft,omitempty"`
	// Primed is false until GitHub was asked whether a pull request exists.
	Primed bool `json:"primed"`
}

// Worktree says what the Changes view shows about GitHub for one worktree.
// When GitHub has not been asked about this branch yet, it asks now.
func (s *Service) Worktree(ctx context.Context, projectID int64, worktree string) (WorktreeInfo, error) {
	s.init()
	c, err := s.Projects.Changes(ctx, projectID, worktree)
	if err != nil {
		return WorktreeInfo{}, err
	}
	info := WorktreeInfo{Connected: s.source() != "", Branch: c.Branch, Base: c.DefaultBranch, Remote: c.Remote, Published: c.Published, Ahead: c.Ahead}
	switch {
	case c.Remote == "":
		info.Reason = "no_remote"
		return info, nil
	case c.Detached || c.Branch == "":
		info.Reason = "detached"
	case c.Branch == c.DefaultBranch:
		info.Reason = "default_branch"
	}
	repo, ok := ParseRemote(c.RemoteURL)
	if !ok {
		info.Reason = "not_github"
		return info, nil
	}
	info.Repo = &RepoRef{Owner: repo.Owner, Name: repo.Name, FullName: repo.FullName(), HTMLURL: "https://github.com/" + repo.FullName()}
	if info.Reason != "" {
		return info, nil
	}
	k := keyOf(projectID, worktree)
	s.track.mu.Lock()
	f := s.track.items[k]
	if f == nil || f.t.branch != c.Branch {
		f = &followed{t: target{projectID: projectID, worktree: worktree, branch: c.Branch, base: c.DefaultBranch, repo: repo}, reviews: map[string]string{}}
		s.track.items[k] = f
		if s.track.repos[repo.FullName()] == nil {
			s.track.repos[repo.FullName()] = &repoPoll{next: s.Now().Add(MinPoll), interval: MinPoll}
		}
	}
	primed := f.primed
	s.track.mu.Unlock()
	if !primed && info.Connected {
		s.lookup(ctx, f)
	}
	s.track.mu.Lock()
	if f.pr != nil {
		p := *f.pr
		info.PR = &p
	}
	info.Primed = f.primed
	s.track.mu.Unlock()
	if info.PR == nil || info.PR.State != "open" {
		subjects, _ := s.Projects.Subjects(ctx, projectID, worktree, c.DefaultBranch)
		d := draftFor(c.Branch, subjects)
		info.Draft = &d
	}
	return info, nil
}

// lookup asks GitHub for the newest pull request from this branch, open or
// not, and reads it.
func (s *Service) lookup(ctx context.Context, f *followed) {
	s.track.mu.Lock()
	t := f.t
	s.track.mu.Unlock()
	doing := "Looking for a pull request from " + t.branch
	q := url.Values{"head": {t.repo.Owner + ":" + t.branch}, "state": {"all"}, "per_page": {"1"}, "sort": {"created"}, "direction": {"desc"}}
	res, e := s.call(ctx, request{method: http.MethodGet, path: repoPath(t.repo) + "/pulls?" + q.Encode(), doing: doing})
	if e != nil {
		s.markError([]*followed{f}, e)
		return
	}
	var ps []apiPull
	if e := decode(res, doing, &ps); e != nil {
		s.markError([]*followed{f}, e)
		return
	}
	if len(ps) == 0 {
		s.track.mu.Lock()
		f.primed, f.lastAt = true, s.Now()
		s.track.mu.Unlock()
		return
	}
	s.refreshPull(ctx, f, ps[0].Number)
}

// Refresh reads one worktree's pull request now (the Refresh button), at
// most once per kickGap.
func (s *Service) Refresh(ctx context.Context, projectID int64, worktree string) (WorktreeInfo, error) {
	s.init()
	k := keyOf(projectID, worktree)
	s.track.mu.Lock()
	f := s.track.items[k]
	if f != nil && s.Now().Sub(f.lastAt) >= kickGap {
		f.primed = false
	}
	s.track.mu.Unlock()
	return s.Worktree(ctx, projectID, worktree)
}

// conventional are the branch prefixes that read as a commit type.
var conventional = map[string]bool{"feat": true, "fix": true, "docs": true, "chore": true, "refactor": true, "test": true, "perf": true, "ci": true, "build": true, "style": true}

// draftFor prefills a pull request: one commit's subject as the title, else
// the branch said as words ("feat/github-auth" → "feat: github auth"); the
// body lists the commits when there is more than one.
func draftFor(branch string, subjects []string) Draft {
	d := Draft{Commits: subjects}
	if d.Commits == nil {
		d.Commits = []string{}
	}
	if len(subjects) == 1 {
		d.Title = subjects[0]
	} else {
		d.Title = branchTitle(branch)
	}
	if len(subjects) > 1 {
		lines := make([]string, 0, len(subjects))
		for i := len(subjects) - 1; i >= 0; i-- {
			lines = append(lines, "- "+subjects[i])
		}
		d.Body = strings.Join(lines, "\n")
	}
	return d
}

func branchTitle(branch string) string {
	prefix, rest, ok := strings.Cut(branch, "/")
	words := func(s string) string {
		return strings.TrimSpace(strings.NewReplacer("-", " ", "_", " ", "/", " ").Replace(s))
	}
	if ok && conventional[strings.ToLower(prefix)] && rest != "" {
		return strings.ToLower(prefix) + ": " + words(rest)
	}
	w := words(branch)
	if w == "" {
		return branch
	}
	return strings.ToUpper(w[:1]) + w[1:]
}

// CreatePRRequest is POST /v1/projects/{id}/github/pr.
type CreatePRRequest struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	Base  string `json:"base,omitempty"`
	Draft bool   `json:"draft"`
}

// CreatePRResult is the new pull request, and the push that went first.
type CreatePRResult struct {
	PR     PR                     `json:"pr"`
	Pushed bool                   `json:"pushed"`
	Push   *projects.RemoteResult `json:"push,omitempty"`
}

// ExistsError is a pull request already open from the branch: the 422,
// with the one GitHub has.
type ExistsError struct {
	Err *Error
	PR  *PR
}

func (e *ExistsError) Error() string { return e.Err.Error() }

// CreatePR opens a pull request from a worktree's branch: it pushes first
// when the branch is not published or has commits GitHub lacks (the Changes
// push), then asks GitHub.
func (s *Service) CreatePR(ctx context.Context, projectID int64, worktree string, req CreatePRRequest) (CreatePRResult, error) {
	s.init()
	const doing = "Opening the pull request"
	title := strings.TrimSpace(req.Title)
	if title == "" {
		return CreatePRResult{}, errorf(KindInvalid, doing, "a pull request needs a title")
	}
	if len(title) > 256 || len(req.Body) > 65536 {
		return CreatePRResult{}, errorf(KindInvalid, doing, "the title (256) or the body (65,536 characters) is too long")
	}
	if _, _, e := s.token(ctx, doing); e != nil {
		return CreatePRResult{}, e
	}
	c, err := s.Projects.Changes(ctx, projectID, worktree)
	if err != nil {
		return CreatePRResult{}, err
	}
	base := strings.TrimSpace(req.Base)
	if base == "" {
		base = c.DefaultBranch
	}
	switch {
	case c.Detached || c.Branch == "":
		return CreatePRResult{}, errorf(KindState, doing, "HEAD is not on a branch; a pull request is opened from one")
	case c.Remote == "":
		return CreatePRResult{}, errorf(KindState, doing, "this repository has no remote; create its GitHub repository first")
	case c.Branch == base:
		return CreatePRResult{}, errorf(KindState, doing, "%s is the base branch; open a pull request from another branch (a worktree)", c.Branch)
	}
	repo, ok := ParseRemote(c.RemoteURL)
	if !ok {
		return CreatePRResult{}, errorf(KindState, doing, "the remote %s is not on github.com", c.RemoteURL)
	}
	out := CreatePRResult{}
	if !c.Published || c.Ahead > 0 {
		pr, _, err := s.Projects.Push(ctx, projectID, worktree)
		if err != nil {
			var ce *projects.ChangeError
			if errors.As(err, &ce) {
				return CreatePRResult{}, &projects.ChangeError{Kind: ce.Kind, Message: "pushing " + c.Branch + " first failed: " + ce.Message, Output: ce.Output}
			}
			return CreatePRResult{}, err
		}
		out.Pushed, out.Push = true, &pr
	}
	body := map[string]any{"title": title, "head": c.Branch, "base": base, "body": req.Body, "draft": req.Draft}
	res, e := s.call(ctx, request{method: http.MethodPost, path: repoPath(repo) + "/pulls", body: body, doing: doing})
	if e != nil {
		if e.Kind == KindExists || strings.Contains(strings.ToLower(e.Message), "pull request already exists") {
			e.Kind = KindExists
			k := keyOf(projectID, worktree)
			f := s.followedFor(k, target{projectID: projectID, worktree: worktree, branch: c.Branch, base: base, repo: repo})
			s.lookup(ctx, f)
			s.track.mu.Lock()
			var have *PR
			if f.pr != nil {
				p := *f.pr
				have = &p
			}
			s.track.mu.Unlock()
			if have != nil {
				e.Message = fmt.Sprintf("a pull request from %s is already open: #%d %s", c.Branch, have.Number, have.Title)
			} else {
				e.Message = "a pull request from " + c.Branch + " is already open"
			}
			return CreatePRResult{}, &ExistsError{Err: e, PR: have}
		}
		return CreatePRResult{}, e
	}
	var p apiPull
	if e := decode(res, doing, &p); e != nil {
		return CreatePRResult{}, e
	}
	k := keyOf(projectID, worktree)
	f := s.followedFor(k, target{projectID: projectID, worktree: worktree, branch: c.Branch, base: base, repo: repo})
	pr := &PR{ProjectID: projectID, Worktree: worktree, Branch: c.Branch, Repo: repo.FullName(), Number: p.Number, URL: p.HTMLURL, Title: p.Title,
		State: p.state(), Draft: p.Draft, Base: p.Base.Ref, HeadSHA: p.Head.SHA, Mergeable: p.Mergeable, Reviews: []Review{},
		Checks: Checks{State: "none", Items: []Check{}}, At: s.Now().UnixMilli()}
	s.track.mu.Lock()
	f.pr, f.primed, f.lastAt = pr, true, s.Now()
	s.track.mu.Unlock()
	s.publishPR(*pr)
	s.Kick(projectID)
	out.PR = *pr
	return out, nil
}

// followedFor is the followed entry for k, made from t when there is none.
func (s *Service) followedFor(k string, t target) *followed {
	s.track.mu.Lock()
	defer s.track.mu.Unlock()
	f := s.track.items[k]
	if f == nil || f.t.branch != t.branch {
		f = &followed{t: t, reviews: map[string]string{}}
		s.track.items[k] = f
	}
	if s.track.repos[t.repo.FullName()] == nil {
		s.track.repos[t.repo.FullName()] = &repoPoll{next: s.Now().Add(MinPoll), interval: MinPoll}
	}
	return f
}
