package agentcat

import (
	"path/filepath"
	"testing"
)

// Claude Code's default effort, as it resolves one: the environment over
// everything, a level saved for the model over the model's own default, and
// the documented default for the models the sheet offers.
func TestClaudeEffortDefaults(t *testing.T) {
	env := testEnv(t)
	e := claudeEntry(env, true, false)
	if len(e.Efforts) != 5 || e.EffortDefault != "" || e.ModelEfforts["claude-opus-5-5"] != "medium" || e.ModelEfforts["claude-fable-5-2"] != "medium" {
		t.Fatalf("documented defaults: %+v", e)
	}

	// A level saved per model wins for that model only; max is not a level
	// the key accepts, and a top-level user effortLevel does not count for
	// the current models.
	write(t, filepath.Join(env.Home, ".claude", "settings.json"), `{"effortLevel": "low", "modelSettings": {"claude-opus-5-5": {"effortLevel": "high"}, "claude-sonnet-5-5": {"effortLevel": "bogus"}}}`)
	e = claudeEntry(env, true, false)
	if e.ModelEfforts["claude-opus-5-5"] != "high" || e.ModelEfforts["claude-sonnet-5-5"] != "medium" || e.ModelEfforts["claude-haiku-5-5"] != "medium" || e.EffortDefault != "" {
		t.Fatalf("saved level: %+v", e.ModelEfforts)
	}

	// CLAUDE_CONFIG_DIR moves the settings it reads.
	other := t.TempDir()
	write(t, filepath.Join(other, "settings.json"), `{"modelSettings": {"claude-haiku-5-5": {"effortLevel": "low"}}}`)
	env.Vars = []string{"CLAUDE_CONFIG_DIR=" + other}
	e = claudeEntry(env, true, false)
	if e.ModelEfforts["claude-haiku-5-5"] != "low" || e.ModelEfforts["claude-opus-5-5"] != "medium" {
		t.Fatalf("config dir: %+v", e.ModelEfforts)
	}

	// The environment variable decides for every model; "auto" sends none.
	env.Vars = []string{"CLAUDE_CODE_EFFORT_LEVEL=xhigh"}
	e = claudeEntry(env, true, false)
	if e.EffortDefault != "xhigh" || e.ModelEfforts != nil {
		t.Fatalf("env level: %+v", e)
	}
	env.Vars = []string{"CLAUDE_CODE_EFFORT_LEVEL=auto"}
	e = claudeEntry(env, true, false)
	if e.EffortDefault != "" || e.ModelEfforts != nil || len(e.Efforts) != 5 {
		t.Fatalf("auto: %+v", e)
	}

	// Not installed: nothing to pick.
	if e := claudeEntry(env, false, false); e.Efforts != nil {
		t.Fatalf("not installed: %+v", e)
	}
}

func TestCodexEffortDefaults(t *testing.T) {
	var e Entry
	codexEfforts(&e, "", map[string]string{"gpt-6-astra": "medium"})
	if len(e.Efforts) != 4 || e.EffortDefault != "" || e.ModelEfforts["gpt-6-astra"] != "medium" {
		t.Fatalf("per model: %+v", e)
	}
	e = Entry{}
	codexEfforts(&e, "high", map[string]string{"gpt-6-astra": "medium"})
	if e.EffortDefault != "high" || e.ModelEfforts != nil {
		t.Fatalf("configured: %+v", e)
	}
}

// Agents with no launch-time effort carry none.
func TestOnlyClaudeAndCodexCarryEfforts(t *testing.T) {
	env := testEnv(t)
	t.Setenv("CODEX_HOME", t.TempDir()) // never the real ~/.codex
	for _, e := range Builtins(env, func(string) bool { return true }) {
		has := len(e.Efforts) > 0
		if want := e.ID == "claude" || e.ID == "codex"; has != want {
			t.Errorf("%s: efforts %v", e.ID, e.Efforts)
		}
	}
}
