// Package export writes Caprock's normalized record out as a flat table.
//
// Five agents write five undocumented formats — Claude Code JSONL and hooks,
// Codex rollouts, OpenCode's SQLite, Gemini's telemetry file, DeepSeek — and
// ingest turns all of them into the same rows. This package is the way back
// out: one stable, documented column set (docs/schema.md) per table, so a
// spreadsheet, a notebook or a warehouse reads every agent the same way.
//
// It reads the database directly and read-only. That is what lets it run with
// the daemon down, and it is why it never writes: the export is a view of the
// record, not a second owner of it.
package export

import (
	"context"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite" // the driver the store uses
)

// Tables and formats the command accepts.
var (
	Tables  = []string{"events", "sessions"}
	Formats = []string{"tsv", "csv", "jsonl"}
	Agents  = []string{"claude", "codex", "opencode", "gemini", "deepseek"}
)

// Options selects what is written.
type Options struct {
	Table   string    // "events" (default) or "sessions"
	Format  string    // "tsv" (default), "csv" or "jsonl"
	Since   time.Time // zero: everything
	Agent   string    // empty: every agent
	Payload bool      // events only, jsonl only: include the raw source payload
}

type colKind int

const (
	kText colKind = iota
	kInt
	kReal
	kTime // unix ms in the database, RFC 3339 UTC on the way out
)

type column struct {
	name string
	expr string
	kind colKind
}

// The column sets are the contract (docs/schema.md, .ai/03-contracts.md
// § Export). Adding a column at the end is compatible; renaming, removing or
// reordering one is not.
var eventCols = []column{
	{"ts", "e.ts", kTime},
	{"session_id", "e.session_id", kText},
	{"agent", "COALESCE(s.agent,'claude')", kText},
	{"subagent_id", "e.agent_id", kText},
	{"source", "e.source", kText},
	{"kind", "e.kind", kText},
	{"tool", "e.tool", kText},
	{"model", "e.model", kText},
	{"tokens_in", "e.tokens_in", kInt},
	{"tokens_out", "e.tokens_out", kInt},
	{"cache_read", "e.cache_read", kInt},
	{"cache_write", "e.cache_write", kInt},
	{"cache_write_1h", "e.cache_write_1h", kInt},
	{"cost_usd", "e.cost_usd", kReal},
	{"tool_bytes", "e.tool_bytes", kInt},
	{"touch_dir", "e.touch_dir", kText},
	{"project", "s.project", kText},
	{"repo_root", "s.repo_root", kText},
	{"msg_id", "e.msg_id", kText},
}

var payloadCol = column{"payload", "e.payload", kText}

var sessionCols = []column{
	{"session_id", "s.session_id", kText},
	{"agent", "s.agent", kText},
	{"model", "s.model", kText},
	{"project", "s.project", kText},
	{"repo_root", "s.repo_root", kText},
	{"repo_path", "s.repo_path", kText},
	{"cwd", "s.cwd", kText},
	{"git_branch", "s.git_branch", kText},
	{"worktree", "s.worktree", kText},
	{"started_at", "s.started_at", kTime},
	{"last_event_at", "s.last_event_at", kTime},
	{"worked_at", "s.worked_at", kTime},
	{"status", "s.status", kText},
	{"title", "s.title", kText},
	{"parent_session", "s.parent_session", kText},
	{"owned", "s.owned", kInt},
	{"agent_version", "s.version", kText},
}

// OpenReadOnly opens the database at path without the ability to write it.
// The path goes through a file: URI so a space (macOS "Application Support"),
// a '#' or a '?' cannot be read as part of the query string, and a Windows
// drive path is spelled the way SQLite's URI parser expects (file:///C:/…).
func OpenReadOnly(path string) (*sql.DB, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	p := filepath.ToSlash(abs)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p // C:/x → /C:/x
	}
	u := url.URL{Scheme: "file", Path: p, RawQuery: "mode=ro&_pragma=busy_timeout(5000)"}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("open %s read-only: %w", path, err)
	}
	return db, nil
}

