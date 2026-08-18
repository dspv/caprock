// Package board is the Phase 2 task board: it bridges the hive's task files and
// mailboxes to the SQLite mirror and the API. It also answers the Stop hook to
// force a worker to keep going while its inbox is non-empty (the autonomy
// engine), with a hard per-(session,task) guard. See .ai/05-orchestration.md.
package board

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/hive"
	"github.com/dspv/caprock/internal/store"
)

// MaxForcedContinues is the Stop-loop guard: after this many forced continues
// for one (session, task), Caprock escalates to the human instead (default 10).
const MaxForcedContinues = 10

// Board wires the hive, store mirror and bus.
type Board struct {
	Hive  *hive.Hive
	Store *store.Store
	Bus   *bus.Bus
	Log   *slog.Logger
	Now   func() time.Time
	// RepoCwd is the repo tasks operate on; verification commands run in the
	// assigned worker's worktree under it, or in RepoCwd when there is no worktree.
	RepoCwd string
}

// New builds a board.
func dirExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

func New(h *hive.Hive, st *store.Store, b *bus.Bus, log *slog.Logger) *Board {
	if log == nil {
		log = slog.Default()
	}
	return &Board{Hive: h, Store: st, Bus: b, Log: log, Now: time.Now}
}

// CreateRequest is the POST /v1/tasks body.
type CreateRequest struct {
	ID           string   `json:"id"`
	Title        string   `json:"title"`
	BudgetUSD    float64  `json:"budget_usd"`
	DoneCriteria []string `json:"done_criteria"`
	Body         string   `json:"body"`
}

// List returns the mirrored task rows.
func (b *Board) List(ctx context.Context) (any, error) {
	rows, err := store.ListTasks(ctx, b.Store.DB())
	if err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []store.TaskRow{}
	}
	return rows, nil
}

// Get returns one mirrored task plus its hive body.
func (b *Board) Get(ctx context.Context, id string) (any, error) {
	row, err := store.GetTask(ctx, b.Store.DB(), id)
	if err != nil {
		return nil, err
	}
	t, herr := b.Hive.GetTask(id)
	body := ""
	if herr == nil {
		body = t.Body
	}
	return map[string]any{"task": row, "body": body}, nil
}

// Create writes a task to the hive and mirrors it.
func (b *Board) Create(ctx context.Context, req any) (any, error) {
	var cr CreateRequest
	raw, _ := json.Marshal(req)
	if err := json.Unmarshal(raw, &cr); err != nil {
		return nil, err
	}
	if cr.ID == "" {
		cr.ID = fmt.Sprintf("t-%d", b.Now().UnixMilli())
	}
	t := hive.Task{ID: cr.ID, Title: cr.Title, Status: hive.StatusInbox, BudgetUSD: cr.BudgetUSD, DoneCriteria: cr.DoneCriteria, Body: cr.Body}
	if err := b.Hive.CreateTask(t); err != nil {
		return nil, err
	}
	if err := b.mirror(ctx, t); err != nil {
		return nil, err
	}
	return b.Get(ctx, cr.ID)
}

// Approve/reject a task in the needs-you column, feeding the decision back to the
// orchestrator via a mailbox message.
func (b *Board) Approve(ctx context.Context, id string, approve bool) error {
	t, err := b.Hive.GetTask(id)
	if err != nil {
		return err
	}
	if t.Status != hive.StatusNeedsYou {
		return fmt.Errorf("task %s is not awaiting approval (status %s)", id, t.Status)
	}
	to := hive.StatusInProgress
	if !approve {
		to = hive.StatusFailed
	}
	updated, err := b.Hive.UpdateTask(id, func(x *hive.Task) error { x.Status = to; return nil })
	if err != nil {
		return err
	}
	// Tell the orchestrator.
	_, _ = b.Hive.Send(hive.Message{From: "human", To: "orchestrator", Kind: hive.KindResult, TaskID: id,
		Body: fmt.Sprintf("Approval decision for %s: %s", id, map[bool]string{true: "approved", false: "rejected"}[approve])})
	return b.mirror(ctx, updated)
}

