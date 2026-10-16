package store

import (
	"context"
	"sort"
	"strings"
	"time"
)

// RepoAgents is one repository's two agent figures on the Pipeline
// (.ai/04-ui.md § Pipeline; owner, 2026-10-15, translated: "In Pipeline I'm
// missing the cost of an hour of work … and roughly the size of this agent
// team on a chart: how many there are and were"). Both are measured here,
// from the repository's own sessions (rule 6); a comparison with too little
// history is withheld by the caller, with the day count it needs to decide.
type RepoAgents struct {
	// Days is the window the usuals are set against, today excluded.
	Days int `json:"days"`
	// Rate is what an hour of agent work costs.
	Rate RepoRate `json:"rate"`
	// Team is how many agents worked, day by day.
	Team RepoTeam `json:"team"`
}

// RepoRate is the repository's cost per active agent-hour. An active
// agent-hour is Usual's rule, the one the cockpit's burn is set against:
// a clock hour in which one session (its subagents included) made at least
// UsualMinCalls priced calls costing more than nothing. Spend in an hour
// below that is in CostUSD but not in the rate: a session touched in
// passing is not an hour anyone worked.
type RepoRate struct {
	// Last24 is the last 24 clock hours, the current one included.
	Last24 RateSpan `json:"last24"`
	// Usual is the RepoAgentDays×24 hours before Last24; absent with no
	// active hour in them.
	Usual *RateSpan `json:"usual,omitempty"`
	// Series is the previous RepoAgentDays local days, oldest first, then
	// today so far.
	Series []RateDay `json:"series"`
}

// RateSpan is a stretch of hours: what it cost, its active agent-hours and
// what they cost, its tokens, and how many clock hours had any priced turn
// at all (WallHours: the repository's wall-clock hours of work, however
// many agents ran in them).
type RateSpan struct {
	CostUSD       float64 `json:"cost_usd"`
	ActiveHours   int64   `json:"active_hours"`
	ActiveCostUSD float64 `json:"active_cost_usd"`
	// Tokens is input, output, cache reads and cache writes; ActiveTokens
	// the active hours' share of it.
	Tokens       int64 `json:"tokens"`
	ActiveTokens int64 `json:"active_tokens"`
	WallHours    int64 `json:"wall_hours"`
	// Days is how many local days had an active hour (Usual only).
	Days int `json:"days,omitempty"`
}

// RateDay is one local day's span.
type RateDay struct {
	Day string `json:"day"`
	RateSpan
}

// RepoTeam is the repository's agents as a contributors chart: every main
// session and every subagent (a session's agent_id) that made an assistant
// turn, counted once a day.
type RepoTeam struct {
	// Now is the agents with a turn in the last RepoAgentNowMs.
	Now TeamCount `json:"now"`
	// PeakToday is today's busiest five minutes: the most agents with a
	// turn in one bucket; zero with none today.
	PeakToday int64 `json:"peak_today"`
	// Series is the previous RepoTeamDays local days, oldest first, then
	// today so far.
	Series []TeamDay `json:"series"`
}

// TeamCount is a count of main sessions and subagents.
type TeamCount struct {
	Sessions  int64 `json:"sessions"`
	Subagents int64 `json:"subagents"`
}

// TeamDay is one local day's distinct agents, by agent kind (claude,
// codex, opencode, gemini, …), and its busiest five minutes.
type TeamDay struct {
	Day string `json:"day"`
	TeamCount
	ByKind map[string]TeamCount `json:"by_kind,omitempty"`
	// Peak is the most agents with a turn in one five-minute bucket.
	Peak int64 `json:"peak"`
}

const (
	// RepoAgentDays is the comparison window of both figures.
	RepoAgentDays = 14
	// RepoTeamDays is the team chart's window: a month, as a contributors
	// chart reads.
	RepoTeamDays = 30
	// RepoAgentNowMs is "now": the burn's own ten minutes.
	RepoAgentNowMs = 10 * 60 * 1000
	hourMs         = int64(time.Hour / time.Millisecond)
)