// Write streams the selected table to w and returns the number of data rows.
func Write(ctx context.Context, db *sql.DB, w io.Writer, o Options) (int64, error) {
	if o.Table == "" {
		o.Table = "events"
	}
	if o.Format == "" {
		o.Format = "tsv"
	}
	if !contains(Tables, o.Table) {
		return 0, fmt.Errorf("unknown table %q (want %s)", o.Table, strings.Join(Tables, " or "))
	}
	if !contains(Formats, o.Format) {
		return 0, fmt.Errorf("unknown format %q (want %s)", o.Format, strings.Join(Formats, ", "))
	}
	if o.Agent != "" && !contains(Agents, o.Agent) {
		return 0, fmt.Errorf("unknown agent %q (want one of %s)", o.Agent, strings.Join(Agents, ", "))
	}
	if o.Payload && (o.Table != "events" || o.Format != "jsonl") {
		return 0, fmt.Errorf("--payload is for events as jsonl: the raw payload is JSON with prose in it, and a cell of it breaks a table")
	}

	cols, query, args := build(o)
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	out := newWriter(w, o.Format, cols)
	if err := out.header(); err != nil {
		return 0, err
	}
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i, c := range cols {
		switch c.kind {
		case kText:
			ptrs[i] = new(sql.NullString)
		case kReal:
			ptrs[i] = new(sql.NullFloat64)
		default:
			ptrs[i] = new(sql.NullInt64)
		}
	}
	var n int64
	for rows.Next() {
		if err := rows.Scan(ptrs...); err != nil {
			return n, err
		}
		for i, c := range cols {
			vals[i] = value(c.kind, ptrs[i])
		}
		if err := out.row(vals); err != nil {
			return n, err
		}
		n++
	}
	if err := rows.Err(); err != nil {
		return n, err
	}
	return n, out.flush()
}

func build(o Options) ([]column, string, []any) {
	var (
		cols  []column
		from  string
		where []string
		args  []any
		order string
	)
	if o.Table == "sessions" {
		cols = sessionCols
		from = "sessions s"
		// A session that holds only hidden product machinery (Codex's review
		// turns) is not work anyone did; the dashboard does not list it either.
		where = append(where, "EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.session_id AND e.internal = 0)")
		if !o.Since.IsZero() {
			where = append(where, "s.last_event_at >= ?")
			args = append(args, o.Since.UnixMilli())
		}
		if o.Agent != "" {
			where = append(where, "s.agent = ?")
			args = append(args, o.Agent)
		}
		order = "s.started_at, s.session_id"
	} else {
		cols = eventCols
		if o.Payload {
			cols = append(append([]column{}, eventCols...), payloadCol)
		}
		from = "events e LEFT JOIN sessions s ON s.session_id = e.session_id"
		where = append(where, "e.internal = 0")
		if !o.Since.IsZero() {
			where = append(where, "e.ts >= ?")
			args = append(args, o.Since.UnixMilli())
		}
		if o.Agent != "" {
			where = append(where, "COALESCE(s.agent,'claude') = ?")
			args = append(args, o.Agent)
		}
		order = "e.id"
	}
	exprs := make([]string, len(cols))
	for i, c := range cols {
		exprs[i] = c.expr
	}
	q := "SELECT " + strings.Join(exprs, ", ") + " FROM " + from +
		" WHERE " + strings.Join(where, " AND ") + " ORDER BY " + order
	return cols, q, args
}

// value turns a scanned cell into nil, int64, float64 or string.
func value(k colKind, p any) any {
	switch v := p.(type) {
	case *sql.NullString:
		if !v.Valid {
			return nil
		}
		return v.String
	case *sql.NullFloat64:
		if !v.Valid {
			return nil
		}
		return v.Float64
	case *sql.NullInt64:
		if !v.Valid {
			return nil
		}
		if k == kTime {
			if v.Int64 <= 0 {
				return nil // 0 is "never" (worked_at before it was known), not 1970
			}
			return time.UnixMilli(v.Int64).UTC().Format("2006-01-02T15:04:05.000Z")
		}
		return v.Int64
	}
	return nil
}

