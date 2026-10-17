package store

import (
	"context"
	"database/sql"
	"errors"
)

// AI;DR (ADR-072): the squeezed form of one assistant answer, kept so the
// second tap on it makes no call (migration 0060).

// EventTLDR is one kept squeeze.
type EventTLDR struct {
	EventID   int64
	Text      string
	Model     string
	CostUSD   float64
	CreatedAt int64
}

// GetEventTLDR returns the squeeze kept for an event; ok is false when there
// is none.
func GetEventTLDR(ctx context.Context, q Querier, eventID int64) (EventTLDR, bool, error) {
	t := EventTLDR{EventID: eventID}
	err := q.QueryRowContext(ctx, `SELECT text, model, cost_usd, created_at FROM event_tldr WHERE event_id = ?`, eventID).
		Scan(&t.Text, &t.Model, &t.CostUSD, &t.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return EventTLDR{}, false, nil
	}
	if err != nil {
		return EventTLDR{}, false, err
	}
	return t, true, nil
}

// PutEventTLDR keeps a squeeze, replacing one already kept for the event.
func PutEventTLDR(ctx context.Context, q Querier, t EventTLDR) error {
	_, err := q.ExecContext(ctx, `INSERT INTO event_tldr(event_id, text, model, cost_usd, created_at) VALUES(?, ?, ?, ?, ?)
		ON CONFLICT(event_id) DO UPDATE SET text = excluded.text, model = excluded.model,
		cost_usd = excluded.cost_usd, created_at = excluded.created_at`,
		t.EventID, t.Text, t.Model, t.CostUSD, t.CreatedAt)
	return err
}
