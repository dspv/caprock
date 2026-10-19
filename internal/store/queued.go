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
}

// ErrQueuedNotFound is returned for an id the session's queue does not hold.
var ErrQueuedNotFound = errors.New("no such queued message")

const queuedCols = `id, session_id, text, created_at, updated_at, via`

func scanQueued(sc interface{ Scan(...any) error }) (QueuedMessage, error) {
	var m QueuedMessage
	err := sc.Scan(&m.ID, &m.SessionID, &m.Text, &m.CreatedAt, &m.UpdatedAt, &m.Via)
	return m, err
}

// ListQueued returns a session's queue, oldest first: the order it is sent in.
func ListQueued(ctx context.Context, q Querier, sessionID string) ([]QueuedMessage, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+queuedCols+` FROM queued_messages WHERE session_id = ? ORDER BY id`, sessionID)
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

// QueuedSessions returns every session that has a message waiting.
func QueuedSessions(ctx context.Context, q Querier) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT DISTINCT session_id FROM queued_messages ORDER BY session_id`)
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

// GetQueued returns one message of a session's queue; ErrQueuedNotFound when
// the session holds no such id.
func GetQueued(ctx context.Context, q Querier, sessionID string, id int64) (QueuedMessage, error) {
	m, err := scanQueued(q.QueryRowContext(ctx, `SELECT `+queuedCols+` FROM queued_messages WHERE session_id = ? AND id = ?`, sessionID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return QueuedMessage{}, ErrQueuedNotFound
	}
	return m, err
}

// UpdateQueued replaces a waiting message's text, keeping its place.
func UpdateQueued(ctx context.Context, q Querier, sessionID string, id int64, text string, now time.Time) error {
	res, err := q.ExecContext(ctx, `UPDATE queued_messages SET text = ?, updated_at = ? WHERE session_id = ? AND id = ?`, text, now.UnixMilli(), sessionID, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrQueuedNotFound
	}
	return nil
}

// DeleteQueued takes one message out of a session's queue.
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

// ClearQueued empties a session's queue and says how many it dropped.
func ClearQueued(ctx context.Context, q Querier, sessionID string) (int64, error) {
	res, err := q.ExecContext(ctx, `DELETE FROM queued_messages WHERE session_id = ?`, sessionID)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
