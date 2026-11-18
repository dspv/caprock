package github

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/config"
)

// Rerun jobs GitHub never ran (owner, 2026-11-18): an opt-in switch in
// Settings → GitHub. While it is on, the daemon itself re-runs the failed
// jobs of a run whose only non-passing jobs got no runner (norunner.go) —
// the request the deck's Rerun button sends, with the same token — when it
// meets such a run in what it already reads: a followed or a session's open
// pull request's checks, a commit's runs, the default branch's newest runs
// and the newest release run. A release run is re-run like any other: it is
// what a click on Rerun would do, and a release whose job never ran is not
// built.
//
// Once per run, ever: the run and the attempt it re-ran are written down
// (<data_dir>/ci-auto-rerun.json) before GitHub is asked, so a restart, a
// second reader or a failed request never asks again, and an attempt that is
// starved again is shown and left to the user. Off by default: it is a write
// to the user's repositories that no click asked for (rule 4, ADR-047).

const (
	// autoRerunKept bounds the runs remembered; the oldest go first.
	autoRerunKept = 256
	// autoRerunWithin: a run that ended longer ago than this is left alone,
	// so turning the switch on does not revive an old commit's CI.
	autoRerunWithin = 6 * time.Hour
	// autoRerunWaited: a job GitHub gave up on waited for a machine (~15
	// minutes in the cases measured on 2026-11-18). One that ended sooner
	// was more likely cancelled by someone, and is not undone.
	autoRerunWaited = 10 * time.Minute
)

// AutoRerun is Caprock's own re-run of a run's jobs GitHub never ran, as a
// run or a pull request's checks carry it.
type AutoRerun struct {
	// Attempt is the run attempt that got no runner and was re-run.
	Attempt int `json:"attempt"`
	// At is when Caprock asked GitHub (unix ms).
	At int64 `json:"at"`
	// Jobs is how many jobs it asked to run again.
	Jobs int `json:"jobs"`
	// Error is why GitHub refused; it is not asked again.
	Error string `json:"error,omitempty"`
	// Again is set when the re-run attempt also got no runner: Caprock does
	// not re-run a run twice, so it is the user's to re-run.
	Again bool `json:"again,omitempty"`
}

// autoRerunRec is one remembered re-run, as the file keeps it.
type autoRerunRec struct {
	Repo    string `json:"repo"`
	RunID   int64  `json:"run_id"`
	Attempt int    `json:"attempt"`
	At      int64  `json:"at"`
	Jobs    int    `json:"jobs"`
	Error   string `json:"error,omitempty"`
}

type autoRerunFile struct {
	Runs []autoRerunRec `json:"runs"`
}

// autoReruns keeps the re-runs done, by "owner/name#run".
type autoReruns struct {
	mu     sync.Mutex
	loaded bool
	m      map[string]autoRerunRec
}

func rerunKey(repo string, run int64) string {
	return strings.ToLower(repo) + "#" + fmt.Sprint(run)
}

// rerunsLocked reads the file once; the caller holds s.reruns.mu.
func (s *Service) rerunsLocked() map[string]autoRerunRec {
	r := &s.reruns
	if r.loaded {
		return r.m
	}
	r.loaded, r.m = true, map[string]autoRerunRec{}
	if s.AutoRerunFile == "" {
		return r.m
	}
	b, err := os.ReadFile(s.AutoRerunFile)
	if err != nil {
		return r.m
	}
	var f autoRerunFile
	if json.Unmarshal(b, &f) != nil {
		return r.m
	}
	for _, x := range f.Runs {
		r.m[rerunKey(x.Repo, x.RunID)] = x
	}
	return r.m
}

// saveRerunsLocked writes the file; the caller holds s.reruns.mu.
func (s *Service) saveRerunsLocked() error {
	m := s.reruns.m
	all := make([]autoRerunRec, 0, len(m))
	for _, x := range m {
		all = append(all, x)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].At > all[j].At })
	if len(all) > autoRerunKept {
		for _, x := range all[autoRerunKept:] {
			delete(m, rerunKey(x.Repo, x.RunID))
		}
		all = all[:autoRerunKept]
	}
	if s.AutoRerunFile == "" {
		return nil
	}
	b, err := json.MarshalIndent(autoRerunFile{Runs: all}, "", "  ")
	if err != nil {
		return err
	}
	return config.WriteFileAtomic(s.AutoRerunFile, b, 0o600)
}

