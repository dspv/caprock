// Package cursor reads Cursor's chats — the editor's Agent and Ask chats and
// the `cursor-agent` CLI's — and carries Cursor's hook events (ADR-095,
// .ai/25-cursor.md).
//
// The editor keeps every chat in one SQLite key-value database,
// `<user dir>/globalStorage/state.vscdb`, table `cursorDiskKV`: a
// `composerData:<chat id>` row per chat (its name, model, the ordered list of
// its messages, and Cursor's own cost per model in `usageData`) and a
// `bubbleId:<chat id>:<message id>` row per message (the words, the tool call,
// and on the last reply of a turn `tokenCount`). The same database holds
// Cursor's sign-in tokens in another table; nothing here reads that table,
// and every query names its key range.
//
// The database belongs to a program that may be writing to it. It is opened
// mode=ro with a busy timeout and one connection, never immutable=1 (Cursor
// runs it in WAL mode, and an immutable open would miss what sits in the WAL).
// Nothing here writes, creates or migrates anything.
//
// Everything below was read from Cursor 2.3.41 (state.vscdb, workbench
// source) and cursor-agent 2025.09.12 (its bundled source) on 2026-11-16.
package cursor

import (
	"context"
	"crypto/md5" //nolint:gosec // the CLI's own folder naming, not a security use
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite" // the driver every other reader uses
)

// Agent is the value Cursor's sessions carry in sessions.agent.
const Agent = "cursor"

// Getenv is the environment lookup the path functions take, so tests can
// give them a machine of their own.
type Getenv func(string) string

// UserDir is the editor's user directory: ~/Library/Application
// Support/Cursor/User on macOS, %APPDATA%\Cursor\User on Windows, and
// $XDG_CONFIG_HOME/Cursor/User (default ~/.config) on Linux — the VS Code
// layout Cursor inherits. "" when no home directory is known.
func UserDir() string { return userDir(os.Getenv, runtime.GOOS, homeDir()) }

func homeDir() string {
	h, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return h
}

func userDir(getenv Getenv, goos, home string) string {
	switch goos {
	case "darwin":
		if home == "" {
			return ""
		}
		return filepath.Join(home, "Library", "Application Support", "Cursor", "User")
	case "windows":
		if a := strings.TrimSpace(getenv("APPDATA")); a != "" {
			return filepath.Join(a, "Cursor", "User")
		}
		if home == "" {
			return ""
		}
		return filepath.Join(home, "AppData", "Roaming", "Cursor", "User")
	default:
		if x := strings.TrimSpace(getenv("XDG_CONFIG_HOME")); x != "" {
			return filepath.Join(x, "Cursor", "User")
		}
		if home == "" {
			return ""
		}
		return filepath.Join(home, ".config", "Cursor", "User")
	}
}

// DBPath is the editor's chat database when it exists, "" otherwise.
func DBPath() string {
	d := UserDir()
	if d == "" {
		return ""
	}
	p := filepath.Join(d, "globalStorage", "state.vscdb")
	if fi, err := os.Stat(p); err != nil || fi.IsDir() {
		return ""
	}
	return p
}

// ConfigDir is cursor-agent's own directory, resolved as it resolves it
// (its bundled source, 2025.09.12): CURSOR_CONFIG_DIR, else
// $XDG_CONFIG_HOME/cursor, else ~/.cursor.
func ConfigDir() string { return configDir(os.Getenv, homeDir()) }

func configDir(getenv Getenv, home string) string {
	if v := strings.TrimSpace(getenv("CURSOR_CONFIG_DIR")); v != "" {
		return v
	}
	if v := strings.TrimSpace(getenv("XDG_CONFIG_HOME")); v != "" {
		return filepath.Join(v, "cursor")
	}
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".cursor")
}

