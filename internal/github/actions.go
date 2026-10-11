package github

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// How long a commit's GitHub Actions runs are kept (the session deck's CI
// panel). While a job runs they are asked about again soonest, so its steps
// move; once every run settled, rarely. Every read is conditional, so an
// unchanged answer costs GitHub's 304.
const (
	ciRunning = 10 * time.Second
	ciSettled = 2 * time.Minute
	// ciRunsShown is how many workflow runs of one commit are read.
	ciRunsShown = 10
	// ciKept bounds the commits whose runs are kept.
	ciKept = 64
	// logKept is how long a finished job's log tail is kept: it never changes.
	logKept = 30 * time.Minute
	// logsKept bounds the log tails kept.
	logsKept = 32
)

// How much of a job's log is read and returned. A log is downloaded from
// where GitHub points (a signed address on its log storage), read up to
// logReadMax, and only the lines around the last error are kept.
const (
	logReadMax   = 32 << 20
	logRing      = 400
	logBefore    = 50
	logAfter     = 10
	logLineMax   = 400
	logReturnMax = 24 << 10
)

// CIStep is one step of a job, as GitHub Actions reports it.
type CIStep struct {
	Number      int    `json:"number"`
	Name        string `json:"name"`
	Status      string `json:"status"`               // queued | in_progress | completed
	Conclusion  string `json:"conclusion,omitempty"` // success | failure | skipped | cancelled …
	StartedAt   int64  `json:"started_at,omitempty"` // unix ms
	CompletedAt int64  `json:"completed_at,omitempty"`
	// DurationMS is CompletedAt - StartedAt, 0 until both are known.
	DurationMS int64 `json:"duration_ms,omitempty"`
}

// CIJob is one job of a workflow run, with its steps.
type CIJob struct {
	ID          int64    `json:"id"`
	RunID       int64    `json:"run_id"`
	Name        string   `json:"name"`
	Status      string   `json:"status"`
	Conclusion  string   `json:"conclusion,omitempty"`
	StartedAt   int64    `json:"started_at,omitempty"`
	CompletedAt int64    `json:"completed_at,omitempty"`
	DurationMS  int64    `json:"duration_ms,omitempty"`
	Labels      []string `json:"labels"`
	// OS is read from the runner labels: linux, windows, macos, self-hosted,
	// or "" when they name none of these.
	OS         string `json:"os,omitempty"`
	RunnerName string `json:"runner_name,omitempty"`
	// RunnerGroup is GitHub's runner_group_name: "GitHub Actions" for its
	// standard hosted runners, the group's name for a larger or self-hosted one.
	RunnerGroup string   `json:"runner_group_name,omitempty"`
	HTMLURL     string   `json:"html_url,omitempty"`
	Steps       []CIStep `json:"steps"`
	// Cost is what the job cost at the runner's list rate (runnercost.go).
	Cost *RunnerCost `json:"cost,omitempty"`
}

// CIRun is one workflow run of a commit.
type CIRun struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	Event      string `json:"event,omitempty"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion,omitempty"`
	Attempt    int    `json:"attempt,omitempty"`
	HTMLURL    string `json:"html_url,omitempty"`
	CreatedAt  int64  `json:"created_at,omitempty"`
	UpdatedAt  int64  `json:"updated_at,omitempty"`
	// StartedAt is when this attempt started (GitHub's run_started_at).
	StartedAt int64 `json:"started_at,omitempty"`
	// HeadBranch is the branch, or for a tag push or a release the tag.
	HeadBranch string  `json:"head_branch,omitempty"`
	HeadSHA    string  `json:"head_sha,omitempty"`
	WorkflowID int64   `json:"workflow_id,omitempty"`
	Jobs       []CIJob `json:"jobs"`
	// Cost sums the run's finished jobs (runnercost.go).
	Cost *CICost `json:"cost,omitempty"`
}

// CIOS is the runner time of the finished jobs on one OS.
type CIOS struct {
	OS string `json:"os"`
	MS int64  `json:"ms"`
}

