// Package weekly builds the report that says what moved — and, more often,
// that nothing did.
//
// The premium page promises "the repository that cost 3× its usual week", and
// the whole difficulty is in the word *usual*. Comparing this week with last
// week gives a ratio, not a finding: a repository that cost $2 and then $6 has
// tripled and means nothing. So "usual" here is the median of the four weeks
// before this one, and a mover is only reported when it also clears an absolute
// floor in dollars. Below that the report says the week was ordinary, which is
// true and worth saying (ADR-024).
//
// This matters more than it would on the dashboard. A reader looking at a screen
// can click into a figure that surprises them; a reader holding a message
// cannot. A confident wrong headline in a weekly message is a claim they have no
// way to check, which is the reason `caprock report` already refuses to publish
// a breakdown whose linkage is too weak.
package weekly

import (
	"sort"
	"time"
)

// MinMoveUSD is the smallest change worth calling a movement.
//
// Ten dollars, and the first draft had it at three — which the tests caught
// immediately. A repository going from $2 to $6 clears a $3 floor and is
// exactly the finding this floor exists to suppress: it is three times its
// usual week and it is nothing. The floor has to be large enough that the
// change is worth a person's attention on its own, before the multiple is even
// considered, because a report that cries wolf is one people stop opening —
// and that costs more than missing a mover.
const MinMoveUSD = 10.0

// BaselineWeeks is how many weeks "usual" is measured over.
//
// Four is a compromise: long enough that one unusual week does not become the
// baseline, short enough to follow someone whose work genuinely changed a month
// ago. The median of the four is used rather than the mean, because one runaway
// week would drag a mean up and hide the next one.
const BaselineWeeks = 4

// Day is one row of daily_stats: a day, a project, a model, and what it cost.
type Day struct {
	Day     string // YYYY-MM-DD
	Project string
	Model   string
	CostUSD float64
	Tokens  int64
}

// Move is one repository whose week departed from its usual.
type Move struct {
	Project string  `json:"project"`
	ThisUSD float64 `json:"this_usd"`
	// UsualUSD is the median of the baseline weeks, which is what "3× its usual
	// week" is measured against — not last week.
	UsualUSD float64 `json:"usual_usd"`
	// Multiple is ThisUSD / UsualUSD. Zero when the project had no baseline at
	// all, which is reported as "new" rather than as an infinite multiple.
	Multiple float64 `json:"multiple"`
	New      bool    `json:"new"`
}

// Report is a week, and what is worth saying about it.
type Report struct {
	WeekStart time.Time `json:"week_start"`
	WeekEnd   time.Time `json:"week_end"`
	CostUSD   float64   `json:"cost_usd"`
	// PriorUSD is the median week of the baseline, for the one line that says
	// whether the week as a whole was ordinary.
	PriorUSD float64 `json:"prior_usd"`
	Tokens   int64   `json:"tokens"`
	// Movers are ranked by how far they departed, biggest first. Empty is the
	// normal case and is not a failure.
	Movers []Move `json:"movers"`
	// Projects is the week's spend per repository, biggest first — the part
	// that is true whether or not anything moved.
	Projects []ProjectWeek `json:"projects"`
	// Quiet says the week produced no reportable movement, so the message can
	// say so plainly instead of listing nothing.
	Quiet bool `json:"quiet"`
	// NoData means the week has no priced activity at all — the machine was off,
	// or the daemon was. Reporting a 100% drop for a week nobody worked would be
	// a lie the reader cannot check.
	NoData bool `json:"no_data"`
}

// ProjectWeek is one repository's week.
type ProjectWeek struct {
	Project string  `json:"project"`
	CostUSD float64 `json:"cost_usd"`
	Tokens  int64   `json:"tokens"`
}

// Build assembles the report for the week ending at weekEnd (exclusive) from
// daily rows covering that week and the baseline before it.
//
// It takes rows rather than a database so the judgement above can be tested
// without one — the same reason cmd/caprock/report.go keeps its assembly pure.
func Build(rows []Day, weekEnd time.Time) Report {
	weekStart := weekEnd.AddDate(0, 0, -7)
	rep := Report{WeekStart: weekStart, WeekEnd: weekEnd}

	// This week, per project.
	thisWeek := map[string]float64{}
	thisTokens := map[string]int64{}
	// Each baseline week, per project, so a median can be taken per project
	// rather than per machine.
	baseline := make([]map[string]float64, BaselineWeeks)
	for i := range baseline {
		baseline[i] = map[string]float64{}
	}
	baseTotals := make([]float64, BaselineWeeks)

	for _, r := range rows {
		d, err := time.ParseInLocation("2006-01-02", r.Day, weekEnd.Location())
		if err != nil {
			continue
		}
		switch {
		case !d.Before(weekStart) && d.Before(weekEnd):
			thisWeek[r.Project] += r.CostUSD
			thisTokens[r.Project] += r.Tokens
			rep.CostUSD += r.CostUSD
			rep.Tokens += r.Tokens
		case d.Before(weekStart):
			// Which baseline week does this day fall in? 0 is the week just
			// before this one.
			weeksBack := int(weekStart.Sub(d).Hours() / (24 * 7)) // 0 for the first six days back
			if weeksBack >= 0 && weeksBack < BaselineWeeks {
				baseline[weeksBack][r.Project] += r.CostUSD
				baseTotals[weeksBack] += r.CostUSD
			}
		}
	}

	if rep.CostUSD == 0 && len(thisWeek) == 0 {
		rep.NoData = true
		return rep
	}

	rep.PriorUSD = median(baseTotals)

	for p, cost := range thisWeek {
		rep.Projects = append(rep.Projects, ProjectWeek{Project: p, CostUSD: cost, Tokens: thisTokens[p]})
	}
	sort.Slice(rep.Projects, func(a, b int) bool { return rep.Projects[a].CostUSD > rep.Projects[b].CostUSD })

	// A mover has to clear both tests: a real change in dollars, and a change
	// against its own usual week. Either alone produces noise — the floor alone
	// flags every busy repository, the multiple alone flags every cheap one.
	for p, cost := range thisWeek {
		var weeks []float64
		for i := range baseline {
			weeks = append(weeks, baseline[i][p])
		}
		usual := median(weeks)
		delta := cost - usual
		if delta < MinMoveUSD {
			continue
		}
		m := Move{Project: p, ThisUSD: cost, UsualUSD: usual}
		if usual <= 0 {
			m.New = true
		} else {
			m.Multiple = cost / usual
			// Twice its usual week, on top of clearing the floor. A repository
			// that grew by half is not news.
			if m.Multiple < 2 {
				continue
			}
		}
		rep.Movers = append(rep.Movers, m)
	}
	sort.Slice(rep.Movers, func(a, b int) bool {
		return rep.Movers[a].ThisUSD-rep.Movers[a].UsualUSD > rep.Movers[b].ThisUSD-rep.Movers[b].UsualUSD
	})
	rep.Quiet = len(rep.Movers) == 0
	return rep
}

// median of the values given, zero for none. Used rather than the mean because
// one runaway week must not become the baseline that hides the next one.
func median(v []float64) float64 {
	if len(v) == 0 {
		return 0
	}
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}
