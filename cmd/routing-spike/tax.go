package main

import (
	"fmt"
	"sort"
	"strings"
)

// Frontier prices per million input tokens. Cache multipliers are Anthropic's
// published 1.25x write / 0.10x read.
var modelPrice = map[string]float64{
	"claude-opus-5":    5.00,
	"claude-opus-4-8":  5.00,
	"claude-sonnet-5":  2.00,
	"claude-fable-5":   1.00,
	"claude-haiku-4-5": 1.00,
}

// priceFor resolves a session's model to an input price, defaulting to Opus.
// Defaulting high is the safe direction: it makes the tax look larger, so a
// kill decision taken on these numbers is not an artefact of underpricing.
func priceFor(model string) Prices {
	for id, p := range modelPrice {
		if strings.HasPrefix(model, id) {
			return Prices{In: p}
		}
	}
	return Prices{In: 5.00}
}

// TaxReport is the Stage 0 answer for the context-tax spec.
type TaxReport struct {
	Sessions        int     `json:"sessions"`
	Excluded        int     `json:"excluded_sessions"`
	AllSeries       int     `json:"all_series"`
	EligibleSeries  int     `json:"eligible_series"`
	BashTokenTurns  int     `json:"bash_token_turns"`
	EligibleBashTT  int     `json:"eligible_bash_token_turns"`
	CoverPct        float64 `json:"eligible_cover_pct"`
	SavedIsoSame    float64 `json:"saved_isolation_same_model"`
	SavedIsoHaiku   float64 `json:"saved_isolation_haiku"`
	SavedCompaction float64 `json:"saved_compaction"`
	TotalTax        float64 `json:"total_context_tax_usd"`
	KillPass        bool    `json:"kill_pass"`

	ByLength []Bucket      `json:"by_length"`
	ByCtx    []Bucket      `json:"by_context"`
	ByClass  []ClassBucket `json:"by_class"`
	Sweep    []SweepRow    `json:"sensitivity"`

	CSub0Median int `json:"c_sub0_median_measured"`

	// WhyNot counts why series were refused, so a coverage figure can be read
	// as "the lever is small" or "one rule is doing all the refusing".
	WhyNot map[string]int `json:"why_not_eligible"`
	// WhyNotTax is the tax held by each refusal reason: a rule that refuses
	// many cheap series matters less than one refusing few expensive ones.
	WhyNotTax map[string]float64 `json:"why_not_tax_usd"`
}

type Bucket struct {
	Label    string  `json:"label"`
	Series   int     `json:"series"`
	TaxUSD   float64 `json:"tax_usd"`
	Eligible int     `json:"eligible"`
}

type ClassBucket struct {
	Class    string  `json:"class"`
	Series   int     `json:"series"`
	Calls    int     `json:"calls"`
	TaxUSD   float64 `json:"tax_usd"`
	Eligible int     `json:"eligible"`
	SavedUSD float64 `json:"saved_usd"`
}

type SweepRow struct {
	MinN     int     `json:"min_n"`
	MinCtx   int     `json:"min_c_start"`
	Eligible int     `json:"eligible_series"`
	CoverPct float64 `json:"cover_pct"`
	SavedUSD float64 `json:"saved_usd"`
}

