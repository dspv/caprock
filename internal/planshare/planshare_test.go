package planshare

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

const day = int64(24 * 3600 * 1000)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestFactorFlatPlan(t *testing.T) {
	now := 100 * day
	from := now - PlanDays*day
	r, note := Factor(Plan{Kind: "flat", Label: "Max", USDPerMonth: 200}, 4000, from, now, 0)
	if r == nil || note != "" {
		t.Fatalf("no factor: %q", note)
	}
	if !near(r.Factor, 200.0/4000) || r.Days != PlanDays || r.FeeUSD != 200 || r.From != from || r.To != now {
		t.Fatalf("rate = %+v", r)
	}
	// $50 of API-priced work is $2.50 of the plan.
	if got := 50 * r.Factor; !near(got, 2.5) {
		t.Fatalf("50 × factor = %v", got)
	}
}

func TestFactorShortHistoryUsesThePriceOfTheDaysRecorded(t *testing.T) {
	now := 100 * day
	from := now - PlanDays*day
	// First session ten days ago: ten days of the price over ten days of spend.
	r, _ := Factor(Plan{Kind: "flat", USDPerMonth: 300}, 50, from, now, now-10*day)
	if r == nil || !near(r.Days, 10) || !near(r.FeeUSD, 100) || !near(r.Factor, 2) || r.From != now-10*day {
		t.Fatalf("rate = %+v", r)
	}
	// A first session older than the period changes nothing.
	r, _ = Factor(Plan{Kind: "flat", USDPerMonth: 300}, 50, from, now, now-90*day)
	if r == nil || r.Days != PlanDays {
		t.Fatalf("rate = %+v", r)
	}
}

func TestFactorNeverGuesses(t *testing.T) {
	now := 100 * day
	from := now - PlanDays*day
	for _, c := range []struct {
		plan Plan
		api  float64
		note string
	}{
		{Plan{Kind: "metered", USDPerMonth: 200}, 100, NoteMetered},
		{Plan{}, 100, NoteNoPlan},
		{Plan{Kind: "flat"}, 100, NoteNoPlan},                          // price 0 = not stated
		{Plan{Kind: "flat", USDPerMonth: math.NaN()}, 100, NoteNoPlan}, // never from a bad number
		{Plan{Kind: "flat", USDPerMonth: 100}, 0, NoteNoSpend},
	} {
		if r, note := Factor(c.plan, c.api, from, now, 0); r != nil || note != c.note {
			t.Fatalf("%+v: rate %+v, note %q, want %q", c.plan, r, note, c.note)
		}
	}
}

// week builds samples of one window ending at reset (unix s): pcts at the
// given hours after the window's start.
func week(reset int64, at []float64, pct []float64) []Sample {
	start := reset*1000 - WeekMs
	out := make([]Sample, len(at))
	for i := range at {
		out[i] = Sample{Ts: start + int64(at[i]*3600*1000), Pct: pct[i], ResetsAt: reset}
	}
	return out
}

func TestStretchFromTheWindowStartToTheFirstHighest(t *testing.T) {
	reset := int64(1_000_000)
	now := reset*1000 + day
	// Out-of-order noise (40 after 45) is ignored; the highest, 60, is
	// first seen at hour 100 and seen again later.
	s := week(reset, []float64{2, 30, 50, 51, 100, 150}, []float64{0, 20, 45, 40, 60, 60})
	got := Stretches(s, now)
	if len(got) != 1 {
		t.Fatalf("stretches = %+v", got)
	}
	st := got[0]
	start := reset*1000 - WeekMs
	if !st.Completed || st.From != start || st.To != start+100*3600*1000 || st.UsedPoints != 60 {
		t.Fatalf("stretch = %+v", st)
	}
}

func TestStretchStartsAgainAfterAnEarlyReset(t *testing.T) {
	reset := int64(1_000_000)
	now := reset*1000 + day
	// 66% then 0% on day five (Anthropic reset the week), then 30%.
	s := week(reset, []float64{10, 96, 100, 140}, []float64{30, 66, 0, 30})
	st := Stretches(s, now)[0]
	start := reset*1000 - WeekMs
	if st.From != start+100*3600*1000 || st.To != start+140*3600*1000 || st.UsedPoints != 30 {
		t.Fatalf("stretch = %+v", st)
	}
}

