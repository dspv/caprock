// Package hermes reads sessions from Hermes Agent's SQLite state database.
//
// Hermes Agent (Nous Research's hermes-agent) keeps every conversation it has
// — in its own CLI and TUI, in cron jobs, in a Telegram chat through its
// gateway — in one database, `<hermes home>/state.db`. The `sessions` table
// carries per-session token counters and Hermes's own cost figure, and
// `messages` keeps the prose, the prompts and the tool calls. Reading it is a
// translation job, as OpenCode's is: the numbers arrive finished and are mapped
// onto Caprock's event model, never recomputed.
//
// The database belongs to another program that is writing to it while we read.
// It is opened with mode=ro, which never takes a write lock, and a busy
// timeout, so a moment where Hermes holds the database is a wait rather than an
// error. It is never opened with immutable=1: Hermes runs in WAL mode, and an
// immutable open both misses whatever sits in the WAL and may read a page
// mid-change. Nothing here writes, creates or migrates anything.
//
// Everything below was read from Hermes Agent v0.21.6's own source
// (hermes_state_common.py, hermes_state_usage.py, agent/usage_pricing.py,
// agent/session_source.py, hermes_state_ids.py) on 2026-10-15; see
// .ai/24-hermes.md.
package hermes

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite" // the driver every other reader uses
)

// Agent is the value sessions read from Hermes carry in sessions.agent.
const Agent = "hermes"

// EnvHome is Hermes's own override for its data directory.
const EnvHome = "HERMES_HOME"

// Home is the directory Hermes keeps its state in, resolved the way Hermes
// resolves it (hermes_constants.get_hermes_home): HERMES_HOME when set, else
// %LOCALAPPDATA%\hermes on Windows and ~/.hermes everywhere else. "" when no
// home directory can be found at all.
func Home() string {
	return home(os.Getenv, runtime.GOOS)
}

func home(getenv func(string) string, goos string) string {
	if h := strings.TrimSpace(getenv(EnvHome)); h != "" {
		return h
	}
	if goos == "windows" {
		if la := strings.TrimSpace(getenv("LOCALAPPDATA")); la != "" {
			return filepath.Join(la, "hermes")
		}
	}
	h, err := os.UserHomeDir()
	if err != nil || h == "" {
		return ""
	}
	if goos == "windows" {
		return filepath.Join(h, "AppData", "Local", "hermes")
	}
	return filepath.Join(h, ".hermes")
}

// DBPath is Hermes's state database when it exists, "" otherwise.
func DBPath() string {
	h := Home()
	if h == "" {
		return ""
	}
	p := filepath.Join(h, "state.db")
	if fi, err := os.Stat(p); err != nil || fi.IsDir() {
		return ""
	}
	return p
}

// Open opens Hermes's database read-only. SQLite opens lazily, so a file
// that is not a database (or one that is locked) is only found out on the
// first query; callers read Sessions once before announcing anything.
func Open(path string) (*sql.DB, error) { return open(path, 5000) }

// open is Open with the busy timeout, in milliseconds, as a parameter: how
// long a read waits for Hermes to finish a write before it gives up until the
// next poll.
func open(path string, busyMs int) (*sql.DB, error) {
	if path == "" {
		return nil, errors.New("hermes: no database found")
	}
	dsn := "file:" + filepath.ToSlash(path) + "?mode=ro&_pragma=busy_timeout(" + strconv.Itoa(busyMs) + ")"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("hermes: open: %w", err)
	}
	// One reader connection: the smallest footprint on another program's WAL.
	db.SetMaxOpenConns(1)
	return db, nil
}

// Session is one row of Hermes's `sessions` table, with the figures Caprock
// uses. Times are Hermes's own unix seconds converted to time.Time; a zero
// time means the column was NULL.
type Session struct {
	ID       string
	Source   string // cli, tui, desktop, acp, cron, telegram, oneshot, …
	ParentID string
	Model    string
	Title    string
	Cwd      string
	Branch   string

	Started      time.Time
	Ended        time.Time
	EndReason    string
	LastActivity time.Time

	// The cumulative counters Hermes keeps per session. InputTokens is fresh
	// input: Hermes's prompt is input + cache read + cache write
	// (CanonicalUsage.prompt_tokens), the same split as Caprock's.
	InputTokens, OutputTokens         int64
	CacheReadTokens, CacheWriteTokens int64
	ReasoningTokens                   int64
	APICalls, ToolCalls, Messages     int64

	BillingProvider, BillingMode string
	CostStatus, CostSource       string
	Estimated, Actual            sql.NullFloat64

	// The model_config markers Hermes writes on a child row, which say what
	// kind of child it is (hermes_state_common.py, delegate_tool.py).
	DelegateFrom, BranchedFrom, ResetFrom string
}

