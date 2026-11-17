package agentcat

import "testing"

func TestGapsAreOneSentenceForEveryAgent(t *testing.T) {
	for _, agent := range []string{"", "claude", "codex", "opencode"} {
		if g := Gaps(agent, SessionFacts{Tokens: 10, CostUSD: 1}); g != nil {
			t.Errorf("%q records every figure shown, got gaps %v", agent, g)
		}
	}
	want := map[string]map[string]string{
		"cursor":   {GapCache: "Cursor doesn't record cache reads or writes", GapCompactionCost: "Cursor doesn't record what a summary cost"},
		"gemini":   {GapCacheWrite: "Gemini doesn't record cache writes"},
		"deepseek": {GapCacheWrite: "DeepSeek doesn't record cache writes"},
		"hermes":   {GapContext: "Hermes doesn't record each request's tokens"},
	}
	for agent, w := range want {
		g := Gaps(agent, SessionFacts{Tokens: 10, CostUSD: 1})
		if len(g) != len(w) {
			t.Errorf("%s: gaps %v, want %v", agent, g, w)
		}
		for k, v := range w {
			if g[k] != v {
				t.Errorf("%s %s = %q, want %q", agent, k, g[k], v)
			}
		}
	}
	// A cursor-agent chat seen through hooks has no tokens; an editor chat
	// Cursor recorded no cost for says so instead of "price unknown".
	g := Gaps("cursor", SessionFacts{})
	if g[GapTokens] != "Cursor doesn't record token counts for this chat" {
		t.Errorf("tokens gap = %q", g[GapTokens])
	}
	if _, ok := g[GapCost]; ok {
		t.Errorf("a chat with no turns priced or unpriced has a cost gap")
	}
	g = Gaps("cursor", SessionFacts{Tokens: 30, UnpricedTurns: 2})
	if g[GapCost] != "Cursor doesn't record a cost for this chat" {
		t.Errorf("cost gap = %q", g[GapCost])
	}
}
