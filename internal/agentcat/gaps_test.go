package agentcat

import "testing"

func TestGapsAreOneSentenceForEveryAgent(t *testing.T) {
	for _, agent := range []string{"", "claude", "codex", "opencode"} {
		if g := Gaps(agent, SessionFacts{Tokens: 10, CostUSD: 1}); g != nil {
			t.Errorf("%q records every figure shown, got gaps %v", agent, g)
		}
	}
	want := map[string]map[string]string{
		"cursor":   {GapCache: "Cursor doesn't save cache reads or writes on this computer", GapCompactionCost: "Cursor doesn't save what a summary cost on this computer"},
		"gemini":   {GapCacheWrite: "Gemini doesn't save cache writes on this computer"},
		"deepseek": {GapCacheWrite: "DeepSeek doesn't save cache writes on this computer"},
		"hermes":   {GapContext: "Hermes doesn't save each request's tokens on this computer"},
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
	// A cursor-agent chat seen through hooks has no tokens and no cost, and
	// no unpriced turn either (no reply carries tokens): both are gaps, so
	// the inspector never reads "0 tok · $0.00" as free.
	g := Gaps("cursor", SessionFacts{})
	if g[GapTokens] != "Cursor CLI doesn't save token counts on this computer" {
		t.Errorf("tokens gap = %q", g[GapTokens])
	}
	if g[GapCost] != "Cursor CLI doesn't save what a chat costs on this computer" {
		t.Errorf("cli chat cost gap = %q", g[GapCost])
	}
	// An editor chat Cursor recorded no cost for says so instead of "price unknown".
	g = Gaps("cursor", SessionFacts{Tokens: 30, UnpricedTurns: 2})
	if g[GapCost] != "Cursor doesn't save what a chat costs on this computer" {
		t.Errorf("cost gap = %q", g[GapCost])
	}
	if _, ok := g[GapTokens]; ok {
		t.Errorf("an editor chat with tokens has a tokens gap")
	}
	// An editor chat with usageData is priced: no cost gap, no tokens gap.
	g = Gaps("cursor", SessionFacts{Tokens: 30, CostUSD: 0.42})
	if _, ok := g[GapCost]; ok {
		t.Errorf("a priced editor chat has a cost gap")
	}
	// Tokens, every turn priced, and a cost of 0 (no unpriced turn): not a gap.
	g = Gaps("cursor", SessionFacts{Tokens: 30})
	if _, ok := g[GapCost]; ok {
		t.Errorf("a chat with tokens and no unpriced turn has a cost gap")
	}
	// Other agents never get a cost gap from having nothing yet.
	if g := Gaps("claude", SessionFacts{}); g != nil {
		t.Errorf("an empty claude session has gaps %v", g)
	}
}
