package daemon

import (
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/dspv/caprock/internal/agentcat"
	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/hooks"
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
	if sh := envVar(env.Vars, "SHELL"); sh != "" {
		in.Shell = filepath.Base(sh)
	}
	// An agent found where a terminal does not look (readiness.OffPath).
	// Only asked when the terminal's PATH could be read: a guess would tell
	// someone to fix a PATH that is fine.
	tpath, tok := userenv.TerminalPath(a.d.log)
	off := readiness.OffPath{GOOS: runtime.GOOS, Home: home, Dirs: userenv.Dirs(tpath)}
	getenv := func(k string) string { return envVar(env.Vars, k) }
	finder := readiness.ToolFinder{GOOS: runtime.GOOS, Dirs: userenv.Dirs(path)}
	tools := readiness.ToolFacts{
		Node: finder.Found(readiness.ToolNode),
		GH:   finder.Found(readiness.ToolGH),
		Brew: runtime.GOOS == "darwin" && finder.Found("brew"),
	}
	tools.GHSignedIn = readiness.GHSignedIn(readiness.GHHosts(runtime.GOOS, home, getenv), getenv)
	in.Tools = &tools
	// Every built-in Caprock can start that is installed here or can be
	// installed with one command, each with its switch (ADR-099 amendment).
	for _, e := range agentcat.Builtins(env, a.d.mgr.AgentAvailable) {
		install := ""
		if e.Setup != nil && e.Setup.Reason == "not_installed" {
			install = e.Setup.Command
		}
		if !e.Installed && install == "" {
			continue
		}
		ag := readiness.Agent{ID: e.ID, Label: e.Label, Installed: e.Installed, Install: install,
			On: readiness.AgentOn(e.ID, e.Installed, cfg.SetupAgents)}
		if e.Installed && e.ID == agents.AgentClaude {
			tools.Claude = true
			tools.Bypass, _ = bypassAccepted()
			tools.Chrome, _ = hooks.ChromeDefault(subs.DefaultPaths(agents.AgentClaude, home, getenv).GlobalConfig)
		}
		if e.Installed {
			switch e.ID {
			case agents.AgentClaude, agents.AgentCodex:
				ag.SignIn = signInState(e.ID, home, env.Vars, a.d.opt.DataDir, cfg)
				ag.SignInCommand = subs.LoginCommandHere(e.ID, "")
			default:
				// The others say themselves what they lack (a provider, a
				// sign-in): the catalog's Setup, else nothing is missing.
				ag.SignIn = readiness.OK
				if e.Setup != nil {
					ag.SignIn, ag.SignInText, ag.SignInCommand = readiness.Missing, e.Setup.Text, e.Setup.Command
				}
			}
			if tok {
				ag.OffPath = off.Dir(binaryOf(e.ID))
			}
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

// EnableChromeDefault turns Claude in Chrome's "Enabled by default" on in
// Claude Code's global config here, as its /chrome dialog does (POST
// /v1/setup/run, step chrome_default; hooks.ChromeDefaultKey).
func (a *setupAdapter) EnableChromeDefault() error {
	env := agentcat.DefaultEnv(userenv.Cached())
	getenv := func(k string) string { return envVar(env.Vars, k) }
	p := subs.DefaultPaths(agents.AgentClaude, env.Home, getenv).GlobalConfig
	if p == "" {
		return os.ErrNotExist
	}
	return hooks.EnableChromeDefault(p)
}

// binaryOf is the program an agent runs as, for the PATH check: Cursor's
// CLI is cursor-agent, the rest their id.
func binaryOf(id string) string {
	if id == "cursor" {
		return "cursor-agent"
	}
	return id
}

// SetAgentSwitch keeps an agent's switch in the settings (PUT
// /v1/setup/agents/{id}). Nothing else changes: nothing is installed or
// removed.
func (a *setupAdapter) SetAgentSwitch(id string, on bool) error {
	a.d.cfgMu.Lock()
	// A new map, never the old one written: a copy of the config handed out
	// earlier (config()) may still be reading it.
	next := maps.Clone(a.d.opt.Config.SetupAgents)
	if next == nil {
		next = map[string]bool{}
	}
	next[id] = on
	a.d.opt.Config.SetupAgents = next
	cfg := a.d.opt.Config
	a.d.cfgMu.Unlock()
	return config.Save(a.d.opt.DataDir, cfg)
}

// envVar is k in vars (the login environment), the last one winning, else
// the daemon's own.
func envVar(vars []string, k string) string {
	for i := len(vars) - 1; i >= 0; i-- {
		if kk, v, ok := strings.Cut(vars[i], "="); ok && kk == k {
			return v
		}
	}
	return os.Getenv(k)
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
	getenv := func(k string) string { return envVar(vars, k) }
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
