package store

import (
	"context"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// Trends is what the Now screen's Today cells are set against: the same
// figures for each of the previous TrendDays, cut at the same time of day,
// and the viewer's typical burn rate (owner, 2026-10-14, translated: "I see
// the number but don't understand whether it's average or above average").
// Every figure is measured on this machine (rule 6); a comparison with too
// little history is left to the caller to withhold, with the active-day
// count it needs to decide.
type Trends struct {
	// Days is the window behind the comparison, today excluded.
	Days int `json:"days"`
	// CutMin is the time of day, in minutes after local midnight, at which
	// every day's figures are cut: "by this time on each day". Comparing a
	// morning's spend with whole days made every morning read low.
	CutMin int `json:"cut_min"`
	// Series is the previous Days days, oldest first, then today so far.
	Series []TrendDay `json:"series"`
	// Burn is the typical burn rate when something is running.
	Burn *TrendBurn `json:"burn,omitempty"`
}

// TrendDay is one local day's figures up to the cut.
type TrendDay struct {
	// Day is the local date, YYYY-MM-DD.
	Day       string  `json:"day"`
	CostUSD   float64 `json:"cost_usd"`
	Sessions  int64   `json:"sessions"`
	Turns     int64   `json:"turns"`
	ToolCalls int64   `json:"tool_calls"`
	// HitRate is the cache hit rate, 0..1; absent with no input at all.
	HitRate *float64 `json:"hit_rate,omitempty"`
	// BurnUSDPerHour is the median of the day's active burn windows (whole
	// day, not cut: a rate is not a running total); absent with none.
	BurnUSDPerHour *float64 `json:"burn_usd_per_hour,omitempty"`
	// Active: any priced turn on the day, at any hour. Only active days make
	// a median — a weekend off is not a "usual" of zero.
	Active bool `json:"active"`
}

// TrendBurn is the median burn of the active windows in the previous Days.
type TrendBurn struct {
	// MedianUSDPerHour is the median window's spend, as dollars per hour.
	MedianUSDPerHour float64 `json:"median_usd_per_hour"`
	// Windows and Days are the samples behind it.
	Windows int `json:"windows"`
	Days    int `json:"days"`
}

const (
	// TrendDays is the comparison window.
	TrendDays = 14
	// TrendBucketMs is the scan's grain. Five minutes divides every UTC
	// offset in use (all are multiples of fifteen), so a bucket never
	// straddles a local midnight; a day's cut is at most one bucket late.
	TrendBucketMs = 5 * 60 * 1000
	// TrendBurnWindowMs is the burn window, the same ten minutes as the
	// "Burn now" figure it is compared with: two buckets.
	TrendBurnWindowMs = 10 * 60 * 1000
)

// TrendsAt measures the trends as of now (whose location decides the days),
// through the agent filter. One grouped range scan of the covering index the
// summary already uses (idx_events_ts_cover), by (5-minute bucket, session,
// kind): on a copy of the owner's 1.6 GB database, 15 days (200k events, 10k
// groups), 0.14s in the sqlite shell and 0.28s warm through the Go driver
// (2026-10-14), which is why the API caches it. The rollups cannot answer
// this: daily_stats has no time of day, no turn or tool counts, and no agent.
func TrendsAt(ctx context.Context, q Querier, now time.Time, agent AgentFilter) (*Trends, error) {
	y, m, d := now.Date()
	loc := now.Location()
	today := time.Date(y, m, d, 0, 0, 0, 0, loc)
	type span struct{ start, cut, end int64 }
	days := make([]span, TrendDays+1)
	for i := range days {
		k := TrendDays - i // days before today
		start := time.Date(y, m, d-k, 0, 0, 0, 0, loc)
		// The cut is the same wall-clock time, so a DST change does not move it.
		cut := time.Date(y, m, d-k, now.Hour(), now.Minute(), now.Second(), 0, loc)
		end := time.Date(y, m, d-k+1, 0, 0, 0, 0, loc)
		days[i] = span{start.UnixMilli(), cut.UnixMilli(), end.UnixMilli()}
	}
	from := days[0].start
	dayOf := func(ts int64) int {
		// Fifteen spans: a linear walk is cheaper than anything clever.
		for i := len(days) - 1; i >= 0; i-- {
			if ts >= days[i].start {
				if ts < days[i].end {
					return i
				}
				return -1
			}
		}
		return -1
	}
	out := &Trends{Days: TrendDays, CutMin: int(now.Sub(today) / time.Minute), Series: make([]TrendDay, len(days))}
	for i := range days {
		out.Series[i].Day = time.UnixMilli(days[i].start).In(loc).Format("2006-01-02")
	}
	in := make([]int64, len(days))
	read := make([]int64, len(days))
	write := make([]int64, len(days))
	seen := make([]map[string]bool, len(days)) // sessions by the cut
	windows := map[int64]float64{}             // burn window -> cost
	ev, evArgs := agent.eventScope("sid")
	rows, err := q.QueryContext(ctx, `
		SELECT ts / ? AS b, (SELECT session_id FROM sessions WHERE sessions.sid = events.sid), kind, COUNT(*),
		       COALESCE(SUM(tokens_in),0), COALESCE(SUM(cache_read),0), COALESCE(SUM(cache_write),0),
		       COALESCE(SUM(cost_usd),0)
		FROM events INDEXED BY idx_events_ts_cover WHERE ts >= ?`+nonInternalEvent+ev+` GROUP BY b, sid, kind`,
		append([]any{int64(TrendBucketMs), from}, evArgs...)...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var b, n, tin, cr, cw int64
		var sid, kind string
		var c float64
		if err := rows.Scan(&b, &sid, &kind, &n, &tin, &cr, &cw, &c); err != nil {
			_ = rows.Close()
			return nil, err
		}
		at := b * TrendBucketMs
		i := dayOf(at)
		if i < 0 {
			continue
		}
		if kind == string(event.KindTurnAssistant) && c > 0 {
			out.Series[i].Active = true
		}
		if c > 0 {
			windows[at/TrendBurnWindowMs] += c
		}
		if at >= days[i].cut {
			continue
		}
		day := &out.Series[i]
		day.CostUSD += c
		in[i] += tin
		read[i] += cr
		write[i] += cw
		switch kind {
		case string(event.KindTurnAssistant):
			day.Turns += n
		case string(event.KindToolPre):
			day.ToolCalls += n
		}
		// Sessions as the summary counts them: any event since midnight.
		if seen[i] == nil {
			seen[i] = map[string]bool{}
		}
		seen[i][sid] = true
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	_ = rows.Close()
	for i := range out.Series {
		out.Series[i].Sessions = int64(len(seen[i]))
		if den := in[i] + read[i] + write[i]; den > 0 {
			r := float64(read[i]) / float64(den)
			out.Series[i].HitRate = &r
		}
	}

	// Burn: every ten-minute window in which anything was spent, as $/h.
	perDay := make([][]float64, len(days))
	for w, c := range windows {
		if i := dayOf(w * TrendBurnWindowMs); i >= 0 {
			perDay[i] = append(perDay[i], c*6)
		}
	}
	var past []float64
	burnDays := 0
	for i, v := range perDay {
		if len(v) == 0 {
			continue
		}
		med := median(v)
		out.Series[i].BurnUSDPerHour = &med
		if i < TrendDays {
			past = append(past, v...)
			burnDays++
		}
	}
	if len(past) > 0 {
		out.Burn = &TrendBurn{MedianUSDPerHour: median(past), Windows: len(past), Days: burnDays}
	}
	return out, nil
}
