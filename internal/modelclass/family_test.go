package modelclass

import "testing"

// One model named by two agents is one family: Cursor's ids put the version
// before the tier and add mode suffixes; Claude Code's carry a date and [1m].
func TestFamilyJoinsOneModelAcrossAgents(t *testing.T) {
	for in, want := range map[string]string{
		"claude-4.5-sonnet-thinking":  "claude-sonnet-4-5",
		"claude-sonnet-4-5-20250929":  "claude-sonnet-4-5",
		"claude-4-sonnet":             "claude-sonnet-4",
		"claude-sonnet-4-20250514":    "claude-sonnet-4",
		"claude-4.1-opus-thinking":    "claude-opus-4-1",
		"claude-opus-4-1-20250805":    "claude-opus-4-1",
		"claude-opus-5-5[1m]":         "claude-opus-5-5",
		"anthropic/claude-sonnet-4.6": "claude-sonnet-4-6",
		"gpt-5-fast":                  "gpt-5",
		"composer-2.5-fast":           "composer-2.5",
		"GPT-4.1":                     "gpt-4.1",
		"":                            "",
	} {
		if got := Family(in); got != want {
			t.Errorf("Family(%q) = %q, want %q", in, got, want)
		}
	}
}
