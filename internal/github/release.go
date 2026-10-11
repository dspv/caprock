package github

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"sync"
	"time"
)

// The session deck's CI cell also shows a repository's release build and its
// default branch (owner, 2026-10-12, translated: "Can I also see here, in the
// deck, the status of the release build?"). Both are read here, for any
// repository, without knowing its workflow files: a release run is the newest
// run started by pushing a tag or publishing a release.
const (
	// releaseRunsRead is how many recent push runs are searched for a tag.
	releaseRunsRead = 30
	// mainRunsRead is how many recent runs of the default branch are read; one
	// row per workflow is kept from them.
	mainRunsRead = 30
	// mainWorkflowsShown bounds the workflows the Main view lists.
	mainWorkflowsShown = 8
	// estimateRuns is how many past successful release runs the estimate is
	// the median of, at most; estimateMin is the fewest it is made from.
	estimateRuns = 10
	estimateMin  = 2
	// estimateKept is how long a workflow's estimate is reused.
	estimateKept = 30 * time.Minute
	// releaseLinkKept is how long a published release's page is reused; a tag
	// with no release yet is asked again after ciSettled.
	releaseLinkKept = 30 * time.Minute
	// defaultKept is how long a repository's default branch read from GitHub
	// is reused.
	defaultKept = time.Hour
	// repoViewsKept bounds the release and main answers kept.
	repoViewsKept = 64
)

// tagLike is a ref that reads as a release tag: v1.2.3, 1.2, 2026.10.1,
// v1.2.3-rc.1, app/v1.2.0, release-1.4. GitHub reports a tag push's tag in
// head_branch and does not say whether it was a tag; this is how it is told.
var tagLike = regexp.MustCompile(`^(?:[A-Za-z][A-Za-z0-9_.-]*[-/@])?[vV]?[0-9]+(?:\.[0-9]+)+(?:[-+][0-9A-Za-z.+-]*)?$`)

// IsReleaseRun reports whether a run was started by a release: a release
// event, or a push of a tag (a head_branch that reads as a tag and is not the
// default branch).
func IsReleaseRun(event, headBranch, defaultBranch string) bool {
	if event == "release" {
		return true
	}
	return event == "push" && headBranch != "" && headBranch != defaultBranch && tagLike.MatchString(headBranch)
}

// CIEstimate is how long a release run usually takes: the median wall-clock
// span (updated_at - run_started_at, GitHub's own stamps) of the last Runs
// successful release runs of the same workflow. An estimate, labelled so.
type CIEstimate struct {
	MedianMS int64 `json:"median_ms"`
	Runs     int   `json:"runs"`
}

// ReleaseLink is the GitHub release published for a tag.
type ReleaseLink struct {
	URL         string `json:"url"`
	PublishedAt int64  `json:"published_at,omitempty"`
	Draft       bool   `json:"draft,omitempty"`
}

// ReleaseCI is a repository's newest release run with its jobs and steps.
type ReleaseCI struct {
	Repo string `json:"repo"`
	Tag  string `json:"tag,omitempty"`
	// State: running, fail, pass, or none (no release run among the recent).
	State string `json:"state"`
	Run   *CIRun `json:"run,omitempty"`
	// Estimate is set while the run is unfinished and enough past runs exist.
	Estimate *CIEstimate `json:"estimate,omitempty"`
	// Release is set once the run finished and GitHub has a release for the tag.
	Release *ReleaseLink `json:"release,omitempty"`
	At      int64        `json:"at"`
	Error   *Error       `json:"error,omitempty"`
}

type releaseEntry struct {
	rel ReleaseCI
	at  time.Time
}

type mainEntry struct {
	ci CI
	at time.Time
}

type estimateEntry struct {
	est *CIEstimate
	at  time.Time
}

type linkEntry struct {
	link *ReleaseLink
	at   time.Time
}

type defaultEntry struct {
	branch string
	// visibility is public or private, from the same read (runnercost.go).
	visibility string
	at         time.Time
}

// repoCI keeps the release and main answers, estimates, release links and
// default branches, each bounded.
type repoCI struct {
	mu        sync.Mutex
	release   map[string]releaseEntry
	main      map[string]mainEntry
	estimates map[string]estimateEntry
	links     map[string]linkEntry
	defaults  map[string]defaultEntry
	// visFail is when a repository's metadata last failed to read, so its
	// visibility is not asked on every CI read (RepoVisibility).
	visFail map[string]time.Time
}

