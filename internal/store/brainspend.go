package store

import (
	"cmp"
	"context"
	"slices"
	"strings"
	"time"
)

// What Second Brain's automatic extraction spent (GET /v1/brain/spend,
// 03-contracts.md § Second Brain): per local day, per project, and against
// everything Claude Code spent in the sessions Caprock recorded.

// BrainSpendRow is one read's spend: when it finished, its tokens (input
// and output together, as brain_runs keeps them) and cost, and whether
// claude was asked at all — a skipped session costs nothing and is no read —
// and whose it was: the read session's project ("" when it has none or is
// gone), or Retag for a re-tag batch, as BrainSpendByProject groups them.
type BrainSpendRow struct {
	FinishedAt int64
	Tokens     int64
	CostUSD    float64
	Read       bool
	Project    string
	Retag      bool
}

// BrainSpendRows lists every read that finished since a moment, oldest first.
func BrainSpendRows(ctx context.Context, q Querier, since int64) ([]BrainSpendRow, error) {
	rows, err := q.QueryContext(ctx, `SELECT r.finished_at, r.tokens_in + r.tokens_out, r.cost_usd, r.status != 'skipped',
		       COALESCE(s.project, ''), r.session_id = ?
		FROM brain_runs r LEFT JOIN sessions s ON s.session_id = r.session_id
		WHERE r.finished_at >= ? ORDER BY r.finished_at`, BrainRetagSession, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BrainSpendRow{}
	for rows.Next() {
		var r BrainSpendRow
		if err := rows.Scan(&r.FinishedAt, &r.Tokens, &r.CostUSD, &r.Read, &r.Project, &r.Retag); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// BrainDaySpend is one local day of the extraction's reads.
type BrainDaySpend struct {
	// Day is the date, YYYY-MM-DD, in the daemon's time zone; Start is its
	// midnight, unix ms.
	Day     string  `json:"day"`
	Start   int64   `json:"start"`
	Tokens  int64   `json:"tokens"`
	CostUSD float64 `json:"cost_usd"`
	Reads   int     `json:"reads"`
	// Projects is the day's tokens by whose they were, keyed as the
	// window's projects are (project, and retag for the re-tag batches),
	// most tokens first; only those that spent any. They add up to Tokens.
	Projects []BrainDayProject `json:"projects"`
}

// BrainDayProject is one project's tokens on one day.
type BrainDayProject struct {
	Project string `json:"project"`
	Retag   bool   `json:"retag,omitempty"`
	Tokens  int64  `json:"tokens"`
}

// BrainSpendStart is local midnight days-1 days before now's: where a
// chart of `days` days, today the last, begins.
func BrainSpendStart(now time.Time, days int) time.Time {
	y, m, d := now.Date()
	return time.Date(y, m, d-(days-1), 0, 0, 0, 0, now.Location())
}

// BucketBrainDays sums reads into `days` local days ending with now's,
// oldest first, every day present even when nothing was read. A row outside
// them is left out. Days follow the calendar, so one with a clock change
// lasts 23 or 25 hours.
func BucketBrainDays(runs []BrainSpendRow, now time.Time, days int) []BrainDaySpend {
	if days < 1 {
		return []BrainDaySpend{}
	}
	start := BrainSpendStart(now, days)
	day := func(i int) time.Time {
		return time.Date(start.Year(), start.Month(), start.Day()+i, 0, 0, 0, 0, now.Location())
	}
	out := make([]BrainDaySpend, days)
	bounds := make([]int64, days+1)
	for i := range days {
		d := day(i)
		out[i] = BrainDaySpend{Day: d.Format("2006-01-02"), Start: d.UnixMilli(), Projects: []BrainDayProject{}}
		bounds[i] = d.UnixMilli()
	}
	bounds[days] = day(days).UnixMilli()
	for _, r := range runs {
		if r.FinishedAt < bounds[0] || r.FinishedAt >= bounds[days] {
			continue
		}
		i := 0
		for r.FinishedAt >= bounds[i+1] {
			i++
		}
		out[i].Tokens += r.Tokens
		out[i].CostUSD += r.CostUSD
		if r.Read {
			out[i].Reads++
		}
		if r.Tokens == 0 {
			continue
		}
		ps := out[i].Projects
		j := 0
		for j < len(ps) && (ps[j].Project != r.Project || ps[j].Retag != r.Retag) {
			j++
		}
		if j == len(ps) {
			ps = append(ps, BrainDayProject{Project: r.Project, Retag: r.Retag})
		}
		ps[j].Tokens += r.Tokens
		out[i].Projects = ps
	}
	for i := range out {
		slices.SortFunc(out[i].Projects, func(a, b BrainDayProject) int {
			if c := cmp.Compare(b.Tokens, a.Tokens); c != 0 {
				return c
			}
			if a.Retag != b.Retag {
				if a.Retag {
					return 1
				}
				return -1
			}
			return strings.Compare(a.Project, b.Project)
		})
	}
	return out
}

// BrainProjectSpend is one project's share of the reads since a moment:
// how many asked claude, their tokens and cost, and the memories the reads
// with status ok kept. Retag marks the one row that is not a project: the
// re-tag batches (BrainRetagSession), with Project "", Reads the batches
// and Memories the memories they gave keywords.
type BrainProjectSpend struct {
	Project  string  `json:"project"`
	Retag    bool    `json:"retag,omitempty"`
	Reads    int     `json:"reads"`
	Tokens   int64   `json:"tokens"`
	CostUSD  float64 `json:"cost_usd"`
	Memories int     `json:"memories"`
}

// BrainSpendByProject groups the reads since a moment by their session's
// project ("" when the session has none or is gone), most tokens first, the
// re-tag batches in a row of their own. A project whose reads were all
// skipped is left out.
func BrainSpendByProject(ctx context.Context, q Querier, since int64) ([]BrainProjectSpend, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT COALESCE(s.project, '') AS p, r.session_id = ? AS rt, SUM(r.status != 'skipped'), SUM(r.tokens_in + r.tokens_out), SUM(r.cost_usd),
		       SUM(CASE WHEN r.status = 'ok' THEN r.nodes ELSE 0 END)
		FROM brain_runs r LEFT JOIN sessions s ON s.session_id = r.session_id
		WHERE r.finished_at >= ?
		GROUP BY p, rt HAVING SUM(r.status != 'skipped') > 0
		ORDER BY 4 DESC, 3 DESC, p`, BrainRetagSession, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BrainProjectSpend{}
	for rows.Next() {
		var p BrainProjectSpend
		if err := rows.Scan(&p.Project, &p.Retag, &p.Reads, &p.Tokens, &p.CostUSD, &p.Memories); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// BrainTokensPerRead is the mean tokens of the reads that asked claude and
// spent something since a moment, and how many there were: what a
// catch-up's days left are counted from. A re-tag batch is no read of a
// session and is left out. 0, 0 before the first.
func BrainTokensPerRead(ctx context.Context, q Querier, since int64) (int64, int, error) {
	var sum int64
	var n int
	err := q.QueryRowContext(ctx, `SELECT COALESCE(SUM(tokens_in + tokens_out), 0), COUNT(*) FROM brain_runs
		WHERE finished_at >= ? AND status != 'skipped' AND tokens_in + tokens_out > 0 AND session_id != ?`, since, BrainRetagSession).Scan(&sum, &n)
	if err != nil || n == 0 {
		return 0, 0, err
	}
	return sum / int64(n), n, nil
}

// ClaudeTokensSince sums the tokens of Claude Code's assistant turns since a
// moment — input, output, cache read and cache write, the way a read's
// tokens are counted — in the sessions Caprock recorded. A fork's copy of a
// turn carries none (rollup zeroes it), and Second Brain's own reads are not
// sessions (no transcript, no hooks), so they are not in it.
func ClaudeTokensSince(ctx context.Context, q Querier, since int64) (int64, error) {
	var n int64
	err := q.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(COALESCE(tokens_in,0)+COALESCE(tokens_out,0)+COALESCE(cache_read,0)+COALESCE(cache_write,0)), 0)
		FROM events INDEXED BY idx_events_turn_agent
		WHERE kind = 'turn.assistant' AND ts >= ?`+nonInternalEvent+`
		  AND session_id IN (SELECT session_id FROM sessions WHERE COALESCE(agent,'claude') = 'claude')`, since).Scan(&n)
	return n, err
}
