// `caprock report` — your measured usage, in a form you can publish.
//
// This exists because a number on a page goes stale silently. The /numbers page
// on caprock.dev is the owner's own usage presented as proof, and its figures
// were hard-coded constants read on one day; nothing made them wrong out loud
// when the machine moved on. A command that re-reads the same measures from the
// same database turns "a number someone typed once" into "a number you can
// re-run", which is the only version of it that stays honest (rule 6).
//
// Two shapes, because there are two readers:
//   - the default is a block a person pastes into a post — terse, specific, and
//     carrying its caveat *inline* so the caveat cannot be lost by quoting only
//     the first line;
//   - `--json` is the same measures machine-readable, shaped to regenerate the
//     site's facts block.
//
// `--markdown` earns its place as a third only because the paste target is
// often a README or a post that renders markdown, where the plain block's
// alignment collapses; it is the same facts and the same caveat, in a table.
//
// On reading from the daemon rather than the database: the CLI never opens
// SQLite (internal/store: "Nothing else in Caprock issues SQL"), and the daemon
// is what holds the pricing table and the plan settings that the figures are
// computed against. Talking to it also means `caprock report` cannot contend
// for a write lock on a database a live daemon is using. When the daemon is
// down the command says so and stops, rather than opening the database behind
// its back with a second, drifting copy of the aggregation SQL.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/dspv/caprock/internal/version"
)

// reportTopN is how many projects and models the human output names. Enough to
// show the shape of where the money went, few enough to stay pasteable.
const reportTopN = 5

// reportShare is one project or model row.
type reportShare struct {
	Name    string  `json:"name"`
	CostUSD float64 `json:"cost_usd"`
	Turns   int64   `json:"turns,omitempty"`
}

// reportSummary is the slice of /v1/stats/summary this command prints. It is a
// narrow local DTO in the house style rather than the daemon's own type: the
// CLI should not break because a field it never reads changed shape.
type reportSummary struct {
	Sessions   int64   `json:"sessions"`
	Turns      int64   `json:"turns"`
	ToolCalls  int64   `json:"tool_calls"`
	CostUSD    float64 `json:"cost_usd"`
	Pricing    string  `json:"pricing_version"`
	TokensIn   int64   `json:"tokens_in"`
	TokensOut  int64   `json:"tokens_out"`
	CacheRead  int64   `json:"cache_read"`
	CacheWrite int64   `json:"cache_write"`
	Savings    struct {
		HitRate float64 `json:"hit_rate"`
		CutPct  float64 `json:"cut_pct"`
	} `json:"savings"`
	Models []struct {
		Model   string  `json:"model"`
		CostUSD float64 `json:"cost_usd"`
		Turns   int64   `json:"turns"`
	} `json:"models"`
	Projects []struct {
		Project  string  `json:"project"`
		CostUSD  float64 `json:"cost_usd"`
		Sessions int64   `json:"sessions"`
	} `json:"projects"`
}

// reportSettings is the plan half of /v1/settings.
type reportSettings struct {
	PlanKind        string  `json:"plan_kind"`
	PlanLabel       string  `json:"plan_label"`
	PlanUSDPerMonth float64 `json:"plan_usd_per_month"`
}

// reportHistory is the slice of /v1/history this command needs.
//
// Active days come from here rather than from counting distinct days in
// /v1/stats/daily: the daemon computes them with an indexed query over
// daily_stats (queries.go records 0.38ms against 1.26s for the naive scan),
// and re-deriving the figure in the CLI would be a second implementation of a
// count that has already been got wrong once — counting session *start* dates
// undercounted 32 real days as 21.
type reportHistory struct {
	Totals struct {
		Days int64 `json:"days"`
	} `json:"totals"`
	Daily []reportDay `json:"daily"`
}

// reportDay is one row of the daily breakdown, used only for the window's
// first and last dates.
type reportDay struct {
	Day     string  `json:"day"`
	CostUSD float64 `json:"cost_usd"`
}

