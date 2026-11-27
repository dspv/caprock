package store

import (
	"context"
	"database/sql"
	"errors"
)

// The Telegram messages a computer holds for the computer that holds the bot
// (migration 0096, ADR-047 amended 2026-11-27): kept until the holder takes
// them, bounded so a holder gone for a week costs a few hundred rows, not a
// growing table.
const (
	// TelegramOutboxMax is how many messages wait at most; the oldest go
	// first past it.
	TelegramOutboxMax = 200
	// TelegramOutboxMaxAge is how long one waits at most, in milliseconds: a
	// day-old "waiting for approval" is no longer news.
	TelegramOutboxMaxAge = 24 * 60 * 60 * 1000
)

// TelegramQueued is one message waiting for the holder.
type TelegramQueued struct {
	ID        string
	CreatedAt int64
	Body      []byte
	Tries     int
	LastError string
}

// PutTelegramOutbox adds a message and trims the table to its bounds: rows
// older than TelegramOutboxMaxAge, then the oldest past TelegramOutboxMax.
// It returns how many were dropped, so the caller can say so.
func PutTelegramOutbox(ctx context.Context, q Querier, id string, now int64, body []byte) (int, error) {
	if _, err := q.ExecContext(ctx, `INSERT OR REPLACE INTO telegram_outbox (id, created_at, body) VALUES (?, ?, ?)`, id, now, string(body)); err != nil {
		return 0, err
	}
	return TrimTelegramOutbox(ctx, q, now)
}

// TrimTelegramOutbox drops what is past the bounds and says how many went.
func TrimTelegramOutbox(ctx context.Context, q Querier, now int64) (int, error) {
	dropped := 0
	res, err := q.ExecContext(ctx, `DELETE FROM telegram_outbox WHERE created_at < ?`, now-TelegramOutboxMaxAge)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	dropped += int(n)
	res, err = q.ExecContext(ctx, `DELETE FROM telegram_outbox WHERE id IN (
		SELECT id FROM telegram_outbox ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)`, TelegramOutboxMax)
	if err != nil {
		return dropped, err
	}
	n, _ = res.RowsAffected()
	return dropped + int(n), nil
}

// NextTelegramOutbox is the oldest message waiting; ok false when none is.
func NextTelegramOutbox(ctx context.Context, q Querier) (TelegramQueued, bool, error) {
	var m TelegramQueued
	var body string
	err := q.QueryRowContext(ctx, `SELECT id, created_at, body, tries, last_error FROM telegram_outbox
		ORDER BY created_at, id LIMIT 1`).Scan(&m.ID, &m.CreatedAt, &body, &m.Tries, &m.LastError)
	if errors.Is(err, sql.ErrNoRows) {
		return m, false, nil
	}
	if err != nil {
		return m, false, err
	}
	m.Body = []byte(body)
	return m, true, nil
}

// FailTelegramOutbox counts one failed post of a message and keeps its words.
func FailTelegramOutbox(ctx context.Context, q Querier, id, why string) error {
	_, err := q.ExecContext(ctx, `UPDATE telegram_outbox SET tries = tries + 1, last_error = ? WHERE id = ?`, why, id)
	return err
}

// DeleteTelegramOutbox removes a message the holder took, or one it refused
// for good.
func DeleteTelegramOutbox(ctx context.Context, q Querier, id string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM telegram_outbox WHERE id = ?`, id)
	return err
}

// CountTelegramOutbox is how many messages wait.
func CountTelegramOutbox(ctx context.Context, q Querier) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM telegram_outbox`).Scan(&n)
	return n, err
}

// ClearTelegramOutbox drops every waiting message: the owner stopped sending
// through the holder.
func ClearTelegramOutbox(ctx context.Context, q Querier) error {
	_, err := q.ExecContext(ctx, `DELETE FROM telegram_outbox`)
	return err
}
