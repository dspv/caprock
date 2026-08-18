package board

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/hive"
	"github.com/dspv/caprock/internal/store"
)

// orchestratorAgentID is the hive id of the orchestrator (mirror of
// orchestrator.OrchestratorID; duplicated to avoid an import cycle).
const orchestratorAgentID = "orchestrator"

// MaxVerifyRounds is the verification-bounce guard (default 3): after this many
// failed rounds a task escalates to needs_you instead of bouncing again.
const MaxVerifyRounds = 3

// VerifyCommandTimeout bounds a single done_criteria command.
const VerifyCommandTimeout = 5 * time.Minute

// VerifyResult reports the outcome of running a task's done_criteria.
type VerifyResult struct {
	TaskID    string       `json:"task_id"`
	Round     int          `json:"round"`
	Passed    bool         `json:"passed"`
	Commands  []CommandRun `json:"commands"`
	Status    string       `json:"status"` // the task's new status
	Escalated bool         `json:"escalated"`
}

// CommandRun is one done_criteria command's result.
type CommandRun struct {
	Command  string `json:"command"`
	ExitCode int    `json:"exit_code"`
	Output   string `json:"output"`
	Passed   bool   `json:"passed"`
}

// Verify runs a task's done_criteria in the worker's worktree. All green ⇒ the
// task moves to done. Any red ⇒ it bounces back to the worker with the failing
// output (up to MaxVerifyRounds, then it escalates to needs_you). Cwd is the
// directory the commands run in (the worker's worktree, or the repo).
func (b *Board) Verify(ctx context.Context, taskID, cwd string) (VerifyResult, error) {
	t, err := b.Hive.GetTask(taskID)
	if err != nil {
		return VerifyResult{}, err
	}
	res := VerifyResult{TaskID: taskID, Round: t.VerifyRoundsUsed + 1}
	// Destructive-command policy: never run a dangerous command unattended —
	// escalate to the human instead (.ai/05-orchestration.md § Approvals).
	if flagged := ScreenDoneCriteria(t.DoneCriteria); len(flagged) > 0 {
		updated, err := b.Hive.UpdateTask(taskID, func(x *hive.Task) error {
			if hive.CanTransition(x.Status, hive.StatusNeedsYou) {
				x.Status = hive.StatusNeedsYou
			}
			return nil
		})
		if err != nil {
			return res, err
		}
		res.Status = updated.Status
		res.Escalated = true
		_, _ = b.Hive.Send(hive.Message{From: "verifier", To: orchestratorAgentID, Kind: hive.KindEscalation, TaskID: taskID,
			Body: "Task " + taskID + " has a destructive command in its done_criteria and needs human approval before it runs:\n" + strings.Join(flagged, "\n")})
		_ = b.mirror(ctx, updated)
		return res, nil
	}
	if len(t.DoneCriteria) == 0 {
		// No criteria to check: trust the worker, move to done.
		res.Passed = true
	} else {
		res.Passed = true
		for _, cmd := range t.DoneCriteria {
			run := b.runCommand(ctx, cmd, cwd)
			res.Commands = append(res.Commands, run)
			_ = store.RecordVerification(ctx, b.Store.DB(), taskID, res.Round, cmd, run.ExitCode, "")
			if !run.Passed {
				res.Passed = false
			}
		}
	}

	if res.Passed {
		updated, err := b.Hive.UpdateTask(taskID, func(x *hive.Task) error {
			if x.Status != hive.StatusVerifying {
				// Only a verifying task can be marked done; force the legal step.
				if hive.CanTransition(x.Status, hive.StatusVerifying) {
					x.Status = hive.StatusVerifying
				}
			}
			x.Status = hive.StatusDone
			return nil
		})
		if err != nil {
			return res, err
		}
		res.Status = updated.Status
		if updated.Assignee != "" {
			_ = store.CloseAssignment(ctx, b.Store.DB(), taskID, updated.Assignee, b.Now().UnixMilli())
			_, _ = store.AttributeTaskCost(ctx, b.Store.DB(), taskID)
		}
		_ = b.mirror(ctx, updated)
		return res, nil
	}

	// Failed: bounce or escalate.
	updated, err := b.Hive.UpdateTask(taskID, func(x *hive.Task) error {
		x.VerifyRoundsUsed = res.Round
		if res.Round >= MaxVerifyRounds {
			if hive.CanTransition(x.Status, hive.StatusNeedsYou) {
				x.Status = hive.StatusNeedsYou
			}
		} else if hive.CanTransition(x.Status, hive.StatusInProgress) {
			x.Status = hive.StatusInProgress
		}
		return nil
	})
	if err != nil {
		return res, err
	}
	res.Status = updated.Status
	res.Escalated = updated.Status == hive.StatusNeedsYou
	// Bounce the failing output back to the assigned worker (or escalate to human).
	to := updated.Assignee
	kind := hive.KindResult
	if res.Escalated {
		to, kind = orchestratorAgentID, hive.KindEscalation
	}
	if to != "" {
		_, _ = b.Hive.Send(hive.Message{From: "verifier", To: to, Kind: kind, TaskID: taskID, Body: formatFailure(res)})
	}
	_ = b.mirror(ctx, updated)
	return res, nil
}

// runCommand runs one done_criteria command through the platform shell, bounded
// by VerifyCommandTimeout, capturing combined output.
func (b *Board) runCommand(ctx context.Context, command, cwd string) CommandRun {
	cctx, cancel := context.WithTimeout(ctx, VerifyCommandTimeout)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(cctx, "cmd", "/C", command)
	} else {
		cmd = exec.CommandContext(cctx, "/bin/sh", "-c", command)
	}
	if cwd != "" {
		if fi, err := os.Stat(cwd); err == nil && fi.IsDir() {
			cmd.Dir = cwd
		}
	}
	cmd.Env = append(os.Environ(), "CI=1")
	var buf bytes.Buffer
	cmd.Stdout, cmd.Stderr = &buf, &buf
	err := cmd.Run()
	run := CommandRun{Command: command, Output: capOutput(buf.String())}
	if err == nil {
		run.Passed, run.ExitCode = true, 0
		return run
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		run.ExitCode = ee.ExitCode()
	} else {
		run.ExitCode = -1
		run.Output += "\n[runner error: " + err.Error() + "]"
	}
	return run
}

func capOutput(s string) string {
	const max = 16 << 10
	if len(s) <= max {
		return s
	}
	return s[len(s)-max:] // tail is where the failure usually is
}

func formatFailure(res VerifyResult) string {
	var b bytes.Buffer
	fmt.Fprintf(&b, "Verification round %d failed for %s. Fix these and report done again:\n\n", res.Round, res.TaskID)
	for _, c := range res.Commands {
		status := "PASS"
		if !c.Passed {
			status = fmt.Sprintf("FAIL (exit %d)", c.ExitCode)
		}
		fmt.Fprintf(&b, "$ %s\n[%s]\n", c.Command, status)
		if !c.Passed {
			fmt.Fprintf(&b, "%s\n\n", c.Output)
		}
	}
	if res.Escalated {
		b.WriteString("\nThis task has exhausted its verification rounds and is escalated to the human.\n")
	}
	return b.String()
}

// WorktreePath returns the worktree dir for a worker under the repo, matching
// how the orchestrator's worker spawn creates it.
func WorktreePath(repo, workerID string) string {
	return filepath.Join(repo, ".caprock-worktrees", workerID)
}
