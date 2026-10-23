package store

import (
	"context"
	"database/sql"
	"errors"
	"math"
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

// Reasons a read is recorded as skipped before anything is sent, in
// BrainRun.Error. A reason that names its cause carries it after a colon
// ("excluded: /Users/u/dev/ops"); the prefixes are what a screen reads.
const (
	// BrainSkipAutomation marks a session started with `automation: true`
	// (POST /v1/agents): a scheduled job's run, which Second Brain never
	// reads. Written at the spawn, before the session's first event, as the
	// extraction's own record that it was told not to read this session;
	// BrainCandidates leaves such a session out. It is not a column on the
	// session: the extraction is the only reader of the mark.
	BrainSkipAutomation = "automation"
	// BrainSkipExcluded is the prefix of the reason for a session in a
	// folder the user excluded (Settings → Second Brain); the folder follows.
	BrainSkipExcluded = "excluded"
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
	// GapID is the catch-up gap a read went through (brain_gaps), 0 for a
	// regular read. Held marks a read that left a short, still-open tail
	// unread so it is read with what comes next (migration 0068).
	GapID int64 `json:"gap_id,omitempty"`
	Held  bool  `json:"-"`
	// Project, Title and Agent are the session's, joined in when listed;
	// Title is its own name or, without one, its first stored prompt.
	Project string `json:"project,omitempty"`
	Title   string `json:"title,omitempty"`
	Agent   string `json:"agent,omitempty"`
}

// InsertBrainRun records a read and returns its id.
func InsertBrainRun(ctx context.Context, q Querier, r BrainRun) (int64, error) {
	res, err := q.ExecContext(ctx, `INSERT INTO brain_runs
		(session_id, from_event_id, through_event_id, status, model, tokens_in, tokens_out, cost_usd, nodes, error, started_at, finished_at, gap_id, held)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.SessionID, r.FromEventID, r.ThroughEventID, r.Status, r.Model, r.TokensIn, r.TokensOut, r.CostUSD, r.Nodes, r.Error, r.StartedAt, r.FinishedAt,
		nullID(r.GapID), r.Held)
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

// MarkBrainAutomation records, at a session's spawn, that Second Brain is
// never to read it (BrainSkipAutomation): a skipped run with no span. A
// second mark on the same session is not written twice.
func MarkBrainAutomation(ctx context.Context, q Querier, sessionID string, now int64) error {
	_, err := q.ExecContext(ctx, `INSERT INTO brain_runs (session_id, status, error, started_at, finished_at)
		SELECT ?, 'skipped', ?, ?, ? WHERE NOT EXISTS (`+brainAutomationSQL+`)`,
		sessionID, BrainSkipAutomation, now, now, sessionID)
	return err
}

// brainAutomationSQL is the automation mark of the session whose id is the
// bound argument.
const brainAutomationSQL = `SELECT 1 FROM brain_runs a WHERE a.session_id = ? AND a.status = 'skipped' AND a.error = '` + BrainSkipAutomation + `'`

// BrainAutomation reports whether a session carries the automation mark.
func BrainAutomation(ctx context.Context, q Querier, sessionID string) (bool, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM (`+brainAutomationSQL+`)`, sessionID).Scan(&n)
	return n > 0, err
}

// BrainAutomationSince counts the sessions marked as automation since a
// moment (by when the mark was written, which is the spawn).
func BrainAutomationSince(ctx context.Context, q Querier, since int64) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(DISTINCT session_id) FROM brain_runs
		WHERE status = 'skipped' AND error = ? AND finished_at >= ?`, BrainSkipAutomation, since).Scan(&n)
	return n, err
}

// brainCursorSQL is how far the extraction has read a session: the newest
// event a regular read that did not fail went through. A catch-up read
// (gap_id) reads behind the cursor and a held read leaves it where it was.
const brainCursorSQL = `COALESCE((SELECT MAX(r.through_event_id) FROM brain_runs r WHERE r.session_id = s.session_id AND r.status != 'failed' AND r.gap_id IS NULL AND r.held = 0), 0)`

// brainHeldSQL is the session's newest event when a read last held its
// short tail: until the session has newer events, or ends, it is not read.
const brainHeldSQL = `COALESCE((SELECT MAX(r.through_event_id) FROM brain_runs r WHERE r.session_id = s.session_id AND r.held = 1), 0)`

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
	// Ended is set when the session has ended: a short tail can no longer
	// wait for more and is marked read.
	Ended bool
}

// BrainCandidates lists sessions active since `since` and quiet since
// `idleBefore` (or ended), with events past their cursor, newest first. A
// session whose short tail was held is left out until it has newer events
// or ends, and a session marked as automation (MarkBrainAutomation) always.
func BrainCandidates(ctx context.Context, q Querier, since, idleBefore int64, limit int) ([]BrainCandidate, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := q.QueryContext(ctx, `
		SELECT session_id, project, cwd, repo_root, last_event_at, cursor, max_id, ended FROM (
			SELECT s.session_id, COALESCE(s.project, '') AS project, COALESCE(s.cwd, '') AS cwd, COALESCE(s.repo_root, '') AS repo_root,
			       COALESCE(s.last_event_at, 0) AS last_event_at,
			       `+brainCursorSQL+` AS cursor,
			       COALESCE((SELECT MAX(e.id) FROM events e WHERE e.session_id = s.session_id), 0) AS max_id,
			       s.status = 'ended' AS ended,
			       `+brainHeldSQL+` AS held
			FROM sessions s
			WHERE COALESCE(s.last_event_at, 0) >= ? AND (s.status = 'ended' OR COALESCE(s.last_event_at, 0) < ?)
			  AND NOT EXISTS (SELECT 1 FROM brain_runs a WHERE a.session_id = s.session_id AND a.status = 'skipped' AND a.error = '`+BrainSkipAutomation+`')
		) WHERE max_id > cursor AND (ended OR max_id > held)
		ORDER BY last_event_at DESC LIMIT ?`, since, idleBefore, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BrainCandidate{}
	for rows.Next() {
		var c BrainCandidate
		if err := rows.Scan(&c.SessionID, &c.Project, &c.Cwd, &c.RepoRoot, &c.LastEventAt, &c.Cursor, &c.MaxEventID, &c.Ended); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// BrainFailures is how many regular reads of a session have failed since its last
// one that did not, and when the latest failed (unix ms).
func BrainFailures(ctx context.Context, q Querier, sessionID string) (int, int64, error) {
	var n int
	var last int64
	err := q.QueryRowContext(ctx, `
		SELECT COUNT(*), COALESCE(MAX(finished_at), 0) FROM brain_runs
		WHERE session_id = ? AND status = 'failed' AND gap_id IS NULL
		  AND id > COALESCE((SELECT MAX(id) FROM brain_runs WHERE session_id = ? AND status != 'failed' AND gap_id IS NULL), 0)`,
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
	return BrainPassagesBetween(ctx, q, sessionID, after, math.MaxInt64, limit)
}

// BrainPassagesBetween is BrainPassages for the events after `after` up to
// and including `through`: a read never goes past the event it was told to
// stop at, and a catch-up read stays inside its gap.
func BrainPassagesBetween(ctx context.Context, q Querier, sessionID string, after, through int64, limit int) ([]BrainPassage, error) {
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
			WHERE e.session_id = ? AND e.id > ? AND e.id <= ? AND +e.kind IN ('turn.user', 'turn.assistant')
			  AND e.internal = 0 AND `+MainThreadWhere+`
		) WHERE text != '' ORDER BY id LIMIT ?`, sessionID, after, through, limit)
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

