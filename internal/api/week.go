package api

import (
	"context"
	"errors"
	"net/http"
	"os"
	"runtime"
	"time"

	"github.com/dspv/caprock/internal/contexttax"
	"github.com/dspv/caprock/internal/store"
)

// WeekResponse is GET /v1/week: seven local days of what this machine's agents
// did, for the Week screen's shareable card. Contract: .ai/03-contracts.md.
//
// Everything is computed from the local database; nothing here asks GitHub.
// Pull requests are GitHub's record where the daemon already holds it
// (github_prs, the lists the Pipeline read) and merges the agents ran
// elsewhere (prs_source). Sessions started at a root or in the home
// directory itself — scheduled scripts — are left out of every figure
// (scheduled_sessions counts them). Nothing in it names a repository, a
// path, a prompt or a session title: the card is made to be posted.
type WeekResponse struct {
	store.Week
	// Period is the named window asked for (today, 7d, 30d, all), or empty
	// for a week picked by its first day.
	Period string `json:"period,omitempty"`
	// Start and End are the first and last local day, inclusive.
	Start string `json:"start"`
	End   string `json:"end"`
	// Partial is true while the window has not finished: it reaches today.
	Partial bool `json:"partial"`
	// Tax is the share of the cost that went on re-reading context, priced
	// per model exactly as the Lifetime screen prices it. Absent without a
	// pricing table.
	Tax *contexttax.Lifetime `json:"tax,omitempty"`
	// PRsSource says where prs_opened and prs_merged came from: "github"
	// (github_prs, the pull request lists the Pipeline read, for every
	// repository counted), "agents" (the agents' own `gh pr` commands, no
	// GitHub record held), or "both". Absent with no pull request counted
	// and no GitHub record.
	PRsSource string `json:"prs_source,omitempty"`
	// CostPerMergedPR is an estimate, absent when nothing was merged: with
	// GitHub's record, the mean of what the Pipeline charges each pull
	// request merged in the window (store.KnownPRs; one with no agent work
	// recorded counts as $0); with the agents' count only, all of the
	// window's cost over its merges.
	CostPerMergedPR *float64 `json:"cost_per_merged_pr,omitempty"`
	// SubagentSaving is what the window's subagents on a pricier model than
	// Haiku cost, against the same tokens on Haiku. An estimate at list
	// prices; absent unless the difference is a dollar or more.
	SubagentSaving *SubagentSaving `json:"subagent_saving,omitempty"`
	// Estimates names the fields that are estimates rather than counts or
	// sums, so a renderer cannot forget the "≈" on one.
	Estimates []string `json:"estimates"`
	Pricing   string   `json:"pricing_version,omitempty"`
}

// weekTTL is how long a computed week may be reused. A past week never
// changes; the current one moves by a turn at a time, and the screen is
// opened, not polled.
const weekTTL = 30 * time.Second

// weekLongTTL holds the long windows a little longer: a month or all of
// history costs seconds to count on a large database, and the share dialog
// may ask for it again as the reader flips between periods.
const weekLongTTL = 2 * time.Minute

