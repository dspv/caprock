package weekly

import (
	"testing"
	"time"
)

var end = time.Date(2026, 9, 7, 0, 0, 0, 0, time.UTC) // a Monday

// days builds rows for one project across a span, `perDay` dollars each day.
func days(project string, from time.Time, n int, perDay float64) []Day {
	var out []Day
	for i := 0; i < n; i++ {
		out = append(out, Day{
			Day:     from.AddDate(0, 0, i).Format("2006-01-02"),
			Project: project, Model: "claude-opus-5",
			CostUSD: perDay, Tokens: 1000,
		})
	}
	return out
}

// The headline claim: 3x its USUAL week, where usual is a baseline rather than
// last week. A repo that was quiet for a month and then busy is the finding.
func TestReportsARealMover(t *testing.T) {
	var rows []Day
	rows = append(rows, days("quiet-repo", end.AddDate(0, 0, -35), 28, 0.50)...) // ~$3.50/wk
	rows = append(rows, days("quiet-repo", end.AddDate(0, 0, -7), 7, 4.00)...)   // $28 this week

	rep := Build(rows, end)
	if len(rep.Movers) != 1 {
		t.Fatalf("movers: %+v", rep.Movers)
	}
	m := rep.Movers[0]
	if m.Project != "quiet-repo" {
		t.Errorf("project %q", m.Project)
	}
	if m.Multiple < 7 || m.Multiple > 9 {
		t.Errorf("multiple %.1f — want about 8 ($28 against a $3.50 usual)", m.Multiple)
	}
	if rep.Quiet {
		t.Error("a real mover was reported as a quiet week")
	}
}

// The whole reason for the floor. $2 to $6 is 3x and is not a finding; putting
// it in a message the reader cannot click into is worse than saying nothing.
func TestSmallMultiplesAreNotFindings(t *testing.T) {
	var rows []Day
	rows = append(rows, days("tiny", end.AddDate(0, 0, -35), 28, 2.0/7)...) // $2/wk
	rows = append(rows, days("tiny", end.AddDate(0, 0, -7), 7, 6.0/7)...)   // $6 this week

	rep := Build(rows, end)
	if len(rep.Movers) != 0 {
		t.Errorf("a $2 → $6 week was reported as a movement: %+v", rep.Movers)
	}
	if !rep.Quiet {
		t.Error("should have reported a quiet week")
	}
}

// Steady work is not news, however expensive. A repo costing $200 every week
// must not be a mover just because it is the biggest number on the machine.
func TestSteadySpendIsNotAMover(t *testing.T) {
	rows := days("busy", end.AddDate(0, 0, -35), 35, 30)
	rep := Build(rows, end)
	if len(rep.Movers) != 0 {
		t.Errorf("steady spend flagged as movement: %+v", rep.Movers)
	}
	if rep.CostUSD < 200 {
		t.Errorf("this week's total looks wrong: %.2f", rep.CostUSD)
	}
	// It still appears in the week's spend, which is true whether or not
	// anything moved.
	if len(rep.Projects) != 1 || rep.Projects[0].Project != "busy" {
		t.Errorf("projects: %+v", rep.Projects)
	}
}

// One runaway week must not become the baseline that hides the next one —
// which is why the baseline is a median and not a mean.
func TestOneWildWeekDoesNotBecomeTheBaseline(t *testing.T) {
	var rows []Day
	// Three quiet weeks and one huge one in the baseline.
	rows = append(rows, days("repo", end.AddDate(0, 0, -35), 21, 0.20)...)
	rows = append(rows, days("repo", end.AddDate(0, 0, -14), 7, 20.0)...)
	// This week is busy again.
	rows = append(rows, days("repo", end.AddDate(0, 0, -7), 7, 5.0)...)

	rep := Build(rows, end)
	// With a mean baseline (~$36/4 = $9) this would not clear 2x. With a median
	// (~$1.40) it does, which is the honest reading: three weeks in four were
	// quiet.
	if len(rep.Movers) != 1 {
		t.Errorf("a mean baseline hid a real mover: %+v", rep.Movers)
	}
}

// A machine that was off is not a machine whose spending collapsed.
func TestAnEmptyWeekIsNotADrop(t *testing.T) {
	rows := days("repo", end.AddDate(0, 0, -35), 21, 5) // baseline only, nothing this week
	rep := Build(rows, end)
	if !rep.NoData {
		t.Errorf("an empty week should report no data, got %+v", rep)
	}
	if len(rep.Movers) != 0 {
		t.Error("reported movement in a week with no activity")
	}
}

// A repository seen for the first time has no usual week, so it is named as new
// rather than given an infinite multiple.
func TestANewRepositoryIsNamedNew(t *testing.T) {
	rows := days("fresh", end.AddDate(0, 0, -7), 7, 3.0)
	rep := Build(rows, end)
	if len(rep.Movers) != 1 || !rep.Movers[0].New {
		t.Fatalf("movers: %+v", rep.Movers)
	}
	if rep.Movers[0].Multiple != 0 {
		t.Errorf("a new repo should carry no multiple, got %.1f", rep.Movers[0].Multiple)
	}
}

func TestMedian(t *testing.T) {
	for _, c := range []struct {
		in   []float64
		want float64
	}{
		{nil, 0},
		{[]float64{5}, 5},
		{[]float64{1, 2, 3}, 2},
		{[]float64{1, 2, 3, 100}, 2.5}, // the outlier does not move it
	} {
		if got := median(c.in); got != c.want {
			t.Errorf("median(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}