// CI is a commit's GitHub Actions: every workflow run, their jobs and steps,
// with what each took. RunnerMS sums the jobs that finished, measured from
// GitHub's own timestamps; a running job's time is the reader's clock minus
// its StartedAt. No billing multiplier is applied: ByOS says which runners
// the minutes were on, and nothing more.
type CI struct {
	Repo    string `json:"repo"`
	HeadSHA string `json:"head_sha"`
	// Branch is set on a branch's CI (MainCI), "" on a commit's.
	Branch string `json:"branch,omitempty"`
	// State: running (a run is queued or in progress), fail, pass, or none.
	State    string  `json:"state"`
	Runs     []CIRun `json:"runs"`
	RunnerMS int64   `json:"runner_ms"`
	ByOS     []CIOS  `json:"by_os"`
	// Cost sums every run's finished jobs at the runners' list rates: an
	// estimate before a private repository's included minutes.
	Cost  *CICost `json:"cost,omitempty"`
	At    int64   `json:"at"`
	Error *Error  `json:"error,omitempty"`
}

// CILog is the end of a failed job's log: the lines around its last error.
type CILog struct {
	JobID int64    `json:"job_id"`
	Lines []string `json:"lines"`
	// ErrorLine is the index in Lines of the error the tail is built around,
	// -1 when the log names none and Lines is simply its end.
	ErrorLine int  `json:"error_line"`
	Truncated bool `json:"truncated,omitempty"` // the log was longer than was read
}

type ciEntry struct {
	ci CI
	at time.Time
}

type logEntry struct {
	log CILog
	at  time.Time
}

type ciCache struct {
	mu   sync.Mutex
	runs map[string]ciEntry // "owner/name@sha" -> answer
	logs map[string]logEntry
}

// apiRun, apiStep and apiJob are the parts of GitHub's answers read here.
type apiRun struct {
	ID           int64  `json:"id"`
	Name         string `json:"name"`
	Event        string `json:"event"`
	Status       string `json:"status"`
	Conclusion   string `json:"conclusion"`
	RunAttempt   int    `json:"run_attempt"`
	HTMLURL      string `json:"html_url"`
	CreatedAt    string `json:"created_at"`
	UpdatedAt    string `json:"updated_at"`
	RunStartedAt string `json:"run_started_at"`
	HeadBranch   string `json:"head_branch"`
	HeadSHA      string `json:"head_sha"`
	WorkflowID   int64  `json:"workflow_id"`
}

func (ar apiRun) run() CIRun {
	return CIRun{ID: ar.ID, Name: ar.Name, Event: ar.Event, Status: ar.Status, Conclusion: ar.Conclusion, Attempt: ar.RunAttempt,
		HTMLURL: ar.HTMLURL, CreatedAt: unixMS(ar.CreatedAt), UpdatedAt: unixMS(ar.UpdatedAt), StartedAt: unixMS(ar.RunStartedAt),
		HeadBranch: ar.HeadBranch, HeadSHA: ar.HeadSHA, WorkflowID: ar.WorkflowID, Jobs: []CIJob{}}
}

type apiStep struct {
	Number      int    `json:"number"`
	Name        string `json:"name"`
	Status      string `json:"status"`
	Conclusion  string `json:"conclusion"`
	StartedAt   string `json:"started_at"`
	CompletedAt string `json:"completed_at"`
}

type apiJob struct {
	ID          int64     `json:"id"`
	RunID       int64     `json:"run_id"`
	Name        string    `json:"name"`
	Status      string    `json:"status"`
	Conclusion  string    `json:"conclusion"`
	StartedAt   string    `json:"started_at"`
	CompletedAt string    `json:"completed_at"`
	Labels      []string  `json:"labels"`
	RunnerName  string    `json:"runner_name"`
	RunnerGroup string    `json:"runner_group_name"`
	HTMLURL     string    `json:"html_url"`
	Steps       []apiStep `json:"steps"`
}

