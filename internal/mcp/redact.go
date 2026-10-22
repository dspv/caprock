package mcp

import (
	"unicode/utf8"

	"github.com/dspv/caprock/internal/redact"
)

// Redact replaces credentials and payment details in s with a placeholder
// naming each ("[redacted: api key]"). A session's prose or a memory can
// quote one (an agent echoing a key it was handed), and an MCP answer lands
// in another agent's context — possibly another vendor's model — so these
// never leave in a tool result. The shapes are internal/redact's, the same
// filter Second Brain runs before it saves a memory; the honest promise is
// "keys that look like keys".
func Redact(s string) string { return redact.String(s) }

// clipBytes cuts s to at most n bytes on a rune boundary.
func clipBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// clipRunes cuts s to at most n runes, marking a cut with an ellipsis.
func clipRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + "…"
}
