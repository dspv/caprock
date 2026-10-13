package github

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"
)

// A run's and each job's time against what they usually take (owner,
// 2026-10-12, translated: "In CI runs I want to see the execution time plus
// an estimate relative to the average — plus or minus percent"). The basis is
// the median of the same workflow's last successful runs on the same
// repository, and of each job by its name within them; fewer than
// baselineMin samples is no baseline at all, never a guessed one (rule 6).
const (
	// baselineRuns is how many past successful runs of a workflow are read, at most.
	baselineRuns = 5
	// baselineMin is the fewest samples a median is made from.
	baselineMin = 2
	// baselineListKept is how long a workflow's list of past successful runs is reused.
	baselineListKept = 30 * time.Minute
	// baselineJobsKept bounds the finished runs whose jobs are kept. A
	// completed run's jobs never change, so they are kept for the daemon's
	// lifetime, the oldest read dropped first once full.
	baselineJobsKept = 256
	// baselineWorkflowsKept bounds the workflows whose past runs are kept.
	baselineWorkflowsKept = 64
)

type baselineList struct {
	runs []CIRun // the past successful runs, newest first, without jobs
	at   time.Time
}

type baselineJobs struct {
	jobs []CIJob
	at   time.Time
}

// baselineCache keeps, per workflow, its last successful runs, and per
// finished run, its jobs.
type baselineCache struct {
	mu    sync.Mutex
	lists map[string]baselineList
	jobs  map[string]baselineJobs
}

// WithBaselines returns runs with Baseline set on each run and each job that
// has one: the median of the workflow's last baselineRuns successful runs
// (other than the runs shown), read once per workflow per baselineListKept;
// the jobs of a finished run are read once. The runs given are not changed.
// Without GitHub, or when a read fails, the runs come back as they were: a
// missing baseline is no figure, not an error. Called only by the deck's
// routes, so nothing is asked while the deck is closed.
func (s *Service) WithBaselines(ctx context.Context, repo Repo, runs []CIRun) []CIRun {
	s.init()
	if len(runs) == 0 || !namePart.MatchString(repo.Owner) || !namePart.MatchString(repo.Name) || s.source() == "" {
		return runs
	}
	shown := map[int64]bool{}
	for _, r := range runs {
		shown[r.ID] = true
	}
	out := make([]CIRun, len(runs))
	past := map[int64][]CIRun{}
	for i, r := range runs {
		// Never nil: a run GitHub lists no jobs for yet is `"jobs": []`, not
		// null, which the dashboard reads as a list and the app crashed on.
		r.Jobs = append([]CIJob{}, r.Jobs...)
		if r.WorkflowID != 0 {
			p, ok := past[r.WorkflowID]
			if !ok {
				p = s.pastRuns(ctx, repo, r.WorkflowID, shown)
				past[r.WorkflowID] = p
			}
			applyBaseline(&r, p)
		}
		out[i] = r
	}
	return out
}

// pastRuns is the workflow's newest baselineRuns successful runs, other than
// those shown, each with its jobs.
func (s *Service) pastRuns(ctx context.Context, repo Repo, workflow int64, shown map[int64]bool) []CIRun {
	key := fmt.Sprintf("%s#%d", repo.FullName(), workflow)
	s.baseline.mu.Lock()
	if s.baseline.lists == nil {
		s.baseline.lists = map[string]baselineList{}
		s.baseline.jobs = map[string]baselineJobs{}
	}
	l, have := s.baseline.lists[key]
	s.baseline.mu.Unlock()
	if !have || s.Now().Sub(l.at) >= baselineListKept {
		doing := "Reading past runs of a workflow of " + repo.FullName()
		// A few more than needed: the runs shown may be among them.
		list, ce := s.listRuns(ctx, fmt.Sprintf("%s/actions/workflows/%d/runs?status=success&per_page=%d", repoPath(repo), workflow, baselineRuns+3), doing)
		if ce != nil {
			if !have {
				return nil
			}
		} else {
			l = baselineList{at: s.Now()}
			for _, ar := range list {
				if ar.Status == "completed" && ar.Conclusion == "success" {
					l.runs = append(l.runs, ar.run())
				}
			}
			s.baseline.mu.Lock()
			if _, ok := s.baseline.lists[key]; !ok && len(s.baseline.lists) >= baselineWorkflowsKept {
				dropOldest(s.baseline.lists, func(v baselineList) time.Time { return v.at })
			}
			s.baseline.lists[key] = l
			s.baseline.mu.Unlock()
		}
	}
	out := []CIRun{}
	for _, r := range l.runs {
		if len(out) == baselineRuns {
			break
		}
		if shown[r.ID] {
			continue
		}
		jobs, ok := s.finishedJobs(ctx, repo, r.ID)
		if !ok {
			continue
		}
		r.Jobs = jobs
		out = append(out, r)
	}
	return out
}

// finishedJobs is a completed run's jobs, read from GitHub once and kept.
func (s *Service) finishedJobs(ctx context.Context, repo Repo, runID int64) ([]CIJob, bool) {
	key := fmt.Sprintf("%s#%d", repo.FullName(), runID)
	s.baseline.mu.Lock()
	e, have := s.baseline.jobs[key]
	s.baseline.mu.Unlock()
	if have {
		return e.jobs, true
	}
	jobs, ce := s.readJobs(ctx, repo, runID)
	if ce != nil {
		return nil, false
	}
	s.baseline.mu.Lock()
	if len(s.baseline.jobs) >= baselineJobsKept {
		dropOldest(s.baseline.jobs, func(v baselineJobs) time.Time { return v.at })
	}
	s.baseline.jobs[key] = baselineJobs{jobs: jobs, at: s.Now()}
	s.baseline.mu.Unlock()
	return jobs, true
}

func dropOldest[V any](m map[string]V, at func(V) time.Time) {
	var oldest string
	var t time.Time
	for k, v := range m {
		if oldest == "" || at(v).Before(t) {
			oldest, t = k, at(v)
		}
	}
	delete(m, oldest)
}

// applyBaseline sets the run's baseline (its wall-clock span, run_started_at
// to updated_at) and each job's (its duration, by name, over the past jobs
// that succeeded).
func applyBaseline(r *CIRun, past []CIRun) {
	spans := []int64{}
	byName := map[string][]int64{}
	for _, p := range past {
		if d := span(p.StartedAt, p.UpdatedAt); d > 0 {
			spans = append(spans, d)
		}
		for _, j := range p.Jobs {
			if j.Conclusion == "success" && j.DurationMS > 0 {
				byName[j.Name] = append(byName[j.Name], j.DurationMS)
			}
		}
	}
	r.Baseline = medianOf(spans)
	for i := range r.Jobs {
		r.Jobs[i].Baseline = medianOf(byName[r.Jobs[i].Name])
	}
}

// medianOf is the median of xs with the count it is made from; nil with
// fewer than baselineMin.
func medianOf(xs []int64) *CIEstimate {
	if len(xs) < baselineMin {
		return nil
	}
	v := append([]int64(nil), xs...)
	sort.Slice(v, func(i, j int) bool { return v[i] < v[j] })
	m := v[len(v)/2]
	if len(v)%2 == 0 {
		m = (v[len(v)/2-1] + v[len(v)/2]) / 2
	}
	return &CIEstimate{MedianMS: m, Runs: len(v)}
}
