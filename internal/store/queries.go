package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
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
	res, err := q.ExecContext(ctx, `
		INSERT INTO events(ts, session_id, source, kind, tool, payload, tokens_in, tokens_out, cache_read, cache_write, cost_usd, key, model, cache_write_1h, agent_id)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id, key) WHERE key IS NOT NULL DO NOTHING`,
		ev.Ts.UnixMilli(), ev.SessionID, string(ev.Source), string(ev.Kind), nullStr(ev.Tool), string(ev.Payload),
		tin, tout, cr, cw, cost, key, nullStr(ev.Model), cw1h, nullStr(ev.AgentID))
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
	_, err := q.ExecContext(ctx, `
		INSERT INTO sessions(session_id, cwd, project, model, started_at, last_event_at, status, transcript_path, has_hooks, has_transcript, git_branch, version)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET
		  cwd             = COALESCE(NULLIF(excluded.cwd, ''), sessions.cwd),
		  project         = COALESCE(NULLIF(excluded.project, ''), sessions.project),
		  model           = COALESCE(NULLIF(excluded.model, ''), sessions.model),
		  transcript_path = COALESCE(NULLIF(excluded.transcript_path, ''), sessions.transcript_path),
		  git_branch      = COALESCE(NULLIF(excluded.git_branch, ''), sessions.git_branch),
		  version         = COALESCE(NULLIF(excluded.version, ''), sessions.version),
		  started_at      = MIN(sessions.started_at, excluded.started_at),
		  last_event_at   = MAX(sessions.last_event_at, excluded.last_event_at),
		  status          = CASE WHEN ? != '' THEN ? WHEN sessions.status = 'ended' THEN 'ended' ELSE 'active' END,
		  has_hooks       = MAX(sessions.has_hooks, excluded.has_hooks),
		  has_transcript  = MAX(sessions.has_transcript, excluded.has_transcript)`,
		id, p.Cwd, p.Project, p.Model, p.StartedAt, p.LastEventAt, status, p.TranscriptPath, b2i(p.FromHook), b2i(p.FromTranscript), p.GitBranch, p.Version,
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
	_ = rows.Close()
	if len(ids) == 0 {
		return nil, nil
	}
	if _, err := q.ExecContext(ctx, `UPDATE sessions SET status = 'ended' WHERE status != 'ended' AND last_event_at < ?`, before); err != nil {
		return nil, err
	}
	return ids, nil
}

const sessionCols = `session_id, COALESCE(cwd,''), COALESCE(project,''), COALESCE(model,''), COALESCE(started_at,0), COALESCE(last_event_at,0), status, COALESCE(transcript_path,''), has_hooks, has_transcript, COALESCE(git_branch,''), COALESCE(version,''), COALESCE(owned,0), COALESCE(worktree,''), COALESCE(spawn_command,''), COALESCE(pid,0), exit_code`

func scanSession(sc interface{ Scan(...any) error }) (Session, error) {
	var s Session
	var hh, ht, owned int
	var exit sql.NullInt64
	err := sc.Scan(&s.SessionID, &s.Cwd, &s.Project, &s.Model, &s.StartedAt, &s.LastEventAt, &s.Status, &s.TranscriptPath, &hh, &ht, &s.GitBranch, &s.Version, &owned, &s.Worktree, &s.SpawnCommand, &s.PID, &exit)
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
func SearchNotes(ctx context.Context, q Querier, query string, limit int) ([]AssistantNote, error) {
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
	if strings.TrimSpace(query) != "" {
		// LIKE with an escaped pattern: the corpus is one developer's own
		// sessions, so a scan is cheap, and it avoids an FTS table that would
		// need migrating and rebuilding for historical rows.
		sql += ` AND json_extract(e.payload, '$.text') LIKE ? ESCAPE '\'`
		args = append(args, "%"+escapeLike(strings.TrimSpace(query))+"%")
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

// ProjectShare is tokens/cost per project (cwd basename). Sessions is how many
// distinct sessions touched the project in the range — the "who is working in
// this repo" half of the question; cost alone does not answer it.
type ProjectShare struct {
	Project  string  `json:"project"`
	Tokens   int64   `json:"tokens"`
	CostUSD  float64 `json:"cost_usd"`
	Sessions int64   `json:"sessions"`
}

// Summarize aggregates events since fromMs (0 = all time).
func Summarize(ctx context.Context, q Querier, fromMs int64) (Summary, error) {
	s := Summary{FromMs: fromMs}
	err := q.QueryRowContext(ctx, `
		SELECT COUNT(DISTINCT session_id),
		       COALESCE(SUM(CASE WHEN kind = 'turn.assistant' THEN 1 ELSE 0 END),0),
		       COALESCE(SUM(CASE WHEN kind = 'tool.pre' THEN 1 ELSE 0 END),0),
		       COALESCE(SUM(tokens_in),0), COALESCE(SUM(tokens_out),0), COALESCE(SUM(cache_read),0), COALESCE(SUM(cache_write),0),
		       COALESCE(SUM(cost_usd),0)
		FROM events WHERE ts >= ?`, fromMs).
		Scan(&s.Sessions, &s.Turns, &s.ToolCalls, &s.TokensIn, &s.TokensOut, &s.CacheRead, &s.CacheWrite, &s.CostUSD)
	if err != nil {
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
	rows, err := q.QueryContext(ctx, `
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
	_ = rows.Close()
	rows, err = q.QueryContext(ctx, `
		SELECT COALESCE(se.project,''), COALESCE(SUM(COALESCE(e.tokens_in,0)+COALESCE(e.tokens_out,0)+COALESCE(e.cache_read,0)+COALESCE(e.cache_write,0)),0), COALESCE(SUM(e.cost_usd),0), COUNT(DISTINCT e.session_id)
		FROM events e LEFT JOIN sessions se ON se.session_id = e.session_id
		WHERE e.kind = 'turn.assistant' AND e.ts >= ? GROUP BY se.project ORDER BY 3 DESC`, fromMs)
	if err != nil {
		return s, err
	}
	defer rows.Close()
	for rows.Next() {
		var p ProjectShare
		if err := rows.Scan(&p.Project, &p.Tokens, &p.CostUSD, &p.Sessions); err != nil {
			return s, err
		}
		s.Projects = append(s.Projects, p)
	}
	return s, rows.Err()
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
		       COALESCE(AVG(CASE WHEN last_event_at > started_at THEN (last_event_at - started_at)/1000.0 END),0),
		       COUNT(DISTINCT date(started_at/1000, 'unixepoch', 'localtime'))
		FROM sessions WHERE last_event_at >= ?`, fromMs).
		Scan(&h.Sessions, &h.OwnedSessions, &h.AvgSessionSec, &h.Days)
	if err != nil {
		return h, err
	}
	err = q.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(CASE WHEN kind='turn.assistant' THEN 1 ELSE 0 END),0),
		       COALESCE(SUM(CASE WHEN kind='tool.pre' THEN 1 ELSE 0 END),0),
		       COALESCE(SUM(cost_usd),0)
		FROM events WHERE ts >= ?`, fromMs).Scan(&h.Turns, &h.ToolCalls, &h.CostUSD)
	if err != nil {
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

// ProjectFromCwd derives the project label from a working directory (its basename).
func ProjectFromCwd(cwd string) string {
	cwd = strings.TrimRight(cwd, `/\`)
	if cwd == "" {
		return ""
	}
	if i := strings.LastIndexAny(cwd, `/\`); i >= 0 {
		return cwd[i+1:]
	}
	return cwd
}