// HooksPath is the user-level hooks file both the editor and the CLI read,
// ~/.cursor/hooks.json (cursor.com/docs/agent/hooks, read 2026-11-16).
func HooksPath() string {
	h := homeDir()
	if h == "" {
		return ""
	}
	return filepath.Join(h, ".cursor", "hooks.json")
}

// ChatDir is where cursor-agent keeps one chat: <config dir>/chats/<md5 of
// the folder it ran in>/<chat id>. The folder is hashed as the CLI's
// process.cwd() spells it.
func ChatDir(cwd, chatID string) string {
	c := ConfigDir()
	if c == "" || cwd == "" || chatID == "" {
		return ""
	}
	return filepath.Join(c, "chats", FolderHash(cwd), chatID)
}

// FolderHash is the name cursor-agent gives a folder's chat directory.
func FolderHash(cwd string) string {
	sum := md5.Sum([]byte(cwd)) //nolint:gosec // matching the CLI's naming
	return hex.EncodeToString(sum[:])
}

// Open opens a Cursor SQLite database read-only, with a busy timeout and one
// connection. SQLite opens lazily: a file that is not a database is found
// out on the first query.
func Open(path string) (*sql.DB, error) { return open(path, 5000) }

func open(path string, busyMs int) (*sql.DB, error) {
	if path == "" {
		return nil, errors.New("cursor: no database found")
	}
	dsn := "file:" + filepath.ToSlash(path) + "?mode=ro&_pragma=busy_timeout(" + strconv.Itoa(busyMs) + ")"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("cursor: open: %w", err)
	}
	db.SetMaxOpenConns(1)
	return db, nil
}

// ModelUsage is Cursor's own figure for one model in one chat: how many
// requests it counted and what it charged, in cents (composerData.usageData).
type ModelUsage struct {
	Requests int64
	Cents    float64
}

// Composer is one editor chat (a `composerData:` row), with what Caprock reads.
type Composer struct {
	ID       string
	Name     string
	Model    string // modelConfig.modelName: the model picked now
	MaxMode  bool
	Mode     string // unifiedMode: agent, chat (Ask), plan…
	Status   string
	Created  time.Time
	Updated  time.Time
	Messages int // entries in fullConversationHeadersOnly
	Archived bool
	// Usage is Cursor's own cost per model; nil when Cursor recorded none.
	Usage map[string]ModelUsage
	// ContextUsed and ContextLimit are Cursor's last reading of the chat's
	// context window, 0 when it kept none.
	ContextUsed, ContextLimit int64
}

// Fingerprint changes whenever anything Caprock reads from the chat changes.
func (c Composer) Fingerprint() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%d|%d|%s|%s|%d", c.Updated.UnixMilli(), c.Messages, c.Model, c.Name, c.ContextUsed)
	for _, m := range sortedKeys(c.Usage) {
		u := c.Usage[m]
		fmt.Fprintf(&b, "|%s:%d:%g", m, u.Requests, u.Cents)
	}
	return b.String()
}

// keyRange is the half-open key range of rows that start with prefix, which
// lets SQLite walk the table's unique key index instead of scanning it.
func keyRange(prefix string) (string, string) {
	end := prefix[:len(prefix)-1] + string(rune(prefix[len(prefix)-1]+1))
	return prefix, end
}