// Tokens is every token the session moved.
func (s Session) Tokens() int64 {
	return s.InputTokens + s.OutputTokens + s.CacheReadTokens + s.CacheWriteTokens
}

// Cost bases, as the UI labels them.
const (
	BasisActual    = "actual"    // the provider reported what it billed
	BasisEstimated = "estimated" // Hermes priced the tokens from its own table
	BasisIncluded  = "included"  // a subscription route: no per-call invoice
	BasisUnknown   = "unknown"   // Hermes could not price it
)

// realCostSources are Hermes's cost sources that come from the provider's own
// invoice or generation record rather than from a price list
// (usage_pricing.CostSource).
var realCostSources = map[string]bool{"provider_cost_api": true, "provider_generation_api": true}

// Cost is the session's spend and what kind of figure it is. Hermes's actual
// figure wins when Hermes says it is real — status "actual", or a source that
// is the provider's own billing — and is recorded; otherwise its estimate. A
// subscription route is priced at zero and called that. ok is false when
// Hermes has no figure at all, which Caprock shows as unpriced rather than as
// a guess (rule 6).
//
// A provider profile may hand Hermes the provider's own figure as the call's
// cost (providers/base.py get_usage_cost, "distinguish estimates from
// invoices"); Hermes then writes it to estimated_cost_usd with status
// "actual" and leaves actual_cost_usd empty, so that pair reads as actual too.
// Hermes's own readers take COALESCE(actual_cost_usd, estimated_cost_usd)
// (hermes_state_maintenance.py), which is the same figure.
func (s Session) Cost() (usd float64, basis string, ok bool) {
	real := s.CostStatus == "actual" || realCostSources[s.CostSource]
	if s.Actual.Valid && (real || s.Actual.Float64 > 0) {
		return s.Actual.Float64, BasisActual, true
	}
	if real && s.Estimated.Valid {
		return s.Estimated.Float64, BasisActual, true
	}
	if s.CostStatus == "included" || s.BillingMode == "subscription_included" {
		v := 0.0
		if s.Estimated.Valid {
			v = s.Estimated.Float64
		}
		return v, BasisIncluded, true
	}
	if s.Estimated.Valid && (s.Estimated.Float64 > 0 || s.CostStatus == "estimated") {
		return s.Estimated.Float64, BasisEstimated, true
	}
	return 0, BasisUnknown, false
}

// Background reports whether nobody was reading the session as it ran.
// Hermes defines its attended sources itself (agent/session_source.py,
// ATTENDED_SOURCES): its CLI, TUI, desktop app and ACP editors. Everything
// else — cron, a Telegram or Slack chat through the gateway, a one-shot run, a
// kanban worker — is work that happened without a person watching it.
func Background(source string) bool {
	switch source {
	case "cli", "tui", "desktop", "acp", "":
		return false
	}
	return true
}