func TestStretchStopsAtTheLimit(t *testing.T) {
	reset := int64(1_000_000)
	now := reset*1000 + day
	// 100% at hour 120; work after it adds spend and no percentage.
	s := week(reset, []float64{20, 120, 160}, []float64{40, 100, 100})
	st := Stretches(s, now)[0]
	if st.To != reset*1000-WeekMs+120*3600*1000 || st.UsedPoints != 100 {
		t.Fatalf("stretch = %+v", st)
	}
}

func TestStretchesOrderAndLimits(t *testing.T) {
	r1 := int64(1_000_000)
	r2 := r1 + WeekMs/1000
	r3 := r2 + WeekMs/1000 // current
	now := r2*1000 + 3*day
	var s []Sample
	s = append(s, week(r1, []float64{50}, []float64{40})...)
	s = append(s, week(r2, []float64{50}, []float64{70})...)
	s = append(s, week(r3, []float64{20}, []float64{25})...)
	// A window too thin to calibrate on is left out.
	s = append(s, week(r3+WeekMs/1000, []float64{1}, []float64{5})...)
	got := Stretches(s, now)
	if len(got) != 3 || got[0].ResetsAt != r2 || got[1].ResetsAt != r1 || got[2].ResetsAt != r3 || got[2].Completed {
		t.Fatalf("order = %+v", got)
	}
	// Past the lookback a completed week is not used.
	got = Stretches(s, r1*1000+WeekLookbackMs+1)
	for _, st := range got {
		if st.ResetsAt == r1 {
			t.Fatalf("stale week kept: %+v", got)
		}
	}
}

func TestStretchMergesAWanderingReset(t *testing.T) {
	// Codex reports its reset to the second, and it moves between samples.
	reset := int64(1_000_000)
	s := []Sample{
		{Ts: reset*1000 - WeekMs + 3600_000, Pct: 10, ResetsAt: reset - 2},
		{Ts: reset*1000 - WeekMs + 7200_000, Pct: 30, ResetsAt: reset + 1},
	}
	got := Stretches(s, reset*1000+day)
	if len(got) != 1 || got[0].UsedPoints != 30 {
		t.Fatalf("stretches = %+v", got)
	}
}

func TestCalibrate(t *testing.T) {
	r1 := int64(1_000_000)
	r2 := r1 + WeekMs/1000
	now := r1*1000 + 2*day // r1 completed, r2 current
	s := append(week(r1, []float64{100}, []float64{50}), week(r2, []float64{30}, []float64{20})...)
	var asked [][2]int64
	spend := func(usd float64) func(a, b int64) (float64, error) {
		return func(a, b int64) (float64, error) { asked = append(asked, [2]int64{a, b}); return usd, nil }
	}
	w, note, err := Calibrate(s, now, spend(500))
	if err != nil || note != "" || w == nil {
		t.Fatalf("w %+v note %q err %v", w, note, err)
	}
	if !w.Completed || w.ResetsAt != r1 || !near(w.PctPerUSD, 50.0/500) || w.APIUSD != 500 {
		t.Fatalf("week = %+v", w)
	}
	// A $1,200 release is 120% of that week: shown as it is, not capped.
	if got := 1200 * w.PctPerUSD; !near(got, 120) {
		t.Fatalf("1200 × rate = %v", got)
	}
	if asked[0][0] != r1*1000-WeekMs {
		t.Fatalf("spend asked from %d", asked[0][0])
	}

	// Too little spend in every stretch: not enough.
	if w, note, _ := Calibrate(s, now, spend(0.5)); w != nil || note != NoteNotEnough {
		t.Fatalf("w %+v note %q", w, note)
	}
	// No completed week yet: the current one stands in once it has enough.
	cur := week(r2, []float64{30}, []float64{20})
	if w, _, _ := Calibrate(cur, now, spend(10)); w == nil || w.Completed || !near(w.PctPerUSD, 2) {
		t.Fatalf("current = %+v", w)
	}
	// Never observed: no window.
	if w, note, _ := Calibrate(nil, now, spend(10)); w != nil || note != NoteNoWindow {
		t.Fatalf("w %+v note %q", w, note)
	}
}