func (r *repoCI) lazy() {
	if r.release == nil {
		r.release = map[string]releaseEntry{}
		r.main = map[string]mainEntry{}
		r.estimates = map[string]estimateEntry{}
		r.links = map[string]linkEntry{}
		r.defaults = map[string]defaultEntry{}
		r.visFail = map[string]time.Time{}
	}
}

// bound drops the oldest entry of m when it is full and key is new.
func bound[V any](m map[string]V, key string, at func(V) time.Time) {
	if _, ok := m[key]; ok || len(m) < repoViewsKept {
		return
	}
	var oldest string
	var t time.Time
	for k, v := range m {
		if oldest == "" || at(v).Before(t) {
			oldest, t = k, at(v)
		}
	}
	delete(m, oldest)
}

func (s *Service) checkRepo(repo Repo, doing string) *Error {
	if !namePart.MatchString(repo.Owner) || !namePart.MatchString(repo.Name) {
		return errorf(KindInvalid, doing, "No repository to read the CI of.")
	}
	if s.source() == "" {
		return errorf(KindNotConnected, doing, "GitHub is not connected.")
	}
	return nil
}

// DefaultBranch is the repository's default branch as GitHub reports it,
// kept for defaultKept. Used when git does not know it locally.
func (s *Service) DefaultBranch(ctx context.Context, repo Repo) (string, *Error) {
	s.init()
	doing := "Reading the default branch of " + repo.FullName()
	if e := s.checkRepo(repo, doing); e != nil {
		return "", e
	}
	key := repo.FullName()
	s.repoCI.mu.Lock()
	s.repoCI.lazy()
	d, have := s.repoCI.defaults[key]
	s.repoCI.mu.Unlock()
	if have && s.Now().Sub(d.at) < defaultKept {
		return d.branch, nil
	}
	d, e := s.readRepoMeta(ctx, repo, doing)
	if e != nil {
		return "", e
	}
	return d.branch, nil
}

// readRepoMeta reads GET /repos/{o}/{r} and keeps its default branch and
// visibility for defaultKept.
func (s *Service) readRepoMeta(ctx context.Context, repo Repo, doing string) (defaultEntry, *Error) {
	if e := s.checkRepo(repo, doing); e != nil {
		return defaultEntry{}, e
	}
	res, e := s.call(ctx, request{method: http.MethodGet, doing: doing, path: repoPath(repo)})
	if e != nil {
		return defaultEntry{}, e
	}
	var r apiRepo
	if de := decode(res, doing, &r); de != nil {
		return defaultEntry{}, de
	}
	d := defaultEntry{branch: r.DefaultBranch, visibility: VisibilityPublic, at: s.Now()}
	if r.Private {
		d.visibility = VisibilityPrivate
	}
	key := repo.FullName()
	s.repoCI.mu.Lock()
	s.repoCI.lazy()
	bound(s.repoCI.defaults, key, func(v defaultEntry) time.Time { return v.at })
	s.repoCI.defaults[key] = d
	delete(s.repoCI.visFail, key)
	s.repoCI.mu.Unlock()
	return d, nil
}

// ReleaseByRepo is the repository's newest release run — the newest run of
// a release event, or of a push whose head_branch reads as a tag — with its
// jobs and steps, kept for ciRunning while it runs and ciSettled after. While
// it runs, the estimate of how long it takes; once it finished, the GitHub
// release published for its tag, when there is one. Nothing is sent while
// GitHub is not connected.
func (s *Service) ReleaseByRepo(ctx context.Context, repo Repo, defaultBranch string) (ReleaseCI, *Error) {
	s.init()
	doing := "Reading the release runs of " + repo.FullName()
	key := repo.FullName()
	now := s.Now()
	s.repoCI.mu.Lock()
	s.repoCI.lazy()
	e, have := s.repoCI.release[key]
	s.repoCI.mu.Unlock()
	if have && now.Sub(e.at) < releaseKeep(e.rel) {
		return e.rel, nil
	}
	if ce := s.checkRepo(repo, doing); ce != nil {
		return ReleaseCI{}, ce
	}
	rel, ce := s.readRelease(ctx, repo, defaultBranch, e.rel)
	if ce != nil {
		if have {
			e.rel.Error = ce
			return e.rel, nil
		}
		return ReleaseCI{}, ce
	}
	s.repoCI.mu.Lock()
	bound(s.repoCI.release, key, func(v releaseEntry) time.Time { return v.at })
	s.repoCI.release[key] = releaseEntry{rel: rel, at: now}
	s.repoCI.mu.Unlock()
	return rel, nil
}

