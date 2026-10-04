package codex

import (
	"os"
	"path/filepath"
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
