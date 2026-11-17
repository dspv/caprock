package cost_test

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/gemini"
)

// launchMenus is the file that holds the model lists the New agent dialog,
// the phone sheet and Quick chat offer (MODELS, GEMINI_MODELS).
const launchMenus = "../../ui/src/components/SpawnDialog.tsx"

// offeredInUI reads the model ids out of an exported list in SpawnDialog.tsx:
// `export const NAME: [...][] = [ ['id', 'label'], ... ]`.
func offeredInUI(t *testing.T, src, name string) []string {
	t.Helper()
	block := regexp.MustCompile(`(?s)export const ` + name + `\b[^=]*=\s*\[(.*?)\n\]`).FindStringSubmatch(src)
	if block == nil {
		t.Fatalf("%s: no `export const %s` list; the test must follow the list if it moved", launchMenus, name)
	}
	var ids []string
	for _, m := range regexp.MustCompile(`\[\s*'([^']+)'\s*,`).FindAllStringSubmatch(block[1], -1) {
		ids = append(ids, m[1])
	}
	if len(ids) == 0 {
		t.Fatalf("%s: %s lists no model", launchMenus, name)
	}
	return ids
}

// Every model id Caprock itself offers to start a session on has a pricing
// row, matched by the same rule a turn is priced by. An offered model with no
// row starts sessions whose turns are unpriced from the first one — the
// failure the Gemini list made once and Kimi made until 2026-11-17.1.
//
// Cursor is not here on purpose: a Cursor chat carries Cursor's own cost and
// is never priced from the table (ADR-095). Codex's and OpenCode's lists are
// read from their own caches at run time, so they cannot be checked here; the
// daily pricing watch (scripts/pricing-watch.py) checks Codex's published
// catalog instead.
func TestEveryOfferedModelIsPriced(t *testing.T) {
	tb, err := cost.Embedded()
	if err != nil {
		t.Fatalf("embedded table: %v", err)
	}
	b, err := os.ReadFile(filepath.FromSlash(launchMenus))
	if err != nil {
		t.Fatalf("read %s: %v", launchMenus, err)
	}
	src := string(b)
	offered := map[string]string{
		agents.DeepSeekModel:          "Claude Code on DeepSeek (internal/agents)",
		agents.DeepSeekModel + "[1m]": "Claude Code on DeepSeek, main model (internal/agents)",
		agents.KimiModel:              "Claude Code on Kimi (internal/agents)",
		agents.KimiFastModel:          "Claude Code on Kimi, Haiku tier (internal/agents)",
		gemini.DefaultModel:           "Gemini CLI default (internal/gemini)",
	}
	for _, id := range offeredInUI(t, src, "MODELS") {
		offered[id] = "Claude Code models (SpawnDialog MODELS)"
	}
	for _, id := range offeredInUI(t, src, "GEMINI_MODELS") {
		offered[id] = "Gemini CLI models (SpawnDialog GEMINI_MODELS)"
	}
	for id, where := range offered {
		m, ok := tb.Lookup(id)
		if !ok || m.Input == 0 && m.Output == 0 {
			t.Errorf("%s offers %q, which has no row in pricing/pricing.json: its sessions would be unpriced. Add the row (with its source and date) or stop offering the model.", where, id)
		}
	}
}
