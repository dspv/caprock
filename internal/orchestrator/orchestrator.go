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

	mu           sync.Mutex
	orchestrator string            // orchestrator session id, "" if not running
	workers      map[string]string // hive agent id → session id
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
		Cwd:            o.Cwd,
		PermissionMode: "acceptEdits",
		Args:           []string{"--append-system-prompt-file", promptPath, "--add-dir", o.Hive.Root},
	})
	if err != nil {
		return "", fmt.Errorf("orchestrator: spawn: %w", err)
	}
	o.mu.Lock()
	o.orchestrator = ag.SessionID
	o.mu.Unlock()
	go o.routerLoop(ctx)
	o.Log.Info("orchestrator started", "component", "orchestrator", "session_id", ag.SessionID, "hive", o.Hive.Root)
	return ag.SessionID, nil
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
		Cwd:            o.Cwd,
		Worktree:       workerID,
		PermissionMode: "acceptEdits",
		Args:           []string{"--append-system-prompt-file", promptPath, "--add-dir", o.Hive.Root},
	})
	if err != nil {
		return "", err
	}
	o.mu.Lock()
	o.workers[workerID] = ag.SessionID
	o.mu.Unlock()
	o.Log.Info("worker spawned", "component", "orchestrator", "worker", workerID, "session_id", ag.SessionID)
	return ag.SessionID, nil
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
			if n, err := o.Hive.Deliver(); err != nil {
				o.Log.Warn("router deliver", "component", "orchestrator", "err", err)
			} else if n > 0 {
				o.Log.Info("mail delivered", "component", "orchestrator", "count", n)
			}
		}
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

func workerPrompt(id, home string) string {
	return "You are Caprock worker **" + id + "** in a hive. You receive task assignments as " +
		"mailbox files in your inbox (`" + home + "/inbox/`). Do the assigned work in the repo, then " +
		"report by writing a `result` message into your outbox (`" + home + "/outbox/`) — never mark a " +
		"task done yourself; Caprock verifies via the task's done_criteria. Read your inbox every turn; " +
		"when the Stop hook says you have unread mail, process it before stopping. Ask questions by " +
		"writing a `question` message. Be terse.\n\nYour hive home is: " + home + "\n"
}
