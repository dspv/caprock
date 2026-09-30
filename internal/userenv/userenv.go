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
// a spawned process inherits. It is cached briefly, bounded by a timeout, and
// falls back to the daemon's own environment on any failure — a slow or broken
// profile must never stop a session from starting.
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
	// top starts in well under a second; anything slower is a profile doing
	// something we should not wait for.
	Timeout = 5 * time.Second
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

var (
	mu         sync.Mutex
	cached     []string
	cachedAt   time.Time
	refreshing bool
	// resolveFn and now are swapped by tests.
	resolveFn = resolve
	now       = time.Now
)

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
		if now().Sub(cachedAt) >= TTL && !refreshing {
			refreshing = true
			go refresh(log)
		}
		env := append([]string(nil), cached...)
		mu.Unlock()
		return env
	}
	mu.Unlock()
	if env := refresh(log); env != nil {
		return env
	}
	// Not cached: the next spawn tries again rather than living with the
	// fallback.
	return os.Environ()
}

// Warm resolves the environment in the background, so the first session the
// user starts does not wait for their shell.
func Warm(log *slog.Logger) {
	if runtime.GOOS == "windows" {
		return
	}
	go Environ(log)
}

// refresh resolves once and stores the result; nil on failure. Concurrent
// first calls may each run the shell — harmless, and simpler than making a
// spawn wait on someone else's resolution.
func refresh(log *slog.Logger) []string {
	ctx, cancel := context.WithTimeout(context.Background(), Timeout)
	defer cancel()
	env, err := resolveFn(ctx, loginShell(), os.Environ())
	mu.Lock()
	defer mu.Unlock()
	refreshing = false
	if err != nil {
		if log != nil {
			log.Warn("resolve login shell environment; using the daemon's", "component", "userenv", "err", err)
		}
		return nil
	}
	cached, cachedAt = pin(env), now()
	return append([]string(nil), cached...)
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
	cached, cachedAt, refreshing = nil, time.Time{}, false
	mu.Unlock()
}
