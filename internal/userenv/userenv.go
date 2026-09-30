// Package userenv gives the processes Caprock starts the environment the user's
// own terminal would give them.
//
// The daemon's environment is the wrong one to hand down. Started at login by
// launchd it holds ten variables and PATH=/usr/bin:/bin:/usr/sbin:/sbin — no
// Homebrew, no gcloud, nothing the user exports from their shell profile — and
// started from a terminal it is a snapshot of that terminal, frozen for as
// long as the daemon runs. A session spawned from either one fails in ways a
// session typed into a terminal does not: `gcloud` is not found, a project
// variable is unset, a credential helper is missing. The user reads that as
// "Caprock can't reach BigQuery" when plain `claude` can.
//
// So, the way VS Code resolves its shell environment, the user's login shell
// is run once, interactively, and asked to print its environment; that is what
// a spawned process inherits. It is cached and refreshed in the background, a
// failed refresh keeps the previous copy, a failed first resolution retries on
// its own, and a session that starts before any has succeeded waits briefly
// and then falls back to the daemon's environment — a slow or broken profile
// must never stop a session from starting.
package userenv

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/config"
)

const (
	// Timeout bounds one resolution. An interactive zsh with a framework on
	// top starts in about a second at rest — but the first resolution runs as
	// the daemon starts, beside every importer's first pass, and on the
	// owner's machine at load 11 a 5s bound killed it: the cache stayed empty
	// and a session started then would have got the daemon's bare PATH, the
	// exact failure this package exists to prevent (FB-033). A resolution
	// runs in the background, so a generous bound costs nobody a wait.
	Timeout = 30 * time.Second
	// FirstWait is the longest a session start waits for an environment that
	// is being resolved but has never been had. Starting at once with the
	// daemon's would be the silent failure; waiting forever would be a start
	// button that hangs.
	FirstWait = 15 * time.Second
	// TTL is how long a resolved environment is served before a background
	// refresh. An export added to the profile reaches sessions started a
	// minute later, without restarting the daemon.
	TTL = time.Minute
	// ResolvingVar is set in the shell while it is being asked for its
	// environment, so a profile can skip work that only makes sense for a
	// person (a tmux attach, a greeting, an update check).
	ResolvingVar = "CAPROCK_RESOLVING_ENVIRONMENT"
	mark         = "__CAPROCK_ENV_7f3a__"
)

// retryAfter is how long to wait before trying again when no environment has
// ever been resolved: soon, because a busy start is the usual cause, then
// backing off so a profile that is simply broken does not run every minute.
var retryAfter = []time.Duration{10 * time.Second, 30 * time.Second, 2 * time.Minute, 10 * time.Minute}

var (
	mu       sync.Mutex
	cached   []string
	cachedAt time.Time
	// inflight is closed when the running resolution ends; nil when none is
	// running. One shell at a time: a session start that finds one running
	// waits on it instead of starting a second on an already busy machine.
	inflight chan struct{}
	lastErr  error
	failures int
	// resolveFn, now and retryAfter are swapped by tests.
	resolveFn = resolve
	now       = time.Now
)

// State says where the environment a started process gets comes from, for
// `caprock status`: a user whose session cannot see gcloud needs to be able
// to tell "Caprock never read my profile" from everything else.
type State struct {
	// Source is "login-shell" once resolved, "resolving" before the first
	// resolution ends, "daemon" when it failed and nothing was ever had, and
	// "inherited" on Windows, which has no profile to replay.
	Source     string `json:"source"`
	Shell      string `json:"shell,omitempty"`
	ResolvedAt int64  `json:"resolved_at_ms,omitempty"`
	// Error is the last resolution's failure, kept while it is the reason.
	Error string `json:"error,omitempty"`
}

// Current reports the state of the environment cache.
func Current() State {
	if runtime.GOOS == "windows" {
		return State{Source: "inherited"}
	}
	mu.Lock()
	defer mu.Unlock()
	st := State{Shell: loginShell()}
	switch {
	case cached != nil:
		st.Source, st.ResolvedAt = "login-shell", cachedAt.UnixMilli()
		if lastErr != nil {
			st.Error = oneLine(lastErr) // a refresh failed; the older copy is still served
		}
	case inflight != nil && lastErr == nil:
		st.Source = "resolving"
	default:
		st.Source = "daemon"
		if lastErr != nil {
			st.Error = oneLine(lastErr)
		}
	}
	return st
}

// oneLine flattens a joined error ("shell printed no environment\nexit
// status 1") for a status line.
func oneLine(err error) string {
	return strings.ReplaceAll(err.Error(), "\n", "; ")
}

// Environ returns the environment for a process Caprock starts on the user's
// behalf: their login shell's, or the daemon's own when that cannot be had.
// The caller owns the returned slice.
//
// Only the first call ever waits for the shell (Warm makes even that one
// free). After that a stale copy is returned at once and refreshed in the
// background: an interactive zsh with a framework takes one to two seconds,
// which is not a cost to put in front of every session start.
func Environ(log *slog.Logger) []string {
	if runtime.GOOS == "windows" {
		// Windows has no login profile to replay: a process's environment is
		// built from the registry, which the daemon already inherited.
		return os.Environ()
	}
	mu.Lock()
	if cached != nil {
		if now().Sub(cachedAt) >= TTL {
			startLocked(log)
		}
		env := append([]string(nil), cached...)
		mu.Unlock()
		return env
	}
	done := startLocked(log)
	mu.Unlock()
	select {
	case <-done:
	case <-time.After(FirstWait):
	}
	mu.Lock()
	defer mu.Unlock()
	if cached != nil {
		return append([]string(nil), cached...)
	}
	// Nothing resolved yet. The session starts with the daemon's environment
	// rather than not at all, the failure is logged, and a retry is already
	// scheduled.
	if log != nil {
		log.Warn("starting with the daemon's environment; the login shell's is not available yet",
			"component", "userenv", "err", lastErr)
	}
	return os.Environ()
}

