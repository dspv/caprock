// Package agents spawns and controls Claude Code sessions Caprock owns: a real
// `claude` process in a PTY, its output buffered for the terminal view and its
// exit recorded. Externally started sessions are never touched here — we only
// spawn, type into, pause and kill processes we started (.ai/05-orchestration.md).
package agents

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/ptyman"
	"github.com/dspv/caprock/internal/store"
)

// SpawnRequest describes a session to launch.
type SpawnRequest struct {
	Cwd            string   `json:"cwd"`
	Worktree       string   `json:"worktree,omitempty"`        // git worktree name to create under the repo
	Model          string   `json:"model,omitempty"`           // --model
	PermissionMode string   `json:"permission_mode,omitempty"` // --permission-mode
	Command        string   `json:"command,omitempty"`         // default "claude"
	Args           []string `json:"args,omitempty"`            // extra args
	Cols           int      `json:"cols,omitempty"`
	Rows           int      `json:"rows,omitempty"`
}

// Agent is a live owned session.
type Agent struct {
	SessionID string
	Cwd       string
	Worktree  string
	Command   string
	StartedAt time.Time

	sess   ptyman.Session
	ring   *ring
	log    *slog.Logger
	mu     sync.Mutex
	subs   map[chan []byte]struct{}
	done   chan struct{}
	exit   int
	exited bool
	onExit func(sessionID string, code int)
}

// Manager owns the set of running agents.
type Manager struct {
	pty      ptyman.Manager
	store    *store.Store
	log      *slog.Logger
	dataDir  string
	claude   string // resolved claude binary (or "claude")
	mu       sync.Mutex
	agents   map[string]*Agent
	OnExit   func(sessionID string, code int)
	OnOutput func(sessionID string) // called (throttled by caller) when new bytes arrive
	// NewSessionID generates a session id; overridable in tests.
	NewSessionID func() string
}

// NewManager builds a manager. claudePath "" resolves "claude" on PATH.
func NewManager(st *store.Store, dataDir, claudePath string, log *slog.Logger) *Manager {
	if log == nil {
		log = slog.Default()
	}
	if claudePath == "" {
		claudePath = resolveClaude()
	}
	return &Manager{pty: ptyman.New(), store: st, log: log, dataDir: dataDir, claude: claudePath, agents: map[string]*Agent{}, NewSessionID: config.NewSessionID}
}

// ClaudeAvailable reports whether the resolved claude binary can be launched.
func (m *Manager) ClaudeAvailable() bool {
	if filepath.IsAbs(m.claude) {
		fi, err := os.Stat(m.claude)
		return err == nil && !fi.IsDir()
	}
	_, err := exec.LookPath(m.claude)
	return err == nil
}

// resolveClaude finds the claude binary: PATH first, then the well-known install
// locations, because the daemon's PATH (especially when launched from a GUI or a
// service manager) often omits ~/.local/bin where the CLI installs itself.
func resolveClaude() string {
	if p, err := exec.LookPath("claude"); err == nil {
		return p
	}
	name := "claude"
	if runtime.GOOS == "windows" {
		name = "claude.exe"
	}
	home, _ := os.UserHomeDir()
	candidates := []string{
		filepath.Join(home, ".local", "bin", name),
		filepath.Join(home, ".claude", "local", name),
		filepath.Join(home, "bin", name),
		filepath.Join("/opt", "homebrew", "bin", name),
		filepath.Join("/usr", "local", "bin", name),
	}
	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			return c
		}
	}
	return "claude"
}

