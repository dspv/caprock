// Package modelclass classifies model ids whose role changes how Caprock
// should present their usage. It does not contain prices: those belong only in
// pricing/pricing.json.
package modelclass

import "strings"

const (
	// CodexAutoReview is Codex's hidden approval-review model. Codex describes
	// it in its local model catalog as "Automatic approval review model for
	// Codex." It is background product machinery, not a model the user chose,
	// and OpenAI publishes neither a price nor a base-model mapping for it.
	CodexAutoReview = "codex-auto-review"
)

// IsInternal reports whether a model is known background product machinery.
// Keep this an explicit allow-list: matching a prefix such as "codex-auto-"
// would silently hide a future user-facing model we have never investigated.
func IsInternal(id string) bool {
	switch strings.ToLower(strings.TrimSpace(id)) {
	case CodexAutoReview:
		return true
	default:
		return false
	}
}
