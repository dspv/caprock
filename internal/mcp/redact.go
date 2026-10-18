package mcp

import (
	"regexp"
	"unicode/utf8"
)

// secretShapes are credentials with a recognisable shape. A session's prose
// or a memory can quote one (an agent echoing a key it was handed), and an
// MCP answer lands in another agent's context — possibly another vendor's
// model — so these never leave in a tool result. The list is the common
// shapes, not a guarantee: the honest promise is "keys that look like keys".
var secretShapes = []*regexp.Regexp{
	// Anthropic, OpenAI and most "sk-" style keys.
	regexp.MustCompile(`\bsk-(?:ant-|proj-)?[A-Za-z0-9_\-]{16,}`),
	// GitHub tokens: classic, fine-grained, OAuth, app, refresh.
	regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`),
	// Slack tokens.
	regexp.MustCompile(`\bxox[abprs]-[A-Za-z0-9-]{10,}`),
	// AWS access key ids.
	regexp.MustCompile(`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`),
	// Google API keys.
	regexp.MustCompile(`\bAIza[0-9A-Za-z_\-]{35}`),
	// Telegram bot tokens.
	regexp.MustCompile(`\b\d{8,10}:[A-Za-z0-9_\-]{35}\b`),
	// Stripe keys.
	regexp.MustCompile(`\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}`),
	// JSON web tokens.
	regexp.MustCompile(`\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}`),
	// A bearer header's value.
	regexp.MustCompile(`(?i)\bbearer\s+[A-Za-z0-9._\-]{20,}`),
	// PEM private keys, whole.
	regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`),
}

// Redact replaces every credential-shaped run in s with [redacted].
func Redact(s string) string {
	for _, re := range secretShapes {
		s = re.ReplaceAllString(s, "[redacted]")
	}
	return s
}

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
