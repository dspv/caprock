package agents

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"time"

	"github.com/dspv/caprock/internal/ptyman"
	"github.com/dspv/caprock/internal/termbuf"
	"github.com/dspv/caprock/internal/userenv"
)

// KindShell is the Agent.Kind (and pty-host meta kind) of a shell tab: the
// user's login shell in a folder, held by a pty-host like an agent session
// so it outlives the daemon (F04, WP-07).
//
// A shell is not a session. It writes no sessions row and no event, so it is
// in no total, no Now card, no export and no count by construction — the
// same reason ADR-037 removes rows rather than flagging them: a filter column
// would have to be remembered by every query, and a missed one counts a
// shell as work. What knows a shell exists is this manager (and, across a
// restart, its pty-host's registry entry).
const KindShell = "shell"

// ShellRequest starts a shell.
type ShellRequest struct {
	Cwd  string
	Cols int
	Rows int
}

// SpawnShell starts the user's login shell in req.Cwd. Rule 7 holds: Caprock
// started it, so Caprock may type into it and end it.
func (m *Manager) SpawnShell(ctx context.Context, req ShellRequest) (*Agent, error) {
	if fi, err := os.Stat(req.Cwd); err != nil || !fi.IsDir() {
		return nil, fmt.Errorf("%q is not a directory", req.Cwd)
	}
	env := childEnv(userenv.Environ(m.log))
	command, args := m.loginShell(env)
	id := m.NewSessionID()
	spec := ptyman.Spec{ID: id, Command: command, Args: args, Dir: req.Cwd, Env: env, Cols: req.Cols, Rows: req.Rows,
		Meta: map[string]string{metaKind: KindShell}}
	sess, err := m.pty.Spawn(context.WithoutCancel(ctx), spec)
	if err != nil {
		return nil, fmt.Errorf("start %s: %w", command, err)
	}
	a := &Agent{
		SessionID: id, Cwd: req.Cwd, Command: command + " " + join(args), StartedAt: time.Now(), Kind: KindShell,
		sess: sess, ring: ringFor(sess, 256<<10), inputs: termbuf.NewInputs(termbuf.InputTTL), log: m.log, subs: map[chan []byte]struct{}{}, done: make(chan struct{}), onExit: m.OnExit,
	}
	m.mu.Lock()
	m.agents[id] = a
	m.mu.Unlock()
	go a.pump(m.OnOutput)
	go a.wait(m)
	m.log.Info("started a shell", "component", "agents", "shell_id", id, "cwd", req.Cwd, "pid", sess.PID())
	return a, nil
}

// Shells lists the running shells, oldest first.
func (m *Manager) Shells() []*Agent {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []*Agent
	for _, a := range m.agents {
		if a.Kind == KindShell {
			out = append(out, a)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt.Before(out[j].StartedAt) })
	return out
}

// IsShell reports whether id is a running shell.
func (m *Manager) IsShell(id string) bool {
	a, ok := m.Get(id)
	return ok && a.Kind == KindShell
}

// loginShell is the shell a tab runs and its arguments: on POSIX the user's
// $SHELL (from the login environment, which launchd's lacks) as a login
// shell; on Windows PowerShell 7, else Windows PowerShell, else cmd.exe.
func (m *Manager) loginShell(env []string) (string, []string) {
	if m.shellCmd != nil {
		return m.shellCmd()
	}
	if runtime.GOOS == "windows" {
		return windowsShell(env)
	}
	for _, s := range []string{envValue(env, "SHELL"), os.Getenv("SHELL"), "/bin/zsh", "/bin/bash", "/bin/sh"} {
		if s != "" && isExecutable(s) {
			return s, []string{"-l"}
		}
	}
	return "/bin/sh", []string{"-l"}
}

// windowsShell picks PowerShell 7 (pwsh), then Windows PowerShell, then the
// command processor.
func windowsShell(env []string) (string, []string) {
	for _, name := range []string{"pwsh.exe", "powershell.exe"} {
		if p := findBinaryIn(name, env, nil); p != "" {
			return p, []string{"-NoLogo"}
		}
	}
	if c := envValue(env, "ComSpec"); c != "" {
		return c, nil
	}
	if p, err := exec.LookPath("cmd.exe"); err == nil {
		return p, nil
	}
	return "cmd.exe", nil
}
