package api

import (
	"testing"

	"github.com/dspv/caprock/internal/github"
)

// A pull request whose only non-passing check is a job GitHub never gave a
// machine is not put in fix: its card says ci no_runner, names no failed
// check, and its macOS dot is no_runner, not fail. A real failure beside it
// still puts it in fix, naming only the real one.
func TestBoardNoRunner(t *testing.T) {
	idle := github.Check{Name: "go (macos-latest)", State: "fail", NoRunner: true, StartedAt: 1000, CompletedAt: 2000}
	ok := github.Check{Name: "go (ubuntu-latest)", State: "pass", StartedAt: 1000, CompletedAt: 1500}
	p := github.BranchPR{Number: 941, State: "open", CreatedAt: 500}
	live := github.PR{Number: 941, State: "open", Checks: github.Checks{State: "no_runner", Passed: 1, NoRunner: 1, Items: []github.Check{idle, ok}}}
	var c BoardCard
	stage, _ := openStage(p, live, nil, &c)
	if stage != StageOpen || c.CI != "no_runner" || c.Why != "" || len(c.Failed) != 0 {
		t.Fatalf("stage %q, card %+v", stage, c)
	}
	for _, o := range c.OS {
		if o.OS == "macos" && o.State != "no_runner" || o.OS == "linux" && o.State != "pass" {
			t.Fatalf("os: %+v", c.OS)
		}
	}

	bad := github.Check{Name: "go (windows-latest)", State: "fail", StartedAt: 1000, CompletedAt: 1800}
	live.Checks = github.Checks{State: "fail", Passed: 1, Failed: 1, NoRunner: 1, Items: []github.Check{idle, ok, bad}}
	c = BoardCard{}
	stage, _ = openStage(p, live, nil, &c)
	if stage != StageFix || c.Why != "ci" || len(c.Failed) != 1 || c.Failed[0] != "go (windows-latest)" {
		t.Fatalf("mixed: stage %q, card %+v", stage, c)
	}
}
