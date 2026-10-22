package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"unicode/utf8"
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
	// Project, Title and Agent are the session's, joined in when listed;
	// Title is its own name or, without one, its first stored prompt.
	Project string `json:"project,omitempty"`
	Title   string `json:"title,omitempty"`
	Agent   string `json:"agent,omitempty"`
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
	SessionID string
	Project   string
	// Cwd and RepoRoot are where the session ran and the repository root
	// found there at ingest ("" outside one), for the extraction to decide
	// which project its memories belong to.
	Cwd, RepoRoot string
	LastEventAt   int64
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
		SELECT session_id, project, cwd, repo_root, last_event_at, cursor, max_id FROM (
			SELECT s.session_id, COALESCE(s.project, '') AS project, COALESCE(s.cwd, '') AS cwd, COALESCE(s.repo_root, '') AS repo_root,
			       COALESCE(s.last_event_at, 0) AS last_event_at,
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
		if err := rows.Scan(&c.SessionID, &c.Project, &c.Cwd, &c.RepoRoot, &c.LastEventAt, &c.Cursor, &c.MaxEventID); err != nil {
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
// event id, oldest first by event id, at most limit of them (the oldest kept
// when there are more). Empty passages are left out before the limit, so a
// full page means more may follow: a read that sends only part of them moves
// its cursor to the last one it sent, and the next read goes on from there.
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
		) WHERE text != '' ORDER BY id LIMIT ?`, sessionID, after, limit)
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
		       r.cost_usd, r.nodes, r.error, r.started_at, r.finished_at, COALESCE(s.project, ''),
		       COALESCE(NULLIF(s.title, ''), s.prompt, ''), COALESCE(s.agent, '')
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
			&r.CostUSD, &r.Nodes, &r.Error, &r.StartedAt, &r.FinishedAt, &r.Project, &r.Title, &r.Agent); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// BrainSessionInfo is what a screen names a session by while it is read:
// its own title (or first stored prompt), agent and the time of its last
// event. A session that is not there gives empty values, not an error.
func BrainSessionInfo(ctx context.Context, q Querier, sessionID string) (title, agent string, lastEventAt int64, err error) {
	err = q.QueryRowContext(ctx, `SELECT COALESCE(NULLIF(title, ''), prompt, ''), COALESCE(agent, ''), COALESCE(last_event_at, 0)
		FROM sessions WHERE session_id = ?`, sessionID).Scan(&title, &agent, &lastEventAt)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return title, agent, lastEventAt, err
}

// BrainReadSession is a session active since a moment that the extraction
// has read at least once without failing, with the memories its reads kept.
type BrainReadSession struct {
	SessionID string
	Project   string
	Memories  int
}

// BrainReadSessions lists the sessions active since `since` with a read
// that did not fail: the "read" side of a build's progress.
func BrainReadSessions(ctx context.Context, q Querier, since int64) ([]BrainReadSession, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT s.session_id, COALESCE(s.project, ''), COALESCE(SUM(r.nodes), 0)
		FROM sessions s JOIN brain_runs r ON r.session_id = s.session_id AND r.status != 'failed'
		WHERE COALESCE(s.last_event_at, 0) >= ?
		GROUP BY s.session_id`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BrainReadSession{}
	for rows.Next() {
		var r BrainReadSession
		if err := rows.Scan(&r.SessionID, &r.Project, &r.Memories); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// BrainProjectMemories returns a project's pinned memories, then its newest,
// for a new session's handoff. An imported note is among them only when
// every vault it came from lets its notes reach agents (ADR-079).
func BrainProjectMemories(ctx context.Context, q Querier, project string, limit int) ([]BrainNode, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+brainCols+` FROM brain_nodes n
		WHERE n.project = ? AND n.kind NOT IN ('topic','person','project') AND `+brainAgentsMayRead+`
		ORDER BY n.pinned DESC, n.created_at DESC LIMIT ?`, project, limit)
	if err != nil {
		return nil, err
	}
	return scanBrainRows(rows)
}

// BrainHandoffMax and BrainHandoffRunes bound what Second Brain adds to a
// served handoff (ADR-063): the repository's pinned memories first, then the
// newest, titles with a clipped summary, in a budget of their own so the
// passage before them is never cut to make room. BrainHandoffSummary is how
// far each summary is clipped.
const (
	BrainHandoffMax     = 5
	BrainHandoffRunes   = 700
	BrainHandoffSummary = 160
)

// BrainHandoff is what a new session in a repository is handed from Second
// Brain: the memories that fit, in order, and the line each is given as. The
// SessionStart handoff appends the lines; GET /v1/brain/handoff shows the
// memories, so the screen names exactly what a session gets.
func BrainHandoff(ctx context.Context, q Querier, project string) ([]BrainNode, []string, error) {
	mems, err := BrainProjectMemories(ctx, q, project, BrainHandoffMax)
	if err != nil || len(mems) == 0 {
		return nil, nil, err
	}
	var picked []BrainNode
	var lines []string
	left := BrainHandoffRunes
	for _, m := range mems {
		line := "\n- " + m.Kind + ": " + m.Title
		if m.Summary != "" {
			line += " — " + ClipSentence(m.Summary, BrainHandoffSummary)
		}
		n := utf8.RuneCountInString(line)
		if n > left {
			break
		}
		left -= n
		picked = append(picked, m)
		lines = append(lines, line)
	}
	return picked, lines, nil
}

// ClipSentence cuts to n runes at a sentence boundary where one is near the
// end, so a passage does not stop mid-word (relay.Clip is this).
func ClipSentence(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	cut := string([]rune(s)[:n])
	if i := strings.LastIndexAny(cut, ".!?\n"); i > len(cut)*3/4 {
		return strings.TrimSpace(cut[:i+1])
	}
	return strings.TrimSpace(cut) + "…"
}

// BrainCostSince is what the extraction's reads cost since a moment, in US
// dollars, as claude reported each (its `total_cost_usd`, at API list price).
func BrainCostSince(ctx context.Context, q Querier, since int64) (float64, error) {
	var n float64
	err := q.QueryRowContext(ctx, `SELECT COALESCE(SUM(cost_usd), 0) FROM brain_runs WHERE finished_at >= ?`, since).Scan(&n)
	return n, err
}

// BrainLastRead is when the newest read that kept something finished, unix
// ms; 0 before the first.
func BrainLastRead(ctx context.Context, q Querier) (int64, error) {
	var n int64
	err := q.QueryRowContext(ctx, `SELECT COALESCE(MAX(finished_at), 0) FROM brain_runs WHERE status = 'ok'`).Scan(&n)
	return n, err
}

// CountBrainMemoriesSince counts the memories (not entities, not imported
// notes) added since a moment, by hand or by a read.
func CountBrainMemoriesSince(ctx context.Context, q Querier, since int64) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM brain_nodes
		WHERE kind NOT IN ('topic','person','project','note') AND created_at >= ?`, since).Scan(&n)
	return n, err
}

// BrainGraphCounts is how many topics the graph holds and how many links
// join its nodes.
func BrainGraphCounts(ctx context.Context, q Querier) (topics, links int, err error) {
	err = q.QueryRowContext(ctx, `SELECT
		(SELECT COUNT(*) FROM brain_nodes WHERE kind = 'topic'),
		(SELECT COUNT(*) FROM brain_edges)`).Scan(&topics, &links)
	return topics, links, err
}

// SetHandoffBrain records how many Second Brain memories a new session was
// handed with its handoff (migration 0058).
func SetHandoffBrain(ctx context.Context, q Querier, sessionID string, n int) error {
	_, err := q.ExecContext(ctx, `UPDATE sessions SET handoff_brain = ? WHERE session_id = ?`, n, sessionID)
	return err
}

// BrainHandedSince counts the sessions started since a moment that were
// handed Second Brain memories, and how many memories that was in all.
func BrainHandedSince(ctx context.Context, q Querier, since int64) (sessions, memories int, err error) {
	err = q.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(handoff_brain), 0) FROM sessions
		WHERE handoff_brain > 0 AND started_at >= ?`, since).Scan(&sessions, &memories)
	return sessions, memories, err
}

// BrainAgentRead is one agent whose sessions the extraction read: how many
// distinct sessions, and when the newest of those reads finished (unix ms).
type BrainAgentRead struct {
	Agent    string `json:"agent"`
	Sessions int    `json:"sessions"`
	LastAt   int64  `json:"last_at"`
}

// BrainAgentsSince lists the agents whose sessions a read went through
// (status ok) since a moment, most sessions first, then the newest read. A
// session with no agent recorded counts as claude, the default agent.
func BrainAgentsSince(ctx context.Context, q Querier, since int64) ([]BrainAgentRead, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT COALESCE(NULLIF(s.agent, ''), 'claude') AS a, COUNT(DISTINCT r.session_id), MAX(r.finished_at)
		FROM brain_runs r LEFT JOIN sessions s ON s.session_id = r.session_id
		WHERE r.status = 'ok' AND r.finished_at >= ?
		GROUP BY a ORDER BY 2 DESC, 3 DESC, a`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BrainAgentRead{}
	for rows.Next() {
		var a BrainAgentRead
		if err := rows.Scan(&a.Agent, &a.Sessions, &a.LastAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
