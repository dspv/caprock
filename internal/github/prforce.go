package github

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

// The session deck's force actions on a pull request (owner, 2026-10-12,
// translated: "if needed I want to FORCE a fix or a check"): re-run its
// checks, and bring its branch up to date with its base. Both are writes to
// the user's own repository with the user's own token, asked by a click and
// a confirm, never by a poll (rule 4). A refusal names the permission the
// token lacks, as the Actions usage line does, and does not mark the health
// line: a read-only token is not a broken connection.

// Documented permissions, said when GitHub's answer names none.
var (
	rerunNeeds  = []string{`"Actions" repository permission (write), for a fine-grained token`, `"repo" scope, for a classic token`}
	updateNeeds = []string{`"Pull requests" repository permission (write), for a fine-grained token`, `"repo" scope, for a classic token`}
)

// Rerun is what re-running a commit's checks asked GitHub to do.
type Rerun struct {
	// Mode is failed (only the failed jobs of the runs that failed) or all
	// (every job of every finished run, when none failed: a flaky green).
	Mode string `json:"mode"`
	Runs int    `json:"runs"`
	// Jobs is how many jobs GitHub was asked to run again.
	Jobs int `json:"jobs"`
}

// failedRun is a finished run that did not pass.
func failedRun(r CIRun) bool {
	if r.Status != "completed" {
		return false
	}
	switch r.Conclusion {
	case "failure", "cancelled", "timed_out", "startup_failure":
		return true
	}
	return false
}

// failedJob is a job that did not pass: what rerun-failed-jobs runs again.
func failedJob(j CIJob) bool {
	switch j.Conclusion {
	case "failure", "cancelled", "timed_out":
		return true
	}
	return false
}

// RerunChecks runs a commit's GitHub Actions again: the failed jobs of every
// finished run that failed (POST …/actions/runs/{id}/rerun-failed-jobs),
// else, when none failed, every finished run whole (…/rerun). A run still
// going is left alone: GitHub refuses to re-run one. The commit's kept runs
// and its pull requests are forgotten, so the next poll shows them queued.
func (s *Service) RerunChecks(ctx context.Context, repo Repo, sha string) (Rerun, *Error) {
	s.init()
	const doing = "Re-running the checks"
	if sha == "" || !namePart.MatchString(repo.Owner) || !namePart.MatchString(repo.Name) {
		return Rerun{}, errorf(KindInvalid, doing, "No repository or commit to re-run the checks of.")
	}
	tok, src, e := s.token(ctx, doing)
	if e != nil {
		return Rerun{}, e
	}
	s.forgetCI(repo, sha)
	ci, e := s.CIBySHA(ctx, repo, sha)
	if e != nil {
		return Rerun{}, e
	}
	out := Rerun{Mode: "failed"}
	var pick []CIRun
	for _, r := range ci.Runs {
		if failedRun(r) {
			pick = append(pick, r)
		}
	}
	if len(pick) == 0 {
		out.Mode = "all"
		for _, r := range ci.Runs {
			if r.Status == "completed" {
				pick = append(pick, r)
			}
		}
	}
	if len(pick) == 0 {
		if len(ci.Runs) == 0 {
			return Rerun{}, errorf(KindState, doing, "There are no GitHub Actions runs on this commit to re-run.")
		}
		return Rerun{}, errorf(KindState, doing, "Every run on this commit is still going; GitHub re-runs a run only once it has finished.")
	}
	for _, r := range pick {
		path := fmt.Sprintf("%s/actions/runs/%d/rerun", repoPath(repo), r.ID)
		if out.Mode == "failed" {
			path += "-failed-jobs"
		}
		_, ce := s.c.do(ctx, request{method: http.MethodPost, path: path, body: map[string]any{}, doing: doing, token: tok, source: src})
		if ce != nil {
			if out.Runs > 0 {
				// Some went: say what did, and why the rest did not.
				ce.Message = fmt.Sprintf("%d of %d runs were re-run; then: %s", out.Runs, len(pick), ce.Message)
			}
			s.forgetCI(repo, sha)
			return out, needsFor(ce, rerunNeeds)
		}
		out.Runs++
		n := 0
		for _, j := range r.Jobs {
			if out.Mode == "all" || failedJob(j) {
				n++
			}
		}
		out.Jobs += n
	}
	s.forgetCI(repo, sha)
	s.forgetPulls(repo)
	return out, nil
}

// UpdateBranch brings a pull request's branch up to date with its base, the
// way GitHub's own "Update branch" button does (PUT …/pulls/{n}/update-branch,
// a merge commit of the base into the head). expectedHead guards against a
// push made since the deck last read the pull request: GitHub refuses then.
// A conflict is GitHub's to refuse too; the deck offers this only without one.
func (s *Service) UpdateBranch(ctx context.Context, repo Repo, number int, expectedHead string) *Error {
	s.init()
	doing := fmt.Sprintf("Updating the branch of pull request #%d", number)
	if number <= 0 || !namePart.MatchString(repo.Owner) || !namePart.MatchString(repo.Name) {
		return errorf(KindInvalid, doing, "No pull request to update.")
	}
	tok, src, e := s.token(ctx, doing)
	if e != nil {
		return e
	}
	body := map[string]any{}
	if expectedHead != "" {
		body["expected_head_sha"] = expectedHead
	}
	_, ce := s.c.do(ctx, request{method: http.MethodPut, path: fmt.Sprintf("%s/pulls/%d/update-branch", repoPath(repo), number), body: body, doing: doing, token: tok, source: src})
	s.forgetPulls(repo)
	if ce != nil {
		if ce.Kind == KindInvalid && strings.Contains(strings.ToLower(ce.Message), "expected head sha") {
			ce.Message = "The branch moved since Caprock last read it; nothing was changed. Try again once the deck shows the new head."
		}
		return needsFor(ce, updateNeeds)
	}
	return nil
}

// needsFor names the documented permission on a refusal that named none.
func needsFor(ce *Error, needs []string) *Error {
	if (ce.Kind == KindScope || ce.Kind == KindForbidden) && len(ce.Needs) == 0 {
		ce.Kind = KindScope
		ce.Needs = needs
	}
	return ce
}

// forgetCI drops a commit's kept runs, so the next read asks GitHub.
func (s *Service) forgetCI(repo Repo, sha string) {
	s.ci.mu.Lock()
	delete(s.ci.runs, repo.FullName()+"@"+sha)
	s.ci.mu.Unlock()
}

// forgetPulls drops the kept pull requests of a repository read by link, so
// the next poll sees what a force action changed.
func (s *Service) forgetPulls(repo Repo) {
	prefix := "https://github.com/" + strings.ToLower(repo.FullName()) + "/pull/"
	s.byURL.mu.Lock()
	for k := range s.byURL.m {
		if strings.HasPrefix(strings.ToLower(k), prefix) {
			delete(s.byURL.m, k)
		}
	}
	s.byURL.mu.Unlock()
}