// AnalyseTax runs the section 5.4 / 5.5 counterfactuals over the archive.
//
// cSub0 is the subagent's starting context. The spec guesses 25k; this spike
// measures it from the real subagent transcripts in the archive and uses the
// measured figure, because a guess in the denominator of a kill decision is
// exactly the kind of thing that decides it by accident.
func AnalyseTax(sessions []Session, rule Rule, cSub0, summary, brief int) TaxReport {
	r := TaxReport{Sessions: len(sessions), CSub0Median: cSub0,
		WhyNot: map[string]int{}, WhyNotTax: map[string]float64{}}
	haiku := Prices{In: 1.00}

	byLen := map[string]*Bucket{}
	byCtx := map[string]*Bucket{}
	byClass := map[string]*ClassBucket{}

	for _, s := range sessions {
		p := priceFor(s.Model)
		evByTurn := groupSeriesEvents(s, rule)
		for _, se := range evByTurn {
			sr, ev := se.sr, se.ev
			r.AllSeries++

			taxUSD := float64(sr.TaxTok) * p.cacheRead() / 1e6
			r.TotalTax += taxUSD

			lb := lenBucket(sr.N)
			if byLen[lb] == nil {
				byLen[lb] = &Bucket{Label: lb}
			}
			byLen[lb].Series++
			byLen[lb].TaxUSD += taxUSD

			cb := ctxBucket(sr.CStart)
			if byCtx[cb] == nil {
				byCtx[cb] = &Bucket{Label: cb}
			}
			byCtx[cb].Series++
			byCtx[cb].TaxUSD += taxUSD

			if byClass[sr.Class] == nil {
				byClass[sr.Class] = &ClassBucket{Class: sr.Class}
			}
			byClass[sr.Class].Series++
			byClass[sr.Class].Calls += sr.N
			byClass[sr.Class].TaxUSD += taxUSD

			// The kill criterion is stated against Bash token-turns, so only
			// the Bash calls inside a series count towards coverage.
			bashTT := 0
			for _, e := range ev {
				if e.Class == ClassBash {
					bashTT += e.TokenTurns()
				}
			}
			r.BashTokenTurns += bashTT

			if !sr.Eligible {
				r.WhyNot[sr.Why]++
				r.WhyNotTax[sr.Why] += taxUSD
				continue
			}
			r.EligibleSeries++
			r.EligibleBashTT += bashTT
			byLen[lb].Eligible++
			byCtx[cb].Eligible++
			byClass[sr.Class].Eligible++

			same := IsolateSeries(sr, ev, p, p, cSub0, summary, brief)
			cheap := IsolateSeries(sr, ev, p, haiku, cSub0, summary, brief)
			if same.Saved > 0 {
				r.SavedIsoSame += same.Saved
			}
			if cheap.Saved > 0 {
				r.SavedIsoHaiku += cheap.Saved
				byClass[sr.Class].SavedUSD += cheap.Saved
			}
		}

		// Compaction: the best single point in the session (spec §5.5).
		if best := bestCompaction(s, p); best > 0 {
			r.SavedCompaction += best
		}
	}

	if r.BashTokenTurns > 0 {
		r.CoverPct = 100 * float64(r.EligibleBashTT) / float64(r.BashTokenTurns)
	}
	r.KillPass = r.CoverPct >= 25

	for _, b := range byLen {
		r.ByLength = append(r.ByLength, *b)
	}
	for _, b := range byCtx {
		r.ByCtx = append(r.ByCtx, *b)
	}
	for _, b := range byClass {
		r.ByClass = append(r.ByClass, *b)
	}
	sort.Slice(r.ByLength, func(i, j int) bool { return lenOrder(r.ByLength[i].Label) < lenOrder(r.ByLength[j].Label) })
	sort.Slice(r.ByCtx, func(i, j int) bool { return ctxOrder(r.ByCtx[i].Label) < ctxOrder(r.ByCtx[j].Label) })
	sort.Slice(r.ByClass, func(i, j int) bool { return r.ByClass[i].TaxUSD > r.ByClass[j].TaxUSD })

	// Sensitivity: the kill decision must not turn on one arbitrary pair of
	// thresholds, so the same measurement is repeated across the grid.
	for _, n := range []int{3, 5, 8, 12} {
		for _, c := range []int{200_000, 350_000, 500_000, 700_000} {
			sub := AnalyseTaxOnce(sessions, Rule{MinN: n, MinCStart: c}, cSub0, summary, brief)
			r.Sweep = append(r.Sweep, SweepRow{
				MinN: n, MinCtx: c, Eligible: sub.EligibleSeries,
				CoverPct: sub.CoverPct, SavedUSD: sub.SavedIsoHaiku,
			})
		}
	}
	return r
}

// AnalyseTaxOnce is AnalyseTax without the sweep, used by the sweep itself.
func AnalyseTaxOnce(sessions []Session, rule Rule, cSub0, summary, brief int) TaxReport {
	r := TaxReport{}
	haiku := Prices{In: 1.00}
	for _, s := range sessions {
		p := priceFor(s.Model)
		for _, se := range groupSeriesEvents(s, rule) {
			bashTT := 0
			for _, e := range se.ev {
				if e.Class == ClassBash {
					bashTT += e.TokenTurns()
				}
			}
			r.BashTokenTurns += bashTT
			if !se.sr.Eligible {
				continue
			}
			r.EligibleSeries++
			r.EligibleBashTT += bashTT
			if iso := IsolateSeries(se.sr, se.ev, p, haiku, cSub0, summary, brief); iso.Saved > 0 {
				r.SavedIsoHaiku += iso.Saved
			}
		}
	}
	if r.BashTokenTurns > 0 {
		r.CoverPct = 100 * float64(r.EligibleBashTT) / float64(r.BashTokenTurns)
	}
	return r
}

type seriesEvents struct {
	sr Series
	ev []Event
}

// groupSeriesEvents re-walks a session and returns each series with the events
// that belong to it, which the counterfactuals need per-call.
func groupSeriesEvents(s Session, rule Rule) []seriesEvents {
	var out []seriesEvents
	var cur []Event
	flush := func() {
		if len(cur) == 0 {
			return
		}
		out = append(out, seriesEvents{sr: buildSeries(s, cur, rule), ev: append([]Event(nil), cur...)})
		cur = nil
	}
	for _, e := range s.Events {
		if e.BreaksSeries {
			flush()
			continue
		}
		if e.ContextAtCall == 0 {
			continue
		}
		if len(cur) > 0 && e.Turn != cur[len(cur)-1].Turn && e.UserBefore {
			flush()
		}
		cur = append(cur, e)
	}
	flush()
	return out
}

