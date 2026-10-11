// Package eta estimates when a queued message starts and finishes, from how
// long the turns already finished in the same project took. Pure arithmetic
// over durations; the daemon reads the durations (store.ProjectTurns) and the
// Queue view shows what this returns, always as a rough estimate with its
// basis (.ai/03-contracts.md § Queue, rule 6).
//
// How good it is was measured before it was shown: on a copy of the owner's
// database (2026-10-12, 2,168 Claude Code turns with at least five earlier
// turns in their project) the median of the previous 200 turns missed a turn's
// length by 55 s at the median (the typical turn is 48 s), and the turn landed
// inside the predicted p25–p75 in 49% of cases and p10–p90 in 78%. So the view
// shows ranges, never a single time (.ai/12-risks.md RISK-08).
package eta

import (
	"sort"
	"time"
)

// MinSamples is the fewest finished turns an estimate is made from. Below it
// the view says how many there are instead of a number.
const MinSamples = 5

// Window is how many of a project's newest finished turns the estimate reads:
// recent work predicts the next turn a little better than the whole history
// (median miss 55 s against 63 s for every turn ever, same measurement).
const Window = 200

// Stats are the quantiles of a project's finished turn durations.
type Stats struct {
	N      int
	P25    time.Duration
	Median time.Duration
	P75    time.Duration
	sorted []time.Duration
}

// New returns the stats of durations, and false when there are fewer than
// MinSamples of them. Negative durations are dropped.
func New(durations []time.Duration) (Stats, bool) {
	sorted := make([]time.Duration, 0, len(durations))
	for _, d := range durations {
		if d >= 0 {
			sorted = append(sorted, d)
		}
	}
	if len(sorted) < MinSamples {
		return Stats{N: len(sorted)}, false
	}
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	return Stats{
		N:      len(sorted),
		P25:    Quantile(sorted, 0.25),
		Median: Quantile(sorted, 0.5),
		P75:    Quantile(sorted, 0.75),
		sorted: sorted,
	}, true
}

// Quantile is the p-quantile of sorted durations by linear interpolation
// between the two nearest ranks; 0 for none.
func Quantile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	if p <= 0 {
		return sorted[0]
	}
	if p >= 1 {
		return sorted[len(sorted)-1]
	}
	i := float64(len(sorted)-1) * p
	lo := int(i)
	hi := lo + 1
	if hi >= len(sorted) {
		return sorted[lo]
	}
	return sorted[lo] + time.Duration(float64(sorted[hi]-sorted[lo])*(i-float64(lo)))
}

// Range is an estimate: Mid is the median, Lo and Hi the 25th and 75th
// percentiles. All are durations from now.
type Range struct {
	Lo, Mid, Hi time.Duration
}

func (r Range) add(o Range) Range {
	return Range{Lo: r.Lo + o.Lo, Mid: r.Mid + o.Mid, Hi: r.Hi + o.Hi}
}

// Turn is one turn's length as a range: p25, median, p75.
func (s Stats) Turn() Range { return Range{Lo: s.P25, Mid: s.Median, Hi: s.P75} }

// Remaining is what is left of a turn that has run for elapsed, and false when
// no estimate can be made: the turn has outlasted all but a handful of the
// turns seen here.
//
// Before the median it is the median minus elapsed (p25 and p75 the same way,
// floored at 0). Past the median that would say "any moment" for ever, and
// long turns are exactly the ones that run on, so it is the median of what the
// past turns that ran at least this long still took: on the owner's database
// the miss at 2 minutes in was 178 s this way against 211 s for the median
// minus elapsed, at 10 minutes 319 s against 381 s.
func (s Stats) Remaining(elapsed time.Duration) (Range, bool) {
	if elapsed < 0 {
		elapsed = 0
	}
	if elapsed < s.Median {
		return Range{
			Lo:  max(0, s.P25-elapsed),
			Mid: s.Median - elapsed,
			Hi:  max(0, s.P75-elapsed),
		}, true
	}
	var left []time.Duration
	for _, d := range s.sorted {
		if d > elapsed {
			left = append(left, d-elapsed)
		}
	}
	if len(left) < MinSamples {
		return Range{}, false
	}
	return Range{Lo: Quantile(left, 0.25), Mid: Quantile(left, 0.5), Hi: Quantile(left, 0.75)}, true
}

// Queued is when the message ahead turns after the current one starts and
// when it is done: the current turn's remaining time plus one typical turn
// per message ahead of it, then one more for itself. rem is the current
// turn's remaining time (zero when the session is at its prompt).
func (s Stats) Queued(rem Range, ahead int) (start, done Range) {
	start = rem
	for i := 0; i < ahead; i++ {
		start = start.add(s.Turn())
	}
	return start, start.add(s.Turn())
}
