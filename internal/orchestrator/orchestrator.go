package orchestrator

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/hive"
	"github.com/dspv/caprock/internal/store"
)

// OrchestratorID is the fixed hive agent id for the orchestrator session.
const OrchestratorID = hive.OrchestratorAgentID

// Spawner is the subset of agents.Manager the orchestrator needs.
type Spawner interface {
	Spawn(ctx context.Context, req agents.SpawnRequest) (*agents.Agent, error)
	Get(sessionID string) (*agents.Agent, bool)
	ClaudeAvailable() bool
	// Input writes typed bytes into an owned session's PTY (the kick message).
	Input(sessionID string, data []byte) error
}

// Orchestrator owns the orchestrator session and the worker fleet, and runs the
// mailbox router on a tick.
type Orchestrator struct {
	Hive    *hive.Hive
	Store   *store.Store
	Spawner Spawner
	Log     *slog.Logger
	// PromptFile is the path the orchestrator system prompt is written to for
	// --append-system-prompt-file (defaults to <hive>/.orchestrator-prompt.md).
	PromptFile string
	// Cwd is the repo the orchestrator and workers operate on.
	Cwd string
	// RouterTick is how often mail is delivered (default 2s).
	RouterTick time.Duration
	// KickDelay is how long to wait for the freshly-spawned TUI to be ready for
	// input before writing the kick message (default 2500ms).
	KickDelay time.Duration
	// Verify runs a task's done_criteria and moves it out of `verifying`
	// (→ done | in_progress | needs_you). Injected by the daemon as a closure over
	// board.VerifyTask so the orchestrator need not import board. nil ⇒
	// verification is driven elsewhere (or disabled in tests).
	Verify func(ctx context.Context, taskID string) error
	// OverBudget moves a task that outspent its budget to needs_you and mirrors
	// it, with the reason attached. Injected by the daemon as a closure over
	// board.OverBudget for the same reason as Verify (the board owns the mirror
	// and the bus, and importing it here would cycle). nil ⇒ the router does the
	// hive-side move itself, without a mirror.
	OverBudget func(ctx context.Context, taskID, reason string) error
	// WakeThrottle bounds how often an idle session is re-kicked to process new
	// mail (default 20s), so a still-working agent is not spammed every tick.
	WakeThrottle time.Duration
	// Now returns the current time (overridable in tests).
	Now func() time.Time
	// BaseCtx is the daemon-lifetime context the router and kick goroutines run
	// under. It must NOT be the per-request context passed to Start — that is
	// cancelled the instant the HTTP handler returns, which would kill the router
	// immediately. The daemon sets this to its run context. If nil, Start falls
	// back to a non-cancellable copy of the Start context.
	BaseCtx context.Context

	mu           sync.Mutex
	orchestrator string               // orchestrator session id, "" if not running
	starting     bool                 // a spawn is in flight (guards the Start TOCTOU)
	workers      map[string]string    // hive agent id → session id
	kicked       bool                 // the orchestrator's kick message was sent once
	verifying    map[string]bool      // task ids with an in-flight verification
	lastWake     map[string]time.Time // agent id → last wake re-kick time
}

func (o *Orchestrator) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now()
}

// New builds an orchestrator.
func New(h *hive.Hive, st *store.Store, sp Spawner, cwd string, log *slog.Logger) *Orchestrator {
	if log == nil {
		log = slog.Default()
	}
	return &Orchestrator{Hive: h, Store: st, Spawner: sp, Log: log, Cwd: cwd, RouterTick: 2 * time.Second, workers: map[string]string{}}
}

