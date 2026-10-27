package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// QueuedMessage is one message waiting for a session's turn to end
// (migration 0047, ADR-053).
type QueuedMessage struct {
	ID        int64  `json:"id"`
	SessionID string `json:"session_id"`
	Text      string `json:"text"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
	// Via is where the message came from: "telegram" for a forward to the
	// paired bot (migration 0064, ADR-081), "" for Caprock's own field.
	Via string `json:"via,omitempty"`
	// UndeliveredAt is when the session's process was found gone with this
	// message still waiting (unix ms, migration 0075, ADR-053 amendment of
	// 2026-10-27); 0 while it waits.
	UndeliveredAt int64 `json:"undelivered_at,omitempty"`
}

// ErrQueuedNotFound is returned for an id the session's queue does not hold.
var ErrQueuedNotFound = errors.New("no such queued message")

const queuedCols = `id, session_id, text, created_at, updated_at, via, undelivered_at`

func scanQueued(sc interface{ Scan(...any) error }) (QueuedMessage, error) {
	var m QueuedMessage
	err := sc.Scan(&m.ID, &m.SessionID, &m.Text, &m.CreatedAt, &m.UpdatedAt, &m.Via, &m.UndeliveredAt)
	return m, err
}

// ListQueued returns a session's queue, oldest first: the order it is sent
// in. Only the messages that still wait, not the undelivered ones.
func ListQueued(ctx context.Context, q Querier, sessionID string) ([]QueuedMessage, error) {
	return listQueued(ctx, q, `SELECT `+queuedCols+` FROM queued_messages WHERE session_id = ? AND undelivered_at = 0 ORDER BY id`, sessionID)
}

// ListUndelivered returns the messages a session's process ended before
// typing in, oldest first (ADR-053, 2026-10-27).
func ListUndelivered(ctx context.Context, q Querier, sessionID string) ([]QueuedMessage, error) {
	return listQueued(ctx, q, `SELECT `+queuedCols+` FROM queued_messages WHERE session_id = ? AND undelivered_at > 0 ORDER BY id`, sessionID)
}

func listQueued(ctx context.Context, q Querier, query, sessionID string) ([]QueuedMessage, error) {
	rows, err := q.QueryContext(ctx, query, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []QueuedMessage{}
	for rows.Next() {
		m, err := scanQueued(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// QueuedSessions returns every session that has a message waiting (not one
// that holds only undelivered ones).
func QueuedSessions(ctx context.Context, q Querier) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT DISTINCT session_id FROM queued_messages WHERE undelivered_at = 0 ORDER BY session_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// AddQueued puts text at the end of a session's queue.
func AddQueued(ctx context.Context, q Querier, sessionID, text string, now time.Time) (QueuedMessage, error) {
	return AddQueuedVia(ctx, q, sessionID, text, "", now)
}

// AddQueuedVia is AddQueued for a message that came from elsewhere
// ("telegram").
func AddQueuedVia(ctx context.Context, q Querier, sessionID, text, via string, now time.Time) (QueuedMessage, error) {
	ms := now.UnixMilli()
	res, err := q.ExecContext(ctx, `INSERT INTO queued_messages (session_id, text, created_at, updated_at, via) VALUES (?, ?, ?, ?, ?)`, sessionID, text, ms, ms, via)
	if err != nil {
		return QueuedMessage{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return QueuedMessage{}, err
	}
	return QueuedMessage{ID: id, SessionID: sessionID, Text: text, CreatedAt: ms, UpdatedAt: ms, Via: via}, nil
}

// GetQueued returns one waiting message of a session's queue;
// ErrQueuedNotFound when the session holds no such id waiting.
func GetQueued(ctx context.Context, q Querier, sessionID string, id int64) (QueuedMessage, error) {
	m, err := scanQueued(q.QueryRowContext(ctx, `SELECT `+queuedCols+` FROM queued_messages WHERE session_id = ? AND id = ? AND undelivered_at = 0`, sessionID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return QueuedMessage{}, ErrQueuedNotFound
	}
	return m, err
}

// UpdateQueued replaces a waiting message's text, keeping its place.
func UpdateQueued(ctx context.Context, q Querier, sessionID string, id int64, text string, now time.Time) error {
	res, err := q.ExecContext(ctx, `UPDATE queued_messages SET text = ?, updated_at = ? WHERE session_id = ? AND id = ? AND undelivered_at = 0`, text, now.UnixMilli(), sessionID, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrQueuedNotFound
	}
	return nil
}

// DeleteQueued takes one message out of a session's queue, waiting or
// undelivered.
func DeleteQueued(ctx context.Context, q Querier, sessionID string, id int64) error {
	res, err := q.ExecContext(ctx, `DELETE FROM queued_messages WHERE session_id = ? AND id = ?`, sessionID, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrQueuedNotFound
	}
	return nil
}

// MarkUndelivered keeps what still waited for a session whose process is
// gone, as not delivered since now, and says how many (ADR-053, 2026-10-27).
func MarkUndelivered(ctx context.Context, q Querier, sessionID string, now time.Time) (int64, error) {
	res, err := q.ExecContext(ctx, `UPDATE queued_messages SET undelivered_at = ? WHERE session_id = ? AND undelivered_at = 0`, now.UnixMilli(), sessionID)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// MoveQueued puts the waiting messages of session from into session to's
// queue, keeping their order (a /clear gave the process a new session id),
// and says how many.
func MoveQueued(ctx context.Context, q Querier, from, to string) (int64, error) {
	res, err := q.ExecContext(ctx, `UPDATE queued_messages SET session_id = ? WHERE session_id = ? AND undelivered_at = 0`, to, from)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// Requeue makes undelivered messages of session from wait again, in session
// to's queue (the same id when the conversation was resumed under its own),
// in their order; no ids is all of them. Says how many it moved.
func Requeue(ctx context.Context, q Querier, from, to string, ids []int64, now time.Time) (int64, error) {
	ms := now.UnixMilli()
	if len(ids) == 0 {
		res, err := q.ExecContext(ctx, `UPDATE queued_messages SET session_id = ?, undelivered_at = 0, updated_at = ? WHERE session_id = ? AND undelivered_at > 0`, to, ms, from)
		if err != nil {
			return 0, err
		}
		return res.RowsAffected()
	}
	var n int64
	for _, id := range ids {
		res, err := q.ExecContext(ctx, `UPDATE queued_messages SET session_id = ?, undelivered_at = 0, updated_at = ? WHERE session_id = ? AND id = ? AND undelivered_at > 0`, to, ms, from, id)
		if err != nil {
			return n, err
		}
		k, _ := res.RowsAffected()
		n += k
	}
	return n, nil
}

// PruneUndelivered deletes the undelivered messages kept since before
// cutoff, and says how many.
func PruneUndelivered(ctx context.Context, q Querier, cutoff time.Time) (int64, error) {
	res, err := q.ExecContext(ctx, `DELETE FROM queued_messages WHERE undelivered_at > 0 AND undelivered_at < ?`, cutoff.UnixMilli())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