// Report is the machine-readable shape — the site's facts block, regenerable.
// Every field is measured; the ones that cannot be measured are absent rather
// than zero, so a consumer can tell "nothing to say" from "the value is 0".
type Report struct {
	GeneratedAt string `json:"generated_at"`
	Caprock     string `json:"caprock_version"`

	CostUSD        float64 `json:"cost_usd"`
	PricingVersion string  `json:"pricing_version"`
	CostBasis      string  `json:"cost_basis"`
	Caveat         string  `json:"caveat"`

	// Plan is absent when no plan is stated — and so is Multiple, because a
	// multiple with no fee under it is an invented number. FeeUSD is the plan
	// fee prorated to the measured window, i.e. the denominator of Multiple,
	// published alongside it so the division can be checked.
	Plan     *ReportPlan `json:"plan,omitempty"`
	Multiple *float64    `json:"multiple,omitempty"`
	FeeUSD   float64     `json:"fee_usd,omitempty"`

	Sessions  int64 `json:"sessions"`
	Turns     int64 `json:"turns"`
	ToolCalls int64 `json:"tool_calls"`
	Projects  int   `json:"projects"`

	// CacheHitPct and CacheCutPct are absent when nothing was cached at all,
	// rather than reported as a confident 0%.
	CacheHitPct *float64 `json:"cache_hit_pct,omitempty"`
	CacheCutPct *float64 `json:"cache_cut_pct,omitempty"`

	// The raw token counts the percentages above are computed from. They are
	// the most concrete thing in the report: "99% cache hit" is an abstraction,
	// while fifteen billion tokens read from cache against a hundred thousand
	// fresh is a fact a reader can picture. Published as counts only — no ratio
	// between them is derived anywhere, because the percentages already state
	// what the cache did and a second derived number would invite the question
	// of which one is the real claim.
	TokensIn   int64 `json:"tokens_in"`
	TokensOut  int64 `json:"tokens_out"`
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_write"`

	Window *ReportWindow `json:"window,omitempty"`

	TopProjects []reportShare `json:"top_projects,omitempty"`
	TopModels   []reportShare `json:"top_models,omitempty"`
}

// ReportPlan is what the user says they pay.
type ReportPlan struct {
	Kind       string  `json:"kind"`
	Label      string  `json:"label,omitempty"`
	USDPerMont float64 `json:"usd_per_month"`
}

// ReportWindow is the measured date range and how many of its days had work.
type ReportWindow struct {
	First      string `json:"first_day"`
	Last       string `json:"last_day"`
	ActiveDays int    `json:"active_days"`
}

// reportCaveat is the one sentence that must travel with the number.
//
// It is deliberately the dashboard's wording, not new phrasing: PlanValue.tsx
// says "not a discount you received, and not money back", and CostBasis.tsx
// says "not a bill". The CLI, the dashboard and the site saying the same thing
// in three different ways is how a caveat stops being believed.
func reportCaveat(plan reportSettings) string {
	switch plan.PlanKind {
	case "metered":
		return "Priced from captured tokens at Anthropic list prices. Billed per token, so this is approximately the actual cost — not a saving."
	case "flat":
		return "Priced from captured tokens at Anthropic list prices — what the same work would have cost through the API. Not a bill, not a discount received, and not money back: without the plan I would not have run this much."
	default:
		return "Priced from captured tokens at Anthropic list prices. Whether that is an actual bill depends on how the usage is paid for — no plan is stated, so nothing is claimed."
	}
}

// reportBasis is the short subtitle form, mirroring costBasis() in CostBasis.tsx.
func reportBasis(plan reportSettings) string {
	switch plan.PlanKind {
	case "metered":
		return "at API list price · ≈ the bill"
	case "flat":
		return "at API list price · not a bill"
	default:
		return "at API list price"
	}
}

func reportCmd() *cobra.Command {
	var (
		asJSON   bool
		markdown bool
	)
	c := &cobra.Command{
		Use:   "report",
		Short: "Print your measured usage in a form you can publish",
		Long: "Reads the same measures the dashboard shows — total at API list prices, " +
			"the plan multiple, turns, sessions, projects, cache hit rate, the date window — " +
			"and prints them ready to paste, with the caveat attached.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if asJSON && markdown {
				return fmt.Errorf("--json and --markdown are different output shapes; pick one")
			}
			rt, err := runningDaemon()
			if err != nil {
				return err
			}
			rep, err := buildReport(rt.Port)
			if err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			switch {
			case asJSON:
				enc := json.NewEncoder(out)
				enc.SetIndent("", "  ")
				return enc.Encode(rep)
			case markdown:
				return writeReportMarkdown(out, rep)
			default:
				return writeReportText(out, rep)
			}
		},
	}
	c.Flags().BoolVar(&asJSON, "json", false, "Machine-readable, shaped to regenerate the site's facts block")
	c.Flags().BoolVar(&markdown, "markdown", false, "A markdown table, for a README or a post that renders markdown")
	return c
}

