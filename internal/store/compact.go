package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"

	"github.com/dspv/caprock/internal/event"
)

// Payload compaction: the base64 that rows stored before event.CapToolField
// still hold, replaced by the marker CapToolField writes now.
//
// CapToolField bounds what is written from 2026-10-13 on; the rows written
// before it keep every screenshot as base64. On the owner's machine that was
// most of a 2.2 GB file, and nothing reads it back: no screen renders a stored
// image (the chat's image upload is base64 on its way in, never read from the
// database). Only the base64 goes — long text is kept as it was, unlike on
// the write path, because a row already stored is someone's history.
//
// The daemon runs it a step at a time while idle (internal/daemon/compact.go).
// Each step reads a window of ids outside any transaction, rewrites the rows
// that held base64 in one short transaction, and moves the cursor in the same
// one, so a stopped daemon resumes where it was and a finished pass is never
// read again.
const (
	// MetaPayloadCompactCursor is the highest event id the compaction has
	// examined, or PayloadCompactDone once it has examined them all.
	MetaPayloadCompactCursor = "payload_compact_cursor"
	// MetaPayloadCompactUntil is the highest event id when the compaction
	// began: every row after it was written through CapToolField already, so
	// the pass has an end however much is recorded while it runs.
	MetaPayloadCompactUntil = "payload_compact_until"
	// PayloadCompactDone is the cursor's value once the pass is complete.
	PayloadCompactDone = "done"
)

// CompactStep is what one step of the payload compaction did.
type CompactStep struct {
	// Rewritten is how many rows lost base64; Freed is how many payload bytes
	// that took out of them.
	Rewritten int
	Freed     int64
	// Done is true once the last window has been examined.
	Done bool
}

// CompactPayloadsStep examines the next window of up to `window` event ids
// and replaces the base64 in each row that holds any (event.StripBinary).
// It is idempotent and resumable: the cursor moves in the transaction that
// rewrites the rows, and a row rewritten twice is not changed the second time.
//
// The window is read outside the write transaction, so the write lock is held
// only for the updates. A row whose payload changed between the read and the
// write (an assistant turn whose prose was merged into it) is left for what
// it now holds: the update matches the payload it read, byte for byte.
func (s *Store) CompactPayloadsStep(ctx context.Context, window int) (CompactStep, error) {
	var st CompactStep
	if window <= 0 {
		window = 500
	}
	cur, err := s.GetMeta(ctx, MetaPayloadCompactCursor)
	if err != nil {
		return st, err
	}
	if cur == PayloadCompactDone {
		st.Done = true
		return st, nil
	}
	from, _ := strconv.ParseInt(cur, 10, 64)
	until, err := s.compactCeiling(ctx)
	if err != nil {
		return st, err
	}
	if from >= until {
		st.Done = true
		return st, s.SetMeta(ctx, MetaPayloadCompactCursor, PayloadCompactDone)
	}
	to := min(from+int64(window), until)

	// instr() is the cheap filter: every shape StripBinary replaces names
	// "base64" or "image", or is a data: URI, somewhere in its JSON.
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, payload FROM events
		 WHERE id > ? AND id <= ?
		   AND (instr(payload, 'base64') > 0 OR instr(payload, '"image"') > 0 OR instr(payload, '"data:') > 0)`,
		from, to)
	if err != nil {
		return st, err
	}
	type change struct {
		id       int64
		old, new string
	}
	var changes []change
	for rows.Next() {
		var id int64
		var payload string
		if err := rows.Scan(&id, &payload); err != nil {
			_ = rows.Close()
			return st, err
		}
		if out, ok := event.StripBinary([]byte(payload)); ok {
			changes = append(changes, change{id, payload, string(out)})
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return st, err
	}
	if err := rows.Close(); err != nil {
		return st, err
	}

	next := strconv.FormatInt(to, 10)
	if to >= until {
		next = PayloadCompactDone
		st.Done = true
	}
	err = s.WithTx(ctx, func(q Querier) error {
		for _, c := range changes {
			// tool_bytes keeps the size the tool handed back: rows written
			// before migration 0018 measured it, and a row that somehow has
			// none is measured from the payload before it shrinks.
			res, err := q.ExecContext(ctx, `
				UPDATE events
				   SET payload = ?,
				       tool_bytes = CASE WHEN kind = 'tool.post' AND tool_bytes = 0
				                         THEN COALESCE(LENGTH(json_extract(payload, '$.tool_response')), 0)
				                         ELSE tool_bytes END
				 WHERE id = ? AND payload = ?`, c.new, c.id, c.old)
			if err != nil {
				return fmt.Errorf("compact event %d: %w", c.id, err)
			}
			if n, _ := res.RowsAffected(); n == 1 {
				st.Rewritten++
				st.Freed += int64(len(c.old) - len(c.new))
			}
		}
		_, err := q.ExecContext(ctx,
			`INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
			MetaPayloadCompactCursor, next)
		return err
	})
	if err != nil {
		return CompactStep{}, err
	}
	return st, nil
}

// compactCeiling is MetaPayloadCompactUntil, set to the highest event id the
// first time it is asked for.
func (s *Store) compactCeiling(ctx context.Context) (int64, error) {
	v, err := s.GetMeta(ctx, MetaPayloadCompactUntil)
	if err != nil {
		return 0, err
	}
	if n, err := strconv.ParseInt(v, 10, 64); err == nil {
		return n, nil
	}
	var top sql.NullInt64
	if err := s.db.QueryRowContext(ctx, `SELECT MAX(id) FROM events`).Scan(&top); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	if err := s.SetMeta(ctx, MetaPayloadCompactUntil, strconv.FormatInt(top.Int64, 10)); err != nil {
		return 0, err
	}
	return top.Int64, nil
}

// PayloadCompactFinished reports whether the payload compaction has finished.
func (s *Store) PayloadCompactFinished(ctx context.Context) (bool, error) {
	v, err := s.GetMeta(ctx, MetaPayloadCompactCursor)
	return v == PayloadCompactDone, err
}