func (s *Server) handleWeek(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	period, raw := q.Get("period"), q.Get("start")
	if period != "" && raw != "" {
		s.failCode(w, http.StatusBadRequest, errors.New("ask for a period or a start, not both"))
		return
	}
	var (
		from, to time.Time
		err      error
	)
	if period != "" {
		from, to, err = s.weekPeriod(r.Context(), period)
	} else {
		from, err = s.weekStart(raw)
		to = time.Date(from.Year(), from.Month(), from.Day()+7, 0, 0, 0, 0, from.Location())
	}
	if err != nil {
		s.failCode(w, http.StatusBadRequest, err)
		return
	}
	v, err := s.weekAnswer(r.Context(), period, from, to)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// weekAnswer is the cached Week for one window.
func (s *Server) weekAnswer(ctx context.Context, period string, from, to time.Time) (any, error) {
	cache := s.week
	if period == "30d" || period == "all" {
		cache = s.weekLong
	}
	key := "week:" + period + ":" + from.Format("2006-01-02") + ":" + to.Format("2006-01-02")
	return cache.get(ctx, key, func() (any, error) {
		resp, err := s.buildWeek(context.WithoutCancel(ctx), from, to)
		resp.Period = period
		return resp, err
	})
}

// weekPeriod is the window a named period covers, in whole local days ending
// today: the same days the Cost screen's ranges use. "all" starts on the day
// of the first event recorded.
func (s *Server) weekPeriod(ctx context.Context, period string) (time.Time, time.Time, error) {
	now := s.d.Now()
	loc := now.Location()
	y, m, d := now.Date()
	day := func(n int) time.Time { return time.Date(y, m, d+n, 0, 0, 0, 0, loc) }
	to := day(1)
	switch period {
	case "today":
		return day(0), to, nil
	case "7d":
		return day(-6), to, nil
	case "30d":
		return day(-29), to, nil
	case "all":
		first, err := store.FirstEventTs(ctx, s.d.Store.DB())
		if err != nil {
			return time.Time{}, time.Time{}, err
		}
		if first <= 0 {
			return day(0), to, nil
		}
		f := time.UnixMilli(first).In(loc)
		return time.Date(f.Year(), f.Month(), f.Day(), 0, 0, 0, 0, loc), to, nil
	}
	return time.Time{}, time.Time{}, errors.New("period must be today, 7d, 30d or all")
}

// weekStart reads `start` as a local date. Unset means the seven days ending
// today -- the same window as the Cost screen's 7d range.
func (s *Server) weekStart(raw string) (time.Time, error) {
	now := s.d.Now()
	loc := now.Location()
	if raw == "" {
		y, m, d := now.Date()
		return time.Date(y, m, d-6, 0, 0, 0, 0, loc), nil
	}
	t, err := time.ParseInLocation("2006-01-02", raw, loc)
	if err != nil {
		return time.Time{}, errors.New("start must be a date, YYYY-MM-DD")
	}
	return t, nil
}

func (s *Server) buildWeek(ctx context.Context, from, to time.Time) (WeekResponse, error) {
	loc := from.Location()
	home, _ := os.UserHomeDir()
	wk, err := store.WeekStats(ctx, s.d.Store.DB(), store.WeekOptions{
		From: from, To: to, Loc: loc,
		LoopK: s.d.LoopK, LoopWindow: s.d.LoopWindow,
		Home: home, TempDirs: store.DefaultTempDirs(), Windows: runtime.GOOS == "windows",
	})
	if err != nil {
		return WeekResponse{}, err
	}
	resp := WeekResponse{
		Week:      wk,
		Start:     from.Format("2006-01-02"),
		End:       to.AddDate(0, 0, -1).Format("2006-01-02"),
		Partial:   s.d.Now().Before(to),
		Estimates: []string{"lines_added", "lines_removed"},
	}
	// The agents' own count is replaced by GitHub's record wherever the
	// daemon holds one (weekprs.go); the transcripts' unresolved merges stay
	// as they were counted.
	prs, err := s.countWeekPRs(ctx, wk, loc)
	if err != nil {
		return WeekResponse{}, err
	}
	resp.PRsOpened, resp.PRsMerged, resp.PRsSource = prs.opened, prs.merged, prs.source
	for i := range resp.Days {
		resp.Days[i].PRsOpened = prs.days[i]
	}
	if prs.perMerged != nil {
		resp.CostPerMergedPR = prs.perMerged
		resp.Estimates = append(resp.Estimates, "cost_per_merged_pr")
	}
	if s.d.Table != nil {
		resp.Pricing = s.d.Table.Version
		models := make([]contexttax.ModelTax, 0, len(wk.Models))
		for _, m := range wk.Models {
			models = append(models, contexttax.ModelTax{Model: m.Model, CacheRead: m.CacheRead, CostUSD: m.CostUSD})
		}
		lt := contexttax.Sum(models, s.d.Table)
		resp.Tax = &lt
		subs, err := store.SubagentTokensByModelSkip(ctx, s.d.Store.DB(), from.UnixMilli(), to.UnixMilli(), wk.SkipSQL)
		if err != nil {
			return WeekResponse{}, err
		}
		if resp.SubagentSaving = subagentSaving(subs, s.d.Table); resp.SubagentSaving != nil {
			resp.Estimates = append(resp.Estimates, "subagent_saving")
		}
		if l := resp.Loop; l != nil {
			calls, _, err := store.LoopTaxCalls(ctx, s.d.Store.DB(), l.SessionID, time.UnixMilli(l.FirstMs), time.UnixMilli(l.LastMs))
			if err != nil {
				return WeekResponse{}, err
			}
			priced, prices := contexttax.PriceSeries(store.TimedCalls(calls), s.d.Table)
			if len(priced) > 0 {
				l.TaxUSD = contexttax.TaxOf(priced, prices)
				l.TaxPricedCalls = len(priced)
				resp.Estimates = append(resp.Estimates, "loop.tax_usd")
			}
		}
	}
	return resp, nil
}
