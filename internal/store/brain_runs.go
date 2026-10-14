package store

import (
	"context"
)

// Second Brain's automatic extraction reads (migration 0055, ADR-063): which
// sessions have prose it has not read, what that prose is, and the record of
// each read.

// Brain run statuses, as the CHECK constraint spells them.
const (
	BrainRunOK      = "ok"
	BrainRunFailed  = "failed"
	BrainRunSkipped = "skipped"
)

// BrainRun is one read of one session by the automatic extraction.
type BrainRun struct {
	ID             int64   `json:"id"`
	SessionID      string  `json:"session_id"`
	FromEventID    int64   `json:"from_event_id"`
	ThroughEventID int64   `json:"through_event_id"`
	Status         string  `json:"status"`
	Model          string  `json:"model,omitempty"`
	TokensIn       int64   `json:"tokens_in"`
	TokensOut      int64   `json:"tokens_out"`
	CostUSD        float64 `json:"cost_usd"`
	Nodes          int     `json:"nodes"`
	Error          string  `json:"error,omitempty"`
	StartedAt      int64   `json:"started_at"`
	FinishedAt     int64   `json:"finished_at"`
	// Project is the session's, joined in when listed.
	Project string `json:"project,omitempty"`
}

// InsertBrainRun records a read and returns its id.
func InsertBrainRun(ctx context.Context, q Querier, r BrainRun) (int64, error) {
	res, err := q.ExecContext(ctx, `INSERT INTO brain_runs
		(session_id, from_event_id, through_event_id, status, model, tokens_in, tokens_out, cost_usd, nodes, error, started_at, finished_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.SessionID, r.FromEventID, r.ThroughEventID, r.Status, r.Model, r.TokensIn, r.TokensOut, r.CostUSD, r.Nodes, r.Error, r.StartedAt, r.FinishedAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// SetBrainRunNodes records how many nodes a read made, once they are stored.
func SetBrainRunNodes(ctx context.Context, q Querier, id int64, nodes int) error {
	_, err := q.ExecContext(ctx, `UPDATE brain_runs SET nodes = ? WHERE id = ?`, nodes, id)
	return err
}

// brainCursorSQL is how far the extraction has read a session: the newest
// event a read that did not fail went through.
const brainCursorSQL = `COALESCE((SELECT MAX(r.through_event_id) FROM brain_runs r WHERE r.session_id = s.session_id AND r.status != 'failed'), 0)`

// BrainCandidate is a session with events the extraction has not read.
type BrainCandidate struct {
	SessionID   string
	Project     string
	LastEventAt int64
	// Cursor is the newest event already read; MaxEventID the session's newest.
	Cursor     int64
	MaxEventID int64
}

// BrainCandidates lists sessions active since `since` and quiet since
// `idleBefore` (or ended), with events past their cursor, newest first.
func BrainCandidates(ctx context.Context, q Querier, since, idleBefore int64, limit int) ([]BrainCandidate, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := q.QueryContext(ctx, `
		SELECT session_id, project, last_event_at, cursor, max_id FROM (
			SELECT s.session_id, COALESCE(s.project, '') AS project, COALESCE(s.last_event_at, 0) AS last_event_at,
			       `+brainCursorSQL+` AS cursor,
			       COALESCE((SELECT MAX(e.id) FROM events e WHERE e.session_id = s.session_id), 0) AS max_id
			FROM sessions s
			WHERE COALESCE(s.last_event_at, 0) >= ? AND (s.status = 'ended' OR COALESCE(s.last_event_at, 0) < ?)
		) WHERE max_id > cursor
		ORDER BY last_event_at DESC LIMIT ?`, since, idleBefore, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BrainCandidate{}
	for rows.Next() {
		var c BrainCandidate
		if err := rows.Scan(&c.SessionID, &c.Project, &c.LastEventAt, &c.Cursor, &c.MaxEventID); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// BrainFailures is how many reads of a session have failed since its last
// one that did not, and when the latest failed (unix ms).
func BrainFailures(ctx context.Context, q Querier, sessionID string) (int, int64, error) {
	var n int
	var last int64
	err := q.QueryRowContext(ctx, `
		SELECT COUNT(*), COALESCE(MAX(finished_at), 0) FROM brain_runs
		WHERE session_id = ? AND status = 'failed'
		  AND id > COALESCE((SELECT MAX(id) FROM brain_runs WHERE session_id = ? AND status != 'failed'), 0)`,
		sessionID, sessionID).Scan(&n, &last)
	return n, last, err
}

// BrainPassage is one prompt or one answer in a session's main thread.
type BrainPassage struct {
	EventID int64
	Ts      int64
	// User is true for the user's prompt, false for the agent's prose.
	User bool
	Text string
}

// BrainPassages returns a session's main-thread prompts and prose after an
// event id, oldest first, at most limit of them (the newest kept when cut).
func BrainPassages(ctx context.Context, q Querier, sessionID string, after int64, limit int) ([]BrainPassage, error) {
	if limit <= 0 {
		limit = 400
	}
	rows, err := q.QueryContext(ctx, `
		SELECT id, ts, user, text FROM (
			SELECT e.id, e.ts, e.kind = 'turn.user' AS user,
			       CASE WHEN e.kind = 'turn.user'
			            THEN COALESCE(json_extract(e.payload, '$.prompt'), json_extract(e.payload, '$.text'), '')
			            ELSE COALESCE(json_extract(e.payload, '$.text'), '') END AS text
			FROM events e
			WHERE e.session_id = ? AND e.id > ? AND +e.kind IN ('turn.user', 'turn.assistant')
			  AND e.internal = 0 AND `+MainThreadWhere+`
			ORDER BY e.id DESC LIMIT ?
		) WHERE text != '' ORDER BY ts, id`, sessionID, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BrainPassage{}
	for rows.Next() {
		var p BrainPassage
		if err := rows.Scan(&p.EventID, &p.Ts, &p.User, &p.Text); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// BrainTokensSince is what the extraction's reads have spent since a moment,
// input and output together.
func BrainTokensSince(ctx context.Context, q Querier, since int64) (int64, error) {
	var n int64
	err := q.QueryRowContext(ctx, `SELECT COALESCE(SUM(tokens_in + tokens_out), 0) FROM brain_runs WHERE finished_at >= ?`, since).Scan(&n)
	return n, err
}

// LastBrainRuns returns the newest reads that did something (not skipped),
// newest first.
func LastBrainRuns(ctx context.Context, q Querier, limit int) ([]BrainRun, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT r.id, r.session_id, r.from_event_id, r.through_event_id, r.status, r.model, r.tokens_in, r.tokens_out,
		       r.cost_usd, r.nodes, r.error, r.started_at, r.finished_at, COALESCE(s.project, '')
		FROM brain_runs r LEFT JOIN sessions s ON s.session_id = r.session_id
		WHERE r.status != 'skipped' ORDER BY r.id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BrainRun{}
	for rows.Next() {
		var r BrainRun
		if err := rows.Scan(&r.ID, &r.SessionID, &r.FromEventID, &r.ThroughEventID, &r.Status, &r.Model, &r.TokensIn, &r.TokensOut,
			&r.CostUSD, &r.Nodes, &r.Error, &r.StartedAt, &r.FinishedAt, &r.Project); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// BrainProjectMemories returns a project's pinned memories, then its newest,
// for a new session's handoff.
func BrainProjectMemories(ctx context.Context, q Querier, project string, limit int) ([]BrainNode, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+brainCols+` FROM brain_nodes n
		WHERE n.project = ? AND n.kind NOT IN ('topic','person','project')
		ORDER BY n.pinned DESC, n.created_at DESC LIMIT ?`, project, limit)
	if err != nil {
		return nil, err
	}
	return scanBrainRows(rows)
}
