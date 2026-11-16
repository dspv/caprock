package modelclass

import (
	"regexp"
	"strings"
)

var (
	// Cursor writes Claude as claude-<version>-<tier>[-thinking]:
	// claude-4.5-sonnet-thinking, claude-4.1-opus-thinking, claude-4-sonnet.
	cursorClaude = regexp.MustCompile(`^claude-(\d+(?:\.\d+)?)-(opus|sonnet|haiku)\b`)
	// Anthropic writes claude-<tier>-<major>[-<minor>][-<date>]:
	// claude-sonnet-4-5-20250929, claude-opus-5-5.
	apiClaude = regexp.MustCompile(`^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d{1,2}))?(?:-\d{8})?\b`)
)

// Family is a model id reduced to the model it runs, so the same model named
// by two agents compares as one: Cursor's "claude-4.5-sonnet-thinking" and
// Claude Code's "claude-sonnet-4-5-20250929" are both "claude-sonnet-4-5".
// Modes that do not change the model — Cursor's -thinking, -max and -fast
// suffixes, Claude Code's [1m] — are dropped. An id it does not recognise is
// returned lower-cased with those suffixes off.
func Family(id string) string {
	m := strings.ToLower(strings.TrimSpace(id))
	m = strings.TrimSuffix(m, "[1m]")
	if i := strings.LastIndexByte(m, '/'); i >= 0 {
		m = m[i+1:] // a provider prefix: anthropic/claude-…
	}
	if g := cursorClaude.FindStringSubmatch(m); g != nil {
		return "claude-" + g[2] + "-" + strings.ReplaceAll(g[1], ".", "-")
	}
	if g := apiClaude.FindStringSubmatch(m); g != nil {
		out := "claude-" + g[1] + "-" + g[2]
		if g[3] != "" {
			out += "-" + g[3]
		}
		return out
	}
	for _, suf := range []string{"-thinking", "-max", "-fast", "-1m"} {
		m = strings.TrimSuffix(m, suf)
	}
	return m
}