// Start registers the orchestrator agent, spawns its session with the hive-aware
// system prompt, and begins the router loop. Returns the session id.
func (o *Orchestrator) Start(ctx context.Context) (string, error) {
	if !o.Spawner.ClaudeAvailable() {
		return "", fmt.Errorf("orchestrator: claude binary not found; cannot spawn")
	}
	// Idempotent, and safe against a double "Start" click: if an orchestrator
	// session is already live — or a spawn is in flight — do not spawn a second
	// one (which would leak the first and start a second router loop racing the
	// first on the same hive). Instead re-kick the existing session so it re-reads
	// its inbox and picks up newly-queued tasks. The `starting` flag closes the
	// check-then-spawn race: two concurrent calls cannot both pass the guard.
	o.mu.Lock()
	existing := o.orchestrator
	live := false
	if existing != "" {
		_, live = o.Spawner.Get(existing)
	}
	if live || o.starting {
		o.mu.Unlock()
		if live {
			bg := o.BaseCtx
			if bg == nil {
				bg = context.WithoutCancel(ctx)
			}
			go o.wake(bg, existing, kickMessage)
			o.Log.Info("orchestrator already running; re-kicked", "component", "orchestrator", "session_id", existing)
			return existing, nil
		}
		return "", fmt.Errorf("orchestrator: a start is already in progress")
	}
	o.starting = true
	o.mu.Unlock()
	// From here on, clear `starting` on every exit path.
	defer func() {
		o.mu.Lock()
		o.starting = false
		o.mu.Unlock()
	}()
	home := filepath.Join(o.Hive.Root, "agents", OrchestratorID)
	if err := o.Hive.RegisterAgent(OrchestratorID, "# Orchestrator\n"); err != nil {
		return "", err
	}
	promptPath := o.PromptFile
	if promptPath == "" {
		promptPath = filepath.Join(o.Hive.Root, ".orchestrator-prompt.md")
	}
	if err := writeFile(promptPath, SystemPrompt(home)); err != nil {
		return "", err
	}
	ag, err := o.Spawner.Spawn(ctx, agents.SpawnRequest{
		Cwd: o.Cwd,
		// Autonomous: no human to answer the trust-folder / permission prompts, so
		// skip them. The user opts into this by starting the orchestrator.
		Args: []string{"--dangerously-skip-permissions", "--append-system-prompt-file", promptPath, "--add-dir", o.Hive.Root},
	})
	if err != nil {
		return "", fmt.Errorf("orchestrator: spawn: %w", err)
	}
	o.mu.Lock()
	o.orchestrator = ag.SessionID
	o.mu.Unlock()
	// Background loops must outlive the request that started them; use the
	// daemon-lifetime context, never the per-request ctx.
	bg := o.BaseCtx
	if bg == nil {
		bg = context.WithoutCancel(ctx)
	}
	go o.routerLoop(bg)
	go o.kick(bg, ag.SessionID)
	o.Log.Info("orchestrator started", "component", "orchestrator", "session_id", ag.SessionID, "hive", o.Hive.Root)
	return ag.SessionID, nil
}

// kickMessage is the single start signal handed to the freshly-spawned
// orchestrator TUI. It is declarative (state lives in the hive), so a stray
// re-send is harmless — it just re-reads the inbox. One line only: an embedded
// newline would submit the message early in the TUI.
const kickMessage = "Read your inbox now. List every open task in the hive, assign each to a worker, then monitor their result messages; verify with the task's done_criteria before anything is marked done. Start immediately and never stop while your inbox has unread mail."

// kick waits for the spawned TUI to settle, then writes the start message once.
// The orchestrator is otherwise a normal interactive Claude session waiting for
// human input; this is the one synthetic "type this and press Enter" that boots
// the autonomous loop (thereafter the Stop hook keeps it going).
func (o *Orchestrator) kick(ctx context.Context, sessionID string) {
	delay := o.KickDelay
	if delay == 0 {
		delay = 2500 * time.Millisecond
	}
	select {
	case <-ctx.Done():
		return
	case <-time.After(delay):
	}
	o.mu.Lock()
	if o.kicked || o.orchestrator != sessionID {
		o.mu.Unlock()
		return
	}
	o.kicked = true
	o.mu.Unlock()
	if err := o.Spawner.Input(sessionID, []byte(kickMessage)); err != nil {
		o.Log.Warn("orchestrator kick: write text", "component", "orchestrator", "err", err)
		return
	}
	// A separate carriage return submits it. Splitting the write avoids the TUI
	// swallowing the Enter as part of a paste burst.
	select {
	case <-ctx.Done():
		return
	case <-time.After(120 * time.Millisecond):
	}
	if err := o.Spawner.Input(sessionID, []byte("\r")); err != nil {
		o.Log.Warn("orchestrator kick: submit", "component", "orchestrator", "err", err)
		return
	}
	o.Log.Info("orchestrator kicked", "component", "orchestrator", "session_id", sessionID)
}