func releaseKeep(r ReleaseCI) time.Duration {
	if r.State == "running" {
		return ciRunning
	}
	return ciSettled
}

// listRuns reads one page of a repository's workflow runs.
func (s *Service) listRuns(ctx context.Context, path, doing string) ([]apiRun, *Error) {
	res, ce := s.call(ctx, request{method: http.MethodGet, doing: doing, path: path})
	if ce != nil {
		return nil, ce
	}
	var list struct {
		Runs []apiRun `json:"workflow_runs"`
	}
	if de := decode(res, doing, &list); de != nil {
		return nil, de
	}
	return list.Runs, nil
}

func (s *Service) readRelease(ctx context.Context, repo Repo, defaultBranch string, prev ReleaseCI) (ReleaseCI, *Error) {
	doing := "Reading the release runs of " + repo.FullName()
	out := ReleaseCI{Repo: repo.FullName(), State: "none", At: s.Now().UnixMilli()}
	var found []apiRun
	for _, q := range []string{
		fmt.Sprintf("%s/actions/runs?event=push&per_page=%d", repoPath(repo), releaseRunsRead),
		repoPath(repo) + "/actions/runs?event=release&per_page=5",
	} {
		runs, ce := s.listRuns(ctx, q, doing)
		if ce != nil {
			return ReleaseCI{}, ce
		}
		for _, r := range runs {
			if IsReleaseRun(r.Event, r.HeadBranch, defaultBranch) {
				found = append(found, r)
			}
		}
	}
	if len(found) == 0 {
		return out, nil
	}
	sort.SliceStable(found, func(i, j int) bool { return unixMS(found[i].CreatedAt) > unixMS(found[j].CreatedAt) })
	newest := found[0]
	var prevRuns []CIRun
	if prev.Run != nil {
		prevRuns = []CIRun{*prev.Run}
	}
	runs, je := s.withJobs(ctx, repo, []apiRun{newest}, prevRuns)
	s.priceCI(ctx, repo, runs)
	run := runs[0]
	out.Run, out.Tag, out.Error = &run, run.HeadBranch, je
	one := CI{Runs: runs}
	settle(&one)
	out.State = one.State
	if out.State == "running" {
		out.Estimate = s.estimate(ctx, repo, defaultBranch, run)
	} else if run.Conclusion == "success" && out.Tag != "" {
		out.Release = s.releaseLink(ctx, repo, out.Tag)
	}
	return out, nil
}

// estimate is the median wall-clock span of the last successful release runs
// of the run's workflow, the run itself left out; nil with fewer than
// estimateMin. Kept per workflow for estimateKept. A failed read is no
// estimate, not an error: the run is still shown.
func (s *Service) estimate(ctx context.Context, repo Repo, defaultBranch string, run CIRun) *CIEstimate {
	if run.WorkflowID == 0 {
		return nil
	}
	key := fmt.Sprintf("%s#%d", repo.FullName(), run.WorkflowID)
	s.repoCI.mu.Lock()
	e, have := s.repoCI.estimates[key]
	s.repoCI.mu.Unlock()
	if have && s.Now().Sub(e.at) < estimateKept {
		return e.est
	}
	doing := "Reading past release runs of " + repo.FullName()
	runs, ce := s.listRuns(ctx, fmt.Sprintf("%s/actions/workflows/%d/runs?status=success&per_page=%d", repoPath(repo), run.WorkflowID, 3*estimateRuns), doing)
	if ce != nil {
		return nil
	}
	est := medianSpan(runs, run.ID, defaultBranch)
	s.repoCI.mu.Lock()
	bound(s.repoCI.estimates, key, func(v estimateEntry) time.Time { return v.at })
	s.repoCI.estimates[key] = estimateEntry{est: est, at: s.Now()}
	s.repoCI.mu.Unlock()
	return est
}

// medianSpan is the median of updated_at - run_started_at over the newest
// estimateRuns successful release runs other than skip; nil with fewer than
// estimateMin of them.
func medianSpan(runs []apiRun, skip int64, defaultBranch string) *CIEstimate {
	spans := []int64{}
	for _, r := range runs {
		if len(spans) == estimateRuns {
			break
		}
		if r.ID == skip || r.Status != "completed" || r.Conclusion != "success" || !IsReleaseRun(r.Event, r.HeadBranch, defaultBranch) {
			continue
		}
		start := unixMS(r.RunStartedAt)
		if start == 0 {
			start = unixMS(r.CreatedAt)
		}
		if d := span(start, unixMS(r.UpdatedAt)); d > 0 {
			spans = append(spans, d)
		}
	}
	if len(spans) < estimateMin {
		return nil
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i] < spans[j] })
	m := spans[len(spans)/2]
	if len(spans)%2 == 0 {
		m = (spans[len(spans)/2-1] + spans[len(spans)/2]) / 2
	}
	return &CIEstimate{MedianMS: m, Runs: len(spans)}
}

