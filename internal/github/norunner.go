package github

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"sync"
)

// A job GitHub never ran (measured 2026-11-18 on this repository: 11 in 3
// days): a hosted macOS job waits ~15 minutes for a machine, then ends
// cancelled or failed with no step run and no runner assigned, its only
// annotation "The job was not acquired by Runner of type hosted even after
// multiple attempts". Its code was never tested, so it is not a failure of
// the code; a re-run of the failed jobs has always fixed it. Such a job is
// "no runner": the deck draws it apart from a real failure, offers the
// re-run, and a run or a set of checks whose only non-passing jobs are no
// runner is not counted as failed.

// noRunner reports whether a job ended without GitHub ever giving it a
// machine: completed, failed or cancelled, with no step run and no runner.
func noRunner(conclusion string, steps, runnerID int, runnerName string) bool {
	if conclusion != "failure" && conclusion != "cancelled" {
		return false
	}
	return steps == 0 && runnerID == 0 && runnerName == ""
}

// noRunnerKept bounds the job verdicts kept (a finished job never changes;
// a re-run makes new job ids).
const noRunnerKept = 512

// noRunnerCache keeps whether a finished job had no runner, by job id.
type noRunnerCache struct {
	mu sync.Mutex
	m  map[int64]bool
}

func (c *noRunnerCache) get(id int64) (bool, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.m[id]
	return v, ok
}

func (c *noRunnerCache) put(id int64, v bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil {
		c.m = map[int64]bool{}
	}
	if _, ok := c.m[id]; !ok && len(c.m) >= noRunnerKept {
		for k := range c.m { // any one: a dropped verdict is only read again
			delete(c.m, k)
			break
		}
	}
	c.m[id] = v
}

var runLink = regexp.MustCompile(`/actions/runs/([0-9]+)/job/[0-9]+`)

// runOf is the Actions run id in a check run's link, 0 when it names none.
func runOf(link string) int64 {
	m := runLink.FindStringSubmatch(link)
	if m == nil {
		return 0
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return 0
	}
	return n
}

// markNoRunner sets NoRunner on the failed or cancelled Actions checks of a
// commit whose job GitHub never ran. A verdict comes, in order, from the
// ones kept by job id, from the commit's runs when they are kept
// (CIBySHA's), and only then from GitHub: one read of the jobs of each run
// that has such a check (…/actions/runs/{id}/jobs), never one per job, and
// none at all for checks that passed or are still going. A read that fails
// leaves the checks as failed, as they were before this existed.
func (s *Service) markNoRunner(ctx context.Context, repo Repo, sha string, items []Check, conclusions []string) {
	ask := map[int64][]int{} // run id -> indexes of its checks with no verdict yet
	for i := range items {
		c := &items[i]
		if c.JobID == 0 || c.State != "fail" || (conclusions[i] != "failure" && conclusions[i] != "cancelled") {
			continue
		}
		if v, ok := s.noRun.get(c.JobID); ok {
			c.NoRunner = v
			continue
		}
		if run := runOf(c.URL); run != 0 {
			ask[run] = append(ask[run], i)
		}
	}
	if len(ask) == 0 {
		return
	}
	// The commit's runs, when CIBySHA keeps them: no call.
	s.ci.mu.Lock()
	kept, have := s.ci.runs[repo.FullName()+"@"+sha]
	s.ci.mu.Unlock()
	if have {
		for _, r := range kept.ci.Runs {
			for _, j := range r.Jobs {
				if j.Status == "completed" {
					s.noRun.put(j.ID, j.NoRunner)
				}
			}
		}
	}
	for run, idx := range ask {
		missing := false
		for _, i := range idx {
			if v, ok := s.noRun.get(items[i].JobID); ok {
				items[i].NoRunner = v
			} else {
				missing = true
			}
		}
		if !missing {
			continue
		}
		jobs, e := s.readRunJobs(ctx, repo, run)
		if e != nil {
			continue
		}
		for _, j := range jobs {
			if j.Status == "completed" {
				s.noRun.put(j.ID, j.NoRunner)
			}
		}
		for _, i := range idx {
			v, ok := s.noRun.get(items[i].JobID)
			if !ok {
				// GitHub did not list it: it stays failed, and is not asked again.
				s.noRun.put(items[i].JobID, false)
			}
			items[i].NoRunner = v
		}
	}
}

// readRunJobs reads every attempt's jobs of one run (filter=all, so a job of
// an earlier attempt that the checks still name is listed too).
func (s *Service) readRunJobs(ctx context.Context, repo Repo, runID int64) ([]CIJob, *Error) {
	return s.jobsAt(ctx, repo, fmt.Sprintf("%s/actions/runs/%d/jobs?filter=all&per_page=100", repoPath(repo), runID))
}

// noRunnerOnly reports whether a finished run that did not pass failed only
// because GitHub gave some of its jobs no machine: every job that did not
// pass or get skipped is no runner, and there is at least one.
func noRunnerOnly(r CIRun) bool {
	n := 0
	for _, j := range r.Jobs {
		switch {
		case j.NoRunner:
			n++
		case j.Status != "completed":
			return false
		case j.Conclusion == "success" || j.Conclusion == "skipped" || j.Conclusion == "neutral":
		default:
			return false
		}
	}
	return n > 0
}
