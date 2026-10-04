package codex

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Model is one model the Codex CLI offers in its own picker.
type Model struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// ListedModels is the models Codex itself lists, read from the catalog it
// caches at `$CODEX_HOME/models_cache.json`, in the order of its own picker.
//
// Read from the CLI's cache rather than written into Caprock: the catalog is
// per account and changes with Codex releases, and the Claude and Gemini lists
// in the dialog were both wrong the first time they were written from memory.
// Only `visibility: "list"` entries are offered — the rest are Codex's own
// machinery (`codex-auto-review`) or hidden. Empty when there is no cache.
func ListedModels() []Model {
	home := Home()
	if home == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(home, "models_cache.json"))
	if err != nil {
		return nil
	}
	var cache struct {
		Models []struct {
			Slug        string `json:"slug"`
			DisplayName string `json:"display_name"`
			Visibility  string `json:"visibility"`
			Priority    int    `json:"priority"`
		} `json:"models"`
	}
	if err := json.Unmarshal(b, &cache); err != nil {
		return nil
	}
	sort.SliceStable(cache.Models, func(i, j int) bool { return cache.Models[i].Priority < cache.Models[j].Priority })
	var out []Model
	for _, m := range cache.Models {
		if m.Visibility != "list" || m.Slug == "" {
			continue
		}
		label := m.DisplayName
		if label == "" {
			label = m.Slug
		}
		out = append(out, Model{ID: m.Slug, Label: label})
	}
	return out
}

// ConfiguredModel is the `model = "…"` set at the top of
// `$CODEX_HOME/config.toml` — what a session started without -m runs on — or
// "" when none is set. Only the top-level key is read: a `model` inside a
// [profile] table applies to that profile, not to a plain start.
func ConfiguredModel() string {
	home := Home()
	if home == "" {
		return ""
	}
	f, err := os.Open(filepath.Join(home, "config.toml"))
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "[") {
			return "" // a table began; the top level had no model
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(key) != "model" {
			continue
		}
		val = strings.TrimSpace(val)
		if i := strings.Index(val, "#"); i > 0 && !strings.HasPrefix(val, `"`) {
			val = strings.TrimSpace(val[:i])
		}
		if len(val) >= 2 && (val[0] == '"' || val[0] == '\'') {
			if j := strings.IndexByte(val[1:], val[0]); j >= 0 {
				return val[1 : 1+j]
			}
		}
		return ""
	}
	return ""
}