// Spawn launches a new session and registers it. The PTY session id is forced
// with `claude --session-id <uuid>` so hooks and transcript arrive under the id
// Caprock already knows.
func (m *Manager) Spawn(ctx context.Context, req SpawnRequest) (*Agent, error) {
	if req.Cwd == "" {
		return nil, errors.New("agents: spawn without cwd")
	}
	if fi, err := os.Stat(req.Cwd); err != nil || !fi.IsDir() {
		return nil, fmt.Errorf("agents: cwd %q is not a directory", req.Cwd)
	}
	sessionID := m.NewSessionID()
	cwd := req.Cwd
	worktree := ""
	if req.Worktree != "" {
		wt, err := createWorktree(ctx, req.Cwd, req.Worktree)
		if err != nil {
			return nil, err
		}
		cwd, worktree = wt, req.Worktree
	}
	command := req.Command
	if command == "" {
		command = m.claude
	}
	args := []string{"--session-id", sessionID}
	if req.Model != "" {
		args = append(args, "--model", req.Model)
	}
	if req.PermissionMode != "" {
		args = append(args, "--permission-mode", req.PermissionMode)
	}
	args = append(args, req.Args...)

	spec := ptyman.Spec{Command: command, Args: args, Dir: cwd, Env: childEnv(), Cols: req.Cols, Rows: req.Rows}
	// The PTY process is controlled explicitly via Signal/Close; it must not die
	// when the caller's context (e.g. an HTTP request) ends.
	sess, err := m.pty.Spawn(context.WithoutCancel(ctx), spec)
	if err != nil {
		return nil, fmt.Errorf("agents: spawn %s: %w", command, err)
	}
	a := &Agent{
		SessionID: sessionID, Cwd: cwd, Worktree: worktree, Command: command + " " + join(args), StartedAt: time.Now(),
		sess: sess, ring: newRing(256 << 10), log: m.log, subs: map[chan []byte]struct{}{}, done: make(chan struct{}), onExit: m.OnExit,
	}
	m.mu.Lock()
	m.agents[sessionID] = a
	m.mu.Unlock()

	// Persist ownership so a restart knows what Caprock launched.
	_ = m.store.WithTx(ctx, func(q store.Querier) error {
		if err := store.UpsertSession(ctx, q, sessionID, store.SessionPatch{Cwd: cwd, Project: store.ProjectFromCwd(cwd)}); err != nil {
			return err
		}
		return store.MarkOwned(ctx, q, sessionID, worktree, a.Command, sess.PID())
	})

	go a.pump(m.OnOutput)
	go a.wait(m)
	m.log.Info("spawned owned session", "component", "agents", "session_id", sessionID, "cwd", cwd, "pid", sess.PID())
	return a, nil
}

// Get returns a running agent.
func (m *Manager) Get(sessionID string) (*Agent, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.agents[sessionID]
	return a, ok
}

// List returns running agents.
func (m *Manager) List() []*Agent {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*Agent, 0, len(m.agents))
	for _, a := range m.agents {
		out = append(out, a)
	}
	return out
}

// Input writes typed bytes to an owned session.
func (m *Manager) Input(sessionID string, data []byte) error {
	a, ok := m.Get(sessionID)
	if !ok {
		return errNotOwned(sessionID)
	}
	_, err := a.sess.Write(data)
	return err
}

// Signal pauses/resumes/kills an owned session.
func (m *Manager) Signal(sessionID string, sig ptyman.Signal) error {
	a, ok := m.Get(sessionID)
	if !ok {
		return errNotOwned(sessionID)
	}
	return a.sess.Signal(sig)
}

// Resize an owned session's terminal.
func (m *Manager) Resize(sessionID string, cols, rows int) error {
	a, ok := m.Get(sessionID)
	if !ok {
		return errNotOwned(sessionID)
	}
	return a.sess.Resize(cols, rows)
}

// Shutdown kills every owned session (daemon stopping).
func (m *Manager) Shutdown() {
	for _, a := range m.List() {
		_ = a.sess.Signal(ptyman.SignalKill)
		_ = a.sess.Close()
	}
}

// ErrNotOwned is returned for control operations on a session Caprock did not spawn.
var ErrNotOwned = errors.New("session is not owned by caprock (observe-only)")

func errNotOwned(id string) error { return fmt.Errorf("%w: %s", ErrNotOwned, id) }

