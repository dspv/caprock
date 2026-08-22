package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/event"
)

// Session mirrors the sessions table.
type Session struct {
	SessionID      string `json:"session_id"`
	Cwd            string `json:"cwd"`
	Project        string `json:"project"`
	Model          string `json:"model"`
	StartedAt      int64  `json:"started_at"`
	LastEventAt    int64  `json:"last_event_at"`
	Status         string `json:"status"` // active|idle|ended
	TranscriptPath string `json:"transcript_path"`
	HasHooks       bool   `json:"has_hooks"`
	HasTranscript  bool   `json:"has_transcript"`
	GitBranch      string `json:"git_branch"`
	Version        string `json:"version"`
	RepoRoot       string `json:"repo_root,omitempty"`
	RepoPath       string `json:"repo_path,omitempty"`
	Owned          bool   `json:"owned"`
	Worktree       string `json:"worktree,omitempty"`
	SpawnCommand   string `json:"spawn_command,omitempty"`
	PID            int    `json:"pid,omitempty"`
	ExitCode       *int   `json:"exit_code,omitempty"`
}

// Stats mirrors session_stats.
type Stats struct {
	SessionID    string  `json:"session_id"`
	Turns        int64   `json:"turns"`
	ToolCalls    int64   `json:"tool_calls"`
	FilesTouched int64   `json:"files_touched"`
	TokensIn     int64   `json:"tokens_in"`
	TokensOut    int64   `json:"tokens_out"`
	CacheRead    int64   `json:"cache_read"`
	CacheWrite   int64   `json:"cache_write"`
	CostUSD      float64 `json:"cost_usd"`
}

// DailyStat mirrors daily_stats.
type DailyStat struct {
	Day         string  `json:"day"`
	Project     string  `json:"project"`
	Model       string  `json:"model"`
	TokensTotal int64   `json:"tokens_total"`
	CostUSD     float64 `json:"cost_usd"`
	Sessions    int64   `json:"sessions"`
}

// activeWindow bounds the "active now" count: a session whose last event is
// older than this is not active whatever its stored status says.
const activeWindow = 30 * time.Minute

// Session status values.
const (
	StatusActive = "active"
	StatusIdle   = "idle"
	StatusEnded  = "ended"
)