// repoScope is the subquery naming the sessions of the repository's
// folders (clones of one GitHub repository are several), off
// idx_sessions_repo_branch.
func repoScope(roots []string) (string, []any) {
	ph := strings.TrimSuffix(strings.Repeat("?,", len(roots)), ",")
	args := make([]any, len(roots))
	for i, r := range roots {
		args[i] = r
	}
	return ` AND e.session_id IN (SELECT session_id FROM sessions WHERE repo_root IN (` + ph + `))`, args
}

// localDays is n local days before today, then today: each day's start and
// end in unix ms, and its date.
func localDays(now time.Time, n int) (starts, ends []int64, names []string) {
	y, m, d := now.Date()
	loc := now.Location()
	for k := n; k >= 0; k-- {
		s := time.Date(y, m, d-k, 0, 0, 0, 0, loc)
		starts = append(starts, s.UnixMilli())
		ends = append(ends, time.Date(y, m, d-k+1, 0, 0, 0, 0, loc).UnixMilli())
		names = append(names, s.Format("2006-01-02"))
	}
	return
}

func dayIndex(starts, ends []int64, ts int64) int {
	for i := len(starts) - 1; i >= 0; i-- {
		if ts >= starts[i] {
			if ts < ends[i] {
				return i
			}
			return -1
		}
	}
	return -1
}

// RepoAgentsPast is the part of both figures before today's local
// midnight, which no later turn changes: the rate's hours and the team's
// finished days. The API keeps it for the day (pipeAgentsPastTTL), so a
// request scans only today — the whole window is a few times slower than
// the 50 ms a polled figure may take (.ai/03-contracts.md § Pipeline agents).
type RepoAgentsPast struct {
	// Day is the local date the cut was made on; a past from another day
	// is not used.
	Day string
	// hours is every clock hour's sums, by its start in unix ms.
	hours map[int64]RateSpan
	// team is the finished days, RepoTeamDays of them, oldest first.
	team []TeamDay
}

// RepoAgentsBefore measures what lies before today's local midnight.
func RepoAgentsBefore(ctx context.Context, q Querier, now time.Time, roots []string) (*RepoAgentsPast, error) {
	starts, _, names := localDays(now, RepoTeamDays)
	midnight := starts[len(starts)-1]
	past := &RepoAgentsPast{Day: names[len(names)-1]}
	if len(roots) == 0 {
		past.hours = map[int64]RateSpan{}
		past.team = make([]TeamDay, RepoTeamDays)
		return past, nil
	}
	var err error
	if past.hours, err = rateHours(ctx, q, roots, rateFrom(now), midnight); err != nil {
		return nil, err
	}
	kinds, err := sessionKinds(ctx, q, roots)
	if err != nil {
		return nil, err
	}
	team, err := teamDays(ctx, q, roots, kinds, starts[:len(starts)-1], names[:len(names)-1], starts[0], midnight, 0, nil)
	if err != nil {
		return nil, err
	}
	past.team = team
	return past, nil
}

// RepoAgentsAt measures both figures as of now (whose location decides the
// days) for the sessions whose repo_root is one of roots, on top of past —
// measured here when nil or from another day. Two grouped scans of the
// covering index of priced turns (idx_events_turn_agent), one per figure,
// over today only.
func RepoAgentsAt(ctx context.Context, q Querier, now time.Time, roots []string, past *RepoAgentsPast) (*RepoAgents, error) {
	out := &RepoAgents{Days: RepoAgentDays}
	if len(roots) == 0 {
		out.Rate.Series = []RateDay{}
		out.Team.Series = []TeamDay{}
		return out, nil
	}
	starts, _, names := localDays(now, RepoTeamDays)
	midnight := starts[len(starts)-1]
	if past == nil || past.Day != names[len(names)-1] {
		var err error
		if past, err = RepoAgentsBefore(ctx, q, now, roots); err != nil {
			return nil, err
		}
	}
	today, err := rateHours(ctx, q, roots, midnight, now.UnixMilli()+1)
	if err != nil {
		return nil, err
	}
	out.Rate = composeRate(now, past.hours, today)
	kinds, err := sessionKinds(ctx, q, roots)
	if err != nil {
		return nil, err
	}
	// Today's scan reaches back ten minutes past midnight, for "now" alone.
	nowFrom := now.UnixMilli() - RepoAgentNowMs
	day, err := teamDays(ctx, q, roots, kinds, starts[len(starts)-1:], names[len(names)-1:], min(midnight, nowFrom), now.UnixMilli()+1, nowFrom, &out.Team.Now)
	if err != nil {
		return nil, err
	}
	out.Team.Series = append(append(make([]TeamDay, 0, len(past.team)+1), past.team...), day...)
	out.Team.PeakToday = day[0].Peak
	return out, nil
}

