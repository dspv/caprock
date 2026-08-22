package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// reportRoutes wires a fake daemon answering the three endpoints the report
// reads. Each argument is the raw JSON body for one endpoint.
func reportRoutes(summary, settings, history string) map[string]http.HandlerFunc {
	body := func(s string) http.HandlerFunc {
		return func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(s)) }
	}
	return map[string]http.HandlerFunc{
		"/v1/stats/summary": body(summary),
		"/v1/settings":      body(settings),
		"/v1/history":       body(history),
	}
}

const (
	// A small but complete summary: two projects, one model, real cache figures.
	sampleSummary = `{
		"sessions": 4, "turns": 120, "tool_calls": 300, "cost_usd": 640,
		"pricing_version": "2026-08-18.1",
		"savings": {"hit_rate": 0.9, "cut_pct": 80},
		"models": [{"model":"claude-opus-5","cost_usd":600,"turns":100}],
		"projects": [{"project":"alpha","cost_usd":400},{"project":"beta","cost_usd":240}]
	}`
	// Thirty days of window, so the prorated fee is exactly one month's.
	sampleHistory = `{"totals":{"days":20},"daily":[{"day":"2026-07-01"},{"day":"2026-07-30"}]}`
	flatPlan      = `{"plan_kind":"flat","plan_label":"Max 20\u00d7","plan_usd_per_month":200}`
)

// The multiple is the one figure on this report that is a claim rather than a
// measurement, and it only exists if there is a fee to divide by. A flat plan
// whose monthly price was never stated has no denominator: the honest output
// says so, and must not print a number.
//
// Mutation proof: the fee is guarded twice in assembleReport — once on
// `plan.PlanUSDPerMonth > 0` and once on the prorated `fee > 0` — and with a
// fee of 0 either guard alone still stops it, so removing just one leaves the
// test green. Removing *both* makes the multiple 0/0 and this fails with
//
//	"a multiple was computed with no plan fee to divide by: NaN× the fee".
//
// The redundancy is deliberate: the outer guard states the rule, the inner one
// also covers a window so short that the prorated fee underflows to zero.
func TestReportRefusesAMultipleWithoutAPlanFee(t *testing.T) {
	fakeDaemon(t, reportRoutes(sampleSummary,
		`{"plan_kind":"flat","plan_label":"a plan","plan_usd_per_month":0}`,
		sampleHistory))

	out, err := runCLI(t, "report")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "×") {
		t.Fatalf("a multiple was computed with no plan fee to divide by:\n%s", out)
	}
	if !strings.Contains(out, "No monthly fee stated") {
		t.Fatalf("report did not say why there is no multiple:\n%s", out)
	}

	// The machine-readable shape must omit it too, rather than send 0 — a
	// consumer cannot tell a real zero from a missing value otherwise.
	jsonOut, err := runCLI(t, "report", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(jsonOut), &got); err != nil {
		t.Fatalf("--json is not valid JSON: %v\n%s", err, jsonOut)
	}
	if _, present := got["multiple"]; present {
		t.Fatalf("multiple present in JSON with no fee: %v", got["multiple"])
	}
}

// With no plan stated at all, nothing may be claimed about what the usage is
// worth — and the report has to say that rather than printing the cost alone
// and letting the reader assume it is a bill.
//
// Mutation proof: removing the `if r.Plan == nil` branch in writeReportText
// fails with "report did not explain the missing plan".
func TestReportSaysNothingIsClaimedWithoutAPlan(t *testing.T) {
	fakeDaemon(t, reportRoutes(sampleSummary, `{"plan_kind":"","plan_usd_per_month":0}`, sampleHistory))

	out, err := runCLI(t, "report")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "×") {
		t.Fatalf("claimed a multiple with no plan at all:\n%s", out)
	}
	if !strings.Contains(out, "No plan stated") {
		t.Fatalf("report did not explain the missing plan:\n%s", out)
	}
}

// The caveat is the reason this command can exist under rule 6. It must be in
// the human output on every plan shape — including the one where the figure IS
// approximately a bill, where the wrong caveat is as bad as none.
//
// Mutation proof: deleting the `fmt.Fprintln(out, r.Caveat)` line in
// writeReportText fails for all three plans with e.g.
//
//	"flat: human output carries no caveat".
func TestReportAlwaysCarriesItsCaveat(t *testing.T) {
	for _, tc := range []struct {
		name     string
		settings string
		want     string
		mustNot  string
	}{
		// The dashboard's own wording — CostBasis.tsx and PlanValue.tsx — so
		// the CLI, the dashboard and the site say the same thing.
		{"flat", flatPlan, "Not a bill", "approximately the actual cost"},
		{"metered", `{"plan_kind":"metered","plan_usd_per_month":0}`, "not a saving", "Not a bill"},
		{"unset", `{"plan_kind":"","plan_usd_per_month":0}`, "no plan is stated", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fakeDaemon(t, reportRoutes(sampleSummary, tc.settings, sampleHistory))
			out, err := runCLI(t, "report")
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out, "Anthropic list prices") {
				t.Fatalf("%s: human output carries no caveat:\n%s", tc.name, out)
			}
			if !strings.Contains(out, tc.want) {
				t.Fatalf("%s: caveat missing %q:\n%s", tc.name, tc.want, out)
			}
			if tc.mustNot != "" && strings.Contains(out, tc.mustNot) {
				t.Fatalf("%s: caveat carries the wrong plan's wording %q:\n%s", tc.name, tc.mustNot, out)
			}
		})
	}
}