// Composers lists the editor's chats. Only scalar fields are pulled out in
// SQL, so the rows that carry a whole conversation's headers are never
// copied into Go.
func Composers(ctx context.Context, db *sql.DB) ([]Composer, error) {
	lo, hi := keyRange("composerData:")
	rows, err := db.QueryContext(ctx, `
		SELECT key,
		       COALESCE(json_extract(value,'$.name'),''),
		       COALESCE(json_extract(value,'$.modelConfig.modelName'),''),
		       COALESCE(json_extract(value,'$.modelConfig.maxMode'),0),
		       COALESCE(json_extract(value,'$.unifiedMode'),''),
		       COALESCE(json_extract(value,'$.status'),''),
		       COALESCE(json_extract(value,'$.createdAt'),0),
		       COALESCE(json_extract(value,'$.lastUpdatedAt'),0),
		       COALESCE(json_array_length(value,'$.fullConversationHeadersOnly'),0),
		       COALESCE(json_extract(value,'$.isArchived'),0),
		       COALESCE(json_extract(value,'$.usageData'),''),
		       COALESCE(json_extract(value,'$.contextTokensUsed'),0),
		       COALESCE(json_extract(value,'$.contextTokenLimit'),0)
		FROM cursorDiskKV
		WHERE key >= ? AND key < ? AND json_valid(value)`, lo, hi)
	if err != nil {
		return nil, fmt.Errorf("cursor: read chats: %w", err)
	}
	defer rows.Close()
	var out []Composer
	for rows.Next() {
		var c Composer
		var key, usage string
		var maxMode, archived int
		var created, updated, used, limit float64
		if err := rows.Scan(&key, &c.Name, &c.Model, &maxMode, &c.Mode, &c.Status, &created, &updated, &c.Messages, &archived, &usage, &used, &limit); err != nil {
			return nil, fmt.Errorf("cursor: read chat: %w", err)
		}
		c.ID = strings.TrimPrefix(key, "composerData:")
		c.MaxMode = maxMode != 0
		c.Archived = archived != 0
		c.Created = millis(created)
		c.Updated = millis(updated)
		if c.Updated.IsZero() {
			c.Updated = c.Created
		}
		c.ContextUsed, c.ContextLimit = int64(used), int64(limit)
		c.Usage = parseUsage(usage)
		out = append(out, c)
	}
	return out, rows.Err()
}

