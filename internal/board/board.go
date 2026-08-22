// Package board is the Phase 2 task board: it bridges the hive's task files and
// mailboxes to the SQLite mirror and the API. It also answers the Stop hook to
// force a worker to keep going while its inbox is non-empty (the autonomy
// engine), with a hard per-(session,task) guard. See .ai/05-orchestration.md.
package board

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/hive"
	"github.com/dspv/caprock/internal/store"
)

// MaxForcedContinues is the Stop-loop guard: after this many forced continues
// for one (session, task), Caprock escalates to the human instead (default 10).
const MaxForcedContinues = 10

// noTaskCounterKey is the reserved task_id under which the forced-continue guard
// counts a session that owns no task — the orchestrator. Task ids are generated
// as `t-<ms>-<n>` and hive ids may not contain `/`, so this can never collide
// with a real one.
const noTaskCounterKey = "/no-task"

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

	// idMu guards idSeq, which disambiguates ids created in the same
	// millisecond — see Create.
	idMu  sync.Mutex
	idSeq int64
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

// maxTitle bounds a task title. Titles are rendered on the board and written
// into the task file; a hundred-thousand-character one was accepted before.
const maxTitle = 500

// maxBody bounds the task body — long enough for a real brief, short enough
// that one request cannot fill the hive directory.
const maxBody = 100 << 10

// validate rejects what the board cannot meaningfully hold. Everything here was
// accepted before: an empty title (an unnamed row on the board), a
// hundred-thousand-character one, a negative budget (which breaks every
// "budget left" comparison), and 1e308 (which overflows the moment anything is
// added to it).
//
// It also refuses a task with no done_criteria. Caprock's central claim is that
// nothing reaches Done until its done_criteria pass; a task with none is
// unverifiable, and accepting it meant the verifier passed it unconditionally.
// The check is here rather than only at verification because the earliest honest
// answer is the cheapest one: the user finds out while the form is open.
//
// A zero budget no longer silently means "unlimited". An unattended session with
// no ceiling is the unsafe default, so a task created without one gets
// DefaultBudgetUSD.
func (cr *CreateRequest) validate() error {
	cr.Title = strings.TrimSpace(cr.Title)
	criteria := make([]string, 0, len(cr.DoneCriteria))
	for _, c := range cr.DoneCriteria {
		if s := strings.TrimSpace(c); s != "" {
			criteria = append(criteria, s)
		}
	}
	cr.DoneCriteria = criteria
	switch {
	case cr.Title == "":
		return errors.New("task title is required")
	case len([]rune(cr.Title)) > maxTitle:
		return fmt.Errorf("task title is %d characters; the limit is %d", len([]rune(cr.Title)), maxTitle)
	case len(cr.Body) > maxBody:
		return fmt.Errorf("task body is %d bytes; the limit is %d", len(cr.Body), maxBody)
	case len(cr.DoneCriteria) == 0:
		return errors.New("done_criteria is required: at least one command that must pass before the task can be done. Caprock cannot verify a task without one, and will not mark it done on the worker's say-so")
	case math.IsNaN(cr.BudgetUSD) || math.IsInf(cr.BudgetUSD, 0):
		return errors.New("budget_usd must be a real number")
	case cr.BudgetUSD < 0:
		return fmt.Errorf("budget_usd is %v; a budget cannot be negative", cr.BudgetUSD)
	case cr.BudgetUSD > maxBudgetUSD:
		return fmt.Errorf("budget_usd is %v; the ceiling is %v", cr.BudgetUSD, maxBudgetUSD)
	}
	if cr.BudgetUSD == 0 {
		cr.BudgetUSD = DefaultBudgetUSD
	}
	return nil
}

// maxBudgetUSD is a sanity ceiling, not a policy: a five-figure budget on one
// task is a typo far more often than an intention.
const maxBudgetUSD = 100_000