// Warm resolves the environment in the background, so the first session the
// user starts does not wait for their shell. A failure retries on its own.
func Warm(log *slog.Logger) {
	if runtime.GOOS == "windows" {
		return
	}
	mu.Lock()
	startLocked(log)
	mu.Unlock()
}

// startLocked starts a resolution unless one is running, and returns the
// channel that closes when it ends. mu must be held.
func startLocked(log *slog.Logger) chan struct{} {
	if inflight != nil {
		return inflight
	}
	done := make(chan struct{})
	inflight = done
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), Timeout)
		env, err := resolveFn(ctx, loginShell(), os.Environ())
		cancel()
		mu.Lock()
		defer mu.Unlock()
		inflight = nil
		defer close(done)
		if err == nil {
			cached, cachedAt, lastErr, failures = pin(env), now(), nil, 0
			return
		}
		lastErr = err
		if log != nil {
			if cached != nil {
				log.Warn("refresh login shell environment; keeping the previous one", "component", "userenv", "err", err)
			} else {
				log.Warn("resolve login shell environment", "component", "userenv", "err", err)
			}
		}
		if cached != nil {
			// The older copy keeps being served; the next stale read retries.
			cachedAt = now()
			return
		}
		// Never had one: try again on our own rather than waiting for a
		// session start to discover the gap.
		wait := retryAfter[min(failures, len(retryAfter)-1)]
		failures++
		time.AfterFunc(wait, func() {
			mu.Lock()
			if cached == nil {
				startLocked(log)
			}
			mu.Unlock()
		})
	}()
	return done
}

// loginShell is the user's shell. launchd and systemd both set SHELL from the
// account record, so an empty one is an unusual machine, not a common case.
func loginShell() string {
	if s := os.Getenv("SHELL"); s != "" {
		return s
	}
	return "/bin/sh"
}

// resolve runs the shell as a login, interactive shell — the two together are
// what a terminal tab reads, so zsh sources .zprofile and .zshrc and bash its
// profile and .bashrc — and captures `env -0` between two marks. The marks
// matter: an interactive profile is free to print a banner, and a NUL-separated
// dump survives values that contain newlines.
func resolve(ctx context.Context, shell string, base []string) ([]string, error) {
	script := "printf '%s' '" + mark + "'; /usr/bin/env -0; printf '%s' '" + mark + "'"
	cmd := exec.CommandContext(ctx, shell, "-l", "-i", "-c", script) //nolint:gosec // the user's own shell, fixed script
	cmd.Env = append(append([]string(nil), base...), ResolvingVar+"=1")
	cmd.Stdin = nil // /dev/null: a profile that prompts reads EOF instead of waiting
	var out bytes.Buffer
	cmd.Stdout = &out
	// A profile may start something that keeps the pipe open (an agent, a
	// daemon); stop waiting for it shortly after the shell itself is gone.
	cmd.WaitDelay = time.Second
	runErr := cmd.Run()
	env, err := parse(out.Bytes())
	if err != nil {
		if runErr != nil {
			return nil, errors.Join(err, runErr)
		}
		return nil, err
	}
	// A non-zero exit after a complete dump is a profile whose last line
	// failed; the environment it printed is still the one the user gets.
	return env, nil
}

// parse extracts the NUL-separated environment between the marks.
func parse(out []byte) ([]string, error) {
	start := bytes.Index(out, []byte(mark))
	end := bytes.LastIndex(out, []byte(mark))
	if start < 0 || end <= start {
		return nil, errors.New("shell printed no environment")
	}
	var env []string
	for _, kv := range strings.Split(string(out[start+len(mark):end]), "\x00") {
		i := strings.IndexByte(kv, '=')
		if i <= 0 {
			continue
		}
		switch kv[:i] {
		case ResolvingVar, "PWD", "OLDPWD", "SHLVL", "_":
			// The resolver's own marker, and the shell's view of where and how
			// deep it was — none of which is true of the process we start.
			continue
		}
		env = append(env, kv)
	}
	if !hasKey(env, "PATH") {
		return nil, errors.New("shell environment has no PATH")
	}
	return env, nil
}

// pin keeps the variables the daemon owns at the daemon's values. The hook shim
// in a spawned session reports to the data dir the daemon reads; a profile
// that exports a different one would send its events somewhere nobody looks.
func pin(env []string) []string {
	if dir, ok := os.LookupEnv(config.EnvDataDir); ok {
		env = append(without(env, config.EnvDataDir), config.EnvDataDir+"="+dir)
	}
	return env
}

func without(env []string, key string) []string {
	out := env[:0:0]
	for _, kv := range env {
		if !strings.HasPrefix(kv, key+"=") {
			out = append(out, kv)
		}
	}
	return out
}

func hasKey(env []string, key string) bool {
	for _, kv := range env {
		if strings.HasPrefix(kv, key+"=") {
			return true
		}
	}
	return false
}

// reset clears the cache; tests only.
func reset() {
	mu.Lock()
	cached, cachedAt, inflight, lastErr, failures = nil, time.Time{}, nil, nil, 0
	mu.Unlock()
}
