package agentcat

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/config"
)

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func testEnv(t *testing.T) Env {
	home := t.TempDir()
	// The daemon's own XDG variables must not leak into a test's home.
	for _, k := range []string{"XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"} {
		t.Setenv(k, "")
	}
	return Env{Home: home, GOOS: "darwin"}
}

const catalog = `{
  "deepseek": {"id": "deepseek", "name": "DeepSeek", "env": ["DEEPSEEK_API_KEY"], "models": {"deepseek-chat": {"id": "deepseek-chat", "name": "DeepSeek Chat"}}},
  "anthropic": {"id": "anthropic", "name": "Anthropic", "env": ["ANTHROPIC_API_KEY"], "models": {"claude-x": {"id": "claude-x", "name": "Claude X"}, "old": {"id": "old", "name": "Old", "status": "deprecated"}}},
  "xai": {"id": "xai", "name": "xAI", "env": ["XAI_API_KEY"], "models": {"grok-4.7": {"id": "grok-4.7", "name": "Grok 4.7"}}}
}`

// The owner's report: OpenCode offered an empty list. With nothing connected
// it says so and names the command; connected, it lists that provider's models.
func TestOpenCodeWithoutAndWithAProvider(t *testing.T) {
	env := testEnv(t)
	write(t, filepath.Join(env.Home, ".cache", "opencode", "models.json"), catalog)
	e := opencodeEntry(env, true, false)
	if e.Ready || e.Setup == nil || e.Setup.Reason != "no_provider" || e.Setup.Command != "opencode auth login" || len(e.Models) != 0 {
		t.Fatalf("nothing connected: %+v", e)
	}

	// A key in the login shell connects its provider.
	env.Vars = []string{"DEEPSEEK_API_KEY=x"}
	e = opencodeEntry(env, true, false)
	if !e.Ready || e.Setup != nil || !reflect.DeepEqual(e.Models, []Model{{ID: "deepseek/deepseek-chat", Label: "DeepSeek · DeepSeek Chat"}}) {
		t.Fatalf("deepseek by env: %+v", e)
	}

	// A credential from `opencode auth login` connects too, deprecated models
	// are left out, and the config's model is the default (JSONC accepted).
	env.Vars = nil
	write(t, filepath.Join(env.Home, ".local", "share", "opencode", "auth.json"), `{"anthropic": {"type": "api", "key": "k"}}`)
	write(t, filepath.Join(env.Home, ".config", "opencode", "opencode.jsonc"), "{\n // mine\n \"model\": \"anthropic/claude-x\", /* note */\n \"theme\": \"x//y\",\n}\n")
	e = opencodeEntry(env, true, false)
	if !e.Ready || e.Default != "anthropic/claude-x" || len(e.Models) != 1 || e.Models[0].ID != "anthropic/claude-x" {
		t.Fatalf("anthropic by credential: %+v", e)
	}
}

func TestNotInstalledNamesTheInstall(t *testing.T) {
	env := testEnv(t)
	for _, e := range Builtins(env, func(string) bool { return false }) {
		if e.Installed || e.Ready || e.Setup == nil || e.Setup.Reason != "not_installed" || e.Setup.Command == "" || e.Setup.Docs == "" {
			t.Errorf("%s: %+v", e.ID, e)
		}
	}
	env.GOOS = "windows"
	got := map[string]string{}
	for _, e := range Builtins(env, func(string) bool { return false }) {
		got[e.ID] = e.Setup.Command
	}
	if got["grok"] != "irm https://x.ai/cli/install.ps1 | iex" || got["claude"] != "irm https://claude.ai/install.ps1 | iex" || got["opencode"] != "npm install -g opencode-ai" {
		t.Errorf("windows installs: %v", got)
	}
}

