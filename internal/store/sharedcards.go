package store

import (
	"context"
	"database/sql"
	"errors"
)

// SharedCard is a share card this machine uploaded to caprock.dev
// (migration 0074, ADR-086). DeleteToken takes it down again; it never
// leaves the daemon in a response.
type SharedCard struct {
	ID          string
	URL         string
	Image       string
	DeleteToken string
	Bytes       int64
	At          int64
}

// RecordSharedCard keeps an uploaded card; the same id again replaces it.
func RecordSharedCard(ctx context.Context, q Querier, c SharedCard) error {
	_, err := q.ExecContext(ctx, `INSERT INTO shared_cards(id, url, image, delete_token, bytes, at) VALUES(?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET url = excluded.url, image = excluded.image, delete_token = excluded.delete_token, bytes = excluded.bytes, at = excluded.at`,
		c.ID, c.URL, c.Image, c.DeleteToken, c.Bytes, c.At)
	return err
}

// SharedCards are the uploaded cards, newest first.
func SharedCards(ctx context.Context, q Querier) ([]SharedCard, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, url, image, delete_token, bytes, at FROM shared_cards ORDER BY at DESC`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []SharedCard
	for rows.Next() {
		var c SharedCard
		if err := rows.Scan(&c.ID, &c.URL, &c.Image, &c.DeleteToken, &c.Bytes, &c.At); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// GetSharedCard is one uploaded card; ok is false when none has that id.
func GetSharedCard(ctx context.Context, q Querier, id string) (SharedCard, bool, error) {
	var c SharedCard
	err := q.QueryRowContext(ctx, `SELECT id, url, image, delete_token, bytes, at FROM shared_cards WHERE id = ?`, id).
		Scan(&c.ID, &c.URL, &c.Image, &c.DeleteToken, &c.Bytes, &c.At)
	if errors.Is(err, sql.ErrNoRows) {
		return SharedCard{}, false, nil
	}
	if err != nil {
		return SharedCard{}, false, err
	}
	return c, true, nil
}

// ForgetSharedCard drops a card's row, once the site has deleted the picture.
func ForgetSharedCard(ctx context.Context, q Querier, id string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM shared_cards WHERE id = ?`, id)
	return err
}
