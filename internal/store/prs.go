package store

import (
	"context"
	"database/sql"
	"errors"
)

// SessionPR is a pull request a session opened or merged (migration 0031).
type SessionPR struct {
	SessionID string `json:"session_id"`
	URL       string `json:"url"`
	Number    int    `json:"number"`
	Title     string `json:"title,omitempty"`
	OpenedAt  int64  `json:"opened_at,omitempty"`
	// MergedAt is set only when a merge was recorded; a PR without it is not
	// known to be merged, which is not the same as known to be open.
	MergedAt int64 `json:"merged_at,omitempty"`
	ClosedAt int64 `json:"closed_at,omitempty"`
	LastAt   int64 `json:"last_at"`
}

// PRAction is one recorded `gh pr` command: what it did to which PR, and when.
type PRAction struct {
	SessionID string
	URL       string // empty for an action recorded without one ("closed")
	Number    int
	Title     string
	Action    string // created | merged | closed | edited | commented
	Ts        int64
}

// RecordPR folds one `gh pr` command into session_prs. Only created, merged
// and closed are recorded; an edit or a comment is not a PR the session
// opened. An action that came without a URL is matched by number within the
// session, and dropped when the session has no such PR. Idempotent: replaying
// the same action leaves the row as it was.
func RecordPR(ctx context.Context, q Querier, a PRAction) error {
	if a.SessionID == "" || a.Number <= 0 {
		return nil
	}
	var opened, merged, closed int64
	switch a.Action {
	case "created":
		opened = a.Ts
	case "merged":
		merged = a.Ts
	case "closed":
		closed = a.Ts
	default:
		return nil
	}
	if a.URL == "" {
		err := q.QueryRowContext(ctx, `SELECT url FROM session_prs WHERE session_id = ? AND number = ? ORDER BY last_at DESC LIMIT 1`,
			a.SessionID, a.Number).Scan(&a.URL)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
	}
	// The earliest "created" wins; a merge or close keeps its latest time.
	_, err := q.ExecContext(ctx, `
		INSERT INTO session_prs(session_id, url, number, title, opened_at, merged_at, closed_at, last_at)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id, url) DO UPDATE SET
		  title     = CASE WHEN excluded.title != '' AND session_prs.title = '' THEN excluded.title ELSE session_prs.title END,
		  opened_at = CASE WHEN excluded.opened_at > 0 AND (session_prs.opened_at = 0 OR excluded.opened_at < session_prs.opened_at)
		                   THEN excluded.opened_at ELSE session_prs.opened_at END,
		  merged_at = MAX(session_prs.merged_at, excluded.merged_at),
		  closed_at = MAX(session_prs.closed_at, excluded.closed_at),
		  last_at   = MAX(session_prs.last_at, excluded.last_at)`,
		a.SessionID, a.URL, a.Number, a.Title, opened, merged, closed, a.Ts)
	return err
}

// SessionPRs lists a session's pull requests, the latest first.
func SessionPRs(ctx context.Context, q Querier, sessionID string) ([]SessionPR, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT session_id, url, number, title, opened_at, merged_at, closed_at, last_at
		FROM session_prs WHERE session_id = ? ORDER BY last_at DESC`, sessionID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	return scanPRs(rows)
}

// LatestPRByDir is the most recent pull request of any session whose
// repository (or, outside one, directory) is each of the given keys — the
// directory a Projects row is keyed on.
func LatestPRByDir(ctx context.Context, q Querier) (map[string]SessionPR, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT COALESCE(NULLIF(se.repo_root,''), se.cwd) AS dir,
		       p.session_id, p.url, p.number, p.title, p.opened_at, p.merged_at, p.closed_at, p.last_at
		FROM session_prs p JOIN sessions se ON se.session_id = p.session_id
		ORDER BY p.last_at DESC`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]SessionPR{}
	for rows.Next() {
		var dir string
		var p SessionPR
		if err := rows.Scan(&dir, &p.SessionID, &p.URL, &p.Number, &p.Title, &p.OpenedAt, &p.MergedAt, &p.ClosedAt, &p.LastAt); err != nil {
			return nil, err
		}
		if _, seen := out[dir]; !seen && dir != "" {
			out[dir] = p
		}
	}
	return out, rows.Err()
}

func scanPRs(rows *sql.Rows) ([]SessionPR, error) {
	var out []SessionPR
	for rows.Next() {
		var p SessionPR
		if err := rows.Scan(&p.SessionID, &p.URL, &p.Number, &p.Title, &p.OpenedAt, &p.MergedAt, &p.ClosedAt, &p.LastAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// PRToolPosts streams the Bash PostToolUse rows that recorded a `gh pr`
// operation or ran `gh pr create`, for the one-off history backfill. A LIKE on
// the payload: this runs once, after the port opens.
func PRToolPosts(ctx context.Context, q Querier, fn func(sessionID string, ts int64, payload []byte) error) error {
	rows, err := q.QueryContext(ctx, `
		SELECT session_id, ts, payload FROM events
		WHERE kind = 'tool.post' AND tool = 'Bash'
		  AND (payload LIKE '%"gitOperation":{"pr"%' OR payload LIKE '%gh pr create%')
		ORDER BY id`)
	if err != nil {
		return err
	}
	type row struct {
		sid     string
		ts      int64
		payload []byte
	}
	var all []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.sid, &r.ts, &r.payload); err != nil {
			_ = rows.Close()
			return err
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	_ = rows.Close()
	for _, r := range all {
		if err := fn(r.sid, r.ts, r.payload); err != nil {
			return err
		}
	}
	return nil
}