func (s *RateSpan) add(cost float64, priced, tokens int64) {
	s.CostUSD += cost
	s.Tokens += tokens
	if priced >= UsualMinCalls && cost > 0 {
		s.ActiveHours++
		s.ActiveCostUSD += cost
		s.ActiveTokens += tokens
	}
	if priced > 0 {
		s.WallHours = 1
	}
}

func (s *RateSpan) sum(h RateSpan) {
	s.CostUSD += h.CostUSD
	s.Tokens += h.Tokens
	s.ActiveHours += h.ActiveHours
	s.ActiveCostUSD += h.ActiveCostUSD
	s.ActiveTokens += h.ActiveTokens
	s.WallHours += h.WallHours
}

// rateFrom is where the rate's window starts: the usual reaches
// RepoAgentDays×24 hours before the last 24, which is before the series'
// first midnight; a midnight two days before both keeps the hours local.
func rateFrom(now time.Time) int64 {
	y, m, d := now.Date()
	return time.Date(y, m, d-RepoAgentDays-2, 0, 0, 0, 0, now.Location()).UnixMilli()
}

// rateHours is every clock hour in [from, to) with a priced turn, summed
// over the repository's sessions: one row per (session, hour), each made
// active or not by Usual's rule before it is added to its hour. from is a
// local midnight, so the hours are local hours.
func rateHours(ctx context.Context, q Querier, roots []string, from, to int64) (map[int64]RateSpan, error) {
	scope, args := repoScope(roots)
	rows, err := q.QueryContext(ctx, `
		SELECT e.session_id, (e.ts - ?) / 3600000 AS hr,
		       COALESCE(SUM(e.cost_usd),0), COUNT(e.cost_usd),
		       COALESCE(SUM(COALESCE(e.tokens_in,0)+COALESCE(e.tokens_out,0)+COALESCE(e.cache_read,0)+COALESCE(e.cache_write,0)),0)
		FROM events e INDEXED BY idx_events_turn_agent
		WHERE e.kind = 'turn.assistant' AND e.ts >= ? AND e.ts < ?`+nonInternalEventE+scope+`
		GROUP BY e.session_id, hr`, append([]any{from, from, to}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]RateSpan{}
	for rows.Next() {
		var sid string
		var hr, priced, tokens int64
		var cost float64
		if err := rows.Scan(&sid, &hr, &cost, &priced, &tokens); err != nil {
			return nil, err
		}
		var one RateSpan
		one.add(cost, priced, tokens)
		at := from + hr*hourMs
		h := out[at]
		wall := h.WallHours
		h.sum(one)
		h.WallHours = max(wall, one.WallHours) // an hour is one wall-clock hour however many agents ran
		out[at] = h
	}
	return out, rows.Err()
}

// composeRate sets the hours into the last 24, the usual before them and
// the local days.
func composeRate(now time.Time, past, today map[int64]RateSpan) RepoRate {
	starts, ends, names := localDays(now, RepoAgentDays)
	midnight := starts[len(starts)-1]
	nowHour := midnight + (now.UnixMilli()-midnight)/hourMs*hourMs
	last24 := nowHour - 23*hourMs
	usualFrom := last24 - RepoAgentDays*24*hourMs
	r := RepoRate{Series: make([]RateDay, len(starts))}
	for i := range r.Series {
		r.Series[i].Day = names[i]
	}
	var usual RateSpan
	usualDays := map[int64]bool{}
	for _, hours := range []map[int64]RateSpan{past, today} {
		for at, h := range hours {
			if i := dayIndex(starts, ends, at); i >= 0 {
				r.Series[i].sum(h)
			}
			switch {
			case at >= last24:
				r.Last24.sum(h)
			case at >= usualFrom:
				usual.sum(h)
				if h.ActiveHours > 0 {
					usualDays[(at-usualFrom)/(24*hourMs)] = true
				}
			}
		}
	}
	if usual.ActiveHours > 0 {
		usual.Days = len(usualDays)
		r.Usual = &usual
	}
	return r
}

// teamDays is the distinct agents of each day in starts (consecutive local
// days), from one row per (session, subagent, five-minute bucket) with an
// assistant turn in [from, to). Five minutes divides every UTC offset, so a
// bucket never straddles a local midnight. With now set, the agents of the
// buckets that reach past nowFrom are counted into it.
func teamDays(ctx context.Context, q Querier, roots []string, kinds map[string]string, starts []int64, names []string, from, to, nowFrom int64, now *TeamCount) ([]TeamDay, error) {
	ends := make([]int64, len(starts))
	for i := range starts {
		if i+1 < len(starts) {
			ends[i] = starts[i+1]
		} else {
			ends[i] = to
		}
	}
	scope, args := repoScope(roots)
	rows, err := q.QueryContext(ctx, `
		SELECT e.session_id, COALESCE(e.agent_id,''), e.ts / ? AS b
		FROM events e INDEXED BY idx_events_turn_agent
		WHERE e.kind = 'turn.assistant' AND e.ts >= ? AND e.ts < ?`+nonInternalEventE+scope+`
		GROUP BY e.session_id, e.agent_id, b`, append([]any{int64(TrendBucketMs), from, to}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type agentKey struct{ sid, sub string }
	seen := make([]map[agentKey]bool, len(starts))
	perBucket := map[int64]int64{}
	nowSeen := map[agentKey]bool{}
	for rows.Next() {
		var k agentKey
		var b int64
		if err := rows.Scan(&k.sid, &k.sub, &b); err != nil {
			return nil, err
		}
		at := b * TrendBucketMs
		// The bucket the ten minutes begin in counts whole: a turn at
		// 10:01 is "now" at 10:10.
		if now != nil && at+TrendBucketMs > nowFrom && !nowSeen[k] {
			nowSeen[k] = true
			if k.sub == "" {
				now.Sessions++
			} else {
				now.Subagents++
			}
		}
		i := dayIndex(starts, ends, at)
		if i < 0 {
			continue
		}
		if seen[i] == nil {
			seen[i] = map[agentKey]bool{}
		}
		seen[i][k] = true
		perBucket[b]++
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]TeamDay, len(starts))
	for i := range out {
		day := &out[i]
		day.Day = names[i]
		for k := range seen[i] {
			kind := kinds[k.sid]
			if kind == "" {
				kind = "claude"
			}
			if day.ByKind == nil {
				day.ByKind = map[string]TeamCount{}
			}
			c := day.ByKind[kind]
			if k.sub == "" {
				day.Sessions++
				c.Sessions++
			} else {
				day.Subagents++
				c.Subagents++
			}
			day.ByKind[kind] = c
		}
	}
	for b, n := range perBucket {
		if i := dayIndex(starts, ends, b*TrendBucketMs); i >= 0 && n > out[i].Peak {
			out[i].Peak = n
		}
	}
	return out, nil
}

// sessionKinds is each session's agent (claude, codex, …) in the folders.
func sessionKinds(ctx context.Context, q Querier, roots []string) (map[string]string, error) {
	ph := strings.TrimSuffix(strings.Repeat("?,", len(roots)), ",")
	args := make([]any, len(roots))
	for i, r := range roots {
		args[i] = r
	}
	rows, err := q.QueryContext(ctx, `SELECT session_id, COALESCE(agent,'') FROM sessions WHERE repo_root IN (`+ph+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var id, kind string
		if err := rows.Scan(&id, &kind); err != nil {
			return nil, err
		}
		out[id] = kind
	}
	return out, rows.Err()
}

// RepoRootsKey is roots as one cache key: sorted, so the order a client
// sends them in does not split the cache.
func RepoRootsKey(roots []string) string {
	s := append([]string(nil), roots...)
	sort.Strings(s)
	return strings.Join(s, "\x00")
}