// bestCompaction finds the most valuable single compaction point in a session.
func bestCompaction(s Session, p Prices) float64 {
	ev := make([]Event, 0, len(s.Events))
	for _, e := range s.Events {
		if e.ContextAtCall > 0 {
			ev = append(ev, e)
		}
	}
	best := 0.0
	for k := range ev {
		// Spec §5.5: only where the context is already large and enough calls
		// remain for a compaction to pay back its own summary.
		if ev[k].ContextAtCall < 250_000 || len(ev)-k < 20 {
			continue
		}
		if v := CompactionAt(ev, k, p, 0.25, 8_000); v > best {
			best = v
		}
	}
	return best
}

func lenBucket(n int) string {
	switch {
	case n == 1:
		return "1"
	case n <= 2:
		return "2"
	case n <= 4:
		return "3-4"
	case n <= 7:
		return "5-7"
	case n <= 15:
		return "8-15"
	case n <= 30:
		return "16-30"
	}
	return "31+"
}

func lenOrder(l string) int {
	for i, x := range []string{"1", "2", "3-4", "5-7", "8-15", "16-30", "31+"} {
		if x == l {
			return i
		}
	}
	return 99
}

func ctxBucket(c int) string {
	switch {
	case c < 50_000:
		return "<50k"
	case c < 100_000:
		return "50-100k"
	case c < 200_000:
		return "100-200k"
	case c < 300_000:
		return "200-300k"
	case c < 500_000:
		return "300-500k"
	case c < 700_000:
		return "500-700k"
	}
	return "700k+"
}

func ctxOrder(l string) int {
	for i, x := range []string{"<50k", "50-100k", "100-200k", "200-300k", "300-500k", "500-700k", "700k+"} {
		if x == l {
			return i
		}
	}
	return 99
}

// Text renders the tax report.
func (r TaxReport) Text() string {
	var b strings.Builder
	f := func(format string, a ...any) { fmt.Fprintf(&b, format, a...) }

	f("\nCONTEXT TAX (spec sections 5.3-5.5)\n")
	f("  sessions            %d analysed, %d excluded as dev sessions\n", r.Sessions, r.Excluded)
	f("  series              %d total, %d eligible (n>=5, C_start>=200k, no edits)\n", r.AllSeries, r.EligibleSeries)
	f("  subagent C_sub0     %s tokens (measured from real subagent transcripts)\n", kt(r.CSub0Median))
	f("  total context tax   $%.2f\n", r.TotalTax)

	f("\nSERIES BY LENGTH\n")
	f("  %-8s %8s %12s %10s\n", "n", "series", "tax", "eligible")
	for _, x := range r.ByLength {
		f("  %-8s %8d %11.2f$ %10d\n", x.Label, x.Series, x.TaxUSD, x.Eligible)
	}

	f("\nSERIES BY STARTING CONTEXT\n")
	f("  %-10s %8s %12s %10s\n", "C_start", "series", "tax", "eligible")
	for _, x := range r.ByCtx {
		f("  %-10s %8d %11.2f$ %10d\n", x.Label, x.Series, x.TaxUSD, x.Eligible)
	}

	f("\nSERIES BY CLASS\n")
	f("  %-8s %8s %8s %12s %10s %12s\n", "class", "series", "calls", "tax", "eligible", "saved")
	for _, x := range r.ByClass {
		f("  %-8s %8d %8d %11.2f$ %10d %11.2f$\n", x.Class, x.Series, x.Calls, x.TaxUSD, x.Eligible, x.SavedUSD)
	}

	f("\nCOUNTERFACTUALS\n")
	f("  saved_isolation (Haiku subagent)      $%.2f\n", r.SavedIsoHaiku)
	f("  saved_isolation (same model)          $%.2f\n", r.SavedIsoSame)
	f("  saved_compaction (best point/session) $%.2f\n", r.SavedCompaction)

	f("\nSENSITIVITY\n")
	f("  %6s %10s %10s %10s %12s\n", "min n", "min ctx", "eligible", "cover %", "saved")
	for _, s := range r.Sweep {
		f("  %6d %9s %10d %9.1f%% %11.2f$\n", s.MinN, kt(s.MinCtx), s.Eligible, s.CoverPct, s.SavedUSD)
	}

	f("\nWHY SERIES WERE REFUSED\n")
	f("  %-26s %8s %12s\n", "reason", "series", "tax held")
	for _, k := range []string{"too short", "context below threshold", "edits pre-existing files"} {
		if r.WhyNot[k] > 0 {
			f("  %-26s %8d %11.2f$\n", k, r.WhyNot[k], r.WhyNotTax[k])
		}
	}

	f("\nSTAGE 0 KILL CRITERION (spec section 3)\n")
	f("  eligible series must cover >= 25%% of Bash token-turns\n")
	f("  bash token-turns in series : %s\n", kt(r.BashTokenTurns))
	f("  covered by eligible series : %s\n", kt(r.EligibleBashTT))
	f("  coverage                   : %.1f%%  -> %s\n", r.CoverPct, pass(r.KillPass))
	return b.String()
}