func TestGrokModelsAndSignIn(t *testing.T) {
	env := testEnv(t)
	write(t, filepath.Join(env.Home, ".grok", "models_cache.json"), `{"models": {"grok-4.5": {"info": {"id": "grok-4.5", "name": "Grok 4.5"}}, "secret": {"info": {"id": "secret", "name": "S", "hidden": true}}}}`)
	e := grokEntry(env, true, false)
	if !e.Ready || len(e.Models) != 1 || e.Models[0].ID != "grok-4.5" || e.Setup == nil || e.Setup.Reason != "signin" || e.Setup.Command != "grok login" {
		t.Fatalf("not signed in: %+v", e)
	}
	write(t, filepath.Join(env.Home, ".grok", "auth.json"), `{}`)
	if e := grokEntry(env, true, false); e.Setup != nil {
		t.Fatalf("signed in: %+v", e.Setup)
	}
	if e := grokEntry(env, true, false); e.Observed {
		t.Error("Grok sessions are not read yet, so not observed")
	}
}

func TestArgvFillsAndDropsPlaceholders(t *testing.T) {
	tmpl := []string{"--yes", "-m", "{model}", "--message={prompt}", "--verbose"}
	if got := Argv(tmpl, "fix it", "gpt-x"); !reflect.DeepEqual(got, []string{"--yes", "-m", "gpt-x", "--message=fix it", "--verbose"}) {
		t.Errorf("filled: %q", got)
	}
	if got := Argv(tmpl, "", ""); !reflect.DeepEqual(got, []string{"--yes", "--verbose"}) {
		t.Errorf("empty: %q", got)
	}
	// A prompt is one argument whatever it holds.
	if got := Argv([]string{"{prompt}"}, "a b; rm -rf /", ""); !reflect.DeepEqual(got, []string{"a b; rm -rf /"}) {
		t.Errorf("prompt: %q", got)
	}
}

func TestValidateCustom(t *testing.T) {
	got, err := ValidateCustom([]config.CustomAgent{{Name: " Aider (local) ", Command: "aider", Args: []string{"--yes", "", "{prompt}"}, Models: []string{"gpt-x", ""}}})
	if err != nil {
		t.Fatal(err)
	}
	if want := (config.CustomAgent{ID: "aider-local", Name: "Aider (local)", Command: "aider", Args: []string{"--yes", "{prompt}"}, Models: []string{"gpt-x"}}); !reflect.DeepEqual(got[0], want) {
		t.Errorf("got %+v", got[0])
	}
	if got, _ := ValidateCustom([]config.CustomAgent{{Name: "Claude", Command: "claude"}}); got[0].ID != "claude-custom" {
		t.Errorf("a built-in id was reused: %q", got[0].ID)
	}
	for name, bad := range map[string][]config.CustomAgent{
		"no name":     {{Command: "x"}},
		"no command":  {{Name: "x"}},
		"line break":  {{Name: "x", Command: "x", Args: []string{"a\nb"}}},
		"shell words": {{Name: "x", Command: "aider --yes"}},
		"duplicate":   {{Name: "x", Command: "x"}, {Name: "x", Command: "y"}},
		"bad id":      {{ID: "Bad Id", Name: "x", Command: "x"}},
	} {
		if _, err := ValidateCustom(bad); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	if _, err := ValidateCustom(make([]config.CustomAgent, 21)); err == nil || !strings.Contains(err.Error(), "at most") {
		t.Errorf("21 agents: %v", err)
	}
}

func TestCustomEntries(t *testing.T) {
	list := []config.CustomAgent{{ID: "aider", Name: "Aider", Command: "aider", Args: []string{"{prompt}"}, Models: []string{"m1"}}}
	found := func(string) string { return "/bin/aider" }
	// Free, with no licence (2026-11-27): installed is ready.
	e := CustomEntries(list, found)[0]
	if e.ID != "custom:aider" || !e.Ready || !e.Prompt || len(e.Models) != 1 {
		t.Errorf("installed: %+v", e)
	}
	if e := CustomEntries(list, func(string) string { return "" })[0]; e.Ready || e.Setup == nil {
		t.Errorf("missing command: %+v", e)
	}
	if a, ok := FindCustom(list, "custom:aider"); !ok || a.Name != "Aider" {
		t.Error("FindCustom")
	}
	if _, ok := FindCustom(list, "aider"); ok {
		t.Error("a bare id found a custom agent")
	}
}
