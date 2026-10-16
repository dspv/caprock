package store

import (
	"context"
	"database/sql"
)

// Chats (ADR-071): a session Caprock started in its chats workspace to ask
// something rather than to work on a repository. The row is an ordinary
// session — events, turns, cost and all — with `chat = 1`, so everything that
// reads sessions keeps working, the Chats list reads `chat = 1`, and the
// project and terminal lists can leave chats out (migration 0059).

// ChatScope says which sessions a list holds with respect to chats.
type ChatScope int

const (
	// ChatsIncluded lists every session, chats among them (the default).
	ChatsIncluded ChatScope = iota
	// ChatsExcluded lists no chat: the work sessions only.
	ChatsExcluded
	// ChatsOnly lists the chats only, archived or not by Archived.
	ChatsOnly
)

// SessionQuery is what the session list is filtered by.
type SessionQuery struct {
	Active bool   // leave out ended sessions
	Search string // see sessionQueryFilter
	Chats  ChatScope
	// Archived, with ChatsOnly, lists the archived chats instead of the
	// others.
	Archived bool
}

// MarkChat records that a session is a chat. Idempotent.
func MarkChat(ctx context.Context, q Querier, id string) error {
	_, err := q.ExecContext(ctx, `UPDATE sessions SET chat = 1 WHERE session_id = ? AND chat = 0`, id)
	return err
}

// SetChatArchived archives a chat at `at` (unix ms), or brings it back when
// at is 0. sql.ErrNoRows when id is not a chat: a work session is not
// archived from the Chats list.
func SetChatArchived(ctx context.Context, q Querier, id string, at int64) error {
	res, err := q.ExecContext(ctx, `UPDATE sessions SET archived_at = ? WHERE session_id = ? AND chat = 1`, at, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// ChatCounts is how many chats there are: those the list shows, and those
// archived out of it.
type ChatCounts struct {
	Chats    int `json:"chats"`
	Archived int `json:"archived"`
}

// CountChats counts the chats, archived and not, off idx_sessions_chat.
func CountChats(ctx context.Context, q Querier) (ChatCounts, error) {
	var c ChatCounts
	err := q.QueryRowContext(ctx, `SELECT
		COALESCE(SUM(CASE WHEN archived_at = 0 THEN 1 ELSE 0 END), 0),
		COALESCE(SUM(CASE WHEN archived_at > 0 THEN 1 ELSE 0 END), 0)
		FROM sessions WHERE chat = 1`).Scan(&c.Chats, &c.Archived)
	return c, err
}