// BrainTokensSince is what the extraction's reads and re-tag batches have
// spent since a moment, input and output together.
func BrainTokensSince(ctx context.Context, q Querier, since int64) (int64, error) {
	var n int64
	err := q.QueryRowContext(ctx, `SELECT COALESCE(SUM(tokens_in + tokens_out), 0) FROM brain_runs WHERE finished_at >= ?`, since).Scan(&n)
	return n, err
}

// LastBrainRuns returns the newest reads of sessions that did something
// (not skipped, not a re-tag batch), newest first.
func LastBrainRuns(ctx context.Context, q Querier, limit int) ([]BrainRun, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT r.id, r.session_id, r.from_event_id, r.through_event_id, r.status, r.model, r.tokens_in, r.tokens_out,
		       r.cost_usd, r.nodes, r.error, r.started_at, r.finished_at, COALESCE(s.project, ''),
		       COALESCE(NULLIF(s.title, ''), s.prompt, ''), COALESCE(s.agent, ''), COALESCE(r.gap_id, 0)
		FROM brain_runs r LEFT JOIN sessions s ON s.session_id = r.session_id
		WHERE r.status != 'skipped' AND `+brainNotRetag+` ORDER BY r.id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BrainRun{}
	for rows.Next() {
		var r BrainRun
		if err := rows.Scan(&r.ID, &r.SessionID, &r.FromEventID, &r.ThroughEventID, &r.Status, &r.Model, &r.TokensIn, &r.TokensOut,
			&r.CostUSD, &r.Nodes, &r.Error, &r.StartedAt, &r.FinishedAt, &r.Project, &r.Title, &r.Agent, &r.GapID); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// BrainRunsOf lists one session's reads and marks, oldest first.
func BrainRunsOf(ctx context.Context, q Querier, sessionID string) ([]BrainRun, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT id, session_id, from_event_id, through_event_id, status, model, tokens_in, tokens_out,
		       cost_usd, nodes, error, started_at, finished_at, COALESCE(gap_id, 0), held
		FROM brain_runs WHERE session_id = ? ORDER BY id`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BrainRun{}
	for rows.Next() {
		var r BrainRun
		if err := rows.Scan(&r.ID, &r.SessionID, &r.FromEventID, &r.ThroughEventID, &r.Status, &r.Model, &r.TokensIn, &r.TokensOut,
			&r.CostUSD, &r.Nodes, &r.Error, &r.StartedAt, &r.FinishedAt, &r.GapID, &r.Held); err != nil {
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
	// LastEventAt is when the session last did something, unix ms: a
	// catch-up tells the sessions from before the yes by it.
	LastEventAt int64
}

// BrainReadSessions lists the sessions active since `since` with a read
// that did not fail: the "read" side of a build's progress.
func BrainReadSessions(ctx context.Context, q Querier, since int64) ([]BrainReadSession, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT s.session_id, COALESCE(s.project, ''), COALESCE(SUM(r.nodes), 0), COALESCE(s.last_event_at, 0)
		FROM sessions s JOIN brain_runs r ON r.session_id = s.session_id AND r.status != 'failed' AND r.error != '`+BrainSkipAutomation+`'
		WHERE COALESCE(s.last_event_at, 0) >= ?
		GROUP BY s.session_id`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BrainReadSession{}
	for rows.Next() {
		var r BrainReadSession
		if err := rows.Scan(&r.SessionID, &r.Project, &r.Memories, &r.LastEventAt); err != nil {
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

// What Second Brain adds to a new session's handoff (ADR-063), each part in
// a budget of its own so the passage before them is never cut to make room:
//
//   - the repository's current decisions (nothing supersedes them), newest
//     first, at most BrainHandoffDecisions, one line each — "#id title" —
//     in BrainHandoffDecisionRunes. Fifteen titles of up to 80 runes fit.
//   - then its other memories, pinned first, then newest, at most one per
//     source session (so one long session cannot fill it), at most
//     BrainHandoffMax, titles with the summary clipped to
//     BrainHandoffSummary, in BrainHandoffRunes. A superseded memory and a
//     decision already listed are left out.
const (
	BrainHandoffDecisions     = 15
	BrainHandoffDecisionRunes = 1500
	BrainHandoffMax           = 5
	BrainHandoffRunes         = 700
	BrainHandoffSummary       = 160
	// brainHandoffScan is how many of the newest memories the second part
	// looks through for one per session.
	brainHandoffScan = 60
)

// BrainHandoffPick is what a new session in a repository is handed from
// Second Brain: its current decisions, its other memories, and the text
// the SessionStart handoff appends ("" when there is neither).
// GET /v1/brain/handoff shows the same pick, so the screen and the MCP tool
// name exactly what a session gets.
type BrainHandoffPick struct {
	Decisions []BrainNode
	Memories  []BrainNode
	Text      string
}

// Count is how many memories it hands over, decisions included.
func (p BrainHandoffPick) Count() int { return len(p.Decisions) + len(p.Memories) }

// BrainHandoff picks what a new session in a repository is handed.
func BrainHandoff(ctx context.Context, q Querier, project string) (BrainHandoffPick, error) {
	var p BrainHandoffPick
	decs, err := BrainCurrentDecisions(ctx, q, project, BrainHandoffDecisions, false)
	if err != nil {
		return p, err
	}
	listed := map[int64]bool{}
	var dl []string
	left := BrainHandoffDecisionRunes
	for _, d := range decs {
		line := "\n- " + BrainDecisionLine(d)
		n := utf8.RuneCountInString(line)
		if n > left {
			break
		}
		left -= n
		listed[d.ID] = true
		p.Decisions = append(p.Decisions, d)
		dl = append(dl, line)
	}
	mems, err := BrainProjectMemories(ctx, q, project, brainHandoffScan)
	if err != nil {
		return p, err
	}
	if err := markBrainSuperseded(ctx, q, mems); err != nil {
		return p, err
	}
	sessions := map[string]bool{}
	var ml []string
	left = BrainHandoffRunes
	for _, m := range mems {
		if len(p.Memories) == BrainHandoffMax {
			break
		}
		if listed[m.ID] || m.SupersededBy != 0 || (m.Source.SessionID != "" && sessions[m.Source.SessionID]) {
			continue
		}
		line := "\n- " + m.Kind + ": " + m.Title
		if m.Summary != "" {
			line += " — " + ClipSentence(m.Summary, BrainHandoffSummary)
		}
		n := utf8.RuneCountInString(line)
		if n > left {
			break
		}
		left -= n
		if m.Source.SessionID != "" {
			sessions[m.Source.SessionID] = true
		}
		p.Memories = append(p.Memories, m)
		ml = append(ml, line)
	}
	var parts []string
	if len(dl) > 0 {
		parts = append(parts, "Current decisions in the user's Second Brain for this repository, newest first (a newer one replaces an older one it contradicts; they may be stale):"+strings.Join(dl, ""))
	}
	if len(ml) > 0 {
		parts = append(parts, "Also kept for this repository (decisions and findings from earlier sessions; they may be stale):"+strings.Join(ml, ""))
	}
	p.Text = strings.Join(parts, "\n\n")
	return p, nil
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

// BrainCostSince is what the extraction's reads and re-tag batches cost
// since a moment, in US dollars, as claude reported each (its
// `total_cost_usd`, at API list price).
func BrainCostSince(ctx context.Context, q Querier, since int64) (float64, error) {
	var n float64
	err := q.QueryRowContext(ctx, `SELECT COALESCE(SUM(cost_usd), 0) FROM brain_runs WHERE finished_at >= ?`, since).Scan(&n)
	return n, err
}

// BrainLastRead is when the newest read of a session that kept something
// finished, unix ms; 0 before the first. A re-tag batch is not a read.
func BrainLastRead(ctx context.Context, q Querier) (int64, error) {
	var n int64
	err := q.QueryRowContext(ctx, `SELECT COALESCE(MAX(finished_at), 0) FROM brain_runs r WHERE r.status = 'ok' AND `+brainNotRetag).Scan(&n)
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
// join one memory to another. A memory's link to its topic or project is not
// counted: nearly every memory has one, and counting them made the figure
// read as connections between memories that were never drawn.
func BrainGraphCounts(ctx context.Context, q Querier) (topics, links int, err error) {
	err = q.QueryRowContext(ctx, `SELECT
		(SELECT COUNT(*) FROM brain_nodes WHERE kind = 'topic'),
		(SELECT COUNT(*) FROM brain_edges e
		   JOIN brain_nodes a ON a.id = e.src
		   JOIN brain_nodes b ON b.id = e.dst
		  WHERE a.kind NOT IN ('topic','person','project')
		    AND b.kind NOT IN ('topic','person','project'))`).Scan(&topics, &links)
	return topics, links, err
}

// SetHandoffBrain records how many Second Brain memories a new session was
// handed with its handoff (migration 0058).
func SetHandoffBrain(ctx context.Context, q Querier, sessionID string, n int) error {
	_, err := q.ExecContext(ctx, `UPDATE sessions SET handoff_brain = ? WHERE session_id = ?`, n, sessionID)
	return err
}

// SetHandoffRunes records how long a new session's handoff was, in runes of
// its additionalContext (migration 0069).
func SetHandoffRunes(ctx context.Context, q Querier, sessionID string, n int) error {
	_, err := q.ExecContext(ctx, `UPDATE sessions SET handoff_runes = ? WHERE session_id = ?`, n, sessionID)
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
		WHERE r.status = 'ok' AND r.finished_at >= ? AND `+brainNotRetag+`
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