// autoRerunOn reports whether the switch is on.
func (s *Service) autoRerunOn() bool {
	return s.Config != nil && s.Config.AutoRerun()
}

// SetAutoRerun switches the daemon's re-run of jobs GitHub never ran.
func (s *Service) SetAutoRerun(on bool) (Status, error) {
	s.init()
	if err := s.Config.SetAutoRerun(on); err != nil {
		return Status{}, err
	}
	// Every window's switch (Settings, and beside each Rerun) follows.
	s.publishAccount()
	return s.Status(), nil
}

// starvedRun reports whether Caprock may re-run r by itself: it finished
// without passing, every job that did not pass got no runner, one of those
// waited for a machine, and it ended within autoRerunWithin of now.
func starvedRun(r CIRun, now time.Time) bool {
	if r.ID == 0 || !failedRun(r) || !noRunnerOnly(r) {
		return false
	}
	if r.UpdatedAt == 0 || now.Sub(time.UnixMilli(r.UpdatedAt)) > autoRerunWithin {
		return false
	}
	for _, j := range r.Jobs {
		if j.NoRunner && j.StartedAt > 0 && j.CompletedAt-j.StartedAt >= autoRerunWaited.Milliseconds() {
			return true
		}
	}
	return false
}

// autoRerun re-runs, once per run, the failed jobs of each of runs that
// starvedRun allows, while the switch is on. The run is written down before
// GitHub is asked, so a failed request or a restart never asks twice.
func (s *Service) autoRerun(ctx context.Context, repo Repo, runs []CIRun) {
	if !s.autoRerunOn() || len(runs) == 0 {
		return
	}
	now := s.Now()
	for _, r := range runs {
		if !starvedRun(r, now) {
			continue
		}
		key := rerunKey(repo.FullName(), r.ID)
		jobs := 0
		for _, j := range r.Jobs {
			if failedJob(j) {
				jobs++
			}
		}
		rec := autoRerunRec{Repo: repo.FullName(), RunID: r.ID, Attempt: r.Attempt, At: now.UnixMilli(), Jobs: jobs}
		s.reruns.mu.Lock()
		m := s.rerunsLocked()
		if _, done := m[key]; done {
			s.reruns.mu.Unlock()
			continue
		}
		m[key] = rec
		err := s.saveRerunsLocked()
		s.reruns.mu.Unlock()
		if err != nil {
			// Not written down, so not asked: a restart could ask again.
			s.logWarn("github: keeping an automatic re-run failed", "repo", repo.FullName(), "run", r.ID, "err", err)
			s.reruns.mu.Lock()
			delete(s.reruns.m, key)
			s.reruns.mu.Unlock()
			continue
		}
		if e := s.rerunFailedJobs(ctx, repo, r.ID); e != nil {
			s.reruns.mu.Lock()
			rec.Error = e.Message
			s.reruns.m[key] = rec
			_ = s.saveRerunsLocked()
			s.reruns.mu.Unlock()
			s.logWarn("github: an automatic re-run was refused", "repo", repo.FullName(), "run", r.ID, "err", e.Message)
		} else {
			s.logInfo("github: re-ran the jobs GitHub never ran", "repo", repo.FullName(), "run", r.ID, "attempt", r.Attempt, "jobs", jobs)
		}
		s.forgetRepoCI(repo, r.ID)
	}
}

// rerunFailedJobs is the deck's Rerun request for one run
// (POST …/actions/runs/{id}/rerun-failed-jobs), with the same token.
func (s *Service) rerunFailedJobs(ctx context.Context, repo Repo, runID int64) *Error {
	const doing = "Re-running the jobs GitHub never ran"
	tok, src, e := s.token(ctx, doing)
	if e != nil {
		return e
	}
	path := fmt.Sprintf("%s/actions/runs/%d/rerun-failed-jobs", repoPath(repo), runID)
	if _, ce := s.c.do(ctx, request{method: http.MethodPost, path: path, body: map[string]any{}, doing: doing, token: tok, source: src}); ce != nil {
		return needsFor(ce, rerunNeeds)
	}
	return nil
}

