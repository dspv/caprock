// Package planshare turns a cost at API list price into what that work was of
// the user's subscription: plan dollars and a share of the weekly limit.
//
// Every cost Caprock shows is the API-list-price equivalent of the tokens it
// recorded. On a flat plan (Pro, Max, a Team seat) that is not a bill, and the
// owner asked to see, beside it, what the work was in subscription terms
// (2026-10-25):
//
//	$50 at API · ≈$5 of plan · ≈8% of a week
//
// Both are derived figures, labelled estimates on screen (rule 6), and both
// are per sign-in — the user's own Claude Code sign-in, each added
// subscription (ADR-048), Codex's — because each has its own plan and its own
// limit. This package computes the two rates per sign-in, once, in the
// daemon; a figure is priced by multiplying each of its parts (the cost each
// sign-in ran) by its sign-in's rate. The screens do that multiplication
// through one shared function so the wording and the arithmetic cannot drift.
//
// Plan dollars. factor = the plan's price over the trailing PlanDays /
// the API-equivalent spend recorded on that sign-in over the same days. The
// trailing window rather than the calendar month, so the factor does not
// jump on the first. A sign-in recorded for fewer than PlanDays days divides
// that much of the price by that much spend. A metered plan has no factor
// (its API figure is the bill), nor has a sign-in with no plan stated or a
// price of 0: Caprock never guesses one.
//
// Share of a week. Claude Code's status line (and Codex's transcripts)
// report the weekly window's used percentage; the history keeps those
// samples. percent-per-API-dollar = the points used in one weekly window /
// the API spend recorded on that sign-in over the same stretch. See
// Calibrate for which window and which stretch.
//
// Use outside Caprock — claude.ai chats, another machine — draws on the same
// plan and the same limit without being recorded here, so both rates run a
// little high. The screens say so in the figure's explanation.
package planshare

