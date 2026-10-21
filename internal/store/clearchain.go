package store

import (
	"context"
	"database/sql"
	"errors"
)

// A /clear keeps the process and starts a new session id (03-contracts.md §
// "/clear replaces a session"). The rows of one process's conversations are
// linked by parent_session and share its pid; a fork Caprock started is
// linked too but runs in a process of its own, so the pid is what tells the
// two apart.

// clearChainMax bounds a walk along the links: a cycle cannot be written
// (parent_session is set once, to an older session), but a bound costs
// nothing.
const clearChainMax = 64

// InheritOwned makes the session a /clear started in a process Caprock
// started Caprock's as well: owned, with the spawn's worktree, command,
// sign-in and chat mark. It is the same process, so typing into it is typing
// into what Caprock started (rule 7). Nothing changes when prev is not owned.
func InheritOwned(ctx context.Context, q Querier, id, prev string) error {
	if id == "" || prev == "" || id == prev {
		return nil
	}
	_, err := q.ExecContext(ctx, `
		UPDATE sessions SET
		  owned         = 1,
		  worktree      = COALESCE(NULLIF(worktree, ''), (SELECT worktree FROM sessions p WHERE p.session_id = ?)),
		  spawn_command = COALESCE(NULLIF(spawn_command, ''), (SELECT spawn_command FROM sessions p WHERE p.session_id = ?)),
		  subscription  = COALESCE(NULLIF(subscription, ''), (SELECT subscription FROM sessions p WHERE p.session_id = ?), ''),
		  chat          = MAX(chat, (SELECT chat FROM sessions p WHERE p.session_id = ?))
		WHERE session_id = ?
		  AND EXISTS (SELECT 1 FROM sessions p WHERE p.session_id = ? AND p.owned = 1)`,
		prev, prev, prev, prev, id, prev)
	return err
}

// ClearAncestors returns the sessions id continues in the same process, the
// nearest first: its parent while the parent ran on the same pid, then that
// one's, and so on. A fork's parent (another process) ends the walk.
func ClearAncestors(ctx context.Context, q Querier, id string) ([]string, error) {
	var out []string
	cur := id
	for i := 0; i < clearChainMax; i++ {
		var parent string
		var pid, ppid int
		err := q.QueryRowContext(ctx, `
			SELECT c.parent_session, COALESCE(c.pid, 0), COALESCE(p.pid, 0)
			FROM sessions c JOIN sessions p ON p.session_id = c.parent_session
			WHERE c.session_id = ?`, cur).Scan(&parent, &pid, &ppid)
		if errors.Is(err, sql.ErrNoRows) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		if pid <= 0 || pid != ppid {
			return out, nil
		}
		out = append(out, parent)
		cur = parent
	}
	return out, nil
}

// ClearSuccessor returns the newest session that continues id in the same
// process, following /clear after /clear, or "" when none does.
func ClearSuccessor(ctx context.Context, q Querier, id string) (string, error) {
	cur, found := id, ""
	for i := 0; i < clearChainMax; i++ {
		var next string
		err := q.QueryRowContext(ctx, `
			SELECT c.session_id FROM sessions c JOIN sessions p ON p.session_id = c.parent_session
			WHERE c.parent_session = ? AND c.pid > 0 AND c.pid = p.pid
			ORDER BY c.started_at DESC LIMIT 1`, cur).Scan(&next)
		if errors.Is(err, sql.ErrNoRows) {
			return found, nil
		}
		if err != nil {
			return "", err
		}
		found, cur = next, next
	}
	return found, nil
}
