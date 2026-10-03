package rollup

import (
	"context"
	"fmt"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// RepairForkedTurns takes the usage and cost of copied assistant turns back
// out of every total, leaving one row per message id that pays.
//
// `claude --resume <id> --fork-session` writes the parent's history since its
// last compaction into the fork's transcript under the fork's session id, with
// the original message ids and usage. Turns are deduped per session, so each
// copy was stored as a new turn and priced again. On the owner's database one
// fork held 827 copies, $212.93 counted twice. Record now stores a copy with
// no usage (store.TurnPaidElsewhere); this repairs what was stored before.
//
// Within each message id the payer is the row with the most tokens — Claude
// Code zeroes the scalars of the first messages it preserves across a
// compaction, so a copy can hold less than the original, never more — and the
// earliest stored on a tie. Every other row keeps its place in its session's
// timeline with zero tokens and zero cost, and session_stats and daily_stats
// move by exactly what was taken off, in the same transaction. The turn
// count is left alone: the row is still a turn in the fork's history.
//
// Idempotent by construction (a second pass finds one row with usage per
// message id) and run once (store.MetaForkedTurnsRepaired).
func (r *Recorder) RepairForkedTurns(ctx context.Context) (repaired int, err error) {
	if done, _ := r.Store.GetMeta(ctx, store.MetaForkedTurnsRepaired); done == "1" {
		return 0, nil
	}
	loc := r.Location
	if loc == nil {
		loc = time.Local
	}
	type turn struct {
		id, ts          int64
		msg, session    string
		model           string
		internal        bool
		tokens          event.TokenDelta
		cw1h            int64
		cost            float64
		project, cwdPrj string
	}
	err = r.Store.WithTx(ctx, func(q store.Querier) error {
		// The marker first, which also takes the write lock (see
		// RepairSessionModels).
		if _, err := q.ExecContext(ctx, `INSERT INTO meta(k, v) VALUES(?, '1') ON CONFLICT(k) DO UPDATE SET v = excluded.v`, store.MetaForkedTurnsRepaired); err != nil {
			return err
		}
		rows, err := q.QueryContext(ctx, `
			WITH shared AS (
				SELECT msg_id FROM events INDEXED BY idx_events_turn_msg
				WHERE kind = 'turn.assistant' AND msg_id IS NOT NULL
				GROUP BY msg_id HAVING COUNT(DISTINCT session_id) > 1
			)
			SELECT e.id, e.ts, e.msg_id, e.session_id, COALESCE(e.model,''), e.internal,
			       COALESCE(e.tokens_in,0), COALESCE(e.tokens_out,0), COALESCE(e.cache_read,0), COALESCE(e.cache_write,0),
			       COALESCE(e.cache_write_1h,0), COALESCE(e.cost_usd,0),
			       COALESCE(s.project,''), COALESCE(s.cwd,'')
			FROM events e JOIN shared USING (msg_id)
			LEFT JOIN sessions s ON s.session_id = e.session_id
			WHERE e.kind = 'turn.assistant'
			ORDER BY e.msg_id, e.id`)
		if err != nil {
			return fmt.Errorf("find copied turns: %w", err)
		}
		byMsg := map[string][]turn{}
		var order []string
		for rows.Next() {
			var t turn
			var internal int
			var cwd string
			if err := rows.Scan(&t.id, &t.ts, &t.msg, &t.session, &t.model, &internal,
				&t.tokens.In, &t.tokens.Out, &t.tokens.CacheRead, &t.tokens.CacheWrite,
				&t.cw1h, &t.cost, &t.project, &cwd); err != nil {
				_ = rows.Close()
				return err
			}
			t.internal = internal == 1
			t.cwdPrj = store.ProjectFromCwd(cwd)
			if _, ok := byMsg[t.msg]; !ok {
				order = append(order, t.msg)
			}
			byMsg[t.msg] = append(byMsg[t.msg], t)
		}
		_ = rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, msg := range order {
			group := byMsg[msg]
			payer := 0
			for i, t := range group { // ordered by id: a tie keeps the earliest
				if t.tokens.Total() > group[payer].tokens.Total() {
					payer = i
				}
			}
			for i, t := range group {
				if i == payer || (t.tokens.Total() == 0 && t.cw1h == 0 && t.cost == 0) {
					continue
				}
				if _, err := q.ExecContext(ctx, `
					UPDATE events SET tokens_in = 0, tokens_out = 0, cache_read = 0, cache_write = 0,
					                  cache_write_1h = NULL, cost_usd = 0
					WHERE id = ?`, t.id); err != nil {
					return err
				}
				repaired++
				if t.internal {
					continue // added nothing to the rollups, so takes nothing away
				}
				if _, err := store.AddStats(ctx, q, store.Stats{
					SessionID: t.session,
					TokensIn:  -t.tokens.In, TokensOut: -t.tokens.Out,
					CacheRead: -t.tokens.CacheRead, CacheWrite: -t.tokens.CacheWrite,
					CostUSD: -t.cost,
				}); err != nil {
					return err
				}
				// UPDATE, never AddDaily: a negative upsert into a row that is
				// not there would create one. Record filed the day under the
				// project the turn's cwd resolved to, else the session's.
				day := time.UnixMilli(t.ts).In(loc).Format("2006-01-02")
				for _, p := range []string{t.cwdPrj, t.project} {
					if p == "" {
						continue
					}
					res, err := q.ExecContext(ctx,
						`UPDATE daily_stats SET tokens_total = tokens_total - ?, cost_usd = cost_usd - ?
						  WHERE day = ? AND project = ? AND model = ?`,
						t.tokens.Total(), t.cost, day, p, t.model)
					if err != nil {
						return err
					}
					if n, _ := res.RowsAffected(); n > 0 {
						break
					}
				}
			}
		}
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("repair copied turns: %w", err)
	}
	if r.Log != nil && repaired > 0 {
		r.Log.Info("took copied fork turns out of the totals", "component", "rollup", "turns", repaired)
	}
	return repaired, nil
}
