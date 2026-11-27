// Package agentcat answers "which coding agents can start here, on which
// models, and what is missing for the rest" — the New agent sheet's and Quick
// chat's picker (GET /v1/agents/catalog, ADR-046).
//
// The owner's report that started it (2026-10-10, translated): "there's a
// model choice, and OpenCode there is empty — either give buttons to connect
// it or remove it". An agent offered with nothing to pick is a dead end; an
// agent hidden because it is not installed is a feature nobody finds. So each
// agent says whether it is installed, whether it looks set up, the models its
// own files list, and — when something is missing — the command that fixes
// it, which the page offers to type into a shell tab without running it.
//
// Everything here reads files the agents already wrote and the login shell's
// environment. Nothing is run and nothing goes over the network: `opencode
// models` and `grok models` would fetch catalogs, and rule 4 says the daemon
// makes no call the user did not switch on.
package agentcat

import (
	"encoding/json"
	"os"
	"runtime"
	"sort"
	"strings"

	"github.com/dspv/caprock/internal/codex"
)

// Model is one choice in a model picker.
type Model struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// Refused: Codex refused it on this sign-in in a session Caprock started
	// (codex.Model.Refused); listed last, its label says so.
	Refused bool `json:"refused,omitempty"`
}

// Setup is what stands between an agent and a working session.
type Setup struct {
	// Reason is "not_installed", "no_provider" (OpenCode with nothing
	// connected, Hermes with no model chosen) or "signin" (an agent whose
	// credentials Caprock found none of).
	Reason string `json:"reason"`
	// Text says it in one sentence, for the picker.
	Text string `json:"text"`
	// Command fixes it: an install, a sign-in. Typed into a shell tab for the
	// user to read and run, never run by Caprock.
	Command string `json:"command,omitempty"`
	// Docs is the agent's own page on it.
	Docs string `json:"docs,omitempty"`
}

// Entry is one agent in the picker.
type Entry struct {
	// ID is what a spawn request names: "claude", "grok", "custom:<id>".
	ID    string `json:"id"`
	Label string `json:"label"`
	// Installed is true when its binary was found.
	Installed bool `json:"installed"`
	// Ready is Installed and nothing Caprock can see is missing.
	Ready bool `json:"ready"`
	// Default is the model its own config names, "" for none known.
	Default string `json:"default,omitempty"`
	// Models are the choices its own files list. Claude Code's and Gemini
	// CLI's are the page's own checked lists (SpawnDialog.tsx) and are empty
	// here.
	Models []Model `json:"models"`
	// Efforts are the reasoning efforts it takes at launch, lowest first
	// (agents.EffortLevels: Claude Code's --effort, Codex's
	// model_reasoning_effort); absent for an agent that takes none. The
	// pickers draw an Effort control only where this is set, so a computer
	// running an older Caprock, which would drop the field, never shows one.
	Efforts []string `json:"efforts,omitempty"`
	// EffortDefault is the effort every session of it starts at when none is
	// passed, as its own settings on this machine say (Claude Code's
	// CLAUDE_CODE_EFFORT_LEVEL, Codex's model_reasoning_effort); "" when
	// that depends on the model or is not known.
	EffortDefault string `json:"effort_default,omitempty"`
	// ModelEfforts is that default per model id, where it depends on the
	// model: a level saved for it, else the model's own documented or listed
	// default. A model not named here has no default Caprock can state.
	ModelEfforts map[string]string `json:"model_efforts,omitempty"`
	// TypedModel is true when a model may be typed rather than picked
	// (OpenCode's provider/model).
	TypedModel bool `json:"typed_model,omitempty"`
	// Observed is true when Caprock reads the sessions' turns and cost.
	Observed bool `json:"observed"`
	// Custom marks an agent the user added (ADR-046).
	Custom bool `json:"custom,omitempty"`
	// Prompt is false for a custom agent whose args have no {prompt}: a
	// first message would be dropped, so the page says so.
	Prompt bool   `json:"prompt"`
	Setup  *Setup `json:"setup,omitempty"`
}

