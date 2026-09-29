package rollup

import (
	"context"
	"fmt"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// RebuildCodexDaily recomputes daily_stats' Codex rows from the Codex events.
//
// Migrations 0022 and 0023 deleted every Codex event and zeroed the per-session
// totals so the importer could write them again correctly — but left
// daily_stats alone. The re-import then added each re-read turn to the day it
// was already in. On the owner's machine that put five days $3.68 and 7.9M
// tokens above what the events add up to (2025-10-16/17 on gpt-5-codex, three
// days in August and September on gpt-5.6-sol), in every screen that reads
// the daily table.
//
// daily_stats cannot simply be rebuilt from events in general: it outlives
// events that retention has pruned, and its project is the one the turn's own
// cwd resolved to at the time. For Codex both are knowable — the importer
// passes the session's cwd, so the project is the session's — which is why
// this is scoped to Codex, and within Codex:
//
//   - a (day, model) that another source also used on that day is skipped,
//     because its row mixes usage this cannot separate;
//   - a day before keepFrom is skipped, because retention may have pruned its
//     events and rebuilding it would erase real history.
//
// Tokens and cost are rewritten; the session count is left as it is, because
// daily_sessions never double-counted. Runs once (store.MetaCodexDailyRebuilt).
func (r *Recorder) RebuildCodexDaily(ctx context.Context, keepFrom time.Time) (rows int, err error) {
	db := r.Store.DB()
	if done, _ := r.Store.GetMeta(ctx, store.MetaCodexDailyRebuilt); done == "1" {
		return 0, nil
	}
	loc := r.Location
	if loc == nil {
		loc = time.Local
	}
	type key struct{ day, project, model string }
	type pair struct{ day, model string }
	type sum struct {
		tokens int64
		cost   float64
	}
	evRows, err := db.QueryContext(ctx, `
		SELECT e.ts, e.source, COALESCE(e.model,''), COALESCE(s.project,''),
		       COALESCE(e.tokens_in,0)+COALESCE(e.tokens_out,0)+COALESCE(e.cache_read,0)+COALESCE(e.cache_write,0),
		       COALESCE(e.cost_usd,0)
		FROM events e LEFT JOIN sessions s ON s.session_id = e.session_id
		WHERE e.kind = ? AND e.internal = 0`, string(event.KindTurnAssistant))
	if err != nil {
		return 0, fmt.Errorf("read turns: %w", err)
	}
	codex := map[key]sum{}
	codexPairs := map[pair]bool{}
	mixed := map[pair]bool{}
	for evRows.Next() {
		var ts, tokens int64
		var source, model, project string
		var cost float64
		if err := evRows.Scan(&ts, &source, &model, &project, &tokens, &cost); err != nil {
			_ = evRows.Close()
			return 0, err
		}
		at := time.UnixMilli(ts)
		if !keepFrom.IsZero() && at.Before(keepFrom) {
			continue
		}
		p := pair{at.In(loc).Format("2006-01-02"), model}
		if source != string(event.SourceCodex) {
			mixed[p] = true
			continue
		}
		codexPairs[p] = true
		k := key{p.day, project, model}
		v := codex[k]
		v.tokens += tokens
		v.cost += cost
		codex[k] = v
	}
	_ = evRows.Close()
	if err := evRows.Err(); err != nil {
		return 0, err
	}

	err = r.Store.WithTx(ctx, func(q store.Querier) error {
		for p := range codexPairs {
			if mixed[p] {
				continue
			}
			// Every row of this day and model is Codex's, so each one is set to
			// what the events say — including a row whose events all went, which
			// is left at zero rather than at a stale figure.
			dr, err := q.QueryContext(ctx, `SELECT project FROM daily_stats WHERE day = ? AND model = ?`, p.day, p.model)
			if err != nil {
				return err
			}
			var projects []string
			for dr.Next() {
				var pr string
				if err := dr.Scan(&pr); err != nil {
					_ = dr.Close()
					return err
				}
				projects = append(projects, pr)
			}
			_ = dr.Close()
			for _, pr := range projects {
				v := codex[key{p.day, pr, p.model}]
				res, err := q.ExecContext(ctx,
					`UPDATE daily_stats SET tokens_total = ?, cost_usd = ?
					 WHERE day = ? AND project = ? AND model = ? AND (tokens_total != ? OR abs(cost_usd - ?) > 1e-9)`,
					v.tokens, v.cost, p.day, pr, p.model, v.tokens, v.cost)
				if err != nil {
					return err
				}
				if n, _ := res.RowsAffected(); n > 0 {
					rows++
				}
			}
		}
		// In the same transaction, so a crash cannot leave the rows rebuilt
		// and the marker unset, or the other way round.
		_, err := q.ExecContext(ctx, `INSERT INTO meta(k, v) VALUES(?, '1') ON CONFLICT(k) DO UPDATE SET v = excluded.v`, store.MetaCodexDailyRebuilt)
		return err
	})
	if err != nil {
		return 0, err
	}
	if r.Log != nil && rows > 0 {
		r.Log.Info("rebuilt Codex daily totals from events", "component", "rollup", "rows", rows)
	}
	return rows, nil
}