// releaseLink is the GitHub release for a tag, nil when there is none (yet).
// A 404 is the answer "no release", not an error, so it is asked without
// marking the health line.
func (s *Service) releaseLink(ctx context.Context, repo Repo, tag string) *ReleaseLink {
	key := repo.FullName() + "@" + tag
	s.repoCI.mu.Lock()
	e, have := s.repoCI.links[key]
	s.repoCI.mu.Unlock()
	keep := ciSettled
	if have && e.link != nil {
		keep = releaseLinkKept
	}
	if have && s.Now().Sub(e.at) < keep {
		return e.link
	}
	doing := "Reading the release " + tag + " of " + repo.FullName()
	tok, src, te := s.token(ctx, doing)
	if te != nil {
		return nil
	}
	res, ce := s.c.do(ctx, request{method: http.MethodGet, doing: doing, token: tok, source: src,
		path: repoPath(repo) + "/releases/tags/" + url.PathEscape(tag)})
	var link *ReleaseLink
	switch {
	case ce != nil && ce.Kind == KindNotFound:
	case ce != nil:
		s.noteErr(ce)
		return nil
	default:
		var r struct {
			HTMLURL     string `json:"html_url"`
			PublishedAt string `json:"published_at"`
			Draft       bool   `json:"draft"`
		}
		if decode(res, doing, &r) != nil || r.HTMLURL == "" {
			return nil
		}
		link = &ReleaseLink{URL: r.HTMLURL, PublishedAt: unixMS(r.PublishedAt), Draft: r.Draft}
	}
	s.repoCI.mu.Lock()
	bound(s.repoCI.links, key, func(v linkEntry) time.Time { return v.at })
	s.repoCI.links[key] = linkEntry{link: link, at: s.Now()}
	s.repoCI.mu.Unlock()
	return link
}

// MainCI is the CI of a repository's default branch: the newest run of each
// workflow on it (up to mainWorkflowsShown), with jobs and steps, kept for
// ciRunning while any runs and ciSettled after. HeadSHA is the newest run's
// commit. Nothing is sent while GitHub is not connected.
func (s *Service) MainCI(ctx context.Context, repo Repo, branch string) (CI, *Error) {
	s.init()
	doing := "Reading the GitHub Actions runs of " + repo.FullName() + " on " + branch
	if branch == "" {
		return CI{}, errorf(KindInvalid, doing, "No default branch to read the CI of.")
	}
	key := repo.FullName() + "@" + branch
	now := s.Now()
	s.repoCI.mu.Lock()
	s.repoCI.lazy()
	e, have := s.repoCI.main[key]
	s.repoCI.mu.Unlock()
	if have && now.Sub(e.at) < ciKeep(e.ci) {
		return e.ci, nil
	}
	if ce := s.checkRepo(repo, doing); ce != nil {
		return CI{}, ce
	}
	runs, ce := s.listRuns(ctx, fmt.Sprintf("%s/actions/runs?branch=%s&per_page=%d", repoPath(repo), url.QueryEscape(branch), mainRunsRead), doing)
	if ce != nil {
		if have {
			e.ci.Error = ce
			return e.ci, nil
		}
		return CI{}, ce
	}
	// One run per workflow, the newest (GitHub lists the newest first).
	seen := map[int64]bool{}
	pick := []apiRun{}
	for _, r := range runs {
		if r.HeadBranch != branch || seen[r.WorkflowID] || len(pick) == mainWorkflowsShown {
			continue
		}
		seen[r.WorkflowID] = true
		pick = append(pick, r)
	}
	out := CI{Repo: repo.FullName(), Branch: branch, State: "none", ByOS: []CIOS{}, At: now.UnixMilli()}
	if len(pick) > 0 {
		out.HeadSHA = pick[0].HeadSHA
	}
	out.Runs, out.Error = s.withJobs(ctx, repo, pick, e.ci.Runs)
	settle(&out)
	out.Cost = s.priceCI(ctx, repo, out.Runs)
	s.repoCI.mu.Lock()
	bound(s.repoCI.main, key, func(v mainEntry) time.Time { return v.at })
	s.repoCI.main[key] = mainEntry{ci: out, at: now}
	s.repoCI.mu.Unlock()
	return out, nil
}
