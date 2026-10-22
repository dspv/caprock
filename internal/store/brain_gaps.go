package store

import (
	"context"
	"database/sql"
	"errors"
)

// Second Brain's catch-up (migration 0068): the spans of past sessions that
// a read before 2026-10-22 skipped, and how far they have been read since.

// Brain gap statuses, as the CHECK constraint spells them.
const (
	BrainGapPending = "pending"
	BrainGapDone    = "done"
	BrainGapFailed  = "failed"
)

// BrainGap is one skipped span: the session's events after FromEventID up
// to and including ToEventID, read up to Cursor so far.
type BrainGap struct {
	ID          int64
	RunID       int64
	SessionID   string
	FromEventID int64
	// ToEventID is 0 until the gap is measured.
	ToEventID  int64
	Cursor     int64
	Status     string
	ReadsTotal int
	ReadsDone  int
	Attempts   int
	UpdatedAt  int64
	// RunThrough is the skipping read's through_event_id: what that read
	// had in front of it ended there.
	RunThrough int64
}

const brainGapCols = `g.id, g.run_id, g.session_id, g.from_event_id, COALESCE(g.to_event_id, 0), g.cursor, g.status,
	g.reads_total, g.reads_done, g.attempts, g.updated_at, COALESCE(r.through_event_id, 0)`

