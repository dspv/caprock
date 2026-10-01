package rollup

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/modelclass"
	"github.com/dspv/caprock/internal/store"
)

// MetaPriceCorrections records the pricing-table version whose corrections
// have been applied, so they run once per version rather than on every start.
const MetaPriceCorrections = "price_corrections"

// ApplyCorrections reprices the turns the table's `corrections` name, and moves
// the session and daily totals by the difference in the same transaction.
//
// This is the one place a stored cost changes after the fact, and only for a
// mistake in our own table (see cost.Correction): a price that really changed
// keeps the figure it was given when the turn ran. Each turn is priced at the
// row in force at its own timestamp, as Record would have priced it had the
// table been right.
//
// Idempotent: a turn already at the corrected figure moves by nothing, so an
// interrupted pass is finished by the next start.
func (r *Recorder) ApplyCorrections(ctx context.Context) (corrected int, err error) {
	if r.Table == nil || len(r.Table.Corrections) == 0 {
		return 0, nil
	}
	if done, _ := r.Store.GetMeta(ctx, MetaPriceCorrections); done == r.Table.Version {
		return 0, nil
	}
	loc := r.Location
	if loc == nil {
		loc = time.Local
	}
	for _, c := range r.Table.Corrections {
		var from int64
		if c.From != "" {
			d, err := time.Parse("2006-01-02", c.From)
			if err != nil {
				return corrected, err
			}
			from = d.UnixMilli()
		}
		n, err := r.correct(ctx, c.Model, from, loc)
		corrected += n
		if err != nil {
			return corrected, err
		}
	}
	if err := r.Store.SetMeta(ctx, MetaPriceCorrections, r.Table.Version); err != nil {
		return corrected, err
	}
	if r.Log != nil && corrected > 0 {
		r.Log.Info("corrected turns the previous pricing table priced wrongly", "component", "rollup", "version", r.Table.Version, "turns", corrected)
	}
	return corrected, nil
}

func (r *Recorder) correct(ctx context.Context, prefix string, from int64, loc *time.Location) (int, error) {
	// LIKE treats _ as a wildcard; model ids carry none, but escape anyway so
	// a prefix means exactly that prefix.
	esc := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(prefix)
	rows, err := r.Store.DB().QueryContext(ctx, `
		SELECT e.id, e.ts, e.session_id, e.model, e.cost_usd,
		       COALESCE(e.tokens_in,0), COALESCE(e.tokens_out,0), COALESCE(e.cache_read,0), COALESCE(e.cache_write,0), COALESCE(e.cache_write_1h,0),
		       COALESCE(s.project,'')
		FROM events e LEFT JOIN sessions s ON s.session_id = e.session_id
		WHERE e.kind = ? AND e.cost_usd IS NOT NULL AND e.model LIKE ? ESCAPE '\' AND e.ts >= ? AND e.internal = 0`,
		string(event.KindTurnAssistant), esc+"%", from)
	if err != nil {
		return 0, fmt.Errorf("find turns to correct: %w", err)
	}
	type turn struct {
		id             int64
		ts             int64
		session, model string
		old            float64
		tokens         event.TokenDelta
		project        string
	}
	var todo []turn
	for rows.Next() {
		var t turn
		if err := rows.Scan(&t.id, &t.ts, &t.session, &t.model, &t.old,
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
	n := 0
	for _, t := range todo {
		if ctx.Err() != nil {
			return n, ctx.Err()
		}
		at := time.UnixMilli(t.ts)
		usd, ok := r.Table.PriceAt(t.model, t.tokens, at)
		if !ok {
			continue
		}
		delta := usd - t.old
		if math.Abs(delta) < 1e-12 {
			continue
		}
		err := r.Store.WithTx(ctx, func(q store.Querier) error {
			res, err := q.ExecContext(ctx, `UPDATE events SET cost_usd = ? WHERE id = ? AND cost_usd = ?`, usd, t.id, t.old)
			if err != nil {
				return err
			}
			if k, _ := res.RowsAffected(); k == 0 {
				return nil // changed by someone else meanwhile
			}
			if _, err := store.AddStats(ctx, q, store.Stats{SessionID: t.session, CostUSD: delta}); err != nil {
				return err
			}
			return store.AddDaily(ctx, q, at.In(loc).Format("2006-01-02"), t.project, t.model, 0, delta, false)
		})
		if err != nil {
			return n, fmt.Errorf("correct turn %d: %w", t.id, err)
		}
		n++
	}
	return n, nil
}