// Env is what the catalog reads besides files: the login shell's
// environment, the home directory and the platform.
type Env struct {
	Vars []string
	Home string
	GOOS string
}

// DefaultEnv is the running machine's.
func DefaultEnv(vars []string) Env {
	home, _ := os.UserHomeDir()
	if len(vars) == 0 {
		vars = os.Environ()
	}
	return Env{Vars: vars, Home: home, GOOS: runtime.GOOS}
}

func (e Env) get(key string) string {
	for i := len(e.Vars) - 1; i >= 0; i-- {
		if strings.HasPrefix(e.Vars[i], key+"=") {
			return e.Vars[i][len(key)+1:]
		}
	}
	return ""
}

// Builtins lists the agents Caprock knows, in the picker's order. installed
// says whether each one's binary was found.
func Builtins(env Env, installed func(agent string) bool) []Entry {
	win := env.GOOS == "windows"
	out := []Entry{
		claudeEntry(env, installed("claude"), win),
		codexEntry(installed("codex")),
		opencodeEntry(env, installed("opencode"), win),
		geminiEntry(installed("gemini")),
		grokEntry(env, installed("grok"), win),
		hermesEntry(env, installed("hermes"), win),
		cursorEntry(env, installed("cursor"), win),
	}
	return out
}

func notInstalled(name, command, docs string) *Setup {
	return &Setup{Reason: "not_installed", Text: name + " is not installed on this machine.", Command: command, Docs: docs}
}

func claudeEntry(env Env, ok, win bool) Entry {
	e := Entry{ID: "claude", Label: "Claude Code", Installed: ok, Ready: ok, Observed: true, Prompt: true, Models: []Model{}}
	if ok {
		claudeEfforts(env, &e)
	}
	if !ok {
		// code.claude.com/docs/en/setup, read 2026-10-10.
		cmd := "curl -fsSL https://claude.ai/install.sh | bash"
		if win {
			cmd = "irm https://claude.ai/install.ps1 | iex"
		}
		e.Setup = notInstalled("Claude Code", cmd, "https://code.claude.com/docs/en/setup")
	}
	return e
}

func codexEntry(ok bool) Entry {
	e := Entry{ID: "codex", Label: "Codex", Installed: ok, Observed: true, Prompt: true, Models: []Model{}}
	if !ok {
		// github.com/openai/codex README, read 2026-10-10.
		e.Setup = notInstalled("Codex", "npm install -g @openai/codex", "https://github.com/openai/codex")
		return e
	}
	defaults := map[string]string{}
	for _, m := range codex.ListedModels() {
		e.Models = append(e.Models, Model{ID: m.ID, Label: m.Label, Refused: m.Refused})
		if m.DefaultEffort != "" {
			defaults[m.ID] = m.DefaultEffort
		}
	}
	e.Default = codex.DefaultModel()
	codexEfforts(&e, codex.ConfiguredEffort(), defaults)
	// Not checked for a sign-in: Codex can keep its credentials in the OS
	// keyring instead of auth.json, so a missing file proves nothing, and it
	// asks on its first start anyway.
	e.Ready = true
	return e
}

func geminiEntry(ok bool) Entry {
	// Gemini CLI signs in with Google on its first start, or takes a key from
	// the environment or the Cost screen; where it keeps a Google sign-in
	// differs by version, so Caprock does not claim to know whether there is
	// one.
	e := Entry{ID: "gemini", Label: "Gemini CLI", Installed: ok, Ready: ok, Observed: true, Prompt: true, Models: []Model{}}
	if !ok {
		// github.com/google-gemini/gemini-cli README, read 2026-10-10.
		e.Setup = notInstalled("Gemini CLI", "npm install -g @google/gemini-cli", "https://github.com/google-gemini/gemini-cli")
	}
	return e
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func readJSON(p string, v any) bool {
	b, err := os.ReadFile(p)
	if err != nil {
		return false
	}
	return json.Unmarshal(b, v) == nil
}

func sortModels(ms []Model) {
	sort.SliceStable(ms, func(i, j int) bool { return ms[i].Label < ms[j].Label })
}
