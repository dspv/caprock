package daemon

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/jarvisbrain"
	"github.com/dspv/caprock/internal/subs"
	"github.com/dspv/caprock/internal/userenv"
)

// Jarvis's brain (ADR-097): the user's own Claude Code or Codex, headless,
// with no tool, on the sign-in chosen for it, from a folder of Caprock's.

// jarvisTick is how often the Jarvis watchers look at the agents while they
// have something to watch.
const jarvisTick = 3 * time.Second

// jarvisBrainDeps is what the API's Jarvis engine runs with.
func (d *Daemon) jarvisBrainDeps(ctx context.Context) *api.JarvisBrainDeps {
	return &api.JarvisBrainDeps{
		Runner: jarvisbrain.CLIRunner{
			Binary: d.jarvisBinary,
			Env:    d.jarvisEnv,
			Dir:    filepath.Join(d.opt.DataDir, "jarvis", "run"),
		},
		Setting: d.jarvisSetting,
		Check:   d.jarvisCheck,
		// INTEGRATION(feat/jarvis-v2-core): wire the core's answer path
		// (POST /v1/jarvis/answer's: press option N of the question dialog
		// on an owned session's screen) as Answer, and an adapter over
		// d.RecordHandled(ctx, store.HandledItem{Kind: h.Kind, At: h.At,
		// SessionID: h.SessionID, Project: h.Project, Text: h.Text,
		// Reason: h.Reason}) as Record. Until then auto-answer and the
		// brain's "answer" action stay off: Caprock never types a key
		// sequence it has not verified against Claude Code's dialog.
		Answer:  nil,
		Record:  nil,
		Context: ctx,
	}
}

// jarvisLoop settles replies a restart left pending, then ticks the
// watchers until ctx ends.
func (d *Daemon) jarvisLoop(ctx context.Context) {
	if d.api == nil {
		return
	}
	d.api.JarvisSettle(ctx)
	t := time.NewTicker(jarvisTick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			d.api.JarvisTick(ctx)
		}
	}
}

// jarvisSetting is the stored setting, ok false when never chosen.
func (d *Daemon) jarvisSetting() (jarvisbrain.Setting, bool) {
	s := jarvisSettingOf(d.config().JarvisBrain)
	if s == nil {
		return jarvisbrain.Setting{}, false
	}
	return *s, true
}

func jarvisSettingOf(c *config.JarvisBrain) *jarvisbrain.Setting {
	if c == nil {
		return nil
	}
	s := jarvisbrain.Setting{Agent: c.Agent, Sub: c.Sub, AutoAnswer: c.AutoAnswer}
	if s.AutoAnswer == "" {
		s.AutoAnswer = jarvisbrain.AutoRoutine
	}
	return &s
}

func jarvisConfigOf(s *jarvisbrain.Setting) *config.JarvisBrain {
	if s == nil {
		return nil
	}
	return &config.JarvisBrain{Agent: s.Agent, Sub: s.Sub, AutoAnswer: s.AutoAnswer}
}

func (d *Daemon) jarvisBinary(agent string) string {
	if d.mgr == nil {
		return ""
	}
	return d.mgr.AgentBinary(agent)
}

// jarvisSub is the subscription id the brain runs on, "" for the user's own
// sign-in: the one chosen, else the one new sessions of the agent start on.
func (d *Daemon) jarvisSub(set jarvisbrain.Setting) string {
	switch set.Sub {
	case "":
		return d.config().DefaultSubscriptionFor(set.Agent)
	case subs.DefaultID:
		return ""
	}
	return set.Sub
}

func jarvisAgentName(agent string) string {
	if agent == jarvisbrain.AgentCodex {
		return "Codex"
	}
	return "Claude Code"
}

// jarvisEnv is the run's environment: the login shell's, and on a
// subscription its directory in CLAUDE_CONFIG_DIR or CODEX_HOME without the
// variables that would outrank that sign-in (subs.CredentialEnv), as a
// session on it gets (agents.onSubscription).
func (d *Daemon) jarvisEnv(set jarvisbrain.Setting) ([]string, error) {
	env := userenv.Environ(d.log)
	id := d.jarvisSub(set)
	if id == "" {
		return env, nil
	}
	sub, ok := subs.Find(d.config().Subscriptions, id)
	if !ok {
		return nil, fmt.Errorf("the sign-in chosen for Jarvis's brain was removed: choose another in Jarvis")
	}
	if sub.Agent != set.Agent {
		return nil, fmt.Errorf("%s is a %s sign-in, not %s", sub.Label, jarvisAgentName(sub.Agent), jarvisAgentName(set.Agent))
	}
	if err := d.prepareSub(sub); err != nil {
		return nil, err
	}
	return jarvisSubEnv(env, set.Agent, subs.Dir(d.opt.DataDir, id)), nil
}

// jarvisSubEnv is env pointed at a subscription's directory.
func jarvisSubEnv(env []string, agent, dir string) []string {
	// Upper-cased: Windows reads environment names without regard to case.
	drop := map[string]bool{strings.ToUpper(subs.EnvVar(agent)): true}
	for _, k := range subs.CredentialEnv(agent) {
		drop[strings.ToUpper(k)] = true
	}
	out := make([]string, 0, len(env)+1)
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		if drop[strings.ToUpper(k)] {
			continue
		}
		out = append(out, kv)
	}
	return append(out, subs.EnvVar(agent)+"="+dir)
}

// jarvisCheck says whether the brain can run on set: the agent installed,
// the sign-in there and signed in (read from the files the agent wrote,
// subs.Status; nothing is run).
func (d *Daemon) jarvisCheck(set jarvisbrain.Setting) (string, string) {
	name := jarvisAgentName(set.Agent)
	if d.jarvisBinary(set.Agent) == "" {
		return jarvisbrain.StateError, name + " was not found on this computer."
	}
	id := d.jarvisSub(set)
	if id == "" {
		home, _ := os.UserHomeDir()
		env := userenv.Cached()
		if len(subs.CredentialEnvSet(set.Agent, env)) > 0 {
			return "", "" // signed in by a key or token the shell exports
		}
		getenv := func(k string) string {
			for i := len(env) - 1; i >= 0; i-- {
				if v, ok := strings.CutPrefix(env[i], k+"="); ok {
					return v
				}
			}
			return ""
		}
		if !subs.Status(subs.DefaultPaths(set.Agent, home, getenv)).SignedIn {
			return jarvisbrain.StateSignedOut, "Your own " + name + " sign-in looks signed out: sign in with " + name + " in a terminal."
		}
		return "", ""
	}
	sub, ok := subs.Find(d.config().Subscriptions, id)
	if !ok || sub.Agent != set.Agent {
		return jarvisbrain.StateError, "The sign-in chosen for Jarvis's brain is gone: choose another."
	}
	if !subs.Status(subs.ProfilePaths(set.Agent, subs.Dir(d.opt.DataDir, id))).SignedIn {
		return jarvisbrain.StateSignedOut, "The " + sub.Label + " sign-in is signed out: sign in again in Settings → Subscriptions."
	}
	return "", ""
}