func scanBrainGaps(rows *sql.Rows, err error) ([]BrainGap, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BrainGap{}
	for rows.Next() {
		var g BrainGap
		if err := rows.Scan(&g.ID, &g.RunID, &g.SessionID, &g.FromEventID, &g.ToEventID, &g.Cursor, &g.Status,
			&g.ReadsTotal, &g.ReadsDone, &g.Attempts, &g.UpdatedAt, &g.RunThrough); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// UnmeasuredBrainGaps lists the gaps not measured yet, oldest read first.
func UnmeasuredBrainGaps(ctx context.Context, q Querier) ([]BrainGap, error) {
	return scanBrainGaps(q.QueryContext(ctx, `SELECT `+brainGapCols+` FROM brain_gaps g
		LEFT JOIN brain_runs r ON r.id = g.run_id
		WHERE g.to_event_id IS NULL ORDER BY g.id`))
}

// MeasureBrainGap records a gap's last event and how many reads it takes;
// a gap where nothing was skipped (to or reads 0) is deleted instead.
func MeasureBrainGap(ctx context.Context, q Querier, id, to int64, reads int, now int64) error {
	if to <= 0 || reads <= 0 {
		_, err := q.ExecContext(ctx, `DELETE FROM brain_gaps WHERE id = ?`, id)
		return err
	}
	_, err := q.ExecContext(ctx, `UPDATE brain_gaps SET to_event_id = ?, reads_total = ?, updated_at = ? WHERE id = ?`, to, reads, now, id)
	return err
}

// PendingBrainGaps lists the measured gaps still to read, oldest read first.
func PendingBrainGaps(ctx context.Context, q Querier, limit int) ([]BrainGap, error) {
	return scanBrainGaps(q.QueryContext(ctx, `SELECT `+brainGapCols+` FROM brain_gaps g
		LEFT JOIN brain_runs r ON r.id = g.run_id
		WHERE g.status = 'pending' AND g.to_event_id IS NOT NULL ORDER BY g.id LIMIT ?`, limit))
}

// AdvanceBrainGap records one read of a gap: its cursor moves on, the
// failures in a row are forgotten, and once read through the gap is done,
// its total what it took.
func AdvanceBrainGap(ctx context.Context, q Querier, id, cursor, now int64) error {
	_, err := q.ExecContext(ctx, `UPDATE brain_gaps SET cursor = ?, reads_done = reads_done + 1, attempts = 0, error = '',
		status = CASE WHEN ? >= to_event_id THEN 'done' ELSE status END,
		reads_total = CASE WHEN ? >= to_event_id THEN reads_done + 1 ELSE reads_total END,
		updated_at = ? WHERE id = ?`, cursor, cursor, cursor, now, id)
	return err
}

// FinishBrainGap marks a gap read through, its total what it took.
func FinishBrainGap(ctx context.Context, q Querier, id, now int64) error {
	_, err := q.ExecContext(ctx, `UPDATE brain_gaps SET status = 'done', reads_total = reads_done, updated_at = ? WHERE id = ?`, now, id)
	return err
}

// FailBrainGap records a failed read of a gap; after `most` in a row it is
// given up, its total what it read.
func FailBrainGap(ctx context.Context, q Querier, id int64, msg string, most int, now int64) error {
	_, err := q.ExecContext(ctx, `UPDATE brain_gaps SET attempts = attempts + 1, error = ?, updated_at = ?,
		status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE status END,
		reads_total = CASE WHEN attempts + 1 >= ? THEN reads_done ELSE reads_total END
		WHERE id = ?`, msg, now, most, most, id)
	return err
}

// BrainCatchUp is the catch-up's progress over every measured gap: the
// reads made, the reads in all, and how many gaps are left to read.
func BrainCatchUp(ctx context.Context, q Querier) (done, total, left int, err error) {
	err = q.QueryRowContext(ctx, `SELECT COALESCE(SUM(reads_done), 0), COALESCE(SUM(MAX(reads_total, reads_done)), 0),
		COALESCE(SUM(status = 'pending'), 0)
		FROM brain_gaps WHERE to_event_id IS NOT NULL`).Scan(&done, &total, &left)
	return done, total, left, err
}

// BrainGapTokensPerRead is the mean tokens of the catch-up reads that
// succeeded, 0 before the first.
func BrainGapTokensPerRead(ctx context.Context, q Querier) (int64, error) {
	var n sql.NullFloat64
	err := q.QueryRowContext(ctx, `SELECT AVG(tokens_in + tokens_out) FROM brain_runs WHERE gap_id IS NOT NULL AND status = 'ok'`).Scan(&n)
	return int64(n.Float64), err
}

// BrainSessionCandidate is a session as a read sees it — project, where it
// ran, whether it ended — for a catch-up read; ok is false when it is gone.
func BrainSessionCandidate(ctx context.Context, q Querier, sessionID string) (BrainCandidate, bool, error) {
	c := BrainCandidate{SessionID: sessionID}
	err := q.QueryRowContext(ctx, `SELECT COALESCE(project, ''), COALESCE(cwd, ''), COALESCE(repo_root, ''),
		COALESCE(last_event_at, 0), status = 'ended' FROM sessions WHERE session_id = ?`, sessionID).
		Scan(&c.Project, &c.Cwd, &c.RepoRoot, &c.LastEventAt, &c.Ended)
	if errors.Is(err, sql.ErrNoRows) {
		return c, false, nil
	}
	return c, err == nil, err
}

// BrainOldWindow is what a read before 2026-10-22 had in front of it: the
// newest `limit` main-thread turns after `after` up to `through`, empty
// ones counted against the limit and then dropped, ordered by time. The
// catch-up re-runs that read's cut on it to find what it skipped.
func BrainOldWindow(ctx context.Context, q Querier, sessionID string, after, through int64, limit int) ([]BrainPassage, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT id, ts, user, text FROM (
			SELECT e.id, e.ts, e.kind = 'turn.user' AS user,
			       CASE WHEN e.kind = 'turn.user'
			            THEN COALESCE(json_extract(e.payload, '$.prompt'), json_extract(e.payload, '$.text'), '')
			            ELSE COALESCE(json_extract(e.payload, '$.text'), '') END AS text
			FROM events e
			WHERE e.session_id = ? AND e.id > ? AND e.id <= ? AND +e.kind IN ('turn.user', 'turn.assistant')
			  AND e.internal = 0 AND `+MainThreadWhere+`
			ORDER BY e.id DESC LIMIT ?
		) WHERE text != '' ORDER BY ts, id`, sessionID, after, through, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BrainPassage{}
	for rows.Next() {
		var p BrainPassage
		if err := rows.Scan(&p.EventID, &p.Ts, &p.User, &p.Text); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
