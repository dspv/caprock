package agentcat

// What an agent does not record.
//
// Every agent Caprock reads leaves some figure out: Cursor keeps no cache
// split, Gemini and DeepSeek no cache writes, Hermes keeps its usage as
// running totals per session rather than per request. Each screen used to say
// so in words of its own ("Cursor's CLI reports no token counts", "Cursor
// recorded no cost", "claude-4-sonnet not in pricing table") or not at all,
// so a missing figure read differently per agent and sometimes as a fault.
// This is the one map of them, and the one sentence they are said in:
// "<Agent> doesn't record <what>", in the slot under the tile the figure would
// be in (the Context tile's `context_note` slot, ADR-095 for Cursor).
//
// Only what a session screen shows is listed. Each entry was read from the
// agent's importer (2026-11-17): what it writes into event.TokenDelta and
// CostUSD, not what the agent's own store might hold.

// The figures a gap can name; SessionSummary.gaps is keyed by these.
const (
	// GapTokens: no token counts at all (a Cursor chat seen through hooks).
	GapTokens = "tokens"
	// GapCache: neither cache reads nor cache writes.
	GapCache = "cache"
	// GapCacheWrite: cache reads, but no cache writes.
	GapCacheWrite = "cache_write"
	// GapContext: no figure that is one request's size, which is what the
	// context meter needs; a sum over requests is not one.
	GapContext = "context"
	// GapCost: no cost for this session, and Caprock does not price it from
	// its own table (Cursor, ADR-095).
	GapCost = "cost"
	// GapCompactionCost: no figure a compaction's cost could be read from,
	// and Caprock does not price it from its own table (Cursor's summaries
	// are recorded as compactions without one, ADR-095).
	GapCompactionCost = "compaction_cost"
)

// agentGaps is what each agent leaves out of every session. Claude Code
// (and Kimi, which runs through it), Codex and OpenCode record every figure
// the session screen shows, so they have no entry.
var agentGaps = map[string]map[string]string{
	// internal/cursor: tokenCount{inputTokens, outputTokens} on the last
	// reply of a turn only, reconciled as differences; no cache split. Its
	// context is Cursor's own reading (contextWindowStatusAtCreation), so
	// it has no context gap.
	"cursor": {GapCache: "cache reads or writes", GapCompactionCost: "what a summary cost"},
	// internal/gemini: CacheRead from telemetry, no cache-write figure.
	"gemini": {GapCacheWrite: "cache writes"},
	// internal/deepseek: CacheWrite is 0, "DSH reports no cache-write split".
	"deepseek": {GapCacheWrite: "cache writes"},
	// internal/hermes: usage is Hermes's running total per session,
	// stored as differences, never one request's size.
	"hermes": {GapContext: "each request's tokens"},
}

// SessionFacts are the session's own figures some gaps depend on.
type SessionFacts struct {
	// Tokens is every token the session recorded.
	Tokens int64
	// CostUSD is its priced cost; UnpricedTurns its turns with tokens and
	// no cost.
	CostUSD       float64
	UnpricedTurns int64
}

// DoesntRecord is the one sentence a gap is said in: "Cursor doesn't record
// cache reads or writes". The dashboard builds the same sentence for figures
// that are not a session's (ui/src/lib/gaps.ts).
func DoesntRecord(agentLabel, what string) string {
	return agentLabel + " doesn't record " + what
}

// Gaps is what this session's agent does not record, field → sentence; nil
// when it records everything shown.
func Gaps(agent string, f SessionFacts) map[string]string {
	label := gapLabel(agent)
	out := map[string]string{}
	for k, what := range agentGaps[agent] {
		out[k] = DoesntRecord(label, what)
	}
	if agent == "cursor" {
		// A cursor-agent chat is seen through Cursor's hooks, and no hook
		// carries usage; an editor chat has tokens from its database.
		if f.Tokens == 0 {
			out[GapTokens] = DoesntRecord(label, "token counts for this chat")
		}
		// Cursor keeps a cost for some chats only (usageData), and the
		// pricing table is never applied to Cursor's turns: an editor chat
		// with tokens and no usageData has unpriced turns, and a
		// cursor-agent chat has neither tokens nor a cost (its replies are
		// cost_basis "none", so none counts as unpriced). Either way the
		// cost is Cursor's missing figure, never $0.00.
		if f.CostUSD <= 0 && (f.UnpricedTurns > 0 || f.Tokens == 0) {
			out[GapCost] = DoesntRecord(label, "a cost for this chat")
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// gapLabel is the agent's name as a sentence starts with it.
func gapLabel(agent string) string {
	switch agent {
	case "cursor":
		return "Cursor"
	case "gemini":
		return "Gemini"
	case "deepseek":
		return "DeepSeek"
	case "hermes":
		return "Hermes"
	case "opencode":
		return "OpenCode"
	case "codex":
		return "Codex"
	case "", "claude":
		return "Claude Code"
	}
	return agent
}

// ShareOnly is the Context tile's sub-line for a reading that is a share of
// the window alone, with no tokens and no window size: what Cursor's
// November 2025 builds keep (contextUsagePercent, percentageRemaining).
// The tile shows the share; this sits where "120k / 200k" would.
func ShareOnly(agent string) string {
	return DoesntRecord(gapLabel(agent), "this chat's context in tokens")
}