// A flat plan must never be described with the language of money returned. This
// is the same rule PlanValue.test.tsx pins on the dashboard, restated here
// because the CLI output is the one that gets pasted into a post.
func TestReportNeverCallsItASaving(t *testing.T) {
	fakeDaemon(t, reportRoutes(sampleSummary, flatPlan, sampleHistory))
	out, err := runCLI(t, "report")
	if err != nil {
		t.Fatal(err)
	}
	for _, banned := range []string{"you saved", "savings", "saved $", "discount you"} {
		if strings.Contains(strings.ToLower(out), banned) {
			t.Fatalf("report framed a flat plan as money back (%q):\n%s", banned, out)
		}
	}
}

// Day one: the daemon is up, the database is empty. The report must say that in
// a sentence, not print a page of zeroes — and above all must not divide by a
// window that does not exist.
//
// Mutation proof: removing the `if r.Window == nil` early return in
// writeReportText panics the command with a nil-pointer dereference on
// r.Window.First, and the test fails with "report on an empty database failed".
func TestReportOnAnEmptyDatabaseSaysSo(t *testing.T) {
	fakeDaemon(t, reportRoutes(
		`{"sessions":0,"turns":0,"tool_calls":0,"cost_usd":0,"pricing_version":"2026-08-18.1",
		  "savings":{"hit_rate":0,"cut_pct":0},"models":[],"projects":[]}`,
		flatPlan,
		`{"totals":{"days":0},"daily":[]}`))

	out, err := runCLI(t, "report")
	if err != nil {
		t.Fatalf("report on an empty database failed: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Nothing recorded yet") {
		t.Fatalf("empty database did not produce an honest sentence:\n%s", out)
	}
	if strings.Contains(out, "×") || strings.Contains(out, "0 active days") {
		t.Fatalf("empty database produced a wall of zeroes:\n%s", out)
	}
	// Nothing cached is not the same as a 0% cache hit rate, which reads as a
	// broken cache. The figure must be absent, not zero.
	if strings.Contains(out, "0% cache hit") {
		t.Fatalf("reported a confident 0%% cache hit on an empty database:\n%s", out)
	}
}

// An empty database must still emit valid JSON a caller can parse, with the
// unmeasurable fields absent rather than zeroed.
func TestReportJSONOnAnEmptyDatabaseOmitsWhatItCannotMeasure(t *testing.T) {
	fakeDaemon(t, reportRoutes(
		`{"sessions":0,"turns":0,"cost_usd":0,"pricing_version":"2026-08-18.1",
		  "savings":{"hit_rate":0,"cut_pct":0},"models":[],"projects":[]}`,
		flatPlan,
		`{"totals":{"days":0},"daily":[]}`))

	out, err := runCLI(t, "report", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("--json on an empty database is not valid JSON: %v\n%s", err, out)
	}
	for _, absent := range []string{"multiple", "window", "cache_hit_pct", "cache_cut_pct"} {
		if _, present := got[absent]; present {
			t.Fatalf("%q should be omitted on an empty database, got %v", absent, got[absent])
		}
	}
	// The caveat is not conditional on there being data.
	if s, _ := got["caveat"].(string); !strings.Contains(s, "Anthropic list prices") {
		t.Fatalf("caveat missing from empty-database JSON: %q", s)
	}
}

// The multiple divides by the fee for the window that was measured, not by one
// month regardless of how long the window is. Twenty days of usage compared
// against a full month's fee would understate it; sixty days against one month
// would double it.
//
// Mutation proof: forcing `months := 1.0` (charging one month's fee whatever
// the window) fails with
//
//	"fee was not prorated to the window: got $200.00 over a 60-day span, want $400.00".
//
// The window here is 60 days precisely so that dropping the prorating is
// visible; over a 30-day window the two are identical and the test would pass.
func TestReportProratesThePlanFeeToTheMeasuredWindow(t *testing.T) {
	// 2026-07-01 → 2026-08-29 inclusive is 60 days: two months of fee.
	fakeDaemon(t, reportRoutes(sampleSummary, flatPlan,
		`{"totals":{"days":40},"daily":[{"day":"2026-07-01"},{"day":"2026-08-29"}]}`))

	out, err := runCLI(t, "report", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var got Report
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatal(err)
	}
	if got.FeeUSD < 399.9 || got.FeeUSD > 400.1 {
		t.Fatalf("fee was not prorated to the window: got $%.2f over a 60-day span, want $400.00", got.FeeUSD)
	}
	// And the multiple must be the cost divided by exactly that fee.
	if got.Multiple == nil {
		t.Fatal("no multiple computed")
	}
	if want := 640.0 / 400.0; *got.Multiple < want-0.01 || *got.Multiple > want+0.01 {
		t.Fatalf("multiple %.3f is not cost/fee (%.3f)", *got.Multiple, want)
	}
}

// Active days come from the daemon's own indexed count, not from counting the
// daily rows the report happens to receive. The two differ whenever the daily
// list is trimmed, and the daily-row count is the one that has been wrong
// before (32 real days reported as 21).
//
// Mutation proof: changing reportWindow to `active := len(all)` fails with
// "active days came from the daily rows (2), not the daemon's count (20)".
func TestReportTakesActiveDaysFromTheDaemonNotTheRowCount(t *testing.T) {
	fakeDaemon(t, reportRoutes(sampleSummary, flatPlan, sampleHistory))
	out, err := runCLI(t, "report", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var got Report
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatal(err)
	}
	if got.Window == nil {
		t.Fatal("no window")
	}
	// sampleHistory carries two daily rows but reports 20 active days.
	if got.Window.ActiveDays != 20 {
		t.Fatalf("active days came from the daily rows (%d), not the daemon's count (20)",
			got.Window.ActiveDays)
	}
	if got.Window.First != "2026-07-01" || got.Window.Last != "2026-07-30" {
		t.Fatalf("window edges wrong: %+v", got.Window)
	}
}

// A sub-dollar model or project must not round to "$1" (a 64% overstatement on
// $0.61) nor to "$0" (reporting real spend as free).
//
// Mutation proof: removing the `v > 0 && v < 1` branch from fmtUSD0 fails with
// "sub-dollar spend rendered as $1".
func TestReportKeepsCentsBelowADollar(t *testing.T) {
	fakeDaemon(t, reportRoutes(
		`{"sessions":1,"turns":2,"cost_usd":0.61,"pricing_version":"p",
		  "savings":{"hit_rate":0.5,"cut_pct":10},
		  "models":[{"model":"claude-haiku-4-5","cost_usd":0.61,"turns":2}],
		  "projects":[{"project":"tiny","cost_usd":0.61}]}`,
		`{"plan_kind":"","plan_usd_per_month":0}`, sampleHistory))

	out, err := runCLI(t, "report")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "$0.61") {
		t.Fatalf("sub-dollar spend was not rendered with cents:\n%s", out)
	}
	if strings.Contains(out, "$1 ") || strings.Contains(out, "$1\n") {
		t.Fatalf("sub-dollar spend rendered as $1:\n%s", out)
	}
}