// SpawnWorker registers a worker in the hive and spawns its session. Idempotent
// per worker id: if already running, returns the existing session.
func (o *Orchestrator) SpawnWorker(ctx context.Context, workerID string) (string, error) {
	o.mu.Lock()
	if sid, ok := o.workers[workerID]; ok {
		if _, live := o.Spawner.Get(sid); live {
			o.mu.Unlock()
			return sid, nil
		}
	}
	o.mu.Unlock()
	if err := o.Hive.RegisterAgent(workerID, "# Worker "+workerID+"\n"); err != nil {
		return "", err
	}
	home := filepath.Join(o.Hive.Root, "agents", workerID)
	promptPath := filepath.Join(home, ".worker-prompt.md")
	if err := writeFile(promptPath, workerPrompt(workerID, home)); err != nil {
		return "", err
	}
	ag, err := o.Spawner.Spawn(ctx, agents.SpawnRequest{
		Cwd:      o.Cwd,
		Worktree: workerID,
		Args:     []string{"--dangerously-skip-permissions", "--append-system-prompt-file", promptPath, "--add-dir", o.Hive.Root},
	})
	if err != nil {
		return "", err
	}
	o.mu.Lock()
	o.workers[workerID] = ag.SessionID
	o.mu.Unlock()
	go o.kickWorker(ctx, ag.SessionID)
	o.Log.Info("worker spawned", "component", "orchestrator", "worker", workerID, "session_id", ag.SessionID)
	return ag.SessionID, nil
}

// workerKickMessage boots a freshly-spawned worker TUI. Like the orchestrator
// kick it is declarative and one line.
const workerKickMessage = "Read your inbox now and do the task assigned to you in the repo. When you finish the work, write one result message to your outbox — do not mark the task done yourself — then stop. Keep going only while there is genuinely new work in your inbox; do not re-poll an inbox you have already emptied."

// kickWorker sends the worker its one start signal after its TUI settles.
func (o *Orchestrator) kickWorker(ctx context.Context, sessionID string) {
	delay := o.KickDelay
	if delay == 0 {
		delay = 2500 * time.Millisecond
	}
	select {
	case <-ctx.Done():
		return
	case <-time.After(delay):
	}
	if err := o.Spawner.Input(sessionID, []byte(workerKickMessage)); err != nil {
		o.Log.Warn("worker kick: write text", "component", "orchestrator", "err", err, "session_id", sessionID)
		return
	}
	select {
	case <-ctx.Done():
		return
	case <-time.After(120 * time.Millisecond):
	}
	if err := o.Spawner.Input(sessionID, []byte("\r")); err != nil {
		o.Log.Warn("worker kick: submit", "component", "orchestrator", "err", err, "session_id", sessionID)
		return
	}
	o.Log.Info("worker kicked", "component", "orchestrator", "session_id", sessionID)
}

// routerLoop delivers mail every tick until ctx is cancelled.
func (o *Orchestrator) routerLoop(ctx context.Context) {
	t := time.NewTicker(o.RouterTick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			o.tick(ctx)
		}
	}
}

// tick is one router pass: it is the harness half of orchestration. The
// orchestrator (a Claude session with only file tools) declares intent by
// writing mailbox files and scribing task status; the router materializes that
// intent — delivering mail, spawning a worker for each assigned task, waking an
// idle agent that just received mail, and running verification for each task the
// orchestrator moved to `verifying`.
func (o *Orchestrator) tick(ctx context.Context) {
	// (A) Deliver outbox → inbox, and remember who just got mail so we can wake
	// them: a stopped TUI session does not react to a new inbox file on its own.
	woke, err := o.Hive.Deliver()
	if err != nil {
		o.Log.Warn("router deliver", "component", "orchestrator", "err", err)
	} else if woke > 0 {
		o.Log.Info("mail delivered", "component", "orchestrator", "count", woke)
	}
	// (B) Retire fire-once assign messages the worker has already picked up, so
	// the Stop-loop releases and a finished worker can stop instead of looping.
	o.drainConsumedAssignments()
	o.wakeRecipients(ctx)
	// (C) Spawn a worker for every task the orchestrator assigned.
	o.spawnAssignedWorkers(ctx)
	// (D) Run verification for every task scribed to `verifying`.
	o.driveVerification(ctx)
	// (E) Escalate any live task that has spent past its budget.
	o.enforceBudgets(ctx)
}