// parseUsage reads usageData: {"<model>": {"costInCents": n, "amount": n}}.
func parseUsage(raw string) map[string]ModelUsage {
	if raw == "" || raw == "{}" {
		return nil
	}
	var m map[string]struct {
		Cents  float64 `json:"costInCents"`
		Amount float64 `json:"amount"`
	}
	if json.Unmarshal([]byte(raw), &m) != nil || len(m) == 0 {
		return nil
	}
	out := make(map[string]ModelUsage, len(m))
	for k, v := range m {
		if k == "" {
			continue
		}
		out[k] = ModelUsage{Requests: int64(v.Amount), Cents: v.Cents}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func millis(ms float64) time.Time {
	if ms <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(int64(ms))
}

// HeaderIDs is the chat's messages in order: fullConversationHeadersOnly's
// bubble ids.
func HeaderIDs(ctx context.Context, db *sql.DB, composerID string) ([]string, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT COALESCE(json_extract(j.value,'$.bubbleId'),'')
		FROM cursorDiskKV, json_each(cursorDiskKV.value,'$.fullConversationHeadersOnly') j
		WHERE cursorDiskKV.key = ? AND json_valid(cursorDiskKV.value)
		ORDER BY j.key`, "composerData:"+composerID)
	if err != nil {
		return nil, fmt.Errorf("cursor: read chat order: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		if id != "" {
			out = append(out, id)
		}
	}
	return out, rows.Err()
}

// TurnTokens is one message's share of the token figures: a prompt with its
// model, or a reply with its tokenCount.
type TurnTokens struct {
	User    bool
	Model   string
	In, Out int64
}

// TokensByTurn reads the fields token totals need from every message of a
// chat, in the order ids gives. Only those fields leave SQLite.
func TokensByTurn(ctx context.Context, db *sql.DB, composerID string, ids []string) ([]TurnTokens, error) {
	lo, hi := keyRange("bubbleId:" + composerID + ":")
	rows, err := db.QueryContext(ctx, `
		SELECT key, COALESCE(json_extract(value,'$.type'),0),
		       COALESCE(json_extract(value,'$.modelInfo.modelName'),''),
		       MAX(0, COALESCE(json_extract(value,'$.tokenCount.inputTokens'),0)),
		       MAX(0, COALESCE(json_extract(value,'$.tokenCount.outputTokens'),0))
		FROM cursorDiskKV
		WHERE key >= ? AND key < ? AND json_valid(value)`, lo, hi)
	if err != nil {
		return nil, fmt.Errorf("cursor: read token figures: %w", err)
	}
	defer rows.Close()
	byID := map[string]TurnTokens{}
	for rows.Next() {
		var key, model string
		var typ int
		var tin, tout int64
		if err := rows.Scan(&key, &typ, &model, &tin, &tout); err != nil {
			return nil, err
		}
		byID[key[strings.LastIndexByte(key, ':')+1:]] = TurnTokens{User: typ == 1, Model: model, In: tin, Out: tout}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]TurnTokens, 0, len(ids))
	for _, id := range ids {
		if t, ok := byID[id]; ok {
			out = append(out, t)
		}
	}
	return out, nil
}

// Bubble is one message of an editor chat.
type Bubble struct {
	ID       string
	User     bool // type 1; otherwise an assistant step (type 2)
	At       time.Time
	Text     string
	Thinking string
	Model    string // modelInfo.modelName, on the turn's first rows
	// TokensIn and TokensOut are tokenCount, which Cursor fills on the last
	// reply of a turn: the context of that turn's last request, and what
	// that request wrote. Zero on every other row.
	TokensIn, TokensOut int64
	// ContextUsed and ContextLimit are contextWindowStatusAtCreation on a
	// prompt: how full Cursor measured the chat's context window as the
	// prompt was written, and the window's size. Zero when it kept none.
	ContextUsed, ContextLimit int64
	Tool                      *Tool
	// Call is the model request this row belongs to (modelCallId of a tool
	// call, else usageUuid), "" when Cursor kept none.
	Call string
	// TerminalCwd is lastTerminalCwd, the folder Cursor's terminal was in.
	TerminalCwd string
	// Visible is how many characters of the conversation this row adds that
	// a person can read: words, thinking, a tool call's arguments and result.
	Visible int
}

// Tool is a tool call as Cursor recorded it (toolFormerData).
type Tool struct {
	ID     string
	Name   string
	Args   map[string]any
	Status string // completed, error, cancelled, loading
	Error  bool
	// Result is toolFormerData.result, the JSON text Cursor stores the
	// call's output as ({"output": …} for a terminal command, {"contents":
	// …} for a read…); "" while the call runs.
	Result string
	// ErrorText is what Cursor told the model went wrong, when it did.
	ErrorText string
	// Decision is userDecision: accepted or rejected, "" when nobody was
	// asked.
	Decision string
}

type rawBubble struct {
	Type      int    `json:"type"`
	BubbleID  string `json:"bubbleId"`
	CreatedAt any    `json:"createdAt"`
	Text      string `json:"text"`
	Thinking  *struct {
		Text string `json:"text"`
	} `json:"thinking"`
	ModelInfo *struct {
		ModelName string `json:"modelName"`
	} `json:"modelInfo"`
	TokenCount *struct {
		In  int64 `json:"inputTokens"`
		Out int64 `json:"outputTokens"`
	} `json:"tokenCount"`
	Context *struct {
		Used  int64 `json:"tokensUsed"`
		Limit int64 `json:"tokenLimit"`
	} `json:"contextWindowStatusAtCreation"`
	UsageUUID   string `json:"usageUuid"`
	TerminalCwd string `json:"lastTerminalCwd"`
	Tool        *struct {
		Name        string `json:"name"`
		ToolCallID  string `json:"toolCallId"`
		ModelCallID string `json:"modelCallId"`
		Status      string `json:"status"`
		RawArgs     string `json:"rawArgs"`
		Result      string `json:"result"`
		Error       any    `json:"error"`
		Decision    string `json:"userDecision"`
	} `json:"toolFormerData"`
}

// Bubbles reads the messages ids names, in that order (HeaderIDs). A message
// that is missing or unreadable is skipped. Only the rows asked for are read,
// by key, so a pass over a long chat that grew by two messages reads two.
func Bubbles(ctx context.Context, db *sql.DB, composerID string, ids []string) ([]Bubble, error) {
	got := make(map[string]Bubble, len(ids))
	for start := 0; start < len(ids); start += 400 {
		end := min(start+400, len(ids))
		args := make([]any, 0, end-start)
		marks := make([]string, 0, end-start)
		for _, id := range ids[start:end] {
			args = append(args, "bubbleId:"+composerID+":"+id)
			marks = append(marks, "?")
		}
		rows, err := db.QueryContext(ctx, `SELECT key, value FROM cursorDiskKV WHERE key IN (`+strings.Join(marks, ",")+`)`, args...)
		if err != nil {
			return nil, fmt.Errorf("cursor: read messages: %w", err)
		}
		for rows.Next() {
			var key string
			var val []byte
			if err := rows.Scan(&key, &val); err != nil {
				_ = rows.Close()
				return nil, err
			}
			id := key[strings.LastIndexByte(key, ':')+1:]
			if b, ok := parseBubble(id, val); ok {
				got[id] = b
			}
		}
		err = rows.Err()
		_ = rows.Close()
		if err != nil {
			return nil, err
		}
	}
	out := make([]Bubble, 0, len(ids))
	for _, id := range ids {
		if b, ok := got[id]; ok {
			out = append(out, b)
		}
	}
	return out, nil
}

func parseBubble(id string, val []byte) (Bubble, bool) {
	var r rawBubble
	if json.Unmarshal(val, &r) != nil {
		return Bubble{}, false
	}
	b := Bubble{ID: id, User: r.Type == 1, At: parseTime(r.CreatedAt), Text: r.Text, TerminalCwd: r.TerminalCwd, Call: r.UsageUUID}
	if r.Thinking != nil {
		b.Thinking = r.Thinking.Text
	}
	if r.ModelInfo != nil {
		b.Model = r.ModelInfo.ModelName
	}
	if r.TokenCount != nil {
		b.TokensIn, b.TokensOut = max(0, r.TokenCount.In), max(0, r.TokenCount.Out)
	}
	if r.Context != nil {
		b.ContextUsed, b.ContextLimit = max(0, r.Context.Used), max(0, r.Context.Limit)
	}
	b.Visible = len(r.Text) + len(b.Thinking)
	if t := r.Tool; t != nil && t.Name != "" {
		b.Tool = &Tool{ID: t.ToolCallID, Name: t.Name, Args: arguments(t.RawArgs), Status: t.Status,
			Error: t.Error != nil || t.Status == "error", Result: t.Result, ErrorText: errorText(t.Error), Decision: t.Decision}
		if t.ModelCallID != "" {
			b.Call = t.ModelCallID
		}
		b.Visible += len(t.RawArgs) + len(t.Result)
	}
	return b, true
}

// errorText reads toolFormerData.error, a JSON string holding
// {clientVisibleErrorMessage, modelVisibleErrorMessage}: the model's
// message, else the one Cursor showed, else the text as it is.
func errorText(v any) string {
	s, ok := v.(string)
	if !ok || s == "" {
		return ""
	}
	var e struct {
		Model  string `json:"modelVisibleErrorMessage"`
		Client string `json:"clientVisibleErrorMessage"`
	}
	if json.Unmarshal([]byte(s), &e) == nil {
		if e.Model != "" {
			return e.Model
		}
		if e.Client != "" {
			return e.Client
		}
	}
	return s
}

// parseTime reads createdAt, which newer rows write as an ISO string and
// older ones as unix milliseconds.
func parseTime(v any) time.Time {
	switch t := v.(type) {
	case string:
		if ts, err := time.Parse(time.RFC3339Nano, t); err == nil {
			return ts
		}
	case float64:
		return millis(t)
	}
	return time.Time{}
}

func arguments(raw string) map[string]any {
	if raw == "" {
		return map[string]any{}
	}
	var m map[string]any
	if json.Unmarshal([]byte(raw), &m) == nil && m != nil {
		return m
	}
	return map[string]any{}
}

// Workspaces maps editor chats to the folder their window had open, from
// each workspace's own database (workspaceStorage/<hash>/state.vscdb, key
// composer.composerData, which lists the window's chats) and its
// workspace.json. A chat whose window is gone maps to nothing.
func Workspaces(ctx context.Context, userDir string) map[string]string {
	out := map[string]string{}
	if userDir == "" {
		return out
	}
	base := filepath.Join(userDir, "workspaceStorage")
	entries, err := os.ReadDir(base)
	if err != nil {
		return out
	}
	for _, e := range entries {
		if !e.IsDir() || ctx.Err() != nil {
			continue
		}
		dir := filepath.Join(base, e.Name())
		folder := workspaceFolder(filepath.Join(dir, "workspace.json"))
		if folder == "" {
			continue
		}
		p := filepath.Join(dir, "state.vscdb")
		if _, err := os.Stat(p); err != nil {
			continue
		}
		for _, id := range windowChats(ctx, p) {
			out[id] = folder
		}
	}
	return out
}

func windowChats(ctx context.Context, path string) []string {
	db, err := open(path, 1000)
	if err != nil {
		return nil
	}
	defer db.Close()
	var raw sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT CAST(value AS TEXT) FROM ItemTable WHERE key = 'composer.composerData'`).Scan(&raw); err != nil || !raw.Valid {
		return nil
	}
	var v struct {
		All []struct {
			ID string `json:"composerId"`
		} `json:"allComposers"`
	}
	if json.Unmarshal([]byte(raw.String), &v) != nil {
		return nil
	}
	ids := make([]string, 0, len(v.All))
	for _, c := range v.All {
		if c.ID != "" {
			ids = append(ids, c.ID)
		}
	}
	return ids
}

// workspaceFolder is the local folder a workspace.json names: "folder" as a
// file:// URI, or the first folder of the .code-workspace file "workspace"
// points at. A remote folder (vscode-remote://…) is no folder of this
// machine's and reads as "".
func workspaceFolder(path string) string {
	var w struct {
		Folder    string `json:"folder"`
		Workspace string `json:"workspace"`
	}
	b, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(b, &w) != nil {
		return ""
	}
	if w.Folder != "" {
		return fileURIPath(w.Folder)
	}
	ws := fileURIPath(w.Workspace)
	if ws == "" {
		return ""
	}
	wb, err := os.ReadFile(ws)
	if err != nil {
		return ""
	}
	var cw struct {
		Folders []struct {
			Path string `json:"path"`
		} `json:"folders"`
	}
	if json.Unmarshal(wb, &cw) != nil || len(cw.Folders) == 0 || cw.Folders[0].Path == "" {
		return ""
	}
	p := cw.Folders[0].Path
	if !filepath.IsAbs(p) {
		p = filepath.Join(filepath.Dir(ws), p)
	}
	return filepath.Clean(p)
}

// fileURIPath turns file:///Users/x/dev into /Users/x/dev and
// file:///c%3A/dev into C:\dev; any other scheme is "".
func fileURIPath(u string) string {
	if !strings.HasPrefix(u, "file://") {
		return ""
	}
	pu, err := url.Parse(u)
	if err != nil {
		return ""
	}
	p := pu.Path
	// A Windows drive arrives as /c:/dev.
	if len(p) >= 3 && p[0] == '/' && p[2] == ':' {
		p = strings.ToUpper(p[1:2]) + p[2:]
	}
	return filepath.FromSlash(p)
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}
