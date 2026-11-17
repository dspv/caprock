package store

import "context"

// SessionBranch is a branch a session pushed (migration 0084).
type SessionBranch struct {
	SessionID string `json:"session_id"`
	Branch    string `json:"branch"`
	PushedAt  int64  `json:"pushed_at"` // unix ms of the latest push
}

// RecordPush folds one `git push` into session_branches: a later push of the
// same branch moves pushed_at, an earlier one (a replay, the backfill) never
// moves it back.
func RecordPush(ctx context.Context, q Querier, sessionID, branch string, ts int64) error {
	if sessionID == "" || branch == "" {
		return nil
	}
	_, err := q.ExecContext(ctx, `
		INSERT INTO session_branches(session_id, branch, pushed_at) VALUES(?, ?, ?)
		ON CONFLICT(session_id, branch) DO UPDATE SET pushed_at = MAX(session_branches.pushed_at, excluded.pushed_at)`,
		sessionID, branch, ts)
	return err
}

// SessionBranches lists the branches a session pushed, the latest push first.
func SessionBranches(ctx context.Context, q Querier, sessionID string) ([]SessionBranch, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT session_id, branch, pushed_at FROM session_branches
		WHERE session_id = ? ORDER BY pushed_at DESC, branch`, sessionID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []SessionBranch
	for rows.Next() {
		var b SessionBranch
		if err := rows.Scan(&b.SessionID, &b.Branch, &b.PushedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// PushToolPosts streams the Bash PostToolUse rows that recorded a `git push`
// (tool_response.gitOperation.push), for the one-off history backfill. A LIKE
// on the payload, as PRToolPosts: this runs once, after the port opens. The
// pattern is loose ("push" need not be gitOperation's first key);
// gitremote.PushFromToolPost decides.
func PushToolPosts(ctx context.Context, q Querier, fn func(sessionID string, ts int64, payload []byte) error) error {
	rows, err := q.QueryContext(ctx, `
		SELECT sid_, ts, p FROM (
		  SELECT id, (SELECT session_id FROM sessions WHERE sessions.sid = events.sid) AS sid_, ts, `+ZPayload+` AS p FROM events
		  WHERE kind = 'tool.post' AND tool = 'Bash')
		WHERE p LIKE '%"gitOperation":%' AND p LIKE '%"push":{%'
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
