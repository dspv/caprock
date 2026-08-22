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

// orchestratorAgentID is the hive id of the orchestrator (shared constant in the
// hive package, so board and orchestrator agree without an import cycle).
const orchestratorAgentID = hive.OrchestratorAgentID

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
	// Unverifiable is true when the task could not be checked at all (no
	// done_criteria, or no worktree to run them in). It never means "passed":
	// the task is parked in needs_you for the human.
	Unverifiable bool `json:"unverifiable,omitempty"`
}

// CommandRun is one done_criteria command's result.
type CommandRun struct {
	Command  string `json:"command"`
	ExitCode int    `json:"exit_code"`
	Output   string `json:"output"`
	Passed   bool   `json:"passed"`
	// OutputPath is the file the full captured output was written to, so a green
	// result can be audited after the fact (`Output` is tail-capped for the UI).
	OutputPath string `json:"output_path,omitempty"`
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
		updated, err := b.moveTo(taskID, hive.StatusNeedsYou, nil)
		if err != nil {
			return res, err
		}
		res.Status = updated.Status
		res.Escalated = true
		_, _ = b.Hive.Send(hive.Message{From: hive.VerifierAgentID, To: orchestratorAgentID, Kind: hive.KindEscalation, TaskID: taskID,
			Body: "Task " + taskID + " has a destructive command in its done_criteria and needs human approval before it runs:\n" + strings.Join(flagged, "\n")})
		_ = b.mirror(ctx, updated)
		return res, nil
	}
	// Unverifiable is never verified. A task with no done_criteria cannot be
	// checked, so it must not reach `done` on the worker's say-so — that was the
	// hole under the product's central claim ("nothing reaches Done until its
	// done_criteria pass"). Creation now rejects an empty criteria list, so this
	// path is only reachable for a task hand-written into the hive or created
	// before this rule; it escalates to the human rather than silently passing.
	if len(t.DoneCriteria) == 0 {
		updated, err := b.moveTo(taskID, hive.StatusNeedsYou, nil)
		if err != nil {
			return res, err
		}
		res.Status = updated.Status
		res.Escalated = true
		res.Unverifiable = true
		_, _ = b.Hive.Send(hive.Message{From: hive.VerifierAgentID, To: orchestratorAgentID, Kind: hive.KindEscalation, TaskID: taskID,
			Body: "Task " + taskID + " has no done_criteria, so Caprock cannot verify it. It is parked for your decision: add criteria and send it back, or approve it yourself."})
		_ = b.mirror(ctx, updated)
		return res, nil
	}
	// Verification runs in the worker's worktree. A cwd that is not a directory
	// (a missing or removed worktree) would silently fall back to the daemon's
	// own working directory — verifying a clean main repo instead of the agent's
	// work, which passes for the wrong reason. Unverifiable is never verified.
	if err := checkCwd(cwd); err != nil {
		updated, merr := b.moveTo(taskID, hive.StatusNeedsYou, nil)
		if merr != nil {
			return res, merr
		}
		res.Status = updated.Status
		res.Escalated = true
		res.Unverifiable = true
		_, _ = b.Hive.Send(hive.Message{From: hive.VerifierAgentID, To: orchestratorAgentID, Kind: hive.KindEscalation, TaskID: taskID,
			Body: "Task " + taskID + " cannot be verified: " + err.Error() + ". Its done_criteria were NOT run."})
		_ = b.mirror(ctx, updated)
		return res, nil
	}
	res.Passed = true
	for _, cmd := range t.DoneCriteria {
		run := b.runCommand(ctx, cmd, cwd)
		res.Commands = append(res.Commands, run)
		// Persist the command's output so a human can audit a green result: a
		// pass with no evidence is indistinguishable from a pass that never ran.
		// The path is what .ai/05-orchestration.md already promised the
		// `verifications` row carries.
		outPath, werr := b.writeVerificationOutput(taskID, res.Round, len(res.Commands)-1, run)
		if werr != nil {
			b.Log.Warn("write verification output", "component", "board", "task", taskID, "err", werr)
		}
		run.OutputPath = outPath
		res.Commands[len(res.Commands)-1] = run
		_ = store.RecordVerification(ctx, b.Store.DB(), taskID, res.Round, cmd, run.ExitCode, outPath)
		if !run.Passed {
			res.Passed = false
		}
	}

	if res.Passed {
		updated, err := b.moveTo(taskID, hive.StatusDone, nil)
		if err != nil {
			return res, err
		}
		res.Status = updated.Status
		// Mirror first: AttributeTaskCost writes cost onto the tasks row, and
		// UpsertTask does not carry cost_usd, so attributing before mirroring
		// loses the number whenever the row is not there yet.
		_ = b.mirror(ctx, updated)
		// Close every open assignment window on this task and sum its cost.
		// Windows are keyed by session id (what AttributeTaskCost joins events
		// on); the board only knows the agent id, so it closes by task.
		_ = store.CloseTaskAssignments(ctx, b.Store.DB(), taskID, b.Now().UnixMilli())
		if _, err := store.AttributeTaskCost(ctx, b.Store.DB(), taskID); err != nil {
			b.Log.Warn("attribute task cost", "component", "board", "task", taskID, "err", err)
		}
		return res, nil
	}

	// Failed: bounce or escalate.
	target := hive.StatusInProgress
	if res.Round >= MaxVerifyRounds {
		target = hive.StatusNeedsYou
	}
	updated, err := b.moveTo(taskID, target, func(x *hive.Task) { x.VerifyRoundsUsed = res.Round })
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
		_, _ = b.Hive.Send(hive.Message{From: hive.VerifierAgentID, To: to, Kind: kind, TaskID: taskID, Body: formatFailure(res)})
	}
	_ = b.mirror(ctx, updated)
	return res, nil
}