// Querier is satisfied by *sql.DB and *sql.Tx.
type Querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// WithTx runs fn inside a transaction, committing on nil error.
func (s *Store) WithTx(ctx context.Context, fn func(q Querier) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// ErrDuplicate is returned by InsertEvent when (session_id, key) already exists.
var ErrDuplicate = errors.New("duplicate event")

// InsertEvent appends an event. Returns ErrDuplicate (and leaves the row alone)
// when the same (session_id, key) was already stored — the idempotency guarantee
// that lets ingest re-read a transcript after restart.
func InsertEvent(ctx context.Context, q Querier, ev *event.Event) (int64, error) {
	if ev.SessionID == "" {
		return 0, errors.New("event without session_id")
	}
	if ev.Ts.IsZero() {
		ev.Ts = time.UnixMilli(nowMs())
	}
	if len(ev.Payload) == 0 {
		ev.Payload = json.RawMessage("{}")
	}
	var key any
	if ev.Key != "" {
		key = ev.Key
	}
	var tin, tout, cr, cw, cw1h any
	if ev.Tokens != nil {
		tin, tout, cr, cw = ev.Tokens.In, ev.Tokens.Out, ev.Tokens.CacheRead, ev.Tokens.CacheWrite
		if ev.Tokens.CacheWrite1h > 0 {
			cw1h = ev.Tokens.CacheWrite1h
		}
	}
	var cost any
	if ev.CostUSD != nil {
		cost = *ev.CostUSD
	}
	// Per-directory attribution is resolved here, once, rather than by parsing
	// the payload on every read of a polled endpoint (see migration 0012).
	// TouchDir is derived rather than trusted from the caller so every writer —
	// transcript, hook, harness — gets the same normalization.
	touch := any(nil)
	if ev.Kind == event.KindToolPre {
		if d := TouchDir(ev.Payload); d != "" {
			touch = d
		}
	}
	res, err := q.ExecContext(ctx, `
		INSERT INTO events(ts, session_id, source, kind, tool, payload, tokens_in, tokens_out, cache_read, cache_write, cost_usd, key, model, cache_write_1h, agent_id, msg_id, touch_dir)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id, key) WHERE key IS NOT NULL DO NOTHING`,
		ev.Ts.UnixMilli(), ev.SessionID, string(ev.Source), string(ev.Kind), nullStr(ev.Tool), string(ev.Payload),
		tin, tout, cr, cw, cost, key, nullStr(ev.Model), cw1h, nullStr(ev.AgentID), nullStr(ev.MsgID), touch)
	if err != nil {
		return 0, fmt.Errorf("insert event: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return 0, ErrDuplicate
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	ev.ID = id
	return id, nil
}

// SessionPatch carries the fields an event may reveal about its session. Empty
// strings mean "no information" and are never written over existing values.
type SessionPatch struct {
	Cwd, Project, Model, TranscriptPath, GitBranch, Version string
	StartedAt, LastEventAt                                  int64
	FromHook, FromTranscript                                bool
	Status                                                  string // set only to force a status
}

// resolveRepoFields fills Project/RepoRoot/RepoPath from Cwd. Callers pass a cwd
// and get the repository grouping for free, so no call site can forget it and
// reintroduce basename labels.
func (p SessionPatch) resolveRepoFields() (project, root, path string, known bool) {
	if p.Cwd == "" {
		return p.Project, "", "", false
	}
	info := RepoFromCwd(p.Cwd)
	project = info.Repo
	if project == "" {
		project = p.Project
	}
	return project, info.Root, info.Path, true
}

// UpsertSession creates or updates a session from a patch.
func UpsertSession(ctx context.Context, q Querier, id string, p SessionPatch) error {
	if id == "" {
		return errors.New("upsert session without id")
	}
	if p.LastEventAt == 0 {
		p.LastEventAt = nowMs()
	}
	if p.StartedAt == 0 {
		p.StartedAt = p.LastEventAt
	}
	status := p.Status
	if status == "" {
		status = StatusActive
	}
	// The repository grouping is resolved here, from the cwd, so every write
	// path lands the same two-level identity — a caller cannot supply a
	// basename label by accident. repoKnown is false when the patch carries no
	// cwd, and then the stored resolution is left alone rather than blanked.
	project, repoRoot, repoPath, repoKnown := p.resolveRepoFields()
	_, err := q.ExecContext(ctx, `
		INSERT INTO sessions(session_id, cwd, project, model, started_at, last_event_at, status, transcript_path, has_hooks, has_transcript, git_branch, version, repo_root, repo_path)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET
		  cwd             = COALESCE(NULLIF(excluded.cwd, ''), sessions.cwd),
		  project         = COALESCE(NULLIF(excluded.project, ''), sessions.project),
		  repo_root       = CASE WHEN ? THEN excluded.repo_root ELSE COALESCE(sessions.repo_root, excluded.repo_root) END,
		  repo_path       = CASE WHEN ? THEN excluded.repo_path ELSE COALESCE(sessions.repo_path, excluded.repo_path) END,
		  model           = COALESCE(NULLIF(excluded.model, ''), sessions.model),
		  transcript_path = COALESCE(NULLIF(excluded.transcript_path, ''), sessions.transcript_path),
		  git_branch      = COALESCE(NULLIF(excluded.git_branch, ''), sessions.git_branch),
		  version         = COALESCE(NULLIF(excluded.version, ''), sessions.version),
		  started_at      = MIN(sessions.started_at, excluded.started_at),
		  last_event_at   = MAX(sessions.last_event_at, excluded.last_event_at),
		  status          = CASE WHEN ? != '' THEN ? WHEN sessions.status = 'ended' THEN 'ended' ELSE 'active' END,
		  has_hooks       = MAX(sessions.has_hooks, excluded.has_hooks),
		  has_transcript  = MAX(sessions.has_transcript, excluded.has_transcript)`,
		id, p.Cwd, project, p.Model, p.StartedAt, p.LastEventAt, status, p.TranscriptPath, b2i(p.FromHook), b2i(p.FromTranscript), p.GitBranch, p.Version, repoRoot, repoPath,
		repoKnown, repoKnown,
		p.Status, p.Status)
	if err != nil {
		return fmt.Errorf("upsert session: %w", err)
	}
	return nil
}

// MarkOwned records that Caprock spawned this session (Phase 1).
func MarkOwned(ctx context.Context, q Querier, id, worktree, spawnCommand string, pid int) error {
	_, err := q.ExecContext(ctx, `UPDATE sessions SET owned = 1, worktree = COALESCE(NULLIF(?, ''), worktree), spawn_command = ?, pid = ?, status = 'active' WHERE session_id = ?`, worktree, spawnCommand, pid, id)
	return err
}

// SetExit records an owned session's exit code and marks it ended.
func SetExit(ctx context.Context, q Querier, id string, code int) error {
	_, err := q.ExecContext(ctx, `UPDATE sessions SET exit_code = ?, status = 'ended', pid = 0 WHERE session_id = ?`, code, id)
	return err
}

// ListOwnedActive returns owned sessions that are not ended (for restart bookkeeping).
func ListOwnedActive(ctx context.Context, q Querier) ([]Session, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+sessionCols+` FROM sessions WHERE owned = 1 AND status != 'ended' ORDER BY last_event_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		s, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// RecordThrottle appends a throttle observation (Phase 1: capture now, model later).
func RecordThrottle(ctx context.Context, q Querier, ts int64, sessionID, kind string, payload []byte) error {
	_, err := q.ExecContext(ctx, `INSERT INTO throttle_observations(ts, session_id, kind, payload) VALUES(?, ?, ?, ?)`, ts, sessionID, kind, string(payload))
	return err
}

// SetSessionStatus forces a status (idle/ended/active).
func SetSessionStatus(ctx context.Context, q Querier, id, status string) error {
	_, err := q.ExecContext(ctx, `UPDATE sessions SET status = ? WHERE session_id = ?`, status, id)
	return err
}

// MarkIdleSessions flips active sessions with no event since `before` (unix ms) to idle.
// Returns the ids that changed.
func MarkIdleSessions(ctx context.Context, q Querier, before int64) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT session_id FROM sessions WHERE status = 'active' AND last_event_at < ?`, before)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	// A scan that stopped early (cancelled context, read error) leaves a short
	// list that looks complete. The UPDATE below changes every matching row, so
	// reporting a subset would have the daemon emit events for some of the
	// sessions it just changed and stay silent about the rest.
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	_ = rows.Close()
	if len(ids) == 0 {
		return nil, nil
	}
	if _, err := q.ExecContext(ctx, `UPDATE sessions SET status = 'idle' WHERE status = 'active' AND last_event_at < ?`, before); err != nil {
		return nil, err
	}
	return ids, nil
}

// MarkEndedSessions flips idle/active sessions silent since `before` (unix ms) to ended.
func MarkEndedSessions(ctx context.Context, q Querier, before int64) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT session_id FROM sessions WHERE status != 'ended' AND last_event_at < ?`, before)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	// Same reasoning as MarkIdleSessions: a partial read must not pass for a
	// complete one when an UPDATE follows it.
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	_ = rows.Close()
	if len(ids) == 0 {
		return nil, nil
	}
	if _, err := q.ExecContext(ctx, `UPDATE sessions SET status = 'ended' WHERE status != 'ended' AND last_event_at < ?`, before); err != nil {
		return nil, err
	}
	return ids, nil
}

const sessionCols = `session_id, COALESCE(cwd,''), COALESCE(project,''), COALESCE(model,''), COALESCE(started_at,0), COALESCE(last_event_at,0), status, COALESCE(transcript_path,''), has_hooks, has_transcript, COALESCE(git_branch,''), COALESCE(version,''), COALESCE(repo_root,''), COALESCE(repo_path,''), COALESCE(owned,0), COALESCE(worktree,''), COALESCE(spawn_command,''), COALESCE(pid,0), exit_code`

func scanSession(sc interface{ Scan(...any) error }) (Session, error) {
	var s Session
	var hh, ht, owned int
	var exit sql.NullInt64
	err := sc.Scan(&s.SessionID, &s.Cwd, &s.Project, &s.Model, &s.StartedAt, &s.LastEventAt, &s.Status, &s.TranscriptPath, &hh, &ht, &s.GitBranch, &s.Version, &s.RepoRoot, &s.RepoPath, &owned, &s.Worktree, &s.SpawnCommand, &s.PID, &exit)
	s.HasHooks, s.HasTranscript, s.Owned = hh != 0, ht != 0, owned != 0
	if exit.Valid {
		v := int(exit.Int64)
		s.ExitCode = &v
	}
	return s, err
}

// GetSession returns one session; sql.ErrNoRows when unknown.
func GetSession(ctx context.Context, q Querier, id string) (Session, error) {
	return scanSession(q.QueryRowContext(ctx, `SELECT `+sessionCols+` FROM sessions WHERE session_id = ?`, id))
}

// ListSessions returns sessions newest-first. activeOnly filters out ended.
func ListSessions(ctx context.Context, q Querier, activeOnly bool, limit int) ([]Session, error) {
	if limit <= 0 {
		limit = 200
	}
	where := ""
	if activeOnly {
		where = ` WHERE status != 'ended'`
	}
	rows, err := q.QueryContext(ctx, `SELECT `+sessionCols+` FROM sessions`+where+` ORDER BY last_event_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		s, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

const eventCols = `id, ts, session_id, source, kind, COALESCE(tool,''), payload, tokens_in, tokens_out, cache_read, cache_write, cost_usd, COALESCE(key,''), COALESCE(model,''), cache_write_1h, COALESCE(agent_id,'')`

func scanEvent(sc interface{ Scan(...any) error }) (event.Event, error) {
	var ev event.Event
	var ts int64
	var payload string
	var tin, tout, cr, cw, cw1h sql.NullInt64
	var cost sql.NullFloat64
	if err := sc.Scan(&ev.ID, &ts, &ev.SessionID, &ev.Source, &ev.Kind, &ev.Tool, &payload, &tin, &tout, &cr, &cw, &cost, &ev.Key, &ev.Model, &cw1h, &ev.AgentID); err != nil {
		return ev, err
	}
	ev.Ts = time.UnixMilli(ts)
	ev.Payload = json.RawMessage(payload)
	if tin.Valid || tout.Valid || cr.Valid || cw.Valid {
		ev.Tokens = &event.TokenDelta{In: tin.Int64, Out: tout.Int64, CacheRead: cr.Int64, CacheWrite: cw.Int64, CacheWrite1h: cw1h.Int64}
	}
	if cost.Valid {
		c := cost.Float64
		ev.CostUSD = &c
	}
	return ev, nil
}

// AssistantNote is one thing Claude actually said, in prose — the reasoning and
// the closing "here is what changed, here is what I still need from you" that
// people otherwise copy into a notepad or lose to terminal scrollback.
type AssistantNote struct {
	EventID   int64  `json:"event_id"`
	SessionID string `json:"session_id"`
	Project   string `json:"project"`
	Ts        int64  `json:"ts"`
	Model     string `json:"model"`
	Text      string `json:"text"`
	// Fragment marks a note that reads as mid-thought rather than a conclusion
	// ("Let me check that"), so a caller can avoid presenting it as a summary.
	Fragment bool `json:"fragment"`
}

// fragmentMaxRunes is the length under which a note reads as mid-thought rather
// than a conclusion. Measured against real sessions: closing summaries ran to
// roughly 800-2400 characters, while interrupted sessions ended on a one-line
// aside. The label matters when asking "how did this session end" — 60% of all
// notes are legitimately short mid-session remarks, so a caller should use it
// to qualify a *final* note, never to hide prose.
const fragmentMaxRunes = 240

// assistantTextWhere selects assistant turns that carry prose from the MAIN
// thread. The sidechain filter is not optional: 45% of turn.assistant events
// are subagent chatter, so without it "the last thing Claude said" returns a
// subagent's words about half the time.
const assistantTextWhere = `
	e.kind = 'turn.assistant'
	AND COALESCE(e.agent_id, '') = ''
	AND json_extract(e.payload, '$.sidechain') IS NOT 1
	AND COALESCE(json_extract(e.payload, '$.text'), '') != ''`

// SessionNotes returns what Claude said in a session, newest first. Sidechains
// are excluded; the caller gets main-thread prose only.
func SessionNotes(ctx context.Context, q Querier, sessionID string, limit int) ([]AssistantNote, error) {
	if limit <= 0 {
		limit = 200
	}
	if limit > MaxEventPage {
		limit = MaxEventPage
	}
	rows, err := q.QueryContext(ctx, `
		SELECT e.id, e.session_id, COALESCE(se.project,''), e.ts, COALESCE(e.model,''),
		       COALESCE(json_extract(e.payload, '$.text'), '')
		FROM events e LEFT JOIN sessions se ON se.session_id = e.session_id
		WHERE e.session_id = ? AND `+assistantTextWhere+`
		ORDER BY e.id DESC LIMIT ?`, sessionID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanNotes(rows)
}

// SearchNotes finds prose across every session — the question people actually
// ask is "which session was it where Claude explained the SSO thing?", not
// "show me session 17". An empty query returns the most recent notes.
// SearchNotes returns Claude's prose, newest first. `before` pages backwards:
// pass the lowest event_id already shown to get the next page, or 0 to start.
//
// Paging is not an optimisation here, it is the feature working at all. The
// screen used to load a fixed 500 and stop, which on a busy machine is half a
// day — one reporter saw an entry from 22 hours ago followed immediately by one
// from 30 days ago, and reasonably read it as data loss. Nothing was lost; the
// middle was never fetched.
func SearchNotes(ctx context.Context, q Querier, query string, limit int, before int64) ([]AssistantNote, error) {
	if limit <= 0 {
		limit = 100
	}
	if limit > MaxEventPage {
		limit = MaxEventPage
	}
	sql := `
		SELECT e.id, e.session_id, COALESCE(se.project,''), e.ts, COALESCE(e.model,''),
		       COALESCE(json_extract(e.payload, '$.text'), '')
		FROM events e LEFT JOIN sessions se ON se.session_id = e.session_id
		WHERE ` + assistantTextWhere
	args := []any{}
	if trimmed := strings.TrimSpace(query); trimmed != "" {
		// Match the assistant's prose OR the prompt that produced it. People
		// remember their own question — "the SSO thing", "that Windows CI
		// question" — far better than Claude's phrasing of the answer, so
		// searching only the answer misses the way memory actually works. The
		// row returned is still Claude's reply; the prompt is only a way in.
		//
		// LIKE with an escaped pattern: the corpus is one developer's own
		// sessions, so a scan is cheap, and it avoids an FTS table that would
		// need migrating and rebuilding for historical rows — and that would
		// match whole words, losing the fragments people actually search for.
		pattern := "%" + escapeLike(trimmed) + "%"
		sql += ` AND (json_extract(e.payload, '$.text') LIKE ? ESCAPE '\'
		         OR json_extract((
		              SELECT p.payload FROM events p
		              WHERE p.session_id = e.session_id AND p.kind = 'turn.user'
		                AND p.id < e.id AND p.id > e.id - ?
		              ORDER BY p.id DESC LIMIT 1
		            ), '$.prompt') LIKE ? ESCAPE '\')`
		// Only the NEAREST preceding prompt, within a short window: matching any
		// prompt nearby would return every reply in an exchange rather than the
		// passage that answers the question.
		args = append(args, pattern, promptLookback, pattern)
	}
	if before > 0 {
		sql += ` AND e.id < ?`
		args = append(args, before)
	}
	sql += ` ORDER BY e.id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := q.QueryContext(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanNotes(rows)
}

// promptLookback is how many events back from a reply a prompt may sit and
// still count as "the question that produced it". Events are dense — a single
// turn spans several — so this is a few turns, not a whole session.
const promptLookback = 60

// escapeLike neutralises LIKE wildcards so a user searching for "100%" or a
// path with an underscore gets what they typed.
func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

func scanNotes(rows *sql.Rows) ([]AssistantNote, error) {
	var out []AssistantNote
	for rows.Next() {
		var n AssistantNote
		if err := rows.Scan(&n.EventID, &n.SessionID, &n.Project, &n.Ts, &n.Model, &n.Text); err != nil {
			return nil, err
		}
		n.Fragment = utf8.RuneCountInString(n.Text) < fragmentMaxRunes
		out = append(out, n)
	}
	return out, rows.Err()
}

// MaxEventPage is the most events one ListEvents call will return. Callers that
// need more must paginate with `after`.
const MaxEventPage = 5000

// ListEvents returns events for a session with id > after, oldest first.
func ListEvents(ctx context.Context, q Querier, sessionID string, after int64, limit int) ([]event.Event, error) {
	// Asking for more than the ceiling clamps to the ceiling. It used to fall
	// back to 500 — so a caller requesting "everything" silently received the
	// *start* of a session and could mistake an early fragment for its ending.
	if limit <= 0 {
		limit = 500
	}
	if limit > MaxEventPage {
		limit = MaxEventPage
	}
	rows, err := q.QueryContext(ctx, `SELECT `+eventCols+` FROM events WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?`, sessionID, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []event.Event
	for rows.Next() {
		ev, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, ev)
	}
	return out, rows.Err()
}

// LastEvents returns the newest n events for a session, oldest first.
func LastEvents(ctx context.Context, q Querier, sessionID string, n int) ([]event.Event, error) {
	if n <= 0 {
		n = 50
	}
	if n > MaxEventPage {
		n = MaxEventPage
	}
	rows, err := q.QueryContext(ctx, `SELECT * FROM (SELECT `+eventCols+` FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`, sessionID, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []event.Event
	for rows.Next() {
		ev, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, ev)
	}
	return out, rows.Err()
}

// TouchFile records that a session touched a path. Returns true when the path is new for the session.
func TouchFile(ctx context.Context, q Querier, sessionID, path string, ts int64) (bool, error) {
	res, err := q.ExecContext(ctx, `INSERT INTO session_files(session_id, path, first_ts, last_ts) VALUES(?, ?, ?, ?) ON CONFLICT(session_id, path) DO NOTHING`,
		sessionID, path, ts, ts)
	if err != nil {
		return false, err
	}
	if n, _ := res.RowsAffected(); n == 1 {
		return true, nil
	}
	_, err = q.ExecContext(ctx, `UPDATE session_files SET last_ts = MAX(last_ts, ?) WHERE session_id = ? AND path = ?`, ts, sessionID, path)
	return false, err
}

// SessionFiles lists paths a session touched, most recent first.
func SessionFiles(ctx context.Context, q Querier, sessionID string, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := q.QueryContext(ctx, `SELECT path FROM session_files WHERE session_id = ? ORDER BY last_ts DESC LIMIT ?`, sessionID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// AddStats increments session_stats by the delta and returns the new totals.
func AddStats(ctx context.Context, q Querier, d Stats) (Stats, error) {
	if _, err := q.ExecContext(ctx, `
		INSERT INTO session_stats(session_id, turns, tool_calls, files_touched, tokens_in, tokens_out, cache_read, cache_write, cost_usd)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET
		  turns = session_stats.turns + excluded.turns,
		  tool_calls = session_stats.tool_calls + excluded.tool_calls,
		  files_touched = session_stats.files_touched + excluded.files_touched,
		  tokens_in = session_stats.tokens_in + excluded.tokens_in,
		  tokens_out = session_stats.tokens_out + excluded.tokens_out,
		  cache_read = session_stats.cache_read + excluded.cache_read,
		  cache_write = session_stats.cache_write + excluded.cache_write,
		  cost_usd = session_stats.cost_usd + excluded.cost_usd`,
		d.SessionID, d.Turns, d.ToolCalls, d.FilesTouched, d.TokensIn, d.TokensOut, d.CacheRead, d.CacheWrite, d.CostUSD); err != nil {
		return Stats{}, fmt.Errorf("add stats: %w", err)
	}
	return GetStats(ctx, q, d.SessionID)
}

// GetStats returns session_stats for a session (zeros when absent).
func GetStats(ctx context.Context, q Querier, sessionID string) (Stats, error) {
	s := Stats{SessionID: sessionID}
	err := q.QueryRowContext(ctx, `SELECT turns, tool_calls, files_touched, tokens_in, tokens_out, cache_read, cache_write, cost_usd FROM session_stats WHERE session_id = ?`, sessionID).
		Scan(&s.Turns, &s.ToolCalls, &s.FilesTouched, &s.TokensIn, &s.TokensOut, &s.CacheRead, &s.CacheWrite, &s.CostUSD)
	if errors.Is(err, sql.ErrNoRows) {
		return s, nil
	}
	return s, err
}

// AddDaily increments daily_stats for (day, project, model). newSession bumps the sessions count.
func AddDaily(ctx context.Context, q Querier, day, project, model string, tokens int64, cost float64, newSession bool) error {
	_, err := q.ExecContext(ctx, `
		INSERT INTO daily_stats(day, project, model, tokens_total, cost_usd, sessions) VALUES(?, ?, ?, ?, ?, ?)
		ON CONFLICT(day, project, model) DO UPDATE SET
		  tokens_total = daily_stats.tokens_total + excluded.tokens_total,
		  cost_usd = daily_stats.cost_usd + excluded.cost_usd,
		  sessions = daily_stats.sessions + excluded.sessions`,
		day, project, model, tokens, cost, b2i(newSession))
	return err
}

// Daily returns daily_stats for the last `days` days (day >= from), oldest first.
func Daily(ctx context.Context, q Querier, from string) ([]DailyStat, error) {
	rows, err := q.QueryContext(ctx, `SELECT day, project, model, tokens_total, cost_usd, sessions FROM daily_stats WHERE day >= ? ORDER BY day ASC, project, model`, from)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DailyStat
	for rows.Next() {
		var d DailyStat
		if err := rows.Scan(&d.Day, &d.Project, &d.Model, &d.TokensTotal, &d.CostUSD, &d.Sessions); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// Summary is the aggregate for /v1/stats/summary.
type Summary struct {
	Range      string         `json:"range"`
	FromMs     int64          `json:"from_ms"`
	Sessions   int64          `json:"sessions"`
	Active     int64          `json:"active_sessions"`
	Turns      int64          `json:"turns"`
	ToolCalls  int64          `json:"tool_calls"`
	TokensIn   int64          `json:"tokens_in"`
	TokensOut  int64          `json:"tokens_out"`
	CacheRead  int64          `json:"cache_read"`
	CacheWrite int64          `json:"cache_write"`
	CostUSD    float64        `json:"cost_usd"`
	Models     []ModelShare   `json:"models"`
	Projects   []ProjectShare `json:"projects"`
}

// ModelShare is tokens/cost per model.
type ModelShare struct {
	Model   string  `json:"model"`
	Tokens  int64   `json:"tokens"`
	CostUSD float64 `json:"cost_usd"`
	Turns   int64   `json:"turns"`
}

// ProjectShare is tokens/cost per REPOSITORY. Sessions is how many distinct
// sessions touched it in the range — the "who is working in this repo" half of
// the question; cost alone does not answer it.
//
// Paths is the breakdown one level down: what each top-level directory inside
// the repository cost. On a monorepo that is the difference between "caprock
// cost $1,662" and "ui was $400 of it", which is the question a budget actually
// asks. It is present only when the repository has more than one such
// directory — a single-directory repo would just repeat its own total.
// Spark is the per-bucket series behind the row's sparkline, present only when
// the caller asked for one. It is deliberately NOT repeated on PathShare: a
// sparkline per directory would multiply the payload of a polled endpoint for a
// picture nobody sees until they expand the row.
type ProjectShare struct {
	Project  string      `json:"project"`
	Tokens   int64       `json:"tokens"`
	CostUSD  float64     `json:"cost_usd"`
	Sessions int64       `json:"sessions"`
	Paths    []PathShare `json:"paths,omitempty"`
	Spark    *Spark      `json:"spark,omitempty"`
}

// PathShare is tokens/cost for one directory inside a repository, charged by
// what the repository's TURNS touched rather than by where a session was
// launched (see touch.go).
//
// Path is the directory relative to the repository root, written from it so it
// reads as a path — "/", "/services/api". Two values are NOT paths:
// UnattributedPath (turns that ran before their session touched any file) and
// OutsidePath (turns whose most recent touch was outside the repository).
// Callers must render both as their own thing and never as a directory — see
// Unattributed and Outside.
//
// Turns replaces the old Sessions count. A session touches many directories, so
// it cannot be counted once per directory row without the column summing to
// more than the repository's own session count; a TURN is charged to exactly
// one row by construction, so turns partition and add up.
type PathShare struct {
	Path    string  `json:"path"`
	Tokens  int64   `json:"tokens"`
	CostUSD float64 `json:"cost_usd"`
	Turns   int64   `json:"turns"`
	// Unattributed and Outside mark the two rows that are buckets rather than
	// directories, so the UI does not have to know the sentinels' spelling.
	// Unattributed is the turns that ran before their session touched any file;
	// Outside is the turns whose most recent touch was not in this repository.
	// Both are rendered as their own thing and never as a path.
	Unattributed bool `json:"unattributed,omitempty"`
	Outside      bool `json:"outside,omitempty"`
	// TokensPct and CostPct are this row's share of the REPOSITORY's total,
	// including the unattributed bucket — so each column sums to 100% and the
	// unattributed share is visible as its own number instead of being hidden
	// in a denominator.
	//
	// Both are sent because they genuinely differ: cost per token varies by
	// model, so a directory worked on by a cheap model is a larger share of the
	// tokens than of the money. Sending one would leave the reader to assume it
	// described both.
	//
	// They are computed here rather than in the panel because the denominator
	// is the repository total, which the panel only has after summing rows it
	// may be truncating. Values are floored to one decimal on the client
	// (fmtPct), never rounded up.
	TokensPct float64 `json:"tokens_pct"`
	CostPct   float64 `json:"cost_pct"`
}

// turnSpend is one assistant turn's cost and what it touched — the unit
// per-directory attribution charges.
type turnSpend struct {
	tokens  int64
	cost    float64
	touched TouchDirs
}

// Spark is a project's spend over time, as one value per fixed-width bucket —
// the series behind the sparkline on the Projects panel. It answers "when did
// this repo cost that" without shipping the events themselves.
//
// Cost and tokens travel together, as two parallel arrays over the SAME
// buckets, because which of the two the panel plots stays a display choice on
// the client. Sending only one of them would make re-basing the picture a network
// round trip — on a polled endpoint, a control that stalls — and sending events
// so the client could bucket them itself would be orders of magnitude more
// payload for a picture 120px wide.
//
// Bucket i covers [FromMs + i*WidthMs, FromMs + (i+1)*WidthMs). The last bucket
// is the one containing "now" and is therefore still filling; it is not
// extrapolated to a full bucket's worth (rule 6).
type Spark struct {
	FromMs  int64     `json:"from_ms"`
	WidthMs int64     `json:"width_ms"`
	Cost    []float64 `json:"cost"`
	Tokens  []int64   `json:"tokens"`
}

// SparkSpec asks Summarize for per-project time series. Buckets <= 0 disables
// them entirely, which is the default: /v1/stats/summary computes a second
// summary for the 10-minute burn figure, and that one has no sparkline to draw.
type SparkSpec struct {
	// Buckets is how many columns the panel will paint.
	Buckets int
	// WidthMs is one column's width. Callers derive it from the selected range
	// (a day for 30d/7d, an hour for today) so the picture and the number beside
	// it always describe the same period.
	WidthMs int64
	// FromMs is the first bucket's left edge. It is passed separately from
	// Summarize's own fromMs because a range is calendar-aligned: "30d" starts
	// at local midnight 29 days ago, and bucketing from an arbitrary instant
	// would smear each day across two columns.
	FromMs int64
}

// bucket returns the index for an event at ts, and whether it falls in range.
func (sp SparkSpec) bucket(ts int64) (int, bool) {
	if sp.Buckets <= 0 || sp.WidthMs <= 0 || ts < sp.FromMs {
		return 0, false
	}
	i := (ts - sp.FromMs) / sp.WidthMs
	// Past the last bucket is out of range rather than clamped into it: an
	// event after the window would otherwise draw a spike on the final column
	// that never happened there. Same reasoning as buildPulse in the UI.
	if i >= int64(sp.Buckets) {
		return 0, false
	}
	return int(i), true
}

// sessionBucket is tokens+cost for one session, either in total or within one
// sparkline bucket.
type sessionBucket struct {
	tokens int64
	cost   float64
}

// addSpark folds one session's per-bucket totals into a project's series,
// creating the series on first use. A project whose sessions all fall outside
// the bucket grid still gets an all-zero series rather than none, so the panel
// draws a flat line — "no spend in these buckets" — instead of omitting the
// picture, which would read as a rendering fault.
func addSpark(p *ProjectShare, spec SparkSpec, series []sessionBucket) {
	if p.Spark == nil {
		p.Spark = &Spark{
			FromMs:  spec.FromMs,
			WidthMs: spec.WidthMs,
			Cost:    make([]float64, spec.Buckets),
			Tokens:  make([]int64, spec.Buckets),
		}
	}
	for i, v := range series {
		if i >= len(p.Spark.Cost) {
			break
		}
		p.Spark.Cost[i] += v.cost
		p.Spark.Tokens[i] += v.tokens
	}
}

// Summarize aggregates events since fromMs (0 = all time).
func Summarize(ctx context.Context, q Querier, fromMs int64) (Summary, error) {
	return SummarizeSpark(ctx, q, fromMs, SparkSpec{})
}

// SummarizeSpark is Summarize with an optional per-project time series. The
// series costs one extra GROUP BY column on a scan the summary already makes,
// so it is nearly free; see the measurement note on the query below.
func SummarizeSpark(ctx context.Context, q Querier, fromMs int64, spark SparkSpec) (Summary, error) {
	s := Summary{FromMs: fromMs}
	// Grouping by kind runs off idx_events_kind_ts; summing CASE expressions
	// instead forced a read of every row in the range — 197ms against 81ms on a
	// 184k-event database, and this is the query behind both the Cost screen
	// and History.
	//
	// The distinct session count stays a separate query on purpose: per-kind
	// counts cannot be summed, because a session appears under several kinds
	// (it totalled 212 against a true 56 here). That query is ~10ms.
	rows, err := q.QueryContext(ctx, `
		SELECT kind, COUNT(*),
		       COALESCE(SUM(tokens_in),0), COALESCE(SUM(tokens_out),0),
		       COALESCE(SUM(cache_read),0), COALESCE(SUM(cache_write),0),
		       COALESCE(SUM(cost_usd),0)
		FROM events WHERE ts >= ? GROUP BY kind`, fromMs)
	if err != nil {
		return s, err
	}
	for rows.Next() {
		var kind string
		var n, tin, tout, cr, cw int64
		var cost float64
		if err := rows.Scan(&kind, &n, &tin, &tout, &cr, &cw, &cost); err != nil {
			_ = rows.Close()
			return s, err
		}
		// Tokens and cost accrue on assistant turns, but sum every kind so a
		// future priced event type is not silently dropped from the totals.
		s.TokensIn += tin
		s.TokensOut += tout
		s.CacheRead += cr
		s.CacheWrite += cw
		s.CostUSD += cost
		switch kind {
		case string(event.KindTurnAssistant):
			s.Turns = n
		case string(event.KindToolPre):
			s.ToolCalls = n
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return s, err
	}
	if err := rows.Close(); err != nil {
		return s, err
	}
	if err := q.QueryRowContext(ctx,
		`SELECT COUNT(DISTINCT session_id) FROM events WHERE ts >= ?`, fromMs).Scan(&s.Sessions); err != nil {
		return s, err
	}
	// "Active" means active *now*, so it is deliberately not range-scoped — but
	// it must still be bounded in time. A session is marked active on its first
	// event and only reaped later, so during a first-run backfill this counted
	// every historical session at once: a new user's first impression was an
	// active count in the dozens that then fell to one.
	if err := q.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sessions WHERE status = 'active' AND last_event_at >= ?`,
		nowMs()-int64(activeWindow/time.Millisecond)).Scan(&s.Active); err != nil {
		return s, err
	}
	rows, err = q.QueryContext(ctx, `
		SELECT COALESCE(model,''), COALESCE(SUM(COALESCE(tokens_in,0)+COALESCE(tokens_out,0)+COALESCE(cache_read,0)+COALESCE(cache_write,0)),0), COALESCE(SUM(cost_usd),0), COUNT(*)
		FROM events WHERE kind = 'turn.assistant' AND ts >= ? GROUP BY model ORDER BY 3 DESC`, fromMs)
	if err != nil {
		return s, err
	}
	for rows.Next() {
		var m ModelShare
		if err := rows.Scan(&m.Model, &m.Tokens, &m.CostUSD, &m.Turns); err != nil {
			_ = rows.Close()
			return s, err
		}
		s.Models = append(s.Models, m)
	}
	// A truncated model list is a wrong number, not a short one: the model mix
	// is rendered as a share of the total, so a missing row silently reweights
	// every other model on the Cost screen (rule 6).
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return s, err
	}
	_ = rows.Close()
	// Both levels of the projects roll-up come from ONE pass. Grouping by
	// (project, first segment of repo_path) and summing the segments back up
	// into the repository row costs a single scan; asking the database twice —
	// once per repo, once per repo+path — scanned the same events twice for a
	// breakdown that is arithmetic on the rows we already have.
	//
	// The segment is cut in SQL rather than in Go so the group-by collapses
	// `ui/src/components` and `ui/lib` into one `ui` row inside the database,
	// instead of shipping a row per distinct deep path across the driver.
	// repo_path is stored slash-separated by RepoFromCwd whatever the host's
	// separator, so this substring is not platform-dependent.
	// Rows are keyed by repo_root, not by the label. Two checkouts can share a
	// basename (`livegraph/repo` and `orch-live/repo` on the owner's machine),
	// and grouping by the label would sum them into one row — the exact bug
	// this change exists to fix, reintroduced one level up. Roots are unique by
	// construction, so grouping on them cannot collide; the labels are made
	// readable afterwards by DisambiguateLabels.
	//
	// A session outside any repository has no root, so it falls back to its
	// project label, which unrootedInfo already derives from the full path.
	// Events are aggregated per SESSION and grouped into repositories in Go.
	//
	// Grouping in SQL meant joining sessions on every one of ~90k assistant
	// events and grouping on a wide text key; grouping on the integer-ish
	// session_id alone runs off idx_events_cost_cover and needs no join and no
	// COUNT(DISTINCT) — a session's row IS one distinct session. The mapping
	// from session to (repository, segment) is then applied to tens of rows
	// instead of tens of thousands. Measured on the owner's 190k-event
	// database through the Go driver, best of six: the whole summary took
	// 210ms before this change and 204ms after, so the second grouping level
	// is free.
	//
	// When a sparkline is asked for, the SAME scan additionally groups by
	// bucket index, computed in SQL so the driver ships one row per
	// (session, bucket) that had spend rather than one row per event. On the
	// owner's database that is tens of rows becoming hundreds — still nothing —
	// while bucketing in Go would have meant selecting every assistant event's
	// timestamp and carrying ~90k rows across the driver, which is the cost this
	// query was written to avoid in the first place.
	//
	// The arithmetic is integer division on ts, not strftime: a date function
	// would have to be applied per row and could not use the index, and the
	// bucket edges are already known to the caller in unix ms.
	totals := map[string]sessionBucket{}
	// sparks[session][bucket] — only for sessions that actually spent.
	sparks := map[string][]sessionBucket{}
	sparkOn := spark.Buckets > 0 && spark.WidthMs > 0
	if sparkOn {
		// The CASE is not decoration. SQLite's integer division truncates
		// TOWARD ZERO, so an event before the grid's start gives -0 — bucket 0 —
		// and its spend would be painted onto the first column, which is spend
		// that did not happen there. That is reachable whenever the grid starts
		// after the range does. Negative offsets are mapped to -1 so the Go side
		// can reject them as "in the range, but off the picture".
		rows, err = q.QueryContext(ctx, `
			SELECT e.session_id,
			       CASE WHEN e.ts < ? THEN -1 ELSE (e.ts - ?) / ? END AS bucket,
			       COALESCE(SUM(COALESCE(e.tokens_in,0)+COALESCE(e.tokens_out,0)+COALESCE(e.cache_read,0)+COALESCE(e.cache_write,0)),0),
			       COALESCE(SUM(e.cost_usd),0)
			FROM events e
			WHERE e.kind = 'turn.assistant' AND e.ts >= ?
			GROUP BY e.session_id, bucket`, spark.FromMs, spark.FromMs, spark.WidthMs, fromMs)
	} else {
		rows, err = q.QueryContext(ctx, `
			SELECT e.session_id, 0 AS bucket,
			       COALESCE(SUM(COALESCE(e.tokens_in,0)+COALESCE(e.tokens_out,0)+COALESCE(e.cache_read,0)+COALESCE(e.cache_write,0)),0),
			       COALESCE(SUM(e.cost_usd),0)
			FROM events e
			WHERE e.kind = 'turn.assistant' AND e.ts >= ?
			GROUP BY e.session_id`, fromMs)
	}
	if err != nil {
		return s, err
	}
	for rows.Next() {
		var id string
		var b int64
		var t sessionBucket
		if err := rows.Scan(&id, &b, &t.tokens, &t.cost); err != nil {
			_ = rows.Close()
			return s, err
		}
		// The row totals accumulate across buckets, so a repository's headline
		// number is the same whether or not a sparkline was requested. The
		// sparkline must never be able to change the figure it sits beside.
		cur := totals[id]
		cur.tokens += t.tokens
		cur.cost += t.cost
		totals[id] = cur
		if !sparkOn {
			continue
		}
		// Out-of-range buckets still count toward the total above — they are
		// spend inside `fromMs` — but have no column to be drawn in. This
		// happens when the caller's bucket grid starts after fromMs; it is not
		// an error, and silently dropping the money would understate the row.
		if b < 0 || b >= int64(spark.Buckets) {
			continue
		}
		series := sparks[id]
		if series == nil {
			series = make([]sessionBucket, spark.Buckets)
		}
		series[b].tokens += t.tokens
		series[b].cost += t.cost
		sparks[id] = series
	}
	// A truncated projects list is a wrong number for the same reason a
	// truncated model list is (rule 6): the panel renders each bar as a share
	// of the largest row.
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return s, err
	}
	if err := rows.Close(); err != nil {
		return s, err
	}
	// Per-directory attribution needs spend at TURN granularity, because a turn
	// is the unit that can be charged to a directory: its cost is billed as one
	// amount, and the tools it called are what say where that amount went. The
	// two queries below are the only extra work this feature adds to the
	// summary — measured on the owner's database, see § timings in
	// migration 0012.
	turns, err := turnSpendBySession(ctx, q, fromMs)
	if err != nil {
		return s, err
	}
	// The session → repository mapping. Only sessions that actually spent in
	// the range are looked up, so a database full of old sessions costs nothing.
	rows, err = q.QueryContext(ctx,
		`SELECT session_id, COALESCE(project,''), COALESCE(repo_root,''), COALESCE(repo_path,''), COALESCE(cwd,'') FROM sessions`)
	if err != nil {
		return s, err
	}
	defer rows.Close()
	byRoot := map[string]int{}       // grouping key → index into s.Projects
	rootLabel := map[string]string{} // grouping key → label it claims
	// pathIdx keeps one row per (repository, segment) so repeated sessions in
	// the same directory merge instead of stacking duplicate breakdown rows.
	pathIdx := map[[2]string]int{}
	for rows.Next() {
		var id, label, root, path, cwd string
		if err := rows.Scan(&id, &label, &root, &path, &cwd); err != nil {
			return s, err
		}
		t, spent := totals[id]
		if !spent {
			continue // no assistant turns in this range
		}
		delete(totals, id)
		// Rows are keyed by repo_root, not by the label. Two checkouts can
		// share a basename (`livegraph/repo` and `orch-live/repo` on the
		// owner's machine), and grouping by the label would sum them into one
		// row — the exact bug this change exists to fix, one level up. Roots
		// are unique by construction; a session outside any repository falls
		// back to its label, which unrootedInfo derives from the full path.
		// A session outside any repository is identified by its own directory,
		// not by its label: /tmp/demo/testrepo and /tmp/demo2/testrepo are both
		// labelled `testrepo`, and keying on the label would sum them — the
		// original bug, one level up. The label is made unique for display by
		// DisambiguateLabels, which widens only what actually collides.
		key := root
		if key == "" {
			key = "cwd:" + cwd
		}
		// With neither a repository nor a cwd there is nothing to group on but
		// the label itself. Falling through to a shared empty key would merge
		// every such session into one row.
		if key == "cwd:" {
			key = "label:" + label
		}
		i, ok := byRoot[key]
		if !ok {
			i = len(s.Projects)
			byRoot[key] = i
			rootLabel[key] = label
			s.Projects = append(s.Projects, ProjectShare{Project: label})
		}
		p := &s.Projects[i]
		p.Tokens += t.tokens
		p.CostUSD += t.cost
		// A session lives in exactly one directory, so it counts once for its
		// repository and once for its segment: the per-segment counts partition
		// the repository's sessions and add up without double-counting.
		p.Sessions++
		if sparkOn {
			addSpark(p, spark, sparks[id])
		}
		// The per-directory breakdown is charged by what the session's TURNS
		// touched, not by the directory the session was launched from. The
		// per-turn figures were gathered above; here they are folded into the
		// repository this session belongs to.
		//
		// root, not key: attribution compares a carried path against a real
		// repository root, and a session outside any repository ("cwd:…") has
		// none to compare with — its turns land in the outside row, which is
		// the honest answer for work with no repository to be inside of.
		for _, tt := range turns[id] {
			seg, _ := AttributeDir(tt.touched, root)
			pk := [2]string{key, seg}
			j, ok := pathIdx[pk]
			if !ok {
				j = len(p.Paths)
				pathIdx[pk] = j
				p.Paths = append(p.Paths, PathShare{Path: seg})
			}
			ps := &p.Paths[j]
			ps.Tokens += tt.tokens
			ps.CostUSD += tt.cost
			ps.Turns++
		}
	}
	if err := rows.Err(); err != nil {
		return s, err
	}
	// Spend whose session row has since been deleted still belongs in the
	// totals: dropping it would silently understate the bill (rule 6).
	if len(totals) > 0 {
		var orphan ProjectShare
		for id, t := range totals {
			orphan.Tokens += t.tokens
			orphan.CostUSD += t.cost
			orphan.Sessions++
			// The orphan row gets a sparkline too. Without one it would be the
			// single row whose picture disagreed with its number — a blank
			// sparkline beside real money reads as "nothing happened".
			if sparkOn {
				addSpark(&orphan, spark, sparks[id])
			}
		}
		s.Projects = append(s.Projects, orphan)
	}
	labels := DisambiguateLabels(rootLabel)
	for root, i := range byRoot {
		if l, ok := labels[root]; ok && l != "" {
			s.Projects[i].Project = l
		}
	}
	for i := range s.Projects {
		p := &s.Projects[i]
		// Drop a sentinel row that carries no money. Under carry-forward the
		// repository-wide row means only "turns before the session's first
		// touch", which for most repositories is nothing at all — and a row
		// reading $0.00 next to real directories invites the reader to wonder
		// what went wrong.
		//
		// The test is COST, not cost-and-tokens: a turn can carry tokens priced
		// at zero (an unpriced model, a cached-only turn), which still produces
		// a row rendering "$0.00" beside real spend. Directory rows are never
		// dropped — a directory in the list is there because a turn was charged
		// to it, and a real directory that genuinely cost nothing is a fact
		// about the repository rather than an artifact of the rule.
		kept := p.Paths[:0]
		for _, ps := range p.Paths {
			if (ps.Path == UnattributedPath || ps.Path == OutsidePath) && ps.CostUSD == 0 {
				continue
			}
			kept = append(kept, ps)
		}
		p.Paths = kept
		// A breakdown whose only row is a bucket says nothing the repository
		// row does not already say: "all of it, and we cannot tell you where".
		// Nor does a single directory, which would restate the row's own total
		// under a second heading.
		if len(p.Paths) < 2 {
			p.Paths = nil
			continue
		}
		for j := range p.Paths {
			ps := &p.Paths[j]
			ps.Unattributed = ps.Path == UnattributedPath
			ps.Outside = ps.Path == OutsidePath
			// The denominator is the REPOSITORY total, including the
			// unattributed bucket, so the column sums to 100% and the share
			// that could not be attributed is visible as its own percentage
			// rather than inflating the directories that could. A percentage
			// whose base the reader has to guess is exactly what rule 6 exists
			// to prevent.
			if p.Tokens > 0 {
				ps.TokensPct = 100 * float64(ps.Tokens) / float64(p.Tokens)
			}
			if p.CostUSD > 0 {
				ps.CostPct = 100 * ps.CostUSD / p.CostUSD
			}
		}
		// Sorted by cost, except that the two rows which are NOT directories are
		// pinned last however large they are: they do not compete with the
		// directories for "which service costs most", and a reader scanning for
		// the costliest service should not have to skip past them. Outside sits
		// above repository-wide, since it is the larger and more informative of
		// the two on real data.
		rank := func(ps PathShare) int {
			switch ps.Path {
			case OutsidePath:
				return 1
			case UnattributedPath:
				return 2
			}
			return 0
		}
		sort.SliceStable(p.Paths, func(a, b int) bool {
			if ra, rb := rank(p.Paths[a]), rank(p.Paths[b]); ra != rb {
				return ra < rb
			}
			return p.Paths[a].CostUSD > p.Paths[b].CostUSD
		})
	}
	// Rolling the segments up changed the repository totals, so any ORDER BY
	// the database applied would have been over segments, not repositories.
	sort.SliceStable(s.Projects, func(a, b int) bool { return s.Projects[a].CostUSD > s.Projects[b].CostUSD })
	return s, nil
}

// Offset persistence for the transcript tailer.
func GetOffset(ctx context.Context, q Querier, path string) (int64, error) {
	var off int64
	err := q.QueryRowContext(ctx, `SELECT offset FROM transcript_offsets WHERE path = ?`, path).Scan(&off)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return off, err
}

func SetOffset(ctx context.Context, q Querier, path, sessionID string, off int64) error {
	_, err := q.ExecContext(ctx, `
		INSERT INTO transcript_offsets(path, session_id, offset, updated_at) VALUES(?, ?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, session_id = COALESCE(NULLIF(excluded.session_id,''), transcript_offsets.session_id), updated_at = excluded.updated_at`,
		path, sessionID, off, nowMs())
	return err
}

// Cursor is a stable timeline of events across all sessions (for the live feed catch-up).
func EventsAfter(ctx context.Context, q Querier, after int64, limit int) ([]event.Event, error) {
	if limit <= 0 {
		limit = 500
	}
	if limit > MaxEventPage {
		limit = MaxEventPage
	}
	rows, err := q.QueryContext(ctx, `SELECT `+eventCols+` FROM events WHERE id > ? ORDER BY id ASC LIMIT ?`, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []event.Event
	for rows.Next() {
		ev, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, ev)
	}
	return out, rows.Err()
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// ToolCount is one row of the tool-usage distribution.
type ToolCount struct {
	Tool  string `json:"tool"`
	Count int64  `json:"count"`
}

// ToolDistribution counts tool.pre events by tool since fromMs (0 = all time).
func ToolDistribution(ctx context.Context, q Querier, fromMs int64, limit int) ([]ToolCount, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := q.QueryContext(ctx, `SELECT COALESCE(tool,'?'), COUNT(*) FROM events WHERE kind = 'tool.pre' AND ts >= ? GROUP BY tool ORDER BY 2 DESC LIMIT ?`, fromMs, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ToolCount
	for rows.Next() {
		var t ToolCount
		if err := rows.Scan(&t.Tool, &t.Count); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// HistoryTotals is the all-time (or ranged) cross-session summary for the History screen.
type HistoryTotals struct {
	Sessions      int64   `json:"sessions"`
	OwnedSessions int64   `json:"owned_sessions"`
	Turns         int64   `json:"turns"`
	ToolCalls     int64   `json:"tool_calls"`
	FilesTouched  int64   `json:"files_touched"`
	CostUSD       float64 `json:"cost_usd"`
	AvgSessionSec float64 `json:"avg_session_sec"`
	Days          int64   `json:"days"`
}

// History computes cross-session totals since fromMs.
func History(ctx context.Context, q Querier, fromMs int64) (HistoryTotals, error) {
	var h HistoryTotals
	err := q.QueryRowContext(ctx, `
		SELECT COUNT(*), COALESCE(SUM(owned),0),
		       COALESCE(AVG(CASE WHEN last_event_at > started_at THEN (last_event_at - started_at)/1000.0 END),0)
		FROM sessions WHERE last_event_at >= ?`, fromMs).
		Scan(&h.Sessions, &h.OwnedSessions, &h.AvgSessionSec)
	if err != nil {
		return h, err
	}
	// Days is labelled "active days", so it counts days on which something
	// happened — not days on which a session was opened. Counting session start
	// dates undercounts badly once sessions outlive a day: on the author's own
	// database one session spanned twelve days and contributed one, and the
	// screen read 21 where 32 days had work in them.
	//
	// Read from daily_stats rather than from events. The direct
	// COUNT(DISTINCT date(ts…)) is correct but costs 1.26s on a 187k-event
	// database against 0.38ms here — measured through the Go driver, where the
	// gap is far wider than sqlite3(1) suggests (58ms vs 12ms in the shell).
	// History is the slowest screen already; this kept it that way.
	//
	// The one thing daily_stats cannot see is a day that had tool calls but no
	// priced assistant turn, since the rollup writes a row per priced turn. On
	// this database there are zero such days, and a day of tool calls with no
	// model reply is not a plausible session anyway.
	if err := q.QueryRowContext(ctx,
		`SELECT COUNT(DISTINCT day) FROM daily_stats WHERE day >= date(?/1000, 'unixepoch', 'localtime')`, fromMs).
		Scan(&h.Days); err != nil {
		return h, err
	}
	// Grouping by kind lets this run off idx_events_kind_ts. Summing CASE
	// expressions instead forced a scan of the full rows — 1.17s against 0.27s
	// on a 184k-event database, and this is the slowest query on the History
	// screen.
	rows, err := q.QueryContext(ctx, `
		SELECT kind, COUNT(*), COALESCE(SUM(cost_usd),0)
		FROM events WHERE ts >= ? GROUP BY kind`, fromMs)
	if err != nil {
		return h, err
	}
	for rows.Next() {
		var kind string
		var n int64
		var cost float64
		if err := rows.Scan(&kind, &n, &cost); err != nil {
			_ = rows.Close()
			return h, err
		}
		// Cost accrues on assistant turns, but sum every kind so a future
		// priced event type is not silently dropped from the total.
		h.CostUSD += cost
		switch kind {
		case string(event.KindTurnAssistant):
			h.Turns = n
		case string(event.KindToolPre):
			h.ToolCalls = n
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return h, err
	}
	if err := rows.Close(); err != nil {
		return h, err
	}
	// Restrict to the same window as every other total here. Unfiltered, this
	// reported the lifetime figure under a "today" heading beside five stats
	// that did move with the range — the one number in the row that lied.
	if err := q.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(st.files_touched),0)
		FROM session_stats st JOIN sessions se ON se.session_id = st.session_id
		WHERE se.last_event_at >= ?`, fromMs).Scan(&h.FilesTouched); err != nil {
		return h, err
	}
	return h, nil
}

// PruneEventsBefore deletes events older than beforeMs, keeping session rows and
// their rollups (session_stats/daily_stats stay — the totals are already
// materialized). Returns the number of events removed. This is the data-growth
// safety valve; it never touches sessions the user might still be looking at
// (callers pass a cutoff well in the past).
func PruneEventsBefore(ctx context.Context, q Querier, beforeMs int64) (int64, error) {
	res, err := q.ExecContext(ctx, `DELETE FROM events WHERE ts < ?`, beforeMs)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	// Offsets for transcripts whose events we dropped can stay; re-reading is
	// deduped by key anyway. Clean orphaned session_files older than the cutoff.
	_, _ = q.ExecContext(ctx, `DELETE FROM session_files WHERE last_ts < ?`, beforeMs)
	return n, nil
}

// CountThrottles counts throttle observations since sinceMs (limit-forecast input).
func CountThrottles(ctx context.Context, q Querier, sinceMs int64) (int64, error) {
	var n int64
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM throttle_observations WHERE ts >= ?`, sinceMs).Scan(&n)
	return n, err
}

// RateLimitSnapshot is one window's rate-limit state (from Claude Code's
// statusline `rate_limits`).
type RateLimitSnapshot struct {
	Window         string  `json:"window"`
	Ts             int64   `json:"ts"` // unix ms received
	UsedPercentage float64 `json:"used_percentage"`
	ResetsAt       int64   `json:"resets_at"` // unix seconds
}

// rateLimitHistoryMinIntervalMs throttles history inserts: statusline fires per
// message, but the slope only needs a sample every so often. We append a history
// row at most this often per window (the latest-state row is always upserted).
const rateLimitHistoryMinIntervalMs = 30_000

// RecordRateLimit upserts the latest state for a window and, throttled, appends a
// history row for the "at current pace" slope. The latest row is always current;
// history rows are sampled (≥30s apart) to avoid write amplification.
func RecordRateLimit(ctx context.Context, q Querier, s RateLimitSnapshot, sessionID string) error {
	if _, err := q.ExecContext(ctx, `
		INSERT INTO rate_limit_latest(window, ts, session_id, used_percentage, resets_at)
		VALUES(?, ?, ?, ?, ?)
		ON CONFLICT(window) DO UPDATE SET
			ts = excluded.ts, session_id = excluded.session_id,
			used_percentage = excluded.used_percentage, resets_at = excluded.resets_at`,
		s.Window, s.Ts, sessionID, s.UsedPercentage, s.ResetsAt); err != nil {
		return err
	}
	// History insert, throttled: only when the newest history row for this window
	// is older than the min interval (or none exists).
	var lastTs sql.NullInt64
	_ = q.QueryRowContext(ctx, `SELECT MAX(ts) FROM rate_limit_history WHERE window = ?`, s.Window).Scan(&lastTs)
	if !lastTs.Valid || s.Ts-lastTs.Int64 >= rateLimitHistoryMinIntervalMs {
		if _, err := q.ExecContext(ctx, `
			INSERT INTO rate_limit_history(ts, window, used_percentage, resets_at) VALUES(?, ?, ?, ?)`,
			s.Ts, s.Window, s.UsedPercentage, s.ResetsAt); err != nil {
			return err
		}
	}
	return nil
}

// LatestRateLimit returns the current state for a window, or ok=false when none.
func LatestRateLimit(ctx context.Context, q Querier, window string) (RateLimitSnapshot, bool, error) {
	var s RateLimitSnapshot
	err := q.QueryRowContext(ctx, `
		SELECT window, ts, used_percentage, resets_at FROM rate_limit_latest WHERE window = ?`, window).
		Scan(&s.Window, &s.Ts, &s.UsedPercentage, &s.ResetsAt)
	if errors.Is(err, sql.ErrNoRows) {
		return RateLimitSnapshot{}, false, nil
	}
	if err != nil {
		return RateLimitSnapshot{}, false, err
	}
	return s, true, nil
}

// RateLimitPace returns the observed usage slope (percentage points per hour) for
// a window's CURRENT reset cycle. ok is false unless there are ≥2 same-window
// (same resets_at) history samples spanning ≥60s with a strictly rising usage —
// the honesty gate for the "at current pace" forecast. It never extrapolates
// across a reset boundary and never reports a flat/declining slope.
func RateLimitPace(ctx context.Context, q Querier, window string, resetsAt int64) (pctPerHour float64, ok bool, err error) {
	rows, err := q.QueryContext(ctx, `
		SELECT ts, used_percentage FROM rate_limit_history
		WHERE window = ? AND resets_at = ? ORDER BY ts ASC`, window, resetsAt)
	if err != nil {
		return 0, false, err
	}
	defer rows.Close()
	var firstTs, lastTs int64
	var firstPct, lastPct float64
	n := 0
	for rows.Next() {
		var ts int64
		var pct float64
		if err := rows.Scan(&ts, &pct); err != nil {
			return 0, false, err
		}
		if n == 0 {
			firstTs, firstPct = ts, pct
		}
		lastTs, lastPct = ts, pct
		n++
	}
	if err := rows.Err(); err != nil {
		return 0, false, err
	}
	spanMs := lastTs - firstTs
	deltaPct := lastPct - firstPct
	if n < 2 || spanMs < 60_000 || deltaPct <= 0 {
		return 0, false, nil // not enough data / not rising → no honest forecast
	}
	hours := float64(spanMs) / float64(3_600_000)
	return deltaPct / hours, true, nil
}

// CountEvents returns the total number of stored events (for status/metrics).
func CountEvents(ctx context.Context, q Querier) (int64, error) {
	var n int64
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM events`).Scan(&n)
	return n, err
}