// drainConsumedAssignments archives each worker's inbox messages that have been
// consumed — a picked-up `assign`, or a verify-bounce the worker has since acted
// on (see keepWorkerMail for the exact rule). A consumed message that lingers
// keeps InboxCount non-zero, which pins the worker in the Stop-loop and triggers
// an endless re-kick. Live mail (`question`, peer results, un-acted bounces) is
// kept. Draining is keyed on task status, not on the worker deleting the file,
// so it is deterministic and independent of the agent's own housekeeping. It runs
// before wakeRecipients so a just-emptied inbox is not needlessly re-kicked.
func (o *Orchestrator) drainConsumedAssignments() {
	tasks, err := o.Hive.ListTasks()
	if err != nil {
		o.Log.Warn("router list tasks (drain)", "component", "orchestrator", "err", err)
		return
	}
	status := make(map[string]string, len(tasks))
	for _, t := range tasks {
		status[t.ID] = t.Status
	}
	o.mu.Lock()
	workers := make([]string, 0, len(o.workers))
	for wid := range o.workers {
		workers = append(workers, wid)
	}
	o.mu.Unlock()
	for _, wid := range workers {
		n, err := o.Hive.ArchiveInbox(wid, func(m hive.Message) bool {
			return keepWorkerMail(m, status[m.TaskID])
		})
		if err != nil {
			o.Log.Warn("router archive inbox", "component", "orchestrator", "worker", wid, "err", err)
		} else if n > 0 {
			o.Log.Info("worker mail archived", "component", "orchestrator", "worker", wid, "count", n)
		}
	}
}

// keepWorkerMail decides whether a message in a worker's inbox is still live and
// must stay (true), or has been consumed and may be archived (false). It is the
// core of the Stop-loop fix: a message that has served its purpose but lingers
// keeps InboxCount non-zero, pinning the worker in an endless re-kick/poll.
//
//   - An `assign` drives pickup: consumed once the task has moved off
//     inbox/assigned (the worker has taken it up).
//   - A verify-bounce `result` (from the verifier) drives a fix while the task is
//     back in_progress: consumed once the task has moved off in_progress again
//     (the worker acted and it went to verifying/done/needs_you/failed).
//
// Every other message — a peer `result`, a `question`, an `escalation`, or a
// message whose task is unknown/absent — is kept. Draining is keyed on task
// status (deterministic), never on the agent deleting its own file.
func keepWorkerMail(m hive.Message, taskStatus string) bool {
	if taskStatus == "" {
		return true // unknown task: never drop mail we can't reason about
	}
	switch m.Kind {
	case hive.KindAssign:
		return taskStatus == hive.StatusInbox || taskStatus == hive.StatusAssigned
	case hive.KindResult:
		if m.From != hive.VerifierAgentID {
			return true // peer/FYI result, not a bounce the worker must act on
		}
		return taskStatus == hive.StatusInProgress
	default:
		return true
	}
}

// spawnAssignedWorkers ensures a session exists for every worker that has live
// work. The orchestrator sets task.assignee + status=assigned; that is the spawn
// trigger. SpawnWorker is idempotent, so a still-running worker is a no-op.
func (o *Orchestrator) spawnAssignedWorkers(ctx context.Context) {
	tasks, err := o.Hive.ListTasks()
	if err != nil {
		o.Log.Warn("router list tasks", "component", "orchestrator", "err", err)
		return
	}
	for _, t := range tasks {
		if t.Assignee == "" {
			continue
		}
		switch t.Status {
		case hive.StatusAssigned, hive.StatusInProgress:
		default:
			continue // only spawn for live work
		}
		sid, err := o.SpawnWorker(ctx, t.Assignee) // idempotent: returns the live session
		if err != nil {
			o.Log.Warn("router spawn worker", "component", "orchestrator", "worker", t.Assignee, "err", err)
			continue
		}
		// Open the cost-attribution window for this worker's *session* — the id
		// AttributeTaskCost joins events on. The insert is a no-op while a window
		// for that (task, session) is open, so it is safe every tick; the window
		// is closed (and cost summed) when verification finishes the task.
		if o.Store != nil {
			if err := store.OpenAssignment(ctx, o.Store.DB(), t.ID, sid, o.now().UnixMilli()); err != nil {
				o.Log.Warn("router open assignment", "component", "orchestrator", "task", t.ID, "err", err)
			}
		}
	}
}

