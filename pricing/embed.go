// Package pricing embeds the versioned model pricing table. The numbers come from
// the Anthropic first-party pricing page (source + fetched_at recorded inside the
// JSON). No price literal may exist anywhere else in the codebase — see
// .ai/06-engineering-rules.md and ADR-015.
package pricing

import _ "embed"

// JSON is the raw embedded pricing table (pricing/pricing.json).
//
//go:embed pricing.json
var JSON []byte