// Approvals lists tasks in the needs-you column.
func (b *Board) Approvals(ctx context.Context) (any, error) {
	rows, err := store.ListTasks(ctx, b.Store.DB())
	if err != nil {
		return nil, err
	}
	out := []store.TaskRow{}
	for _, r := range rows {
		if r.Status == hive.StatusNeedsYou {
			out = append(out, r)
		}
	}
	return out, nil
}

// StopDecision answers a worker's Stop hook: block (force continue) while the
// worker's inbox is non-empty and the guard is not exhausted; else allow the
// stop. Returns the JSON body to relay to Claude Code, or nil to allow.
func (b *Board) StopDecision(ctx context.Context, sessionID, agentID, taskID string) []byte {
	if agentID == "" {
		return nil // top-level session, not a managed worker
	}
	if b.Hive.InboxCount(agentID) == 0 {
		if taskID != "" {
			_ = store.ResetForcedContinue(ctx, b.Store.DB(), sessionID, taskID)
		}
		return nil
	}
	n := 1
	if taskID != "" {
		var err error
		if err = b.Store.WithTx(ctx, func(q store.Querier) error {
			var e error
			n, e = store.IncForcedContinue(ctx, q, sessionID, taskID)
			return e
		}); err != nil {
			b.Log.Warn("forced-continue counter", "component", "board", "err", err)
		}
	}
	if n > MaxForcedContinues {
		b.Log.Warn("forced-continue guard tripped; escalating", "component", "board", "session_id", sessionID, "task_id", taskID, "count", n)
		if taskID != "" {
			if t, err := b.Hive.UpdateTask(taskID, func(x *hive.Task) error {
				if hive.CanTransition(x.Status, hive.StatusNeedsYou) {
					x.Status = hive.StatusNeedsYou
				}
				return nil
			}); err == nil {
				_ = b.mirror(ctx, t)
			}
		}
		return nil // allow the stop; the human takes over
	}
	reason := fmt.Sprintf("You have %d unread message(s) in your inbox — process them before stopping.", b.Hive.InboxCount(agentID))
	body, _ := json.Marshal(map[string]any{
		"hookSpecificOutput": map[string]any{"hookEventName": "Stop", "decision": "block", "reason": reason},
	})
	return body
}

// VerifyTask (controller entry) resolves the worktree for the assigned worker
// and runs verification.
func (b *Board) VerifyTask(ctx context.Context, id string) (VerifyResult, error) {
	t, err := b.Hive.GetTask(id)
	if err != nil {
		return VerifyResult{}, err
	}
	cwd := b.RepoCwd
	if t.Assignee != "" && b.RepoCwd != "" {
		if wt := WorktreePath(b.RepoCwd, t.Assignee); dirExists(wt) {
			cwd = wt
		}
	}
	return b.Verify(ctx, id, cwd)
}

// mirror upserts a hive task into SQLite and publishes a live frame.
func (b *Board) mirror(ctx context.Context, t hive.Task) error {
	if err := store.UpsertTask(ctx, b.Store.DB(), store.TaskRow{
		ID: t.ID, Title: t.Title, Status: t.Status, Assignee: t.Assignee, BudgetUSD: t.BudgetUSD, VerifyRounds: t.VerifyRoundsUsed,
	}); err != nil {
		return err
	}
	if b.Bus != nil {
		b.Bus.Publish(bus.Frame{Type: "task", Data: t})
	}
	return nil
}

// Rescan rebuilds the SQLite task mirror from the hive files (source of truth).
func (b *Board) Rescan(ctx context.Context) error {
	tasks, err := b.Hive.ListTasks()
	if err != nil {
		return err
	}
	for _, t := range tasks {
		if err := b.mirror(ctx, t); err != nil {
			return err
		}
	}
	return nil
}
