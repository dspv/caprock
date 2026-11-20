package daemon

import (
	"testing"

	"github.com/dspv/caprock/internal/store"
)

// A shell tab is named after the session whose process is its foreground
// job — the owner's "claude --resume <id>" typed into the shell a dead
// session's tab became (2026-11-20) — the newest when a /clear left two on
// one process, and after nothing when no live session is in the job.
func TestAgentInJob(t *testing.T) {
	groups := map[int]int{101: 100, 201: 200, 202: 200}
	in := func(pid, job int) bool { return groups[pid] == job }
	live := []store.LivePID{ // newest first, as store.LivePIDs lists them
		{SessionID: "after-clear", PID: 201},
		{SessionID: "other-terminal", PID: 101},
		{SessionID: "before-clear", PID: 202},
	}
	if got := agentInJob(live, 200, in); got != "after-clear" {
		t.Errorf("job 200 = %q, want after-clear", got)
	}
	if got := agentInJob(live, 100, in); got != "other-terminal" {
		t.Errorf("job 100 = %q, want other-terminal", got)
	}
	if got := agentInJob(live, 300, in); got != "" {
		t.Errorf("a job no session is in = %q, want nothing", got)
	}
	if got := agentInJob(nil, 200, in); got != "" {
		t.Errorf("no live sessions = %q, want nothing", got)
	}
}