func (a *Agent) pump(onOutput func(string)) {
	r := bufio.NewReader(a.sess.Output())
	buf := make([]byte, 32<<10)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			a.ring.write(chunk)
			a.mu.Lock()
			for ch := range a.subs {
				select {
				case ch <- chunk:
				default:
				}
			}
			a.mu.Unlock()
			if onOutput != nil {
				onOutput(a.SessionID)
			}
		}
		if err != nil {
			return
		}
	}
}

// exitCoder lets a ptyman.Session report an exit code without an *exec.ExitError
// (used by the in-memory test backend).
type exitCoder interface{ ExitCode() int }

func (a *Agent) wait(m *Manager) {
	err := a.sess.Wait()
	code := 0
	if err != nil {
		var ee *exec.ExitError
		var ec exitCoder
		switch {
		case errors.As(err, &ee):
			code = ee.ExitCode()
		case errors.As(err, &ec):
			code = ec.ExitCode()
		default:
			code = -1
		}
	}
	a.mu.Lock()
	a.exit, a.exited = code, true
	close(a.done)
	for ch := range a.subs {
		close(ch)
	}
	a.subs = map[chan []byte]struct{}{}
	a.mu.Unlock()
	m.mu.Lock()
	delete(m.agents, a.SessionID)
	m.mu.Unlock()
	_ = m.store.WithTx(context.Background(), func(q store.Querier) error { return store.SetExit(context.Background(), q, a.SessionID, code) })
	m.log.Info("owned session exited", "component", "agents", "session_id", a.SessionID, "code", code, "err", errStr(err))
	if a.onExit != nil {
		a.onExit(a.SessionID, code)
	}
}

// Snapshot returns the current terminal scrollback (for a fresh terminal connect).
func (a *Agent) Snapshot() []byte { return a.ring.snapshot() }

// Subscribe returns a channel of new output chunks and a cancel func. The channel
// is closed when the process exits.
func (a *Agent) Subscribe() (<-chan []byte, func()) {
	ch := make(chan []byte, 256)
	a.mu.Lock()
	if a.exited {
		a.mu.Unlock()
		close(ch)
		return ch, func() {}
	}
	a.subs[ch] = struct{}{}
	a.mu.Unlock()
	return ch, func() {
		a.mu.Lock()
		if _, ok := a.subs[ch]; ok {
			delete(a.subs, ch)
			close(ch)
		}
		a.mu.Unlock()
	}
}

// Write types into the session.
func (a *Agent) Write(b []byte) error { _, err := a.sess.Write(b); return err }

// Resize the terminal.
func (a *Agent) Resize(cols, rows int) error { return a.sess.Resize(cols, rows) }

// Signal the process.
func (a *Agent) Signal(sig ptyman.Signal) error { return a.sess.Signal(sig) }

// Exited reports the exit state.
func (a *Agent) Exited() (int, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.exit, a.exited
}

// Paused reports the pause state.
func (a *Agent) Paused() bool { return a.sess.Paused() }

// childEnv is the environment for a spawned session: the daemon's environment
// with Caprock/Claude nesting markers stripped, so a session Caprock launches is
// a normal top-level Claude Code session (transcripts persist, no "child session"
// mode) even when the daemon itself was started from inside one.
func childEnv() []string {
	drop := map[string]bool{
		"CLAUDE_CODE_CHILD_SESSION": true,
		"CLAUDECODE":                true,
		"CLAUDE_CODE_ENTRYPOINT":    true,
		"CLAUDE_CODE_SSE_PORT":      true,
		"CAPROCK_DATA_DIR":          false, // keep: the child's own hook shim needs it
	}
	var out []string
	for _, kv := range os.Environ() {
		k := kv
		if i := indexByte(kv, '='); i >= 0 {
			k = kv[:i]
		}
		if drop[k] {
			continue
		}
		out = append(out, kv)
	}
	out = append(out, "TERM=xterm-256color", "COLORTERM=truecolor")
	return out
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

func errStr(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func join(args []string) string {
	out := ""
	for i, s := range args {
		if i > 0 {
			out += " "
		}
		out += s
	}
	return out
}
