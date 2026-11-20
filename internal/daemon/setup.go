package daemon

import (
	"net/http"
	"os"
	"runtime"
	"strings"

	"github.com/dspv/caprock/internal/agentcat"
	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/readiness"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/subs"
	"github.com/dspv/caprock/internal/userenv"
)

// setupAdapter gathers GET /v1/setup's facts (ADR-099). Everything is read
// from files, the user's PATH as it is now and the database: nothing is run,
// no token's content is read, the Keychain is never touched.
type setupAdapter struct{ d *Daemon }

func (a *setupAdapter) SetupFacts(r *http.Request) (readiness.Inputs, error) {
	path, fresh := userenv.CurrentPath(a.d.log)
	in := readiness.Inputs{
		GOOS: runtime.GOOS,
		Git:  readiness.Git{Found: readiness.GitFinder{GOOS: runtime.GOOS, Dirs: userenv.Dirs(path)}.Found(), Fresh: fresh},
	}
	cfg := a.d.config()
	env := agentcat.DefaultEnv(userenv.Cached())
	home := env.Home
	entries := agentcat.Builtins(env, a.d.mgr.AgentAvailable)
	for _, e := range entries {
		if e.ID != agents.AgentClaude && e.ID != agents.AgentCodex {
			continue
		}
		ag := readiness.Agent{ID: e.ID, Label: e.Label, Installed: e.Installed}
		if e.Setup != nil && e.Setup.Reason == "not_installed" {
			ag.Install = e.Setup.Command
		}
		if e.Installed {
			ag.SignIn = signInState(e.ID, home, env.Vars, a.d.opt.DataDir, cfg)
			ag.SignInCommand = subs.LoginCommandHere(e.ID, "")
		}
		in.Agents = append(in.Agents, ag)
	}
	ps, err := store.ListProjects(r.Context(), a.d.store.DB(), false)
	if err != nil {
		return in, err
	}
	in.Projects = len(ps)
	return in, nil
}

// signInState says whether an installed agent is signed in, from what it
// wrote (ADR-048's reading, subs.Status): the user's own sign-in, any of
// Caprock's subscriptions for it, or a credential the login shell exports.
// Presence only — no token is read for its content.
//
//   - Claude Code writes `oauthAccount` into .claude.json when it signs in,
//     wherever the credential itself is kept, so its absence is a reliable
//     "not signed in" (missing).
//   - Codex may keep its sign-in in the OS keyring and write no auth.json, so
//     no file proves nothing: unknown, never missing.
func signInState(agent, home string, vars []string, dataDir string, cfg config.Config) string {
	getenv := func(k string) string {
		for i := len(vars) - 1; i >= 0; i-- {
			if kk, v, ok := strings.Cut(vars[i], "="); ok && kk == k {
				return v
			}
		}
		return os.Getenv(k)
	}
	if subs.Status(subs.DefaultPaths(agent, home, getenv)).SignedIn {
		return readiness.OK
	}
	for _, s := range cfg.Subscriptions {
		if s.Agent == agent && subs.Status(subs.ProfilePaths(agent, subs.Dir(dataDir, s.ID))).SignedIn {
			return readiness.OK
		}
	}
	if len(subs.CredentialEnvSet(agent, vars)) > 0 {
		return readiness.OK
	}
	if agent == agents.AgentCodex {
		return readiness.Unknown
	}
	return readiness.Missing
}
