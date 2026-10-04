package nativeterm

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// openTimeout bounds `open` and `osascript`, which return once the window
// is up. An Automation prompt the user has not answered yet would otherwise
// hold the request for as long as they leave it.
const openTimeout = 20 * time.Second

// Run carries a plan out: writes its file, starts its process with env, and
// for a plan that waits, reports the process's failure in its own words.
func Run(ctx context.Context, p Plan, env []string) error {
	if p.File != nil {
		if err := os.MkdirAll(filepath.Dir(p.File.Path), 0o700); err != nil {
			return fmt.Errorf("prepare %s: %w", filepath.Dir(p.File.Path), err)
		}
		if err := os.WriteFile(p.File.Path, []byte(p.File.Content), 0o700); err != nil {
			return fmt.Errorf("write %s: %w", p.File.Path, err)
		}
	}
	if p.Wait {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), openTimeout)
		defer cancel()
		cmd := exec.CommandContext(ctx, p.Command, p.Args...)
		cmd.Dir, cmd.Env = p.Dir, env
		var out bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &out
		if err := cmd.Run(); err != nil {
			msg := strings.TrimSpace(out.String())
			if msg == "" {
				msg = err.Error()
			}
			return fmt.Errorf("%s: %s", filepath.Base(p.Command), msg)
		}
		return nil
	}
	// The terminal itself: started in a session of its own so it outlives
	// the daemon, and reaped in the background so it never lingers as a
	// zombie under it.
	cmd := exec.Command(p.Command, p.Args...)
	cmd.Dir, cmd.Env = p.Dir, env
	cmd.SysProcAttr = sysProcAttr(p.NewConsole)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start %s: %w", filepath.Base(p.Command), err)
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// Env is the environment a terminal is started with: the user's login-shell
// one, without the variables that would make what runs inside it think it is
// nested in another Claude Code session or in Caprock's own PTY.
func Env(base []string) []string {
	drop := map[string]bool{
		"CLAUDECODE": true, "CLAUDE_CODE_ENTRYPOINT": true, "CLAUDE_CODE_CHILD_SESSION": true,
		"CLAUDE_CODE_SSE_PORT": true, "CLAUDE_CODE_SESSION_ID": true, "CLAUDE_CODE_SESSION_ATTENDED": true,
		"CLAUDE_CODE_MESSAGING_SOCKET": true, "CLAUDE_CODE_MESSAGING_TOKEN": true, "CLAUDE_CODE_EXECPATH": true,
		"CLAUDE_PID": true, "CLAUDE_EFFORT": true, "AI_AGENT": true,
		// The terminal sets these for itself.
		"TERM": true, "COLORTERM": true, "TERM_PROGRAM": true, "TERM_PROGRAM_VERSION": true, "TERM_SESSION_ID": true,
	}
	out := make([]string, 0, len(base))
	for _, kv := range base {
		k, _, _ := strings.Cut(kv, "=")
		if drop[k] {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// Shell is the user's login shell named by env, or "" when it names none.
func Shell(env []string) string { return getenv(env, "SHELL") }