// unixMS reads one of GitHub's RFC 3339 times as unix ms; 0 when absent.
func unixMS(s string) int64 {
	if s == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

func span(start, end int64) int64 {
	if start <= 0 || end < start {
		return 0
	}
	return end - start
}

// runnerOS reads the OS a job ran on from its labels. A self-hosted runner
// is named so, whatever else its labels say: it is not GitHub's minutes.
func runnerOS(labels []string) string {
	os := ""
	for _, l := range labels {
		low := strings.ToLower(l)
		switch {
		case low == "self-hosted":
			return "self-hosted"
		case os != "":
		case strings.Contains(low, "windows"):
			os = "windows"
		case strings.Contains(low, "macos"), strings.HasPrefix(low, "mac"):
			os = "macos"
		case strings.Contains(low, "ubuntu"), strings.Contains(low, "linux"):
			os = "linux"
		}
	}
	return os
}

// CIBySHA is a commit's GitHub Actions runs with their jobs and steps, read
// from GitHub and kept for ciRunning while any run is unfinished, else for
// ciSettled. Nothing is sent while GitHub is not connected.
func (s *Service) CIBySHA(ctx context.Context, repo Repo, sha string) (CI, *Error) {
	s.init()
	if sha == "" || !namePart.MatchString(repo.Owner) || !namePart.MatchString(repo.Name) {
		return CI{}, errorf(KindInvalid, "Reading the CI", "No repository or commit to read the CI of.")
	}
	key := repo.FullName() + "@" + sha
	now := s.Now()
	s.ci.mu.Lock()
	if s.ci.runs == nil {
		s.ci.runs = map[string]ciEntry{}
	}
	e, have := s.ci.runs[key]
	s.ci.mu.Unlock()
	if have && now.Sub(e.at) < ciKeep(e.ci) {
		return e.ci, nil
	}
	if s.source() == "" {
		return CI{}, errorf(KindNotConnected, "Reading the CI", "GitHub is not connected.")
	}
	ci, ce := s.readCI(ctx, repo, sha, e.ci)
	if ce != nil {
		if have {
			e.ci.Error = ce
			return e.ci, nil
		}
		return CI{}, ce
	}
	s.ci.mu.Lock()
	if _, ok := s.ci.runs[key]; !ok && len(s.ci.runs) >= ciKept {
		var oldest string
		var at time.Time
		for k, v := range s.ci.runs {
			if oldest == "" || v.at.Before(at) {
				oldest, at = k, v.at
			}
		}
		delete(s.ci.runs, oldest)
	}
	s.ci.runs[key] = ciEntry{ci: ci, at: now}
	s.ci.mu.Unlock()
	return ci, nil
}

func ciKeep(ci CI) time.Duration {
	if ci.State == "running" {
		return ciRunning
	}
	return ciSettled
}

func (s *Service) readCI(ctx context.Context, repo Repo, sha string, prev CI) (CI, *Error) {
	doing := "Reading the GitHub Actions runs of " + repo.FullName()
	res, ce := s.call(ctx, request{method: http.MethodGet, doing: doing,
		path: fmt.Sprintf("%s/actions/runs?head_sha=%s&per_page=%d", repoPath(repo), url.QueryEscape(sha), ciRunsShown)})
	if ce != nil {
		return CI{}, ce
	}
	var list struct {
		Runs []apiRun `json:"workflow_runs"`
	}
	if de := decode(res, doing, &list); de != nil {
		return CI{}, de
	}
	out := CI{Repo: repo.FullName(), HeadSHA: sha, State: "none", ByOS: []CIOS{}, At: s.Now().UnixMilli()}
	out.Runs, out.Error = s.withJobs(ctx, repo, list.Runs, prev.Runs)
	settle(&out)
	out.Cost = s.priceCI(ctx, repo, out.Runs)
	return out, nil
}

// withJobs turns GitHub's runs into CIRuns with their jobs. A settled run
// whose update time and attempt are unchanged since prev keeps the jobs read
// then; a failed jobs read keeps them too, and is returned.
func (s *Service) withJobs(ctx context.Context, repo Repo, runs []apiRun, prev []CIRun) ([]CIRun, *Error) {
	before := map[int64]CIRun{}
	for _, r := range prev {
		before[r.ID] = r
	}
	out := make([]CIRun, 0, len(runs))
	var err *Error
	for _, ar := range runs {
		run := ar.run()
		old, ok := before[run.ID]
		if ok && run.Status == "completed" && old.Status == "completed" && old.UpdatedAt == run.UpdatedAt && old.Attempt == run.Attempt {
			run.Jobs = old.Jobs
		} else if jobs, je := s.readJobs(ctx, repo, run.ID); je != nil {
			if ok {
				run.Jobs = old.Jobs
			}
			err = je
		} else {
			run.Jobs = jobs
		}
		out = append(out, run)
	}
	return out, err
}

func (s *Service) readJobs(ctx context.Context, repo Repo, runID int64) ([]CIJob, *Error) {
	doing := "Reading the jobs of a GitHub Actions run of " + repo.FullName()
	res, ce := s.call(ctx, request{method: http.MethodGet, doing: doing, path: fmt.Sprintf("%s/actions/runs/%d/jobs?per_page=100", repoPath(repo), runID)})
	if ce != nil {
		return nil, ce
	}
	var list struct {
		Jobs []apiJob `json:"jobs"`
	}
	if de := decode(res, doing, &list); de != nil {
		return nil, de
	}
	out := make([]CIJob, 0, len(list.Jobs))
	for _, j := range list.Jobs {
		job := CIJob{ID: j.ID, RunID: j.RunID, Name: j.Name, Status: j.Status, Conclusion: j.Conclusion,
			StartedAt: unixMS(j.StartedAt), CompletedAt: unixMS(j.CompletedAt), Labels: j.Labels, OS: runnerOS(j.Labels),
			RunnerName: j.RunnerName, RunnerGroup: j.RunnerGroup, HTMLURL: j.HTMLURL, Steps: make([]CIStep, 0, len(j.Steps))}
		if job.Labels == nil {
			job.Labels = []string{}
		}
		if job.Status == "completed" {
			job.DurationMS = span(job.StartedAt, job.CompletedAt)
		}
		for _, st := range j.Steps {
			step := CIStep{Number: st.Number, Name: st.Name, Status: st.Status, Conclusion: st.Conclusion,
				StartedAt: unixMS(st.StartedAt), CompletedAt: unixMS(st.CompletedAt)}
			if step.Status == "completed" {
				step.DurationMS = span(step.StartedAt, step.CompletedAt)
			}
			job.Steps = append(job.Steps, step)
		}
		out = append(out, job)
	}
	return out, nil
}

// settle sums the runner time of the finished jobs and decides the state.
func settle(ci *CI) {
	byOS := map[string]int64{}
	running, failed := false, false
	for _, r := range ci.Runs {
		if r.Status != "completed" {
			running = true
		}
		for _, j := range r.Jobs {
			if j.Status != "completed" {
				running = true
				continue
			}
			ci.RunnerMS += j.DurationMS
			if j.DurationMS > 0 {
				os := j.OS
				if os == "" {
					os = "other"
				}
				byOS[os] += j.DurationMS
			}
		}
		switch r.Conclusion {
		case "failure", "timed_out", "startup_failure":
			failed = true
		}
	}
	for os, v := range byOS {
		ci.ByOS = append(ci.ByOS, CIOS{OS: os, MS: v})
	}
	sort.Slice(ci.ByOS, func(i, j int) bool { return ci.ByOS[i].MS > ci.ByOS[j].MS })
	switch {
	case running:
		ci.State = "running"
	case failed:
		ci.State = "fail"
	case len(ci.Runs) > 0:
		ci.State = "pass" // succeeded, or every run skipped, cancelled or neutral
	}
}

// JobLog is the end of one finished job's log: up to logBefore lines before
// its last "##[error]" line and logAfter after it, or the last lines when
// none is marked. GitHub answers the log request with a redirect to a signed
// address on its log storage; that address is fetched without the token (it
// carries its own signature), only over https, and only at the hosts GitHub
// keeps logs on (logHost). Kept for logKept: a finished log does not change.
func (s *Service) JobLog(ctx context.Context, repo Repo, jobID int64) (CILog, *Error) {
	s.init()
	doing := fmt.Sprintf("Reading the log of job %d of %s", jobID, repo.FullName())
	if jobID <= 0 || !namePart.MatchString(repo.Owner) || !namePart.MatchString(repo.Name) {
		return CILog{}, errorf(KindInvalid, doing, "No such job.")
	}
	key := fmt.Sprintf("%s#%d", repo.FullName(), jobID)
	now := s.Now()
	s.ci.mu.Lock()
	if s.ci.logs == nil {
		s.ci.logs = map[string]logEntry{}
	}
	e, have := s.ci.logs[key]
	s.ci.mu.Unlock()
	if have && now.Sub(e.at) < logKept {
		return e.log, nil
	}
	if s.source() == "" {
		return CILog{}, errorf(KindNotConnected, doing, "GitHub is not connected.")
	}
	where, ce := s.logLocation(ctx, repo, jobID, doing)
	if ce != nil {
		return CILog{}, ce
	}
	lines, errAt, truncated, ce := s.readLogTail(ctx, where, doing)
	if ce != nil {
		return CILog{}, ce
	}
	out := CILog{JobID: jobID, Lines: lines, ErrorLine: errAt, Truncated: truncated}
	s.ci.mu.Lock()
	if _, ok := s.ci.logs[key]; !ok && len(s.ci.logs) >= logsKept {
		var oldest string
		var at time.Time
		for k, v := range s.ci.logs {
			if oldest == "" || v.at.Before(at) {
				oldest, at = k, v.at
			}
		}
		delete(s.ci.logs, oldest)
	}
	s.ci.logs[key] = logEntry{log: out, at: now}
	s.ci.mu.Unlock()
	return out, nil
}

// noFollow is the service's HTTP client that hands a redirect back rather
// than following it.
func (s *Service) noFollow() *http.Client {
	hc := *s.HTTP
	hc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &hc
}

// logLocation asks the API where a job's log is, without following the
// redirect, so the token goes to the API host and nowhere else.
func (s *Service) logLocation(ctx context.Context, repo Repo, jobID int64, doing string) (string, *Error) {
	tok, src, e := s.token(ctx, doing)
	if e != nil {
		s.noteErr(e)
		return "", e
	}
	u := fmt.Sprintf("%s%s/actions/jobs/%d/logs", s.c.base, repoPath(repo), jobID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", errorf(KindInvalid, doing, "bad request: %v", err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "caprock")
	req.Header.Set("Authorization", "Bearer "+tok)
	res, err := s.noFollow().Do(req)
	if err != nil {
		return "", errorf(KindNetwork, doing, "could not reach GitHub (%s): %s", hostOf(u), netReason(err))
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	s.c.noteRate("core", res.Header)
	switch {
	case res.StatusCode >= 300 && res.StatusCode < 400:
		loc := res.Header.Get("Location")
		if !s.logHost(loc) {
			return "", errorf(KindGitHub, doing, "GitHub pointed the log to %s, which is not where it keeps logs; not followed", hostOf(loc))
		}
		s.noteOK()
		return loc, nil
	case res.StatusCode >= 200 && res.StatusCode < 300:
		return "", errorf(KindGitHub, doing, "GitHub answered without the log's address")
	case res.StatusCode == http.StatusGone:
		return "", &Error{Kind: KindNotFound, Status: res.StatusCode, Doing: doing, At: s.Now().UnixMilli(),
			Message: "GitHub no longer keeps this log (410): it has expired."}
	}
	ce := classify(res, body, doing, src, s.Now())
	s.noteErr(ce)
	return "", ce
}

// logHost reports whether a log address is one GitHub keeps logs at: over
// https on its Actions log hosts or the storage behind them, or, in tests,
// on the API host itself.
func (s *Service) logHost(loc string) bool {
	u, err := url.Parse(loc)
	if err != nil || u.Host == "" {
		return false
	}
	if base, err := url.Parse(s.c.base); err == nil && u.Scheme == base.Scheme && u.Host == base.Host {
		return true
	}
	if u.Scheme != "https" {
		return false
	}
	h := strings.ToLower(u.Hostname())
	return strings.HasSuffix(h, ".actions.githubusercontent.com") || strings.HasSuffix(h, ".blob.core.windows.net")
}

// readLogTail downloads a log from its signed address, with no token, and
// keeps the lines around its last error.
func (s *Service) readLogTail(ctx context.Context, where, doing string) ([]string, int, bool, *Error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, where, nil)
	if err != nil {
		return nil, -1, false, errorf(KindInvalid, doing, "bad log address: %v", err)
	}
	req.Header.Set("User-Agent", "caprock")
	res, err := s.noFollow().Do(req)
	if err != nil {
		return nil, -1, false, errorf(KindNetwork, doing, "could not download the log (%s): %s", hostOf(where), netReason(err))
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, -1, false, &Error{Kind: KindGitHub, Status: res.StatusCode, Doing: doing, At: s.Now().UnixMilli(),
			Message: fmt.Sprintf("GitHub's log storage answered %d.", res.StatusCode)}
	}
	lines, errAt := tailAroundError(io.LimitReader(res.Body, logReadMax))
	// One more byte means the log went on past what was read.
	var one [1]byte
	n, _ := res.Body.Read(one[:])
	return lines, errAt, n > 0, nil
}

// tailAroundError keeps the last logRing lines of r and returns the window
// around the last "##[error]" line among them (or the last lines when there
// is none), the runner's timestamps cut off and each line and the whole
// capped. The second result is the error line's index, -1 when none.
func tailAroundError(r io.Reader) ([]string, int) {
	ring := make([]string, 0, logRing)
	start := 0
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		line := cleanLogLine(sc.Text())
		if len(ring) < logRing {
			ring = append(ring, line)
		} else {
			ring[start] = line
			start = (start + 1) % logRing
		}
	}
	ordered := append(append([]string{}, ring[start:]...), ring[:start]...)
	errAt := -1
	for i := len(ordered) - 1; i >= 0; i-- {
		if strings.Contains(ordered[i], "##[error]") {
			errAt = i
			break
		}
	}
	from, to := max(0, len(ordered)-(logBefore+logAfter)), len(ordered)
	if errAt >= 0 {
		from, to = max(0, errAt-logBefore), min(len(ordered), errAt+logAfter+1)
		errAt -= from
	}
	out := ordered[from:to]
	// Cap the whole, dropping from the top so the end stays.
	total, cut := 0, len(out)
	for i := len(out) - 1; i >= 0; i-- {
		total += len(out[i]) + 1
		if total > logReturnMax {
			break
		}
		cut = i
	}
	out = out[cut:]
	if errAt >= 0 {
		errAt -= cut
		if errAt < 0 {
			errAt = -1
		}
	}
	return append([]string{}, out...), errAt
}

// cleanLogLine drops the runner's timestamp prefix and caps the length.
func cleanLogLine(s string) string {
	s = strings.TrimSuffix(s, "\r")
	s = strings.TrimPrefix(s, "\uFEFF")
	if len(s) > 28 && s[4] == '-' && s[10] == 'T' {
		if i := strings.IndexByte(s, ' '); i > 0 && i < 40 && s[i-1] == 'Z' {
			s = s[i+1:]
		}
	}
	if len(s) > logLineMax {
		cut := logLineMax
		for cut > 0 && s[cut]&0xC0 == 0x80 {
			cut--
		}
		s = s[:cut] + "…"
	}
	return s
}