// OverBudget parks a task that outspent its budget in needs_you and records why,
// so the approvals column shows a reason rather than an unexplained pause. The
// reason is appended to the task body (which the UI already renders) rather than
// added as a column — no DDL, and it survives in the hive file, which is the
// source of truth. Re-parking an already-parked task is a no-op.
func (b *Board) OverBudget(ctx context.Context, taskID, reason string) error {
	t, err := b.Hive.GetTask(taskID)
	if err != nil {
		return err
	}
	if t.Status == hive.StatusNeedsYou {
		return nil // already awaiting the human
	}
	updated, err := b.moveTo(taskID, hive.StatusNeedsYou, func(x *hive.Task) {
		if !strings.Contains(x.Body, reason) {
			x.Body = strings.TrimRight(x.Body, "\n") + "\n\n> **Over budget.** " + reason + "\n"
		}
	})
	if err != nil {
		return err
	}
	return b.mirror(ctx, updated)
}

// moveTo walks a task to `target` one legal step at a time, applying `mut` on
// the first step. Guarding a single hop with CanTransition and skipping it when
// illegal is what stranded tasks: verification called from a status the
// orchestrator never advanced (say `inbox`) silently no-opped, and the next
// verify then hard-errored on `inbox → done`. Walking the route always lands the
// task somewhere the board can act on; a genuinely unreachable target (only
// `done`, which is terminal) is an error the caller surfaces rather than a
// silent no-op.
func (b *Board) moveTo(taskID, target string, mut func(*hive.Task)) (hive.Task, error) {
	var last hive.Task
	cur, err := b.Hive.GetTask(taskID)
	if err != nil {
		return last, err
	}
	route := hive.TransitionRoute(cur.Status, target)
	if route == nil {
		return last, fmt.Errorf("hive: task %s cannot reach %s from %s", taskID, target, cur.Status)
	}
	first := true
	apply := func(step string) error {
		var err error
		last, err = b.Hive.UpdateTask(taskID, func(x *hive.Task) error {
			if first && mut != nil {
				mut(x)
			}
			first = false
			x.Status = step
			return nil
		})
		return err
	}
	if len(route) == 0 { // already there: still apply mut
		return last, apply(target)
	}
	for _, step := range route {
		if err := apply(step); err != nil {
			return last, err
		}
	}
	return last, nil
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
	// Never fall back to the daemon's working directory: a command that was meant
	// to check an agent's worktree must not silently check whatever the daemon
	// happens to sit in. Verify() screens cwd before calling this, so reaching
	// here with a bad one is a bug — fail the command rather than run it blind.
	if err := checkCwd(cwd); err != nil {
		return CommandRun{Command: command, ExitCode: -1, Output: "[" + err.Error() + "]"}
	}
	cmd.Dir = cwd
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

// checkCwd reports why a verification directory cannot be used. An empty cwd is
// as bad as a missing one: both would run the commands wherever the daemon was
// launched, which is not the code under test.
func checkCwd(cwd string) error {
	if cwd == "" {
		return errors.New("no directory to verify in (the task has no worktree and the daemon has no repo cwd)")
	}
	fi, err := os.Stat(cwd)
	if err != nil {
		return fmt.Errorf("verification directory %s is unavailable: %w", cwd, err)
	}
	if !fi.IsDir() {
		return fmt.Errorf("verification directory %s is not a directory", cwd)
	}
	return nil
}

// VerificationOutputDir is where captured done_criteria output is persisted,
// under the hive so it lives with the task files it explains.
func (b *Board) VerificationOutputDir(taskID string) string {
	return filepath.Join(b.Hive.Root, "verifications", taskID)
}

// writeVerificationOutput persists one command's full output and returns its
// path (the `output_path` column .ai/05-orchestration.md documents). A green
// verification with no stored evidence cannot be audited, which is the whole
// point of verification-before-done.
func (b *Board) writeVerificationOutput(taskID string, round, idx int, run CommandRun) (string, error) {
	dir := b.VerificationOutputDir(taskID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, fmt.Sprintf("round-%d-cmd-%d.log", round, idx))
	header := fmt.Sprintf("$ %s\nexit: %d\n\n", run.Command, run.ExitCode)
	if err := os.WriteFile(path, []byte(header+run.Output), 0o644); err != nil {
		return "", err
	}
	return path, nil
}
