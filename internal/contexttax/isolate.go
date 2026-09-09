package contexttax

// The isolation counterfactual (spec section 5.4). It is displayed and never
// acted on: Stage 0 nudged the model 8 times on eligible series and it
// complied once, with delivery confirmed, so the lever is parked. What
// survives is the number, because it is what tells a user their loop was
// expensive. The intervention that follows is compaction.
//
// The constants are measured, not guessed. Stage 0 read 364 real subagent
// transcripts: a subagent's first turn is a 17.9k median context, and the
// summary it hands back is 10.9k median -- not the 1k the spec first assumed,
// which is why the summary is charged here rather than rounded away.
const (
	// SubStartTokens is a subagent's starting context, median over 364
	// archived subagent transcripts.
	SubStartTokens = 17_900
	// SummaryTokens is what a subagent hands back to its parent, median over
	// the same archive. It is cache-written once and re-read by every turn
	// left in the session, so it is a material cost, not a rounding error.
	SummaryTokens = 10_900
	// BriefTokens is the task description the lead writes to start the
	// subagent.
	BriefTokens = 1_000
)

// Isolation is what a series cost, and what it would have cost inside a
// subagent that starts small.
//
// The saving is not a cheaper model. Same-model isolation captured 96% of it
// in Stage 0 ($466 of $487), so the subagent is charged at the parent's own
// rates by default. The saving is that a subagent never re-reads the parent's
// 380k context: it starts near zero and grows only by its own results.
type Isolation struct {
	Actual   float64 `json:"actual"`
	Isolated float64 `json:"isolated"`
	Saved    float64 `json:"saved"`
}

// Isolate prices a run of calls as it ran and as it would have run in a
// subagent. turnsLeftEnd is the number of assistant turns still to come after
// the series ends, over which the returned summary keeps being re-read.
func Isolate(calls []Call, p Prices, turnsLeftEnd int) Isolation {
	var iso Isolation
	iso.Actual = CostOf(calls, p)

	acc := int64(SubStartTokens)
	for _, c := range calls {
		iso.Isolated += float64(acc) * p.CacheRead
		iso.Isolated += float64(c.Result) * p.CacheWrite
		acc += c.Result
	}
	// What comes back to the parent, and the brief that was written to send it.
	iso.Isolated += SummaryTokens * p.CacheWrite
	iso.Isolated += SummaryTokens * float64(turnsLeftEnd) * p.CacheRead
	iso.Isolated += BriefTokens * p.CacheWrite

	iso.Saved = iso.Actual - iso.Isolated
	// A series that would cost more isolated is a real answer, not an error,
	// but it is not a saving. Displaying a negative one would read as a charge.
	if iso.Saved < 0 {
		iso.Saved = 0
	}
	return iso
}