// forgetRepoCI drops what is kept of a repository's CI — the commits whose
// runs include run, its default branch and release answers, its pull
// requests read by link — so the next read shows the re-run queued.
func (s *Service) forgetRepoCI(repo Repo, run int64) {
	prefix := repo.FullName() + "@"
	s.ci.mu.Lock()
	for k, e := range s.ci.runs {
		if !strings.HasPrefix(k, prefix) {
			continue
		}
		for _, r := range e.ci.Runs {
			if r.ID == run {
				delete(s.ci.runs, k)
				break
			}
		}
	}
	s.ci.mu.Unlock()
	s.forgetPulls(repo)
	s.repoCI.mu.Lock()
	s.repoCI.lazy()
	delete(s.repoCI.release, repo.FullName())
	for k := range s.repoCI.main {
		if strings.HasPrefix(k, prefix) {
			delete(s.repoCI.main, k)
		}
	}
	s.repoCI.mu.Unlock()
}

// rerunOf is Caprock's re-run of a run, nil when it did not re-run it.
func (s *Service) rerunOf(repo string, runID int64) *AutoRerun {
	s.reruns.mu.Lock()
	defer s.reruns.mu.Unlock()
	x, ok := s.rerunsLocked()[rerunKey(repo, runID)]
	if !ok {
		return nil
	}
	return &AutoRerun{Attempt: x.Attempt, At: x.At, Jobs: x.Jobs, Error: x.Error}
}

// markRuns returns runs with AutoRerun set on those Caprock re-ran; the
// slice is a copy, so a kept answer is never written to.
func (s *Service) markRuns(repo string, runs []CIRun) []CIRun {
	var out []CIRun
	for i, r := range runs {
		a := s.rerunOf(repo, r.ID)
		if a == nil {
			continue
		}
		if out == nil {
			out = append([]CIRun(nil), runs...)
		}
		a.Again = a.Error == "" && r.Attempt > a.Attempt && failedRun(r) && noRunnerOnly(r)
		out[i].AutoRerun = a
	}
	if out == nil {
		return runs
	}
	return out
}

// markChecks sets AutoRerun on a pull request's checks when Caprock re-ran a
// run they belong to (the newest such re-run). Again is a check of that run
// that got no runner after it.
func (s *Service) markChecks(repo string, c *Checks) {
	c.AutoRerun = nil
	for _, it := range c.Items {
		run := runOf(it.URL)
		if run == 0 {
			continue
		}
		a := s.rerunOf(repo, run)
		if a == nil || (c.AutoRerun != nil && c.AutoRerun.At >= a.At) {
			continue
		}
		c.AutoRerun = a
	}
	if c.AutoRerun == nil || c.AutoRerun.Error != "" {
		return
	}
	for _, it := range c.Items {
		if it.NoRunner && it.CompletedAt > c.AutoRerun.At {
			c.AutoRerun.Again = true
		}
	}
}

// autoRerunChecks is the pull request poll's part: an open pull request
// whose checks say no_runner has its commit's runs read (CIBySHA, kept) and
// re-run when they allow. Then the checks are marked.
// It reports whether GitHub was asked to re-run anything.
func (s *Service) autoRerunChecks(ctx context.Context, repo Repo, sha string, open bool, c *Checks) bool {
	asked := false
	if open && c.State == "no_runner" && s.autoRerunOn() {
		before := s.rerunCount()
		if ci, e := s.CIBySHA(ctx, repo, sha); e == nil {
			// CIBySHA re-runs on a fresh read; a kept one is offered here.
			s.autoRerun(ctx, repo, ci.Runs)
		}
		asked = s.rerunCount() != before
	}
	s.markChecks(repo.FullName(), c)
	return asked
}

// rerunCount is how many re-runs are remembered.
func (s *Service) rerunCount() int {
	s.reruns.mu.Lock()
	defer s.reruns.mu.Unlock()
	return len(s.rerunsLocked())
}

func (s *Service) logWarn(msg string, args ...any) {
	if s.Log != nil {
		s.Log.Warn(msg, append([]any{"component", "github"}, args...)...)
	}
}

func (s *Service) logInfo(msg string, args ...any) {
	if s.Log != nil {
		s.Log.Info(msg, append([]any{"component", "github"}, args...)...)
	}
}
