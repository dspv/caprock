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
	Cwd            string `json:"cwd"`
	Chat           bool   `json:"chat,omitempty"`            // a quick chat: Caprock picks the directory, no repository needed
	Create         bool   `json:"create,omitempty"`          // make Cwd if it does not exist (one level, under an existing parent)
	Worktree       string `json:"worktree,omitempty"`        // git worktree name to create under the repo
	Model          string `json:"model,omitempty"`           // --model
	PermissionMode string `json:"permission_mode,omitempty"` // --permission-mode
	Command        string `json:"command,omitempty"`         // default "claude"
	// Agent picks which coding agent to launch: "claude" (default) or
	// "gemini". They take different flags — gemini has no --session-id and
	// spells the model -m — so the argv is built per agent rather than
	// pretending one shape fits both.
	Agent string `json:"agent,omitempty"`
	// GeminiKey is the key the daemon holds, passed into the child's
	// environment. Never accepted from the browser — the API fills it in from
	// settings, so a page cannot hand a spawned process someone else's
	// credential.
	GeminiKey string   `json:"-"`
	Args      []string `json:"args,omitempty"` // extra args
	Cols      int      `json:"cols,omitempty"`
	Rows      int      `json:"rows,omitempty"`
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
	gemini   string // resolved gemini binary (or "gemini")
	mu       sync.Mutex
	agents   map[string]*Agent
	OnExit   func(sessionID string, code int)
	OnOutput func(sessionID string) // called (throttled by caller) when new bytes arrive
	// NewSessionID generates a session id; overridable in tests.
	NewSessionID func() string
	// Now is the clock chat directory names are stamped from; overridable in
	// tests so a name can be asserted rather than merely observed to exist.
	Now func() time.Time
}

// now is Manager.Now, or the wall clock when a manager was built by hand.
func (m *Manager) now() time.Time {
	if m.Now != nil {
		return m.Now()
	}
	return time.Now()
}

// NewManager builds a manager. claudePath "" resolves "claude" on PATH.
func NewManager(st *store.Store, dataDir, claudePath string, log *slog.Logger) *Manager {
	if log == nil {
		log = slog.Default()
	}
	if claudePath == "" {
		claudePath = resolveClaude()
	}
	return &Manager{pty: ptyman.New(), store: st, log: log, dataDir: dataDir, claude: claudePath, gemini: resolveGemini(), agents: map[string]*Agent{}, NewSessionID: config.NewSessionID, Now: time.Now}
}

// AgentClaude and AgentGemini name the coding agents Caprock can launch.
const (
	AgentClaude = "claude"
	AgentGemini = "gemini"
)

// geminiApprovalMode maps a Claude permission mode onto Gemini's --approval-mode,
// which covers the same ground with four values instead of six: default (ask),
// auto_edit (edits without asking), yolo (everything without asking), plan
// (read-only). Claude's manual and dontAsk have no counterpart that is not a
// guess about what the user meant, so they are left off and Gemini uses its own
// default — asking is the safe end of that axis.
func geminiApprovalMode(claudeMode string) string {
	switch claudeMode {
	case "acceptEdits":
		return "auto_edit"
	case "bypassPermissions", "auto":
		return "yolo"
	case "plan":
		return "plan"
	default:
		return ""
	}
}

// resolveGemini finds the Gemini CLI, which is an ordinary npm global install
// rather than something with a conventional home — so PATH is the only place
// worth looking.
func resolveGemini() string {
	if p, err := exec.LookPath("gemini"); err == nil {
		return p
	}
	return "gemini"
}

