package agentcat

import (
	"path/filepath"
	"strings"

	"github.com/dspv/caprock/internal/agents"
)

// The effort a session would start at if nothing were passed, so the New
// agent sheet can mark that level as the default and pass nothing while it is
// kept (owner, 2026-11-23). Read from the files the agent itself reads, on
// the machine it runs on, never written; a level that cannot be known is left
// out, and the sheet then marks none.

// claudeDocumentedEffort is each current Claude model's own default effort:
// "Fable 5.2, Opus 5.5, Sonnet 5.5, and Haiku 5.5 default to medium"
// (code.claude.com/docs/en/model-config, "Adjust effort level", read
// 2026-11-23). Only the models the New agent sheet offers are named; for any
// other the default is not stated here.
var claudeDocumentedEffort = map[string]string{
	"claude-fable-5-2":  "medium",
	"claude-opus-5-5":   "medium",
	"claude-sonnet-5-5": "medium",
	"claude-haiku-5-5":  "medium",
}

// claudeEfforts fills e's effort fields from what Claude Code resolves a
// session's effort from, in its own order (model-config, "Adjust effort
// level"): CLAUDE_CODE_EFFORT_LEVEL in the environment over everything (and
// over --effort, so a session started with a pick runs without it, see
// agents.withEffort); then a level saved for the model under `modelSettings`
// in the user settings; then the model's own default. A top-level
// `effortLevel` in the user settings is not read: it applies only to Opus 5,
// Fable 5.1 and older models (settings-reference, `effortLevel`), none of
// which the sheet offers. Project and managed settings are not read either —
// they depend on the folder and the organisation — so a level set there is
// not marked.
func claudeEfforts(env Env, e *Entry) {
	e.Efforts = agents.EffortLevels(agents.AgentClaude)
	if v := strings.TrimSpace(env.get(agents.ClaudeEffortEnv)); v != "" {
		// "auto" or "unset" asks Claude Code to send no level at all: no
		// default to mark.
		if agents.ValidEffort(agents.AgentClaude, v) {
			e.EffortDefault = v
		}
		return
	}
	dir := env.get("CLAUDE_CONFIG_DIR")
	if dir == "" {
		dir = filepath.Join(env.Home, ".claude")
	}
	var settings struct {
		ModelSettings map[string]struct {
			EffortLevel string `json:"effortLevel"`
		} `json:"modelSettings"`
	}
	readJSON(filepath.Join(dir, "settings.json"), &settings)
	out := map[string]string{}
	for model, level := range claudeDocumentedEffort {
		out[model] = level
	}
	for model, s := range settings.ModelSettings {
		if s.EffortLevel != "" && agents.ValidEffort(agents.AgentClaude, s.EffortLevel) {
			out[model] = s.EffortLevel
		}
	}
	e.ModelEfforts = out
}

// codexEfforts fills e's effort fields the way Codex resolves one: the
// top-level `model_reasoning_effort` in config.toml for every model, else
// each model's `default_reasoning_level` from its models_cache.json.
func codexEfforts(e *Entry, configured string, defaults map[string]string) {
	e.Efforts = agents.EffortLevels(agents.AgentCodex)
	if configured != "" {
		e.EffortDefault = configured
		return
	}
	if len(defaults) > 0 {
		e.ModelEfforts = defaults
	}
}