// DefaultBudgetUSD is applied when a task is created without a budget. It is a
// stop, not a forecast: unattended sessions run with
// --dangerously-skip-permissions, and the previous default (0 ⇒ unlimited) meant
// a runaway worker had no ceiling at all. The safe default must be a finite one;
// $5 is small enough that hitting it is a pause a human notices rather than a
// bill they discover, and a user who wants more states it explicitly. It is not
// a claim about what a task costs (rule 6) — it is the ceiling Caprock enforces
// when the user named none.
const DefaultBudgetUSD = 5.0

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
	if err := cr.validate(); err != nil {
		return nil, err
	}
	if cr.ID == "" {
		// Millisecond precision alone collides: twelve concurrent creates
		// produced four tasks and eight "already exists" rejections, so a user
		// adding several at once silently lost most of them. The counter makes
		// the id unique within a millisecond.
		b.idMu.Lock()
		b.idSeq++
		seq := b.idSeq
		b.idMu.Unlock()
		cr.ID = fmt.Sprintf("t-%d-%d", b.Now().UnixMilli(), seq)
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
		// A cleared inbox is genuine progress, so the counter resets — for the
		// task-keyed counter and for the no-task one alike.
		_ = store.ResetForcedContinue(ctx, b.Store.DB(), sessionID, noTaskCounterKey)
		if taskID != "" {
			_ = store.ResetForcedContinue(ctx, b.Store.DB(), sessionID, taskID)
		}
		return nil
	}
	// The counter is keyed per (session, task). A session with no task — the
	// orchestrator, whose TaskForAgent is always "" — used to keep n at 1, so the
	// guard never tripped and one stuck escalation could pin an unattended
	// --dangerously-skip-permissions session in an unbounded forced-continue
	// loop. Bound it too, under a reserved key so it shares the same counter
	// table and the same limit.
	key := taskID
	if key == "" {
		key = noTaskCounterKey
	}
	n := 1
	if err := b.Store.WithTx(ctx, func(q store.Querier) error {
		var e error
		n, e = store.IncForcedContinue(ctx, q, sessionID, key)
		return e
	}); err != nil {
		b.Log.Warn("forced-continue counter", "component", "board", "err", err)
	}
	if n > MaxForcedContinues {
		b.Log.Warn("forced-continue guard tripped; escalating", "component", "board", "session_id", sessionID, "task_id", taskID, "agent_id", agentID, "count", n)
		if taskID != "" {
			// moveTo walks a legal route instead of guarding one hop with
			// CanTransition and silently dropping it when illegal. The old guard
			// left an `assigned` task exactly where it was: the status change
			// vanished, the task stayed live, and the router kept the worker
			// alive and kept waking it — the same silent-no-op bug moveTo was
			// written to kill.
			if t, err := b.moveTo(taskID, hive.StatusNeedsYou, nil); err == nil {
				_ = b.mirror(ctx, t)
			} else {
				b.Log.Warn("forced-continue escalation could not move task", "component", "board", "task", taskID, "err", err)
			}
		} else {
			// No task to park (the orchestrator). Tell the human directly, so an
			// exhausted guard is visible rather than just a session that stopped.
			_, _ = b.Hive.Send(hive.Message{From: hive.VerifierAgentID, To: orchestratorAgentID, Kind: hive.KindEscalation,
				Body: fmt.Sprintf("Agent %s (session %s) hit the forced-continue limit of %d with mail it never cleared. Caprock stopped forcing it to continue; its inbox needs a human.", agentID, sessionID, MaxForcedContinues)})
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
	if t.Assignee != "" {
		// An assigned task is verified in ITS worker's worktree, or not at all.
		// Falling back to RepoCwd here was the subtler half of the wrong-directory
		// defect: RepoCwd exists, so nothing downstream could tell that the
		// agent's worktree had vanished — the checks ran against a clean main
		// repo and the task passed for work that was never inspected. An empty
		// cwd reaches Verify, which escalates rather than verifying.
		cwd = ""
		if b.RepoCwd != "" {
			if wt := WorktreePath(b.RepoCwd, t.Assignee); dirExists(wt) {
				cwd = wt
			}
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
