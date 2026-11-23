package store

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"time"
)

// SubagentQuietMax is how long a subagent may be silent, with no call in
// progress, while its parent sits at its prompt, before it is read as
// stopped. A background subagent working logs a hook event per call; one
// silent this long behind an idle parent is not working, whatever it never
// said.
const SubagentQuietMax = 15 * time.Minute

// Why a subagent with no SubagentStop is read as stopped (SubagentActivity.Lost).
const (
	// SubagentLostRestart: the parent's process started again (a resume)
	// after the subagent's newest event; a subagent runs inside its parent's
	// process, so it went with it, and its SubagentStop never fired
	// (owner, 2026-11-23: one subagent read "working" in the Now tree while
	// none of the lead's agents ran).
	SubagentLostRestart = "restart"
	// SubagentLostEnded: the session itself ended.
	SubagentLostEnded = "ended"
	// SubagentLostQuiet: silent past SubagentQuietMax, no call in progress,
	// while the parent sits at its prompt.
	SubagentLostQuiet = "quiet"
)

// SubagentBounds is when a session's subagents that never sent their
// SubagentStop are read as stopped.
type SubagentBounds struct {
	// RestartAt is the session's newest main-thread SessionStart that did
	// not follow a compaction (a resume of a process that started again), or
	// past every event when the session ended: a subagent silent since before
	// it is not running. 0 with none in the window.
	RestartAt int64
	// Ended says RestartAt is the session's end.
	Ended bool
	// QuietBefore is now − SubagentQuietMax while the parent sits at its
	// prompt (its newest main-thread hook among a prompt, a call and a Stop
	// is the Stop); 0 while it is in a turn.
	QuietBefore int64
}

// Lost says why a subagent whose newest event is `last` and that sent no
// SubagentStop since is read as stopped, or "" while it counts as working.
// pending is its newest event being a call with no result yet: a long
// command is not silence.
func (b SubagentBounds) Lost(last int64, pending bool) string {
	switch {
	case b.Ended:
		return SubagentLostEnded
	case last < b.RestartAt:
		return SubagentLostRestart
	case b.QuietBefore > 0 && last < b.QuietBefore && !pending:
		return SubagentLostQuiet
	}
	return ""
}

// StoppedAt is when a lost subagent is said to have stopped: the restart
// that took it, else its newest event.
func (b SubagentBounds) StoppedAt(lost string, last int64) int64 {
	if lost == SubagentLostRestart {
		return b.RestartAt
	}
	return last
}

// SubagentBoundsOf reads a session's bounds: its status, its newest
// SessionStart that was not a compaction's since `since`, and whether its
// main thread sits at its prompt. Hook events only: a transcript line
// arrives late and says nothing of a turn's end.
func SubagentBoundsOf(ctx context.Context, q Querier, sessionID string, since, now int64) (SubagentBounds, error) {
	var b SubagentBounds
	var status sql.NullString
	err := q.QueryRowContext(ctx, `SELECT status FROM sessions WHERE session_id = ?`, sessionID).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return b, nil
	}
	if err != nil {
		return b, err
	}
	if status.String == "ended" {
		return SubagentBounds{RestartAt: math.MaxInt64, Ended: true}, nil
	}
	if err := q.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(e.ts), 0) FROM events e
		 WHERE e.sid = (SELECT sid FROM sessions WHERE session_id = ?) AND e.ts >= ?
		   AND +e.kind = 'agent.spawn' AND e.source = 'hook' AND COALESCE(e.agent_id, '') = ''
		   AND COALESCE(json_extract(`+ZPayloadE+`, '$.source'), '') <> 'compact'`, sessionID, since).Scan(&b.RestartAt); err != nil {
		return b, err
	}
	// Claude Code's SessionStart at a fresh start comes before anything the
	// session does, so it never stops one of its subagents; a resume's does.
	var kind string
	err = q.QueryRowContext(ctx, `
		SELECT e.kind FROM events e
		 WHERE e.sid = (SELECT sid FROM sessions WHERE session_id = ?) AND e.ts >= ?
		   AND +e.kind IN ('turn.user', 'tool.pre', 'agent.stop') AND e.source = 'hook' AND COALESCE(e.agent_id, '') = ''
		 ORDER BY e.ts DESC, e.id DESC LIMIT 1`, sessionID, since).Scan(&kind)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return b, err
	}
	if kind == "agent.stop" {
		b.QuietBefore = now - SubagentQuietMax.Milliseconds()
	}
	return b, nil
}
