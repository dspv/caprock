package rollup

import (
	"context"
	"fmt"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/modelclass"
	"github.com/dspv/caprock/internal/store"
)

// PriceUnpriced prices the turns stored with no cost because their model was
// missing from the pricing table, now that the table has a row for it.
//
// This is not repricing. A turn that was priced keeps the figure it was given
// when it ran — a bump never restates history. A turn with no cost was never
// given a figure at all; it sat outside every total as "unpriced", and adding
// the model's row fixed only the turns after it. 5,788 Codex turns on the
// owner's machine (gpt-6-sol and gpt-6-luna) were in that state. Each is priced
// at the row in force at its own timestamp, exactly as it would have been had
// the row existed then, and the session and daily totals take the same amount
// in the same transaction, so every screen stays consistent with the events.
func (r *Recorder) PriceUnpriced(ctx context.Context) (priced int, err error) {
	if r.Table == nil {
		return 0, nil
	}
	db := r.Store.DB()
	rows, err := db.QueryContext(ctx, `
		SELECT e.id, e.ts, e.session_id, e.model,
		       COALESCE(e.tokens_in,0), COALESCE(e.tokens_out,0), COALESCE(e.cache_read,0), COALESCE(e.cache_write,0), COALESCE(e.cache_write_1h,0),
		       COALESCE(s.project,'')
		FROM events e LEFT JOIN sessions s ON s.session_id = e.session_id
		WHERE e.kind = ? AND e.cost_usd IS NULL AND COALESCE(e.model,'') != '' AND e.internal = 0
		  AND COALESCE(e.tokens_in,0)+COALESCE(e.tokens_out,0)+COALESCE(e.cache_read,0)+COALESCE(e.cache_write,0) > 0`,
		string(event.KindTurnAssistant))
	if err != nil {
		return 0, fmt.Errorf("find unpriced turns: %w", err)
	}
	type turn struct {
		id             int64
		ts             int64
		session, model string
		tokens         event.TokenDelta
		project        string
	}
	var todo []turn
	for rows.Next() {
		var t turn
		if err := rows.Scan(&t.id, &t.ts, &t.session, &t.model,
			&t.tokens.In, &t.tokens.Out, &t.tokens.CacheRead, &t.tokens.CacheWrite, &t.tokens.CacheWrite1h, &t.project); err != nil {
			_ = rows.Close()
			return 0, err
		}
		if modelclass.IsInternal(t.model) {
			continue
		}
		todo = append(todo, t)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	loc := r.Location
	if loc == nil {
		loc = time.Local
	}
	for _, t := range todo {
		if ctx.Err() != nil {
			return priced, ctx.Err()
		}
		at := time.UnixMilli(t.ts)
		usd, ok := r.Table.PriceAt(t.model, t.tokens, at)
		if !ok {
			continue // still not in the table: stays unpriced, and is counted as such
		}
		err := r.Store.WithTx(ctx, func(q store.Querier) error {
			res, err := q.ExecContext(ctx, `UPDATE events SET cost_usd = ? WHERE id = ? AND cost_usd IS NULL`, usd, t.id)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n == 0 {
				return nil // priced by someone else meanwhile
			}
			if _, err := store.AddStats(ctx, q, store.Stats{SessionID: t.session, CostUSD: usd}); err != nil {
				return err
			}
			// Tokens and the session count were added when the turn was
			// stored; only the money was missing.
			return store.AddDaily(ctx, q, at.In(loc).Format("2006-01-02"), t.project, t.model, 0, usd, false)
		})
		if err != nil {
			return priced, fmt.Errorf("price turn %d: %w", t.id, err)
		}
		priced++
	}
	if r.Log != nil && priced > 0 {
		r.Log.Info("priced turns whose model was missing from the table", "component", "rollup", "turns", priced)
	}
	return priced, nil
}