// enforceBudgets re-attributes cost for every live task and escalates the ones
// that have spent past `budget_usd` to needs_you, with the reason mailed to the
// orchestrator (.ai/05-orchestration.md § Approvals). Attribution otherwise only
// runs when verification finishes a task, so a runaway worker would blow through
// its budget unnoticed; running it on the tick is what makes the number — and
// the limit — live. A budget of 0 (or unset) means no limit.
func (o *Orchestrator) enforceBudgets(ctx context.Context) {
	if o.Store == nil {
		return
	}
	tasks, err := o.Hive.ListTasks()
	if err != nil {
		o.Log.Warn("router list tasks (budget)", "component", "orchestrator", "err", err)
		return
	}
	for _, t := range tasks {
		if t.BudgetUSD <= 0 {
			continue // no budget set: no limit
		}
		switch t.Status {
		case hive.StatusAssigned, hive.StatusInProgress, hive.StatusVerifying:
		default:
			continue // only live work can overspend
		}
		cost, err := store.AttributeTaskCost(ctx, o.Store.DB(), t.ID)
		if err != nil {
			o.Log.Warn("router attribute cost", "component", "orchestrator", "task", t.ID, "err", err)
			continue
		}
		if cost <= t.BudgetUSD {
			continue
		}
		reason := fmt.Sprintf("Task %s has spent $%.2f against a budget of $%.2f and is paused for your decision.", t.ID, cost, t.BudgetUSD)
		if o.OverBudget != nil {
			if err := o.OverBudget(ctx, t.ID, reason); err != nil {
				o.Log.Warn("router over budget", "component", "orchestrator", "task", t.ID, "err", err)
				continue
			}
		} else if err := o.parkTask(t.ID, t.Status); err != nil {
			o.Log.Warn("router over budget", "component", "orchestrator", "task", t.ID, "err", err)
			continue
		}
		_, _ = o.Hive.Send(hive.Message{From: hive.VerifierAgentID, To: OrchestratorID, Kind: hive.KindEscalation, TaskID: t.ID, Body: reason})
		o.Log.Warn("task over budget; escalated", "component", "orchestrator", "task", t.ID, "cost_usd", cost, "budget_usd", t.BudgetUSD)
	}
}

// parkTask moves a task to needs_you one legal step at a time. `assigned` cannot
// reach needs_you in a single hop, so a direct write would be rejected and the
// overspending task would keep burning. This is the fallback used only when no
// OverBudget seam is wired (tests); the daemon's seam goes through the board,
// which also mirrors and records the reason.
func (o *Orchestrator) parkTask(taskID, from string) error {
	route := hive.TransitionRoute(from, hive.StatusNeedsYou)
	if route == nil {
		return fmt.Errorf("orchestrator: task %s cannot reach needs_you from %s", taskID, from)
	}
	for _, step := range route {
		s := step
		if _, err := o.Hive.UpdateTask(taskID, func(x *hive.Task) error { x.Status = s; return nil }); err != nil {
			return err
		}
	}
	return nil
}

// wakeRecipients re-kicks any live agent whose inbox is non-empty. A Claude TUI
// session does not exit when it ends a turn and does not react to a file landing
// in its inbox — only new typed input restarts a turn. So when a verification
// bounce or a worker result is delivered to an idle session, the router re-types
// the (declarative, repeat-safe) kick to wake it. The kick is throttled per
// session so a still-working agent is not spammed every tick.
func (o *Orchestrator) wakeRecipients(ctx context.Context) {
	o.mu.Lock()
	sessions := make(map[string]string, len(o.workers)+1) // agentID → sessionID
	for wid, sid := range o.workers {
		sessions[wid] = sid
	}
	if o.orchestrator != "" {
		sessions[OrchestratorID] = o.orchestrator
	}
	o.mu.Unlock()
	for agentID, sid := range sessions {
		if o.Hive.InboxCount(agentID) == 0 {
			continue
		}
		if _, live := o.Spawner.Get(sid); !live {
			continue
		}
		if !o.shouldWake(agentID) {
			continue
		}
		msg := workerKickMessage
		if agentID == OrchestratorID {
			msg = kickMessage
		}
		o.wake(ctx, sid, msg)
	}
}