// TestComputeBySignIn runs the whole computation over a store: each sign-in
// gets its own plan's factor and its own week, the Codex sign-in no plan
// dollars (a Claude plan's price says nothing about Codex), DeepSeek none
// (metered), and the window stored under each one's key calibrates only it.
func TestComputeBySignIn(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	db := st.DB()
	now := time.Now()
	n := 0
	turn := func(id, agent, sub string, cost float64, at time.Time) {
		t.Helper()
		if err := store.UpsertSession(ctx, db, id, store.SessionPatch{Cwd: "/x", Agent: agent, Subscription: sub, StartedAt: now.Add(-60 * 24 * time.Hour).UnixMilli()}); err != nil {
			t.Fatal(err)
		}
		n++
		c := cost
		if _, err := store.InsertEvent(ctx, db, &event.Event{SessionID: id, Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
			Key: "k" + string(rune('a'+n)), Ts: at, CostUSD: &c}); err != nil {
			t.Fatal(err)
		}
	}
	// The own Claude sign-in: $4,000 in the month, $1,000 of it in the week
	// that ended yesterday, which used 50%.
	reset := now.Add(-24 * time.Hour).Truncate(time.Hour)
	turn("own", "claude", "", 3000, now.Add(-20*24*time.Hour))
	turn("own", "claude", "", 1000, reset.Add(-3*24*time.Hour))
	if err := store.RecordRateLimit(ctx, db, store.RateLimitSnapshot{Window: "seven_day", Ts: reset.Add(-2 * time.Hour).UnixMilli(), UsedPercentage: 50, ResetsAt: reset.Unix()}, "own"); err != nil {
		t.Fatal(err)
	}
	// An added Claude subscription on its own $100 plan: $500 in the month.
	turn("work", "claude", "ab12cd34", 500, now.Add(-5*24*time.Hour))
	// Codex on its own sign-in, with a current week at 40% after $80.
	turn("cx", "codex", "", 80, now.Add(-2*time.Hour))
	if _, err := store.ReplaceRateLimits(ctx, db, store.CodexRateLimitPrefix, "cx", []store.RateLimitSnapshot{
		{Window: "seven_day", Ts: now.Add(-time.Hour).UnixMilli(), UsedPercentage: 40, ResetsAt: now.Add(3 * 24 * time.Hour).Unix()}}); err != nil {
		t.Fatal(err)
	}
	// DeepSeek: metered.
	turn("ds", "claude", "deepseek", 7, now.Add(-time.Hour))

	resp, err := Compute(ctx, db, []SignIn{
		{Agent: "claude", Label: "Own sign-in", Plan: Plan{Kind: "flat", USDPerMonth: 200}, Window: "seven_day"},
		{Agent: "claude", Subscription: "ab12cd34", Label: "Work", Plan: Plan{Kind: "flat", USDPerMonth: 100}, Window: "sub:ab12cd34:seven_day"},
		{Agent: "claude", Subscription: "deepseek", Label: "DeepSeek", Plan: Plan{Kind: "metered"}},
		{Agent: "codex", Label: "Own sign-in", Window: "codex_seven_day"},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]Rate{}
	for _, r := range resp.Rates {
		by[r.Agent+"|"+r.Subscription] = r
	}
	own := by["claude|"]
	if own.Plan == nil || !near(own.Plan.Factor, 200.0/4000) {
		t.Fatalf("own plan = %+v", own.Plan)
	}
	if own.Week == nil || !own.Week.Completed || !near(own.Week.PctPerUSD, 50.0/1000) {
		t.Fatalf("own week = %+v (%s)", own.Week, own.WeekNote)
	}
	work := by["claude|ab12cd34"]
	if work.Plan == nil || !near(work.Plan.Factor, 100.0/500) || work.Week != nil || work.WeekNote != NoteNoWindow {
		t.Fatalf("work = %+v", work)
	}
	if ds := by["claude|deepseek"]; ds.Plan != nil || ds.PlanNote != NoteMetered || ds.Week != nil {
		t.Fatalf("deepseek = %+v", ds)
	}
	cx := by["codex|"]
	if cx.Plan != nil || cx.PlanNote != NoteNoPlan {
		t.Fatalf("codex plan = %+v %q", cx.Plan, cx.PlanNote)
	}
	if cx.Week == nil || cx.Week.Completed || !near(cx.Week.PctPerUSD, 40.0/80) {
		t.Fatalf("codex week = %+v (%s)", cx.Week, cx.WeekNote)
	}
}
