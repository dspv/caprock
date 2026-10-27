package store

import (
	"context"
	"database/sql"
	"time"
)

// Migration 0073 leaves the events stored before it in events_legacy, in the
// old shape, and they move into events in the background while the daemon
// answers (03-contracts.md § Session key DDL).
const (
	// metaMoveTotal is how many rows events_legacy held when the migration
	// ran; metaMoved, how many of them have moved since.
	metaMoveTotal = "events_move_total"
	metaMoved     = "events_moved"
)

const MoveWindow = 500

// Moving reports whether events_legacy still holds rows events lacks.
func (s *Store) Moving() bool { return s.moving.Load() }

func (s *Store) MoveProgress(ctx context.Context) (moved, total int64, err error) {
	if !s.Moving() {
		return 0, 0, nil
	}
	err = s.db.QueryRowContext(ctx, `
		SELECT COALESCE((SELECT CAST(v AS INTEGER) FROM meta WHERE k = ?), 0),
		       COALESCE((SELECT CAST(v AS INTEGER) FROM meta WHERE k = ?), 0)`,
		metaMoved, metaMoveTotal).Scan(&moved, &total)
	return moved, total, err
}

// MoveEventsStep moves the newest window rows left in events_legacy into
// events in one transaction, so an interrupted move resumes where it stopped
// and a row is never in both tables or in neither. A row whose session was
// removed meanwhile is dropped. Done once none is left; the step that finds
// none drops the table.
func (s *Store) MoveEventsStep(ctx context.Context, window int) (moved int, done bool, err error) {
	if !s.Moving() {
		return 0, true, nil
	}
	if window <= 0 {
		window = MoveWindow
	}
	err = s.WithTx(ctx, func(q Querier) error {
		var lo sql.NullInt64
		if err := q.QueryRowContext(ctx,
			`SELECT MIN(id) FROM (SELECT id FROM events_legacy ORDER BY id DESC LIMIT ?)`, window).Scan(&lo); err != nil {
			return err
		}
		if !lo.Valid {
			done = true
			return endMove(ctx, q)
		}
		// Out of events_legacy before into events, or events_legacy_dedupe
		// would find each row and keep it out.
		if _, err := q.ExecContext(ctx, `CREATE TEMP TABLE events_moving AS SELECT * FROM events_legacy WHERE false`); err != nil {
			return err
		}
		res, err := q.ExecContext(ctx, `INSERT INTO temp.events_moving SELECT * FROM events_legacy WHERE id >= ?`, lo.Int64)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		moved = int(n)
		if _, err := q.ExecContext(ctx, `DELETE FROM events_legacy WHERE id >= ?`, lo.Int64); err != nil {
			return err
		}
		for _, stmt := range []string{
			`INSERT INTO events(id, ts, sid, source, kind, tool, payload, tokens_in, tokens_out, cache_read, cache_write,
			                    cost_usd, key, model, cache_write_1h, agent_id, msg_id, touch_dir, tool_bytes, internal, inner_tool)
			   SELECT m.id, m.ts, s.sid, m.source, m.kind, m.tool, m.payload, m.tokens_in, m.tokens_out, m.cache_read, m.cache_write,
			          m.cost_usd, m.key, m.model, m.cache_write_1h, m.agent_id, m.msg_id, m.touch_dir, m.tool_bytes, m.internal, m.inner_tool
			     FROM temp.events_moving m JOIN sessions s ON s.session_id = m.session_id
			    WHERE true ORDER BY m.id
			   ON CONFLICT(sid, key) WHERE key IS NOT NULL DO NOTHING`,
			// The per-session caches (EventsGen) read a session's rows again.
			`INSERT INTO session_gen(session_id, gen)
			   SELECT DISTINCT session_id, 1 FROM temp.events_moving WHERE true
			   ON CONFLICT(session_id) DO UPDATE SET gen = gen + 1`,
			`UPDATE meta SET v = CAST(v AS INTEGER) + (SELECT COUNT(*) FROM temp.events_moving) WHERE k = '` + metaMoved + `'`,
			`DROP TABLE temp.events_moving`,
		} {
			if _, err := q.ExecContext(ctx, stmt); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return 0, false, err
	}
	if done {
		s.moveDone(ctx)
	}
	return moved, done, nil
}

// MoveEvents runs MoveEventsStep until nothing is left, resting between
// steps so ingest and the dashboard always find the database free.
func (s *Store) MoveEvents(ctx context.Context, window int, pause time.Duration) (int, error) {
	total := 0
	for {
		n, done, err := s.MoveEventsStep(ctx, window)
		total += n
		if err != nil || done {
			return total, err
		}
		select {
		case <-ctx.Done():
			return total, ctx.Err()
		case <-time.After(pause):
		}
	}
}

// checkMove runs on Open: a move left unfinished goes on, and one with
// nothing to move (a new database, or every row moved before a crash) ends
// at once.
func (s *Store) checkMove(ctx context.Context) error {
	var legacy bool
	if err := s.db.QueryRowContext(ctx,
		`SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events_legacy')`).Scan(&legacy); err != nil || !legacy {
		return err
	}
	var rows bool
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM events_legacy)`).Scan(&rows); err != nil {
		return err
	}
	if rows {
		s.moving.Store(true)
		return nil
	}
	return s.WithTx(ctx, func(q Querier) error { return endMove(ctx, q) })
}

func endMove(ctx context.Context, q Querier) error {
	for _, stmt := range []string{
		`DROP TRIGGER IF EXISTS events_legacy_dedupe`,
		`DROP TABLE IF EXISTS events_legacy`,
		`DELETE FROM meta WHERE k IN ('` + metaMoveTotal + `', '` + metaMoved + `')`,
	} {
		if _, err := q.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) moveDone(ctx context.Context) {
	s.moving.Store(false)
	sliceMemo.reset()
	learnMemo.reset()
	s.backfillEvents(ctx)
}