// IDTime is the moment Hermes's own session id was minted, when the id has
// the CLI's `YYYYMMDD_HHMMSS_<hex>` shape (hermes_state_ids.new_session_id),
// in local time as Hermes writes it. The CLI mints the id when it starts and
// creates the row only on the first message, so this — not started_at — is
// when a process Caprock spawned began.
func IDTime(id string) (time.Time, bool) {
	if len(id) < 16 || id[8] != '_' || id[15] != '_' {
		return time.Time{}, false
	}
	t, err := time.ParseInLocation("20060102_150405", id[:15], time.Local)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// Message is one row of Hermes's `messages` table.
type Message struct {
	ID        int64
	SessionID string
	Role      string // user, assistant, tool, system
	Content   string
	ToolName  string
	ToolCalls string // JSON, OpenAI's shape
	At        time.Time
	// Summary marks the synthetic summary Hermes writes when it compresses a
	// conversation: its words, not the model's reply.
	Summary bool
}

// columns lists a table's columns, so a query asks only for what this
// version of Hermes has: an older one without a column reads it as NULL, a
// newer one with more is unaffected.
func columns(ctx context.Context, db *sql.DB, table string) (map[string]bool, error) {
	rows, err := db.QueryContext(ctx, `SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out[n] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("hermes: no %s table", table)
	}
	return out, nil
}

// col is the column when the table has it, else NULL.
func col(have map[string]bool, name string) string {
	if have[name] {
		return name
	}
	return "NULL"
}

// Sessions reads every session, oldest first, so a parent is always read
// before the children it spawned.
func Sessions(ctx context.Context, db *sql.DB) ([]Session, error) {
	have, err := columns(ctx, db, "sessions")
	if err != nil {
		return nil, err
	}
	text := func(name string) string { return "COALESCE(" + col(have, name) + ",'')" }
	num := func(name string) string { return "COALESCE(" + col(have, name) + ",0)" }
	cfg := func(key string) string {
		if !have["model_config"] {
			return "''"
		}
		return "CASE WHEN json_valid(model_config) THEN COALESCE(json_extract(model_config,'$." + key + "'),'') ELSE '' END"
	}
	q := `SELECT id, ` + text("source") + `, ` + text("parent_session_id") + `, ` + text("model") + `,
	             ` + text("title") + `, ` + text("cwd") + `, ` + text("git_branch") + `,
	             ` + num("started_at") + `, ` + num("ended_at") + `, ` + text("end_reason") + `, ` + num("last_activity_at") + `,
	             ` + num("input_tokens") + `, ` + num("output_tokens") + `, ` + num("cache_read_tokens") + `,
	             ` + num("cache_write_tokens") + `, ` + num("reasoning_tokens") + `,
	             ` + num("api_call_count") + `, ` + num("tool_call_count") + `, ` + num("message_count") + `,
	             ` + text("billing_provider") + `, ` + text("billing_mode") + `,
	             ` + text("cost_status") + `, ` + text("cost_source") + `,
	             ` + col(have, "estimated_cost_usd") + `, ` + col(have, "actual_cost_usd") + `,
	             ` + cfg("_delegate_from") + `, ` + cfg("_branched_from") + `, ` + cfg("_reset_from") + `
	      FROM sessions ORDER BY ` + num("started_at") + `, id`
	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("hermes: read sessions: %w", err)
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		var s Session
		var started, ended, last float64
		if err := rows.Scan(&s.ID, &s.Source, &s.ParentID, &s.Model, &s.Title, &s.Cwd, &s.Branch,
			&started, &ended, &s.EndReason, &last,
			&s.InputTokens, &s.OutputTokens, &s.CacheReadTokens, &s.CacheWriteTokens, &s.ReasoningTokens,
			&s.APICalls, &s.ToolCalls, &s.Messages,
			&s.BillingProvider, &s.BillingMode, &s.CostStatus, &s.CostSource,
			&s.Estimated, &s.Actual,
			&s.DelegateFrom, &s.BranchedFrom, &s.ResetFrom); err != nil {
			return nil, fmt.Errorf("hermes: read session: %w", err)
		}
		s.Started, s.Ended, s.LastActivity = unix(started), unix(ended), unix(last)
		out = append(out, s)
	}
	return out, rows.Err()
}

// Messages reads one session's messages with an id above after, in order.
func Messages(ctx context.Context, db *sql.DB, sessionID string, after int64) ([]Message, error) {
	have, err := columns(ctx, db, "messages")
	if err != nil {
		return nil, err
	}
	summary := "0"
	if have["_compressed_summary"] {
		summary = "COALESCE(_compressed_summary,0)"
	}
	rows, err := db.QueryContext(ctx, `
		SELECT id, session_id, COALESCE(role,''), COALESCE(CAST(content AS TEXT),''),
		       COALESCE(`+col(have, "tool_name")+`,''), COALESCE(`+col(have, "tool_calls")+`,''),
		       COALESCE(timestamp,0), `+summary+`
		FROM messages WHERE session_id = ? AND id > ? ORDER BY id`, sessionID, after)
	if err != nil {
		return nil, fmt.Errorf("hermes: read messages: %w", err)
	}
	defer rows.Close()
	var out []Message
	for rows.Next() {
		var m Message
		var ts float64
		var sum int
		if err := rows.Scan(&m.ID, &m.SessionID, &m.Role, &m.Content, &m.ToolName, &m.ToolCalls, &ts, &sum); err != nil {
			return nil, fmt.Errorf("hermes: read message: %w", err)
		}
		m.At, m.Summary = unix(ts), sum != 0
		m.Content = decodeContent(m.Content)
		out = append(out, m)
	}
	return out, rows.Err()
}

// unix converts Hermes's float seconds; zero stays the zero time.
func unix(sec float64) time.Time {
	if sec <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(int64(sec * 1000))
}