// shouldWake throttles wake re-kicks to at most once per WakeThrottle per agent,
// so an agent that is mid-turn (and will process its inbox itself) is not
// hammered with typed input every tick.
func (o *Orchestrator) shouldWake(agentID string) bool {
	throttle := o.WakeThrottle
	if throttle == 0 {
		throttle = 20 * time.Second
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.lastWake == nil {
		o.lastWake = map[string]time.Time{}
	}
	last := o.lastWake[agentID]
	if !last.IsZero() && o.now().Sub(last) < throttle {
		return false
	}
	o.lastWake[agentID] = o.now()
	return true
}

// driveVerification runs done_criteria for each task in `verifying`. Verify()
// always moves the task OUT of `verifying`, so a task is caught at most once; the
// in-flight set guards the window while a (possibly slow) command runs, since a
// tick fires far more often than verification completes.
func (o *Orchestrator) driveVerification(ctx context.Context) {
	if o.Verify == nil {
		return // not wired (e.g. unit tests without a board)
	}
	tasks, err := o.Hive.ListTasks()
	if err != nil {
		return
	}
	for _, t := range tasks {
		if t.Status != hive.StatusVerifying {
			continue
		}
		o.mu.Lock()
		if o.verifying == nil {
			o.verifying = map[string]bool{}
		}
		if o.verifying[t.ID] {
			o.mu.Unlock()
			continue
		}
		o.verifying[t.ID] = true
		o.mu.Unlock()
		go func(id string) {
			if err := o.Verify(ctx, id); err != nil {
				o.Log.Warn("router verify", "component", "orchestrator", "task", id, "err", err)
			}
			o.mu.Lock()
			delete(o.verifying, id)
			o.mu.Unlock()
		}(t.ID)
	}
}

// wake types a message + carriage return into a session to restart its turn.
func (o *Orchestrator) wake(ctx context.Context, sessionID, msg string) {
	if err := o.Spawner.Input(sessionID, []byte(msg)); err != nil {
		o.Log.Warn("router wake: write", "component", "orchestrator", "err", err, "session_id", sessionID)
		return
	}
	select {
	case <-ctx.Done():
		return
	case <-time.After(120 * time.Millisecond):
	}
	if err := o.Spawner.Input(sessionID, []byte("\r")); err != nil {
		o.Log.Warn("router wake: submit", "component", "orchestrator", "err", err, "session_id", sessionID)
	}
}

// AgentIDForSession maps a Caprock session id back to its hive agent id (for the
// Stop-loop decision, which needs the agent whose inbox to check).
func (o *Orchestrator) AgentIDForSession(sessionID string) string {
	o.mu.Lock()
	defer o.mu.Unlock()
	if sessionID == o.orchestrator {
		return OrchestratorID
	}
	for wid, sid := range o.workers {
		if sid == sessionID {
			return wid
		}
	}
	return ""
}

// TaskForAgent returns the id of the live (non-terminal) task assigned to an
// agent, or "" if none. It arms the Stop-hook forced-continue guard, which is
// keyed per (session, task). The orchestrator itself is never assigned a task.
func (o *Orchestrator) TaskForAgent(agentID string) string {
	if agentID == "" || agentID == OrchestratorID {
		return ""
	}
	tasks, err := o.Hive.ListTasks()
	if err != nil {
		return ""
	}
	for _, t := range tasks {
		if t.Assignee != agentID {
			continue
		}
		switch t.Status {
		case hive.StatusDone, hive.StatusFailed:
			continue
		}
		return t.ID
	}
	return ""
}

func workerPrompt(id, home string) string {
	return "You are Caprock worker **" + id + "** in a hive. You receive task assignments as " +
		"mailbox files in your inbox (`" + home + "/inbox/`). Do the assigned work in the repo, then " +
		"report by writing a `result` message into your outbox (`" + home + "/outbox/`) — never mark a " +
		"task done yourself; Caprock verifies via the task's done_criteria. When the Stop hook says you " +
		"have unread mail, read it and act on it before stopping; once you have handled the work in your " +
		"inbox and written your result, stop — Caprock retires handled assignments for you, so do not sit " +
		"in a loop re-listing an inbox you have already emptied. Ask questions by writing a `question` " +
		"message. Be terse.\n\nYour hive home is: " + home + "\n"
}
