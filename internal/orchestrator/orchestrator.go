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
const OrchestratorID = "orchestrator"

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
const workerKickMessage = "Read your inbox now and do the task assigned to you in the repo. When finished, write a result message to your outbox — do not mark the task done yourself. Do not stop while your inbox has unread mail."

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
	o.wakeRecipients(ctx)
	// (B) Spawn a worker for every task the orchestrator assigned.
	o.spawnAssignedWorkers(ctx)
	// (C) Run verification for every task scribed to `verifying`.
	o.driveVerification(ctx)
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
		if o.workerLive(t.Assignee) {
			continue
		}
		if _, err := o.SpawnWorker(ctx, t.Assignee); err != nil {
			o.Log.Warn("router spawn worker", "component", "orchestrator", "worker", t.Assignee, "err", err)
		}
	}
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

// workerLive reports whether a worker's session is currently running.
func (o *Orchestrator) workerLive(workerID string) bool {
	o.mu.Lock()
	sid, ok := o.workers[workerID]
	o.mu.Unlock()
	if !ok {
		return false
	}
	_, live := o.Spawner.Get(sid)
	return live
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
		"task done yourself; Caprock verifies via the task's done_criteria. Read your inbox every turn; " +
		"when the Stop hook says you have unread mail, process it before stopping. Ask questions by " +
		"writing a `question` message. Be terse.\n\nYour hive home is: " + home + "\n"
}