// --json and --markdown are different shapes of the same report; asking for
// both is a mistake worth naming rather than silently honouring one.
func TestReportRefusesTwoOutputShapesAtOnce(t *testing.T) {
	fakeDaemon(t, reportRoutes(sampleSummary, flatPlan, sampleHistory))
	if out, err := runCLI(t, "report", "--json", "--markdown"); err == nil {
		t.Fatalf("--json --markdown was accepted:\n%s", out)
	}
}

// The report reads; it must never be able to change anything. A GET-only
// command that acquired a POST would be a new way to mutate the owner's data
// from a command whose whole promise is that it only looks.
func TestReportOnlyIssuesReads(t *testing.T) {
	var methods []string
	record := func(body string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			methods = append(methods, r.Method)
			_, _ = w.Write([]byte(body))
		}
	}
	fakeDaemon(t, map[string]http.HandlerFunc{
		"/v1/stats/summary": record(sampleSummary),
		"/v1/settings":      record(flatPlan),
		"/v1/history":       record(sampleHistory),
	})
	if _, err := runCLI(t, "report"); err != nil {
		t.Fatal(err)
	}
	if len(methods) == 0 {
		t.Fatal("the report made no requests at all")
	}
	for _, m := range methods {
		if m != http.MethodGet {
			t.Fatalf("report issued a %s; it must only read", m)
		}
	}
}

// With no daemon there is nothing to read, and the command must say that rather
// than printing an empty report that looks like a machine with no usage.
func TestReportWithoutADaemonExplainsItself(t *testing.T) {
	t.Setenv("CAPROCK_DATA_DIR", t.TempDir())
	out, err := runCLI(t, "report")
	if err == nil {
		t.Fatalf("report succeeded with no daemon:\n%s", out)
	}
	if !strings.Contains(err.Error(), "not running") {
		t.Fatalf("unhelpful error with no daemon: %v", err)
	}
}
