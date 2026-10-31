package rollup

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/store"
)

// compactionCallBatch is how many calls one read of a compaction's count
// takes; a row is counted in as many reads as it needs.
const compactionCallBatch = 2000

// compactionPrevCalls is how many calls before a boundary are read for its
// model and cache state.
const compactionPrevCalls = 20

// RefreshCompactionStats keeps compaction_stats current (migration 0077;
// 03-contracts.md § Compaction stats DDL): a row for every new main-thread
// boundary, its figures made again under a new pricing table, its cost made
// when what it needs is known, and the calls since its last pass counted
// into its saving. Incremental: a row whose session made no call since its
// last pass costs one index seek, and a row closed by the session's next
// boundary is settled once it has counted up to it. Run at start (the
// backfill) and on the daemon's minute tick. It returns how many rows it
// wrote.
func (r *Recorder) RefreshCompactionStats(ctx context.Context) (written int, err error) {
	if r.Table == nil {
		return 0, nil
	}
	version := r.Table.Version
	now := time.Now
	if r.Now != nil {
		now = r.Now
	}
	db := r.Store.DB()
	if err := r.Store.WithTx(ctx, func(q store.Querier) error {
		_, err := store.AddCompactionBoundaries(ctx, q)
		return err
	}); err != nil {
		return 0, err
	}
	ids, err := store.CompactionStatsToInit(ctx, db, version)
	if err != nil {
		return 0, fmt.Errorf("find compaction rows to fill: %w", err)
	}
	for _, id := range ids {
		if ctx.Err() != nil {
			return written, ctx.Err()
		}
		if err := r.Store.WithTx(ctx, func(q store.Querier) error {
			_, err := store.ReinitCompactionStat(ctx, q, id)
			return err
		}); err != nil {
			return written, fmt.Errorf("fill compaction row %d: %w", id, err)
		}
	}
	open, err := store.OpenCompactionStats(ctx, db)
	if err != nil {
		return written, fmt.Errorf("read open compaction rows: %w", err)
	}
	for _, c := range open {
		if ctx.Err() != nil {
			return written, ctx.Err()
		}
		changed, err := r.refreshCompaction(ctx, db, &c)
		if err != nil {
			return written, fmt.Errorf("count compaction %d: %w", c.EventID, err)
		}
		if !changed && c.PricingVersion == version {
			continue
		}
		c.PricingVersion, c.UpdatedAt = version, now().UnixMilli()
		if err := r.Store.WithTx(ctx, func(q store.Querier) error { return store.SaveCompactionStat(ctx, q, c) }); err != nil {
			return written, err
		}
		written++
	}
	return written, nil
}

// refreshCompaction brings one row up to date in memory: its cost when it is
// stale, and the calls after its cursor. changed is whether anything moved.
func (r *Recorder) refreshCompaction(ctx context.Context, db store.Querier, c *store.CompactionStat) (changed bool, err error) {
	before := int64(math.MaxInt64)
	if c.NextAt.Valid {
		before = c.NextAt.Int64
	}
	var first *store.CompactionCall
	for {
		calls, err := store.MainCallsAfter(ctx, db, c.Sid, c.CountedTs, c.CountedID, before, compactionCallBatch)
		if err != nil {
			return changed, err
		}
		for i := range calls {
			call := calls[i]
			if first == nil && c.TurnsAfter == 0 {
				first = &call
			}
			if c.PostTokens == 0 {
				// The boundary did not say: the first real call after it
				// carries the context after (as store.LastCompaction reads it).
				c.PostTokens = call.Prompt()
			}
			if s, ok := r.Table.CompactionSaving(call.Model, time.UnixMilli(call.Ts), c.PreTokens-c.PostTokens); ok {
				c.EstSavedUSD += s
			}
			c.TurnsAfter++
			c.CountedTs, c.CountedID = call.Ts, call.ID
			changed = true
		}
		if len(calls) < compactionCallBatch {
			break
		}
	}
	if c.NextAt.Valid && c.CountedTs < c.NextAt.Int64 {
		// Closed, and every call before the next boundary is in: settled.
		c.CountedTs, c.CountedID = c.NextAt.Int64, 0
		changed = true
	}
	if c.CostStale {
		ok, err := r.compactionCost(ctx, db, c, first)
		if err != nil {
			return changed, err
		}
		if ok {
			c.CostStale = false
		}
		changed = true
	}
	return changed, nil
}

// compactionCost makes a row's estimated cost: the session's model at the
// boundary (its last main-thread call before, else the first after), the
// cache warm when that last call was within the cache TTL of the moment the
// compaction started, and the summary as output when its length is known.
// ok is false while no call names a model; the cost stays to be made.
func (r *Recorder) compactionCost(ctx context.Context, db store.Querier, c *store.CompactionStat, first *store.CompactionCall) (bool, error) {
	prev, err := store.MainCallsBefore(ctx, db, c.Sid, c.At, compactionPrevCalls)
	if err != nil {
		return false, err
	}
	var dur int64
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(json_extract(payload, '$.duration_ms'), 0) FROM events WHERE id = ?`,
		c.EventID).Scan(&dur); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	c.Warm = compactionWarm(c.At-max(dur, 0), prev)
	switch {
	case len(prev) > 0 && prev[0].Model != "":
		c.Model = prev[0].Model
	case first != nil && first.Model != "":
		c.Model = first.Model
	case c.Model == "":
		if c.TurnsAfter == 0 {
			return false, nil
		}
		calls, err := store.MainCallsAfter(ctx, db, c.Sid, c.At, -1, math.MaxInt64, 1)
		if err != nil || len(calls) == 0 || calls[0].Model == "" {
			return false, err
		}
		c.Model = calls[0].Model
	}
	var summary int64
	if c.SummaryTokensEst.Valid {
		summary = c.SummaryTokensEst.Int64
	}
	usd, ok := r.Table.CompactionCost(c.Model, time.UnixMilli(c.At), c.PreTokens, summary, c.Warm)
	c.EstCostUSD = sql.NullFloat64{Float64: usd, Valid: ok}
	return true, nil
}

// compactionWarm reports whether the prefix was still cached when the
// compaction started at `start` (unix ms): the last main-thread call before
// it (prev, newest first) ran within the cache TTL — an hour when the
// newest call that wrote the cache wrote the 1-hour one, five minutes
// otherwise. No call before: cold.
func compactionWarm(start int64, prev []store.CompactionCall) bool {
	if len(prev) == 0 {
		return false
	}
	ttl := cost.CacheTTL5m
	for _, p := range prev {
		if p.CacheWrite > 0 {
			if p.CacheWrite1h > 0 {
				ttl = cost.CacheTTL1h
			}
			break
		}
	}
	gap := start - prev[0].Ts
	return gap <= ttl.Milliseconds()
}