// getJSON fetches one endpoint from the local daemon into v.
func getJSON(port int, path string, v any) error {
	resp, err := (&http.Client{Timeout: 10 * time.Second}).
		Get(fmt.Sprintf("http://127.0.0.1:%d%s", port, path))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: %s", path, strings.TrimSpace(string(body)))
	}
	return json.Unmarshal(body, v)
}

// buildReport reads the three endpoints the report is assembled from. Neither
// /v1/stats/summary nor /v1/history alone carries every measure: the summary
// has the pricing version, the project list and the model mix; history has the
// active-day count. The plan is a third call.
func buildReport(port int) (Report, error) {
	var (
		sum  reportSummary
		plan reportSettings
		hist reportHistory
	)
	if err := getJSON(port, "/v1/stats/summary?range=all", &sum); err != nil {
		return Report{}, err
	}
	if err := getJSON(port, "/v1/settings", &plan); err != nil {
		return Report{}, err
	}
	if err := getJSON(port, "/v1/history?range=all", &hist); err != nil {
		return Report{}, err
	}
	return assembleReport(sum, plan, hist, version.Version), nil
}

// assembleReport is the pure half, so the shaping rules are testable without a
// daemon: what is omitted, when a multiple may be computed, and what the caveat
// says.
func assembleReport(sum reportSummary, plan reportSettings, hist reportHistory, ver string) Report {
	rep := Report{
		GeneratedAt:    time.Now().Format("2006-01-02"),
		Caprock:        ver,
		CostUSD:        sum.CostUSD,
		PricingVersion: sum.Pricing,
		CostBasis:      reportBasis(plan),
		Caveat:         reportCaveat(plan),
		Sessions:       sum.Sessions,
		Turns:          sum.Turns,
		ToolCalls:      sum.ToolCalls,
		Projects:       len(sum.Projects),
		TokensIn:       sum.TokensIn,
		TokensOut:      sum.TokensOut,
		CacheRead:      sum.CacheRead,
		CacheWrite:     sum.CacheWrite,
	}

	// The plan, and the multiple only if there is a fee to divide by. A flat
	// plan with no monthly figure stated cannot produce a multiple, and
	// guessing one would be exactly the invented number rule 6 forbids.
	if plan.PlanKind != "" {
		rep.Plan = &ReportPlan{Kind: plan.PlanKind, Label: plan.PlanLabel, USDPerMont: plan.PlanUSDPerMonth}
	}
	rep.Window = reportWindow(hist)

	if plan.PlanKind == "flat" && plan.PlanUSDPerMonth > 0 && rep.Window != nil {
		// The fee is prorated to the window that was actually measured, the
		// same way PlanValue.tsx does it (`fee = usd_per_month * days / 30`),
		// rather than compared against one whole month the usage did not fill.
		// The divisor is the calendar span, not the days that had work: the
		// plan is charged for the quiet days too, and dividing by active days
		// only would inflate the multiple.
		months := float64(spanDays(rep.Window)) / 30.0
		if fee := plan.PlanUSDPerMonth * months; fee > 0 {
			m := sum.CostUSD / fee
			rep.Multiple = &m
			rep.FeeUSD = fee
		}
	}

	// Cache figures are omitted rather than zeroed when nothing was cached:
	// a fresh database reporting "0% cache hit" reads as a broken cache, not
	// as an absence of data.
	if sum.Savings.HitRate > 0 {
		hit := sum.Savings.HitRate * 100
		rep.CacheHitPct = &hit
	}
	if sum.Savings.CutPct > 0 {
		cut := sum.Savings.CutPct
		rep.CacheCutPct = &cut
	}

	for _, p := range sum.Projects {
		rep.TopProjects = append(rep.TopProjects, reportShare{Name: p.Project, CostUSD: p.CostUSD})
	}
	sort.SliceStable(rep.TopProjects, func(i, j int) bool { return rep.TopProjects[i].CostUSD > rep.TopProjects[j].CostUSD })
	if len(rep.TopProjects) > reportTopN {
		rep.TopProjects = rep.TopProjects[:reportTopN]
	}
	for _, m := range sum.Models {
		rep.TopModels = append(rep.TopModels, reportShare{Name: m.Model, CostUSD: m.CostUSD, Turns: m.Turns})
	}
	sort.SliceStable(rep.TopModels, func(i, j int) bool { return rep.TopModels[i].CostUSD > rep.TopModels[j].CostUSD })
	if len(rep.TopModels) > reportTopN {
		rep.TopModels = rep.TopModels[:reportTopN]
	}
	return rep
}

