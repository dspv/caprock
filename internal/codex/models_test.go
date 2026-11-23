package codex

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The catalog shape is copied from a real models_cache.json (codex-cli
// 0.160.0, 2026-10-04): hidden entries are Codex's own machinery and must not
// be offered, and the picker's order is its priority, not the file's.
func TestListedModelsReadsTheCLIsOwnCatalog(t *testing.T) {
	home := t.TempDir()
	t.Setenv(EnvHome, home)
	cache := `{"fetched_at":"2026-10-04T08:00:00Z","models":[
	  {"slug":"gpt-6-sol","display_name":"GPT-6-Sol","visibility":"list","priority":3},
	  {"slug":"gpt-6-astra","display_name":"GPT-6-Astra","visibility":"list","priority":2},
	  {"slug":"codex-auto-review","display_name":"Codex Auto Review","visibility":"hide","priority":43},
	  {"slug":"gpt-reserve","display_name":"GPT-Reserve","visibility":"hide","priority":4}
	]}`
	if err := os.WriteFile(filepath.Join(home, "models_cache.json"), []byte(cache), 0o600); err != nil {
		t.Fatal(err)
	}
	got := ListedModels()
	if len(got) != 2 || got[0].ID != "gpt-6-astra" || got[0].Label != "GPT-6-Astra" || got[1].ID != "gpt-6-sol" {
		t.Fatalf("listed models: %+v", got)
	}
}

// signInCache is a catalog shaped like upstream's models.json
// (openai/codex codex-rs/models-manager/models.json, read 2026-11-23):
// gpt-6.2-sol is not offered on the free plan, gpt-chat-only runs only
// through the Codex backend, and gpt-5.5 carries neither field, as a cache
// written by current Codex does not.
const signInCache = `{"models":[
  {"slug":"gpt-6.2-sol","display_name":"GPT-6.2-Sol","visibility":"list","priority":1,"supported_in_api":true,"available_in_plans":["plus","pro","team"]},
  {"slug":"gpt-6-luna","display_name":"GPT-6-Luna","visibility":"list","priority":2,"supported_in_api":true,"available_in_plans":["free","plus","pro","team"]},
  {"slug":"gpt-chat-only","display_name":"GPT-Chat-Only","visibility":"list","priority":3,"supported_in_api":false,"available_in_plans":["free","plus","pro"]},
  {"slug":"gpt-5.5","display_name":"GPT-5.5","visibility":"list","priority":4}
]}`

// fakeIDToken is an unsigned JWT whose payload carries only the plan claim.
func fakeIDToken(plan string) string {
	enc := base64.RawURLEncoding.EncodeToString
	payload := `{"https://api.openai.com/auth":{"chatgpt_plan_type":"` + plan + `"}}`
	return enc([]byte(`{"alg":"none"}`)) + "." + enc([]byte(payload)) + ".fake"
}

func TestListedModelsKeepsWhatTheSignInCanRun(t *testing.T) {
	for name, tc := range map[string]struct {
		auth string // auth.json; "" means none
		want []string
	}{
		"api key, explicit mode": {`{"auth_mode":"apikey","OPENAI_API_KEY":"not-a-real-key"}`,
			[]string{"gpt-6.2-sol", "gpt-6-luna", "gpt-5.5"}},
		"api key, mode inferred from the key": {`{"OPENAI_API_KEY":"not-a-real-key","tokens":null}`,
			[]string{"gpt-6.2-sol", "gpt-6-luna", "gpt-5.5"}},
		"chatgpt free plan": {`{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"` + fakeIDToken("free") + `"}}`,
			[]string{"gpt-6-luna", "gpt-chat-only", "gpt-5.5"}},
		"chatgpt pro plan": {`{"auth_mode":"chatgpt","tokens":{"id_token":"` + fakeIDToken("pro") + `"}}`,
			[]string{"gpt-6.2-sol", "gpt-6-luna", "gpt-chat-only", "gpt-5.5"}},
		"chatgpt, mode inferred, plan unreadable": {`{"OPENAI_API_KEY":null,"tokens":{"id_token":"garbage"}}`,
			[]string{"gpt-6.2-sol", "gpt-6-luna", "gpt-chat-only", "gpt-5.5"}},
		"no auth.json (keyring)": {"",
			[]string{"gpt-6.2-sol", "gpt-6-luna", "gpt-chat-only", "gpt-5.5"}},
	} {
		t.Run(name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv(EnvHome, home)
			if err := os.WriteFile(filepath.Join(home, "models_cache.json"), []byte(signInCache), 0o600); err != nil {
				t.Fatal(err)
			}
			if tc.auth != "" {
				if err := os.WriteFile(filepath.Join(home, "auth.json"), []byte(tc.auth), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			var got []string
			for _, m := range ListedModels() {
				got = append(got, m.ID)
			}
			if strings.Join(got, ",") != strings.Join(tc.want, ",") {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestListedModelsIsEmptyWithoutACache(t *testing.T) {
	t.Setenv(EnvHome, t.TempDir())
	if got := ListedModels(); len(got) != 0 {
		t.Fatalf("no cache, got %+v", got)
	}
}

func TestConfiguredModelReadsOnlyTheTopLevel(t *testing.T) {
	for name, tc := range map[string]struct{ toml, want string }{
		"top level":       {"personality = \"x\"\nmodel = \"gpt-6-astra\"\n[projects.\"/a\"]\ntrust_level = \"trusted\"\n", "gpt-6-astra"},
		"comment":         {"model = 'gpt-5.5' # pinned\n", "gpt-5.5"},
		"only in a table": {"[profiles.fast]\nmodel = \"gpt-6-luna\"\n", ""},
		"none":            {"personality = \"x\"\n", ""},
	} {
		t.Run(name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv(EnvHome, home)
			if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(tc.toml), 0o600); err != nil {
				t.Fatal(err)
			}
			if got := ConfiguredModel(); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// Each listed model carries the effort Codex runs it at by default
// (ModelInfo.default_reasoning_level), and the top-level
// model_reasoning_effort is read like the model, never a table's.
func TestModelEffortsFromTheCacheAndTheConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv(EnvHome, home)
	cache := `{"models":[
	  {"slug":"gpt-6-astra","display_name":"GPT-6-Astra","visibility":"list","priority":1,"default_reasoning_level":"medium","supported_reasoning_levels":[{"effort":"low","description":"l"},{"effort":"medium","description":"m"}]},
	  {"slug":"gpt-6-sol","display_name":"GPT-6-Sol","visibility":"list","priority":2}
	]}`
	if err := os.WriteFile(filepath.Join(home, "models_cache.json"), []byte(cache), 0o600); err != nil {
		t.Fatal(err)
	}
	got := ListedModels()
	if len(got) != 2 || got[0].DefaultEffort != "medium" || got[1].DefaultEffort != "" {
		t.Fatalf("defaults: %+v", got)
	}
	if ConfiguredEffort() != "" {
		t.Fatal("no config, an effort")
	}
	toml := "model = \"gpt-6-astra\"\nmodel_reasoning_effort = \"high\"\n[profiles.deep]\nmodel_reasoning_effort = \"xhigh\"\n"
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(toml), 0o600); err != nil {
		t.Fatal(err)
	}
	if e, m := ConfiguredEffort(), ConfiguredModel(); e != "high" || m != "gpt-6-astra" {
		t.Fatalf("configured effort %q, model %q", e, m)
	}
}
