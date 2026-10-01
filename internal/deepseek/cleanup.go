package deepseek

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// removeInjected deletes, once, the prompts earlier versions stored for the
// `user/message` records DSH writes itself — the AGENTS.md/CLAUDE.md
// instructions and the runtime-context snapshot — which the importer no
// longer stores (see parseLine).
//
// It reads the transcripts again because only they say which record a row
// came from: a stored row keeps the text and the record's seq, not its
// `source.kind`, and telling an injected block from a prompt by its words is
// a guess. A row is deleted only when its key names a record the transcript
// marks as not typed by a person; a session whose transcript is gone keeps
// its rows.
//
// A `turn.user` row added nothing to session_stats or daily_stats —
// rollup.Record counts turns and tool calls only — so there is nothing to take
// back out of them. What a row can have moved is the session's own times, and
// those are recomputed from what remains in the same transaction when one of
// them is the deleted row's.
//
// Interrupted, it runs again on the next start and finds less to do; the
// flag is set only after every transcript was read.
func (in *Ingester) removeInjected(ctx context.Context, files []Transcript) {
	if in.rec == nil || in.rec.Store == nil {
		return
	}
	if done, _ := in.rec.Store.GetMeta(ctx, store.MetaDeepseekInjectedRemoved); done == "1" {
		return
	}
	start := time.Now()
	var parsed, removed int
	for _, f := range files {
		if ctx.Err() != nil {
			return
		}
		s, err := ParseFile(f.Path)
		if err != nil {
			continue
		}
		parsed++
		if len(s.Injected) == 0 {
			continue
		}
		n, err := in.dropKeys(ctx, s.ID, s.Injected)
		if err != nil {
			in.log.Warn("deepseek injected-prompt cleanup", "component", "deepseek", "session_id", s.ID, "err", err)
			return
		}
		removed += n
	}
	if err := in.rec.Store.SetMeta(ctx, store.MetaDeepseekInjectedRemoved, "1"); err != nil {
		return
	}
	in.log.Info("deepseek injected context removed from stored prompts",
		"component", "deepseek", "transcripts", parsed, "rows", removed,
		"took_ms", time.Since(start).Milliseconds())
}

// dropKeys deletes one session's `turn.user` rows stored under keys, and
// repairs the session's times if a deleted row set one of them.
func (in *Ingester) dropKeys(ctx context.Context, session string, keys []string) (int, error) {
	removed := 0
	err := in.rec.Store.WithTx(ctx, func(q store.Querier) error {
		var gone []int64
		for _, k := range keys {
			// The delete is the transaction's first statement, so it takes
			// the write lock (waiting out busy_timeout) rather than reading
			// first: a read-then-write transaction cannot upgrade once another
			// writer — the importers run beside this — has committed, and
			// fails at once with SQLITE_BUSY.
			var ts int64
			err := q.QueryRowContext(ctx, `
				DELETE FROM events
				WHERE session_id = ? AND key = ? AND source = ? AND kind = ?
				RETURNING ts`,
				session, k, string(event.SourceDeepseek), string(event.KindTurnUser)).Scan(&ts)
			if errors.Is(err, sql.ErrNoRows) {
				continue // not stored: nothing to remove
			}
			if err != nil {
				return fmt.Errorf("delete %s: %w", k, err)
			}
			gone = append(gone, ts)
		}
		removed = len(gone)
		for _, ts := range gone {
			if err := repairTimes(ctx, q, session, ts); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return removed, nil
}

// repairTimes recomputes a session time that was the deleted row's.
// worked_at is the last prompt, reply or tool call; started_at and
// last_event_at span every event. Each is touched only when it equals the
// deleted timestamp, so a session whose times came from other rows — every one
// on the owner's machine — is left exactly as it was.
func repairTimes(ctx context.Context, q store.Querier, session string, ts int64) error {
	stmts := []string{
		`UPDATE sessions SET worked_at = COALESCE((SELECT MAX(ts) FROM events
		   WHERE session_id = ?1 AND kind IN ('turn.user','turn.assistant','tool.pre','tool.post')), 0)
		 WHERE session_id = ?1 AND worked_at = ?2`,
		`UPDATE sessions SET started_at = (SELECT MIN(ts) FROM events WHERE session_id = ?1)
		 WHERE session_id = ?1 AND started_at = ?2
		   AND EXISTS (SELECT 1 FROM events WHERE session_id = ?1)`,
		`UPDATE sessions SET last_event_at = (SELECT MAX(ts) FROM events WHERE session_id = ?1)
		 WHERE session_id = ?1 AND last_event_at = ?2
		   AND EXISTS (SELECT 1 FROM events WHERE session_id = ?1)`,
	}
	for _, s := range stmts {
		if _, err := q.ExecContext(ctx, s, session, ts); err != nil {
			return fmt.Errorf("repair session times: %w", err)
		}
	}
	return nil
}