// ── Output formats ─────────────────────────────────────────────────────────

type rowWriter interface {
	header() error
	row([]any) error
	flush() error
}

func newWriter(w io.Writer, format string, cols []column) rowWriter {
	names := make([]string, len(cols))
	for i, c := range cols {
		names[i] = c.name
	}
	switch format {
	case "csv":
		return &csvWriter{w: csv.NewWriter(w), names: names}
	case "jsonl":
		return &jsonlWriter{w: w, names: names}
	default:
		return &tsvWriter{w: w, names: names}
	}
}

func cell(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	return fmt.Sprint(v)
}

// TSV as the "linear TSV" convention spells it: a cell never contains a raw
// tab or line break, so one line is one row for cut, awk and every loader.
var tsvEscaper = strings.NewReplacer(`\`, `\\`, "\t", `\t`, "\n", `\n`, "\r", `\r`)

type tsvWriter struct {
	w     io.Writer
	names []string
	buf   []byte
}

func (t *tsvWriter) header() error {
	_, err := io.WriteString(t.w, strings.Join(t.names, "\t")+"\n")
	return err
}

func (t *tsvWriter) row(vals []any) error {
	t.buf = t.buf[:0]
	for i, v := range vals {
		if i > 0 {
			t.buf = append(t.buf, '\t')
		}
		t.buf = append(t.buf, tsvEscaper.Replace(cell(v))...)
	}
	t.buf = append(t.buf, '\n')
	_, err := t.w.Write(t.buf)
	return err
}

func (t *tsvWriter) flush() error { return nil }

type csvWriter struct {
	w     *csv.Writer
	names []string
	rec   []string
}

func (c *csvWriter) header() error { return c.w.Write(c.names) }

func (c *csvWriter) row(vals []any) error {
	if c.rec == nil {
		c.rec = make([]string, len(vals))
	}
	for i, v := range vals {
		c.rec[i] = cell(v)
	}
	return c.w.Write(c.rec)
}

func (c *csvWriter) flush() error {
	c.w.Flush()
	return c.w.Error()
}

type jsonlWriter struct {
	w     io.Writer
	names []string
	buf   []byte
}

func (j *jsonlWriter) header() error { return nil }

// row writes keys in column order, which a map would not keep.
func (j *jsonlWriter) row(vals []any) error {
	j.buf = append(j.buf[:0], '{')
	for i, v := range vals {
		if i > 0 {
			j.buf = append(j.buf, ',')
		}
		k, _ := json.Marshal(j.names[i])
		j.buf = append(j.buf, k...)
		j.buf = append(j.buf, ':')
		if j.names[i] == "payload" {
			if s, ok := v.(string); ok && json.Valid([]byte(s)) {
				j.buf = append(j.buf, s...) // already JSON: embed it, do not quote it
				continue
			}
		}
		b, err := json.Marshal(v)
		if err != nil {
			return err
		}
		j.buf = append(j.buf, b...)
	}
	j.buf = append(j.buf, '}', '\n')
	_, err := j.w.Write(j.buf)
	return err
}

func (j *jsonlWriter) flush() error { return nil }

// ParseSince reads "30d", "12h", "90m" (relative to now) or a date
// "2006-01-02" (midnight, local time).
func ParseSince(s string, now time.Time) (time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, nil
	}
	if t, err := time.ParseInLocation("2006-01-02", s, time.Local); err == nil {
		return t, nil
	}
	if strings.HasSuffix(s, "d") {
		n, err := strconv.Atoi(strings.TrimSuffix(s, "d"))
		if err != nil || n < 0 {
			return time.Time{}, fmt.Errorf("--since %q: want 30d, 12h or 2026-09-01", s)
		}
		return now.AddDate(0, 0, -n), nil
	}
	d, err := time.ParseDuration(s)
	if err != nil || d < 0 {
		return time.Time{}, fmt.Errorf("--since %q: want 30d, 12h or 2026-09-01", s)
	}
	return now.Add(-d), nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