import (
	"context"
	"math"
	"sort"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// PlanDays is the trailing period the plan factor is measured over.
const PlanDays = 30

// WeekMs is the weekly window's length.
const WeekMs = 7 * 24 * 3600 * 1000

// MinWeekPoints and MinWeekUSD are the least a weekly stretch must hold to
// calibrate on: 10 percentage points used (the status line reports whole
// percentages, so fewer would leave a rounding error over a twentieth of the
// figure) and a dollar of recorded spend.
const (
	MinWeekPoints = 10.0
	MinWeekUSD    = 1.0
)

// ResetDrop is how far the used percentage must fall below the stretch's
// highest so far to be read as a reset inside the window (Anthropic resets
// limits early now and then: on the owner's machine a week fell from 66% to
// 0% on its fifth day, 2026-10-09). Smaller falls are samples arriving out of
// order from two sessions — 63% after 61% after 56% — and are ignored.
const ResetDrop = 20.0

// WeekLookbackMs is how far back a completed window may have ended and
// still calibrate: limits and prices change, and a stale week would price
// today's work at an old rate.
const WeekLookbackMs = 35 * 24 * 3600 * 1000

// Plan is how a sign-in is paid for, as the user stated it.
type Plan struct {
	Kind        string // "flat", "metered", "" (not stated)
	Label       string
	USDPerMonth float64
}

// PlanRate is a sign-in's plan factor and what it was computed from.
type PlanRate struct {
	Label       string  `json:"label,omitempty"`
	USDPerMonth float64 `json:"usd_per_month"`
	// Days is how many of the trailing PlanDays the sign-in has been
	// recorded for (PlanDays unless its first session is newer).
	Days float64 `json:"days"`
	// FeeUSD is the price over those days: USDPerMonth × Days / PlanDays.
	FeeUSD float64 `json:"fee_usd"`
	// APIUSD is the recorded API-equivalent spend over the same days.
	APIUSD float64 `json:"api_usd"`
	From   int64   `json:"from"` // unix ms
	To     int64   `json:"to"`   // unix ms
	// Factor is plan dollars per API dollar: FeeUSD / APIUSD.
	Factor float64 `json:"factor"`
}

// Plan notes: why a sign-in has no plan factor.
const (
	NoteMetered = "metered" // billed per token: the API figure is the bill
	NoteNoPlan  = "no_plan" // no plan stated, or a price of 0
	NoteNoSpend = "no_spend"
)

// Factor computes a sign-in's plan factor from its plan, its recorded spend
// over [from, now) and when it was first seen, or names why there is none.
// from is now − PlanDays; firstAt 0 means unknown (taken as before from).
func Factor(p Plan, apiUSD float64, from, now, firstAt int64) (*PlanRate, string) {
	switch {
	case p.Kind == "metered":
		return nil, NoteMetered
	case p.Kind != "flat" || !(p.USDPerMonth > 0) || math.IsInf(p.USDPerMonth, 0):
		return nil, NoteNoPlan
	}
	start := from
	if firstAt > start && firstAt < now {
		start = firstAt
	}
	days := float64(now-start) / float64(24*3600*1000)
	if days > PlanDays {
		days = PlanDays
	}
	if !(apiUSD > 0) || days <= 0 {
		return nil, NoteNoSpend
	}
	fee := p.USDPerMonth * days / PlanDays
	return &PlanRate{Label: p.Label, USDPerMonth: p.USDPerMonth, Days: days, FeeUSD: fee, APIUSD: apiUSD,
		From: start, To: now, Factor: fee / apiUSD}, ""
}

// Sample is one observation of a weekly window.
type Sample struct {
	Ts       int64   // unix ms observed
	Pct      float64 // used percentage, 0–100
	ResetsAt int64   // unix seconds
}

// WeekRate is a sign-in's share of a week per API dollar and what it was
// calibrated on.
type WeekRate struct {
	// ResetsAt is the calibrated window's end (unix seconds).
	ResetsAt int64 `json:"resets_at"`
	// Completed is whether that window has ended; false is the current
	// one, used only while no completed window qualifies.
	Completed bool `json:"completed"`
	// From and To bound the measured stretch (unix ms): the window's start,
	// or the first sample after a reset inside it, to the first sample at
	// the stretch's highest percentage.
	From int64 `json:"from"`
	To   int64 `json:"to"`
	// UsedPoints is the percentage points used over the stretch.
	UsedPoints float64 `json:"used_points"`
	// APIUSD is the recorded spend on the sign-in over the stretch.
	APIUSD float64 `json:"api_usd"`
	// PctPerUSD is UsedPoints / APIUSD: a week's percent per API dollar.
	PctPerUSD float64 `json:"pct_per_usd"`
}

// Week notes: why a sign-in has no weekly rate.
const (
	NoteNoWindow  = "no_window"  // no weekly window ever observed
	NoteNotEnough = "not_enough" // windows observed, none with enough data
)

// Stretch is one window's measured stretch, before its spend is known.
type Stretch struct {
	ResetsAt   int64
	Completed  bool
	From, To   int64
	UsedPoints float64
}

// Stretches lists, from samples of one weekly window, the stretches to try
// in order: completed windows that ended within WeekLookbackMs, newest
// first, then the current window. A stretch with fewer than MinWeekPoints is
// left out.
//
// Within a window (the samples whose reset is the same, give or take an
// hour — Codex reports its reset to the second and it wanders), samples are
// read oldest first: the stretch starts at the window's start with 0% used,
// and starts again at a sample ResetDrop or more below the highest so far
// (an early reset), with that sample's percentage as its base. It ends at
// the first sample at its highest percentage — usage only grows inside a
// window, so a later lower sample is a stale one, and work after the limit
// was reached adds spend and no percentage.
func Stretches(samples []Sample, now int64) []Stretch {
	byReset := clusters(samples)
	var done, cur []Stretch
	for _, c := range byReset {
		st, ok := stretch(c)
		if !ok {
			continue
		}
		if st.ResetsAt*1000 <= now {
			if now-st.ResetsAt*1000 > WeekLookbackMs {
				continue
			}
			st.Completed = true
			done = append(done, st)
		} else {
			cur = append(cur, st)
		}
	}
	sort.Slice(done, func(i, j int) bool { return done[i].ResetsAt > done[j].ResetsAt })
	return append(done, cur...)
}

// clusters groups samples by reset, merging resets within an hour of each
// other; each group is sorted by observation time.
func clusters(samples []Sample) [][]Sample {
	var s []Sample
	for _, x := range samples {
		if x.ResetsAt > 0 && x.Pct >= 0 && x.Pct <= 100 {
			s = append(s, x)
		}
	}
	sort.Slice(s, func(i, j int) bool {
		if s[i].ResetsAt != s[j].ResetsAt {
			return s[i].ResetsAt < s[j].ResetsAt
		}
		return s[i].Ts < s[j].Ts
	})
	var out [][]Sample
	for i := 0; i < len(s); {
		j := i + 1
		for j < len(s) && s[j].ResetsAt-s[j-1].ResetsAt <= 3600 {
			j++
		}
		g := append([]Sample(nil), s[i:j]...)
		sort.SliceStable(g, func(a, b int) bool { return g[a].Ts < g[b].Ts })
		out = append(out, g)
		i = j
	}
	return out
}

// stretch measures one window's samples (sorted by time).
func stretch(g []Sample) (Stretch, bool) {
	if len(g) == 0 {
		return Stretch{}, false
	}
	var reset int64
	for _, x := range g {
		reset = max(reset, x.ResetsAt)
	}
	start := reset*1000 - WeekMs
	from, base, top, topAt := start, 0.0, 0.0, int64(0)
	for _, x := range g {
		if x.Ts < start || x.Ts > reset*1000 {
			continue
		}
		switch {
		case x.Pct <= top-ResetDrop:
			from, base, top, topAt = x.Ts, x.Pct, x.Pct, 0
		case x.Pct > top:
			top, topAt = x.Pct, x.Ts
		}
	}
	points := top - base
	if topAt == 0 || points < MinWeekPoints {
		return Stretch{}, false
	}
	return Stretch{ResetsAt: reset, From: from, To: topAt, UsedPoints: points}, true
}

// Calibrate picks the first stretch whose recorded spend reaches MinWeekUSD
// and returns its rate. spend(from, to) is the sign-in's recorded spend in
// [from, to). With no samples at all the note is NoteNoWindow; with samples
// but no qualifying stretch, NoteNotEnough.
func Calibrate(samples []Sample, now int64, spend func(from, to int64) (float64, error)) (*WeekRate, string, error) {
	if len(samples) == 0 {
		return nil, NoteNoWindow, nil
	}
	for _, st := range Stretches(samples, now) {
		usd, err := spend(st.From, st.To+1)
		if err != nil {
			return nil, "", err
		}
		if usd < MinWeekUSD {
			continue
		}
		return &WeekRate{ResetsAt: st.ResetsAt, Completed: st.Completed, From: st.From, To: st.To,
			UsedPoints: st.UsedPoints, APIUSD: usd, PctPerUSD: st.UsedPoints / usd}, "", nil
	}
	return nil, NoteNotEnough, nil
}

// Rate is one sign-in's two rates, as GET /v1/plan-share lists them.
type Rate struct {
	Agent string `json:"agent"`
	// Subscription is the id sessions record: "" for the own sign-in, an
	// added subscription's id, or "deepseek".
	Subscription string `json:"subscription"`
	Label        string `json:"label"`
	// PlanKind is the plan that stands for this sign-in: its own, else the
	// main plan for Claude Code; "" when none is stated.
	PlanKind string    `json:"plan_kind"`
	Plan     *PlanRate `json:"plan,omitempty"`
	PlanNote string    `json:"plan_note,omitempty"`
	Week     *WeekRate `json:"week,omitempty"`
	WeekNote string    `json:"week_note,omitempty"`
}

// Response is GET /v1/plan-share.
type Response struct {
	ComputedAt int64  `json:"computed_at"`
	PlanDays   int    `json:"plan_days"`
	Rates      []Rate `json:"rates"`
}

// SignIn is one sign-in to compute rates for.
type SignIn struct {
	Agent, Subscription, Label string
	// Plan is the plan that stands for it (its own, else the main plan for
	// Claude Code).
	Plan Plan
	// Window is the rate_limit key of its weekly window ("seven_day",
	// "codex_seven_day", "sub:<id>:seven_day"); "" when it has none.
	Window string
}

// Compute is both rates for every sign-in, from the store as of now: one
// grouped read of the trailing PlanDays' spend, one of first sessions, and
// per sign-in with a weekly window its samples and a spend sum per stretch
// tried.
func Compute(ctx context.Context, q store.Querier, signIns []SignIn, now time.Time) (Response, error) {
	nowMs := now.UnixMilli()
	from := nowMs - PlanDays*24*3600*1000
	out := Response{ComputedAt: nowMs, PlanDays: PlanDays, Rates: []Rate{}}
	parts, err := store.SpendPartsBetween(ctx, q, from, nowMs, "")
	if err != nil {
		return out, err
	}
	spent := map[string]float64{}
	for _, p := range parts {
		spent[p.Agent+"|"+p.Subscription] += p.CostUSD
	}
	first, err := store.FirstSessionBySignIn(ctx, q)
	if err != nil {
		return out, err
	}
	for _, si := range signIns {
		key := si.Agent + "|" + si.Subscription
		r := Rate{Agent: si.Agent, Subscription: si.Subscription, Label: si.Label, PlanKind: si.Plan.Kind}
		r.Plan, r.PlanNote = Factor(si.Plan, spent[key], from, nowMs, first[key])
		if si.Window == "" {
			r.WeekNote = NoteNoWindow
		} else {
			snaps, err := store.RateLimitSamples(ctx, q, si.Window, nowMs-WeekLookbackMs-WeekMs)
			if err != nil {
				return out, err
			}
			samples := make([]Sample, 0, len(snaps))
			for _, s := range snaps {
				samples = append(samples, Sample{Ts: s.Ts, Pct: s.UsedPercentage, ResetsAt: s.ResetsAt})
			}
			r.Week, r.WeekNote, err = Calibrate(samples, nowMs, func(a, b int64) (float64, error) {
				return store.SpendOn(ctx, q, si.Agent, si.Subscription, a, b)
			})
			if err != nil {
				return out, err
			}
		}
		out.Rates = append(out.Rates, r)
	}
	return out, nil
}