// reportWindow takes the first and last day from the daily rows and the
// active-day count from the daemon's own total. nil when nothing has been
// recorded — an empty database has no window to describe, and inventing one
// would put a date range under a report of nothing.
func reportWindow(hist reportHistory) *ReportWindow {
	seen := map[string]bool{}
	for _, d := range hist.Daily {
		if d.Day != "" {
			seen[d.Day] = true
		}
	}
	if len(seen) == 0 {
		return nil
	}
	all := make([]string, 0, len(seen))
	for d := range seen {
		all = append(all, d)
	}
	sort.Strings(all) // ISO dates sort chronologically as strings
	active := int(hist.Totals.Days)
	if active <= 0 {
		// The daemon did not report a count; the days present are the floor.
		active = len(all)
	}
	return &ReportWindow{First: all[0], Last: all[len(all)-1], ActiveDays: active}
}

// spanDays is the calendar length of the window, inclusive — the period the
// plan fee is charged over, which is not the same as the days that had work.
func spanDays(w *ReportWindow) int {
	first, err1 := time.Parse("2006-01-02", w.First)
	last, err2 := time.Parse("2006-01-02", w.Last)
	if err1 != nil || err2 != nil {
		return w.ActiveDays
	}
	return int(last.Sub(first).Hours()/24) + 1
}

// fmtUSD0 formats a dollar figure with thousands separators and no cents —
// the form a headline number is quoted in. Below a dollar it keeps the cents:
// rounding $0.61 to "$1" overstates it by 64%, and rounding it to "$0" would
// report real spend as free.
func fmtUSD0(v float64) string {
	if v > 0 && v < 1 {
		return fmt.Sprintf("$%.2f", v)
	}
	s := fmt.Sprintf("%.0f", v)
	var b strings.Builder
	for i, r := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	return "$" + b.String()
}

// writeReportText prints the paste-into-a-post block.
//
// Shape matters here: the first line is the whole claim, the caveat is the
// second line rather than a footnote, and the detail follows. Someone quoting
// "the first two lines" still carries the qualifier; someone quoting only the
// headline has visibly cut something off.
func writeReportText(out io.Writer, r Report) error {
	if r.Window == nil {
		fmt.Fprintln(out, "Nothing recorded yet — no sessions have been captured on this machine.")
		fmt.Fprintln(out, "Start a Claude Code session with the daemon running, then run this again.")
		return nil
	}

	head := fmt.Sprintf("%s of Claude Code, %s", fmtUSD0(r.CostUSD), r.CostBasis)
	if r.Multiple != nil && r.Plan != nil {
		head = fmt.Sprintf("%s of Claude Code at API list prices on a %s/month plan — %.1f× the fee",
			fmtUSD0(r.CostUSD), trimUSD(r.Plan.USDPerMont), *r.Multiple)
	}
	fmt.Fprintln(out, head+".")
	fmt.Fprintln(out, r.Caveat)
	fmt.Fprintln(out)

	fmt.Fprintf(out, "%s → %s · %d active days\n", r.Window.First, r.Window.Last, r.Window.ActiveDays)
	// State the fee the multiple divides by, so the arithmetic is checkable
	// rather than asserted. Over a window longer or shorter than a month the
	// fee is prorated, and a reader who cannot see it cannot tell whether the
	// multiple was computed against one month or against the window.
	// The fee carries cents. It is the denominator of the printed multiple, and
	// a prorated fee is rarely a whole number: rounding $233.33 to "$233" made
	// the division a reader does on sight come out at 41.6 against a printed
	// 41.5. Two extra characters keep the arithmetic checkable, which is the
	// whole reason the fee is printed at all — a footnote about rounding would
	// be more noise than the cents it explains.
	if r.Multiple != nil && r.Plan != nil {
		fmt.Fprintf(out, "paid %s over that window · same usage at API list %s\n",
			fmtUSD2(r.FeeUSD), fmtUSD0(r.CostUSD))
	}
	fmt.Fprintf(out, "%s turns · %s sessions · %d projects\n",
		commas(r.Turns), commas(r.Sessions), r.Projects)
	if r.CacheHitPct != nil {
		line := fmt.Sprintf("%.0f%% cache hit", *r.CacheHitPct)
		if r.CacheCutPct != nil {
			line += fmt.Sprintf(" · %.0f%% of input cost cut by cache", *r.CacheCutPct)
		}
		fmt.Fprintln(out, line)
	}
	// The raw basis for those percentages, on its own line. A reader who does
	// not think in percentages can picture the two counts side by side, and
	// they are the concrete half of the cache claim.
	if r.CacheRead > 0 || r.TokensIn > 0 {
		fmt.Fprintf(out, "%s tokens read from cache · %s fresh input\n",
			commas(r.CacheRead), commas(r.TokensIn))
	}
	if r.Plan == nil {
		fmt.Fprintln(out, "No plan stated, so no multiple is shown — set one with the plan picker in the dashboard header.")
	} else if r.Multiple == nil && r.Plan.Kind == "flat" {
		fmt.Fprintln(out, "No monthly fee stated for the plan, so no multiple is shown.")
	}

	if len(r.TopProjects) > 0 {
		fmt.Fprintln(out)
		fmt.Fprintln(out, "Top projects:")
		for _, p := range r.TopProjects {
			fmt.Fprintf(out, "  %-28s %s\n", p.Name, fmtUSD0(p.CostUSD))
		}
	}
	if len(r.TopModels) > 0 {
		fmt.Fprintln(out)
		fmt.Fprintln(out, "Top models:")
		for _, m := range r.TopModels {
			fmt.Fprintf(out, "  %-28s %s\n", m.Name, fmtUSD0(m.CostUSD))
		}
	}
	fmt.Fprintln(out)
	fmt.Fprintf(out, "Measured by caprock %s from its own capture · pricing table %s\n", r.Caprock, r.PricingVersion)
	return nil
}