// GeminiAvailable reports whether the gemini binary can be launched, so the
// dialog offers an agent the machine actually has rather than a choice that
// fails on click.
func (m *Manager) GeminiAvailable() bool {
	if filepath.IsAbs(m.gemini) {
		_, err := os.Stat(m.gemini)
		return err == nil
	}
	_, err := exec.LookPath(m.gemini)
	return err == nil
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

// newChatDir makes a home for one quick chat.
//
// Vova uses Claude to ask things — look something up, talk a problem through —
// and the spawn dialog demanded an absolute path to a repository before it
// would start anything. For "just ask a question" that is a wall, so Caprock
// picks the directory itself.
//
// One directory PER CHAT, not one shared `chats/` folder: Claude Code keys a
// transcript by its working directory, so a shared folder would collapse every
// conversation the user ever had into a single project row worth thousands of
// dollars, with no way to tell one from another. Dated names sort themselves,
// and a chat's own directory is somewhere Claude can write scratch files
// without touching anyone's repository.
func (m *Manager) newChatDir() (string, error) {
	if m.dataDir == "" {
		return "", errors.New("agents: no data directory, so a chat has nowhere to live")
	}
	base := config.ChatsDir(m.dataDir)
	if err := os.MkdirAll(base, 0o700); err != nil {
		return "", fmt.Errorf("agents: create chats directory: %w", err)
	}
	// Second granularity plus a counter: two chats started inside the same
	// second would otherwise land in one directory and share a transcript.
	stamp := m.now().Format("2006-01-02-150405")
	for i := 0; ; i++ {
		name := stamp
		if i > 0 {
			name = fmt.Sprintf("%s-%d", stamp, i+1)
		}
		dir := filepath.Join(base, name)
		if err := os.Mkdir(dir, 0o700); err == nil {
			return dir, nil
		} else if !os.IsExist(err) {
			return "", fmt.Errorf("agents: create chat directory: %w", err)
		}
		if i > 100 {
			return "", errors.New("agents: could not find a free chat directory name")
		}
	}
}

// makeProjectDir creates a directory for a new project, one level deep.
//
// This runs on a POST that already executes a command from its body, so it is
// deliberately the narrowest thing that satisfies the request: **one** level,
// under a parent that already exists. `MkdirAll` would happily materialise
// `/a/b/c/d` from a typo, and the v0.17.0 audit found six defects that all
// began with treating a path from a request as trustworthy.
//
// The parent must exist and be a directory, so this cannot walk anywhere the
// user has not already been. An existing target is not an error — the caller
// asked for a directory to exist and it does.
func makeProjectDir(dir string) error {
	if !filepath.IsAbs(dir) {
		return fmt.Errorf("agents: %q is not an absolute path", dir)
	}
	// Clean first: `/Users/me/dev/../../../etc/x` is absolute and still escapes
	// wherever the user thought they were.
	dir = filepath.Clean(dir)
	parent := filepath.Dir(dir)
	if parent == dir {
		return fmt.Errorf("agents: refusing to create the filesystem root")
	}
	fi, err := os.Stat(parent)
	if err != nil || !fi.IsDir() {
		return fmt.Errorf("agents: %q does not exist, so %q cannot be created in it", parent, filepath.Base(dir))
	}
	// Mkdir, never MkdirAll — the parent check above is the guard, and this
	// call is what keeps it a guard. MkdirAll here would create the chain the
	// check just refused, so the two have to stay in agreement.
	if err := os.Mkdir(dir, 0o755); err != nil && !os.IsExist(err) {
		return fmt.Errorf("agents: could not create %q: %w", dir, err)
	}
	return nil
}

// Spawn launches a new session and registers it. The PTY session id is forced
// with `claude --session-id <uuid>` so hooks and transcript arrive under the id
// Caprock already knows.
func (m *Manager) Spawn(ctx context.Context, req SpawnRequest) (*Agent, error) {
	if req.Chat && req.Cwd == "" {
		dir, err := m.newChatDir()
		if err != nil {
			return nil, err
		}
		req.Cwd = dir
	}
	if req.Cwd == "" {
		return nil, errors.New("agents: spawn without cwd")
	}
	if fi, err := os.Stat(req.Cwd); err != nil || !fi.IsDir() {
		if !req.Create {
			return nil, fmt.Errorf("agents: cwd %q is not a directory", req.Cwd)
		}
		if err := makeProjectDir(req.Cwd); err != nil {
			return nil, err
		}
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
	var args []string
	switch {
	case command != "":
		// An explicit command is taken as given: the caller knows what it is
		// launching, and guessing flags for an unknown binary is worse than
		// launching it bare.
		args = append(args, req.Args...)
	case req.Agent == AgentGemini:
		command = m.gemini
		// Gemini CLI refuses to start in a directory it has not been told to
		// trust, and in a PTY nobody is watching that is an invisible hang
		// rather than an error. Caprock only ever launches a directory the user
		// picked in the dialog, which is the same consent the prompt asks for.
		args = []string{"--skip-trust", "--session-id", sessionID}
		if req.Model != "" {
			args = append(args, "-m", req.Model)
		}
		// Gemini spells the permission modes differently and accepts only its
		// own four; an unmapped mode is left off rather than guessed at.
		if mode := geminiApprovalMode(req.PermissionMode); mode != "" {
			args = append(args, "--approval-mode", mode)
		}
		args = append(args, req.Args...)
	default:
		command = m.claude
		args = []string{"--session-id", sessionID}
		if req.Model != "" {
			args = append(args, "--model", req.Model)
		}
		if req.PermissionMode != "" {
			args = append(args, "--permission-mode", req.PermissionMode)
		}
		args = append(args, req.Args...)
	}

	// Pre-accept the folder-trust dialog so the spawned session does not block on
	// it (best-effort; a failure here must not stop the spawn).
	if err := trustFolder(cwd); err != nil {
		m.log.Warn("pre-trust folder", "component", "agents", "cwd", cwd, "err", err)
	}

	env := childEnv()
	// The Gemini CLI reads GEMINI_API_KEY from its environment, and the key the
	// user pasted into the dashboard lives in the daemon's config — so it has
	// to be handed over here or the child asks for a key it cannot see. Only
	// when the environment does not already carry one: a machine set up the old
	// way keeps what it had, and the child sees one value rather than two.
	if req.Agent == AgentGemini && req.GeminiKey != "" && os.Getenv("GEMINI_API_KEY") == "" {
		env = append(env, "GEMINI_API_KEY="+req.GeminiKey)
	}
	spec := ptyman.Spec{Command: command, Args: args, Dir: cwd, Env: env, Cols: req.Cols, Rows: req.Rows}
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
		// The agent is recorded here, so the session carries it from its first
		// row: the filter, the per-agent totals and the badge all read this
		// column, and a Gemini session that arrived labelled "claude" would be
		// counted under the wrong agent forever.
		agent := req.Agent
		if agent == "" {
			agent = AgentClaude
		}
		if err := store.UpsertSession(ctx, q, sessionID, store.SessionPatch{Cwd: cwd, Agent: agent}); err != nil {
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

// OwnedRunning lists the sessions Caprock started that are still running.
//
// The name says "owned" rather than "all" because that distinction is the whole
// safety story: `m.agents` holds only sessions this manager spawned, and a
// caller must not have to remember that. See PauseOwned.
func (m *Manager) OwnedRunning() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.agents))
	for id := range m.agents {
		out = append(out, id)
	}
	return out
}

// PauseOwned pauses a session Caprock started, reporting whether it did.
//
// An id this manager does not own is refused here, quietly and without error:
// [Rule 7] is enforced at the thing that holds the process handles rather than
// by whoever happens to be calling. A session started in someone's own terminal
// is watched and never signalled, however much it is costing — and the daily
// spend cap, the one caller today, therefore cannot violate that rule even by
// mistake.
//
// [Rule 7]: ../../CLAUDE.md
func (m *Manager) PauseOwned(sessionID string) (bool, error) {
	a, ok := m.Get(sessionID)
	if !ok {
		return false, nil
	}
	if err := a.sess.Signal(ptyman.SignalPause); err != nil {
		return false, err
	}
	return true, nil
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

// ShutdownGrace is how long a session gets to finish on its own before it is
// killed. Claude Code flushes its transcript and releases its session id on
// the way out; none of that survives a SIGKILL.
const ShutdownGrace = 5 * time.Second

// Shutdown ends every owned session, giving each a chance to stop cleanly.
//
// It used to SIGKILL them outright, so upgrading Caprock — or any restart of
// the daemon — silently destroyed whatever the user had running under it,
// mid-turn, with no warning and nothing written out. A tool that watches your
// work must not be the thing that eats it.
//
// Every session is signalled first and waited on together, so the grace period
// is spent once rather than once per session. Anything still alive at the end
// is killed: shutdown has to terminate, and a process that ignores SIGTERM has
// had its chance.
func (m *Manager) Shutdown() {
	agents := m.List()
	if len(agents) == 0 {
		return
	}
	for _, a := range agents {
		// A paused session cannot act on a signal, so let it run first —
		// otherwise SIGTERM sits undelivered and every one of them takes the
		// full grace period before being killed anyway.
		if a.sess.Paused() {
			_ = a.sess.Signal(ptyman.SignalResume)
		}
		_ = a.sess.Signal(ptyman.SignalTerm)
	}
	done := make(chan struct{})
	go func() {
		var wg sync.WaitGroup
		for _, a := range agents {
			wg.Add(1)
			go func(a *Agent) {
				defer wg.Done()
				_ = a.sess.Wait()
			}(a)
		}
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(ShutdownGrace):
	}
	// Close kills anything still running and releases the PTY either way.
	for _, a := range agents {
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