// writeReportMarkdown prints the same facts as a table, for a README or a post
// that renders markdown and would otherwise collapse the plain block's columns.
func writeReportMarkdown(out io.Writer, r Report) error {
	if r.Window == nil {
		fmt.Fprintln(out, "Nothing recorded yet — no sessions have been captured on this machine.")
		return nil
	}
	fmt.Fprintln(out, "| measure | value |")
	fmt.Fprintln(out, "| ------- | ----- |")
	fmt.Fprintf(out, "| At API list prices | %s |\n", fmtUSD0(r.CostUSD))
	if r.Plan != nil {
		label := r.Plan.Label
		if label == "" {
			label = r.Plan.Kind
		}
		fmt.Fprintf(out, "| Plan | %s, %s/month |\n", label, trimUSD(r.Plan.USDPerMont))
	}
	if r.Multiple != nil {
		fmt.Fprintf(out, "| Paid over the window | %s |\n", fmtUSD2(r.FeeUSD))
		fmt.Fprintf(out, "| Multiple of the fee | %.1f× |\n", *r.Multiple)
	}
	fmt.Fprintf(out, "| Window | %s → %s (%d active days) |\n", r.Window.First, r.Window.Last, r.Window.ActiveDays)
	fmt.Fprintf(out, "| Turns | %s |\n", commas(r.Turns))
	fmt.Fprintf(out, "| Sessions | %s |\n", commas(r.Sessions))
	fmt.Fprintf(out, "| Projects | %d |\n", r.Projects)
	if r.CacheHitPct != nil {
		fmt.Fprintf(out, "| Cache hit | %.0f%% |\n", *r.CacheHitPct)
	}
	if r.CacheCutPct != nil {
		fmt.Fprintf(out, "| Input cost cut by cache | %.0f%% |\n", *r.CacheCutPct)
	}
	if r.CacheRead > 0 || r.TokensIn > 0 {
		fmt.Fprintf(out, "| Tokens read from cache | %s |\n", commas(r.CacheRead))
		fmt.Fprintf(out, "| Fresh input tokens | %s |\n", commas(r.TokensIn))
	}
	fmt.Fprintf(out, "| Pricing table | %s |\n", r.PricingVersion)
	fmt.Fprintln(out)
	fmt.Fprintln(out, r.Caveat)
	return nil
}

// fmtUSD2 formats a dollar figure with thousands separators and always two
// decimals — for a figure someone is expected to divide by.
func fmtUSD2(v float64) string {
	whole := fmt.Sprintf("%.2f", v)
	dot := strings.LastIndex(whole, ".")
	intPart, frac := whole[:dot], whole[dot:]
	var b strings.Builder
	for i, r := range intPart {
		if i > 0 && (len(intPart)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	return "$" + b.String() + frac
}

// trimUSD renders a plan fee without trailing cents when it is a whole number.
func trimUSD(v float64) string {
	if v == float64(int64(v)) {
		return fmt.Sprintf("$%d", int64(v))
	}
	return fmt.Sprintf("$%.2f", v)
}

// commas groups an integer for reading.
func commas(n int64) string {
	s := fmt.Sprintf("%d", n)
	var b strings.Builder
	for i, r := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	return b.String()
}
