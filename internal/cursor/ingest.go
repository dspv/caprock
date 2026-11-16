package cursor

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/ingest"
	"github.com/dspv/caprock/internal/rollup"
)

// Ingester copies the editor's chats into Caprock's store.
//
// It polls, as the Hermes and OpenCode readers do. A pass first compares the
// database's size and modification time (and its WAL's) with the last pass,
// so a Cursor that is closed costs one stat per tick; only a chat whose
// fingerprint moved is read, and only from its last prompt on.
//
// Usage is reconciled, as Hermes's is. Cursor fills `tokenCount` on the last
// reply of a turn some time after that reply is first written, and keeps its
// cost as a running total per chat and model (`usageData`), so neither can be
// stored with the message it belongs to the first time the message is read.
// Each pass subtracts what Caprock holds for the chat from Cursor's totals
// and records the difference — on the newest reply the pass stores, or on a
// `turn.assistant` of its own marked `usage_only`, keyed by the totals it
// brings the chat to. Caprock's totals equal Cursor's and a re-read adds
// nothing.
type Ingester struct {
	db      *sql.DB
	path    string
	userDir string
	rec     *rollup.Recorder
	log     *slog.Logger
	every   time.Duration

	mu    sync.Mutex
	sig   string
	seen  map[string]string // chat id → fingerprint read
	from  map[string]int    // chat id → index of its last prompt, where the next read starts
	cwd   map[string]string // chat id → folder
	ws    map[string]string // workspace map, refreshed with wsAt
	wsAt  time.Time
	known map[string]bool // every chat id the database holds
	stats Stats
}

// Stats is what the daemon reports about the Cursor reader.
type Stats struct {
	Chats    int   `json:"chats"`
	Events   int   `json:"events"`
	Priced   int   `json:"priced_chats,omitempty"`
	Unpriced int   `json:"unpriced,omitempty"`
	LastPoll int64 `json:"last_poll_ms,omitempty"`
}

// NewIngester builds an ingester over an already-open editor database.
func NewIngester(db *sql.DB, path, userDir string, rec *rollup.Recorder, log *slog.Logger, every time.Duration) *Ingester {
	if every <= 0 {
		every = 10 * time.Second
	}
	if log == nil {
		log = slog.Default()
	}
	return &Ingester{
		db: db, path: path, userDir: userDir, rec: rec, log: log, every: every,
		seen: map[string]string{}, from: map[string]int{}, cwd: map[string]string{}, known: map[string]bool{},
	}
}

// Stats returns a snapshot of what has been imported.
func (in *Ingester) Stats() Stats {
	in.mu.Lock()
	defer in.mu.Unlock()
	return in.stats
}

// Known reports whether the editor's database holds a chat with this id, so
// the hook plane can leave an editor chat to this reader (hooks.go).
func (in *Ingester) Known(id string) bool {
	in.mu.Lock()
	defer in.mu.Unlock()
	return in.known[id]
}

// Run polls until the context is cancelled, importing once immediately.
func (in *Ingester) Run(ctx context.Context) error {
	t := time.NewTicker(in.every)
	defer t.Stop()
	for {
		if err := in.Once(ctx); err != nil && ctx.Err() == nil {
			in.log.Debug("cursor poll failed", "component", "cursor", "err", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
	}
}

// signature is the database's and its WAL's size and modification time.
func signature(path string) string {
	sig := ""
	for _, p := range []string{path, path + "-wal"} {
		if fi, err := os.Stat(p); err == nil {
			sig += fmt.Sprintf("%d:%d|", fi.Size(), fi.ModTime().UnixNano())
		} else {
			sig += "-|"
		}
	}
	return sig
}

// Once reads everything that changed since the last pass.
func (in *Ingester) Once(ctx context.Context) error {
	if in.path != "" {
		sig := signature(in.path)
		in.mu.Lock()
		same := sig == in.sig
		in.mu.Unlock()
		if same {
			return nil
		}
		defer func() {
			in.mu.Lock()
			in.sig = sig
			in.mu.Unlock()
		}()
	}
	chats, err := Composers(ctx, in.db)
	if err != nil {
		return err
	}
	known := make(map[string]bool, len(chats))
	priced := 0
	for _, c := range chats {
		known[c.ID] = true
		if len(c.Usage) > 0 {
			priced++
		}
	}
	in.mu.Lock()
	in.known = known
	in.mu.Unlock()
	for _, c := range chats {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if c.Messages == 0 && len(c.Usage) == 0 {
			continue // an empty draft
		}
		fp := c.Fingerprint()
		in.mu.Lock()
		same := in.seen[c.ID] == fp
		in.mu.Unlock()
		if same {
			continue
		}
		if err := in.chat(ctx, c); err != nil {
			in.log.Debug("cursor chat failed", "component", "cursor", "chat", c.ID, "err", err)
			continue
		}
		in.mu.Lock()
		in.seen[c.ID] = fp
		in.stats.Chats = len(in.seen)
		in.mu.Unlock()
	}
	in.mu.Lock()
	in.stats.Priced = priced
	in.stats.LastPoll = time.Now().UnixMilli()
	in.mu.Unlock()
	return nil
}

// folder is the chat's folder: its window's, else the folder Cursor's
// terminal was last in, else the repository of the first absolute path a
// tool named. "" when nothing says.
func (in *Ingester) folder(ctx context.Context, c Composer, bubbles []Bubble) string {
	in.mu.Lock()
	if d, ok := in.cwd[c.ID]; ok {
		in.mu.Unlock()
		return d
	}
	stale := in.ws == nil || time.Since(in.wsAt) > 5*time.Minute
	in.mu.Unlock()
	if stale {
		ws := Workspaces(ctx, in.userDir)
		in.mu.Lock()
		in.ws, in.wsAt = ws, time.Now()
		in.mu.Unlock()
	}
	in.mu.Lock()
	d := in.ws[c.ID]
	in.mu.Unlock()
	if d == "" {
		for _, b := range bubbles {
			if b.TerminalCwd != "" {
				d = b.TerminalCwd
				break
			}
		}
	}
	if d == "" {
		for _, b := range bubbles {
			if p := pathHint(b.Tool); p != "" {
				d = repoOf(p)
				break
			}
		}
	}
	if d != "" {
		in.mu.Lock()
		in.cwd[c.ID] = d
		in.mu.Unlock()
	}
	return d
}

// totals is what Cursor's own records add up to for one chat, per model:
// the tokens of every turn it measured (filed under the model the turn ran
// on) and the cost and requests it kept in usageData.
type totals map[string]delta

// chat imports one editor chat from its last prompt on.
func (in *Ingester) chat(ctx context.Context, c Composer) error {
	var ids []string
	if c.Messages > 0 {
		var err error
		if ids, err = HeaderIDs(ctx, in.db, c.ID); err != nil {
			return err
		}
	}
	in.mu.Lock()
	start, started := in.from[c.ID]
	in.mu.Unlock()
	if start > len(ids) {
		start = 0
	}
	if !started && in.upToDate(ctx, c) {
		// Read on an earlier run and nothing has moved since: a restart
		// does not re-read the whole history.
		in.mu.Lock()
		in.from[c.ID] = max(0, len(ids)-1)
		in.mu.Unlock()
		return nil
	}
	bubbles, err := Bubbles(ctx, in.db, c.ID, ids[start:])
	if err != nil {
		return err
	}
	cwd := in.folder(ctx, c, bubbles)
	model := c.Model
	for _, b := range bubbles {
		if b.User && b.Model != "" {
			model = b.Model
		}
	}
	info := rollup.SessionInfo{Cwd: cwd, Model: model, Agent: Agent, Title: c.Name}
	common := func(f map[string]any) map[string]any {
		f["cursor_surface"] = "editor"
		if c.Mode != "" {
			f["cursor_mode"] = c.Mode
		}
		if c.MaxMode {
			f["max_mode"] = true
		}
		return f
	}

	want, err := in.totals(ctx, c, ids)
	if err != nil {
		return err
	}
	if start == 0 {
		if err := in.overhead(ctx, c, bubbles, cwd, model, info); err != nil {
			return err
		}
	}

	lastPrompt := start
	carrier := -1
	for i, b := range bubbles {
		if b.User {
			lastPrompt = start + i
		} else if b.Text != "" || b.TokensIn > 0 {
			carrier = i
		}
	}
	due, err := in.pending(ctx, c.ID, want)
	if err != nil {
		return err
	}
	priced := len(c.Usage) > 0
	carried := ""
	turnModel := c.Model
	for i, b := range bubbles {
		ts := b.At
		if ts.IsZero() {
			ts = c.Updated
		}
		if b.User && b.Model != "" {
			turnModel = b.Model
		}
		switch {
		case b.User:
			if b.Text == "" {
				continue
			}
			payload, _ := json.Marshal(common(map[string]any{"prompt": ingest.ClipAssistantText(b.Text), "cwd": cwd, "model": turnModel}))
			if _, err := in.record(ctx, &event.Event{
				Ts: ts, SessionID: c.ID, Source: event.SourceCursor, Kind: event.KindTurnUser,
				Payload: payload, Key: "cu-user:" + b.ID,
			}, info); err != nil {
				return err
			}
		case b.Tool != nil:
			input, _ := json.Marshal(ToolInput(b.Tool.Name, b.Tool.Args, cwd))
			fields := common(map[string]any{
				"tool_name":   ToolName(b.Tool.Name),
				"tool_input":  event.CapToolField(input),
				"cwd":         cwd,
				"cursor_tool": b.Tool.Name,
			})
			if b.Tool.Error {
				fields["error"] = true
			}
			payload, _ := json.Marshal(fields)
			if _, err := in.record(ctx, &event.Event{
				Ts: ts, SessionID: c.ID, Source: event.SourceCursor, Kind: event.KindToolPre,
				Tool: ToolName(b.Tool.Name), Payload: payload, Key: "cu-tool:" + b.ID, MsgID: msgID(b),
			}, info); err != nil {
				return err
			}
		case b.Text != "" || b.TokensIn > 0:
			fields := common(map[string]any{"text": ingest.ClipAssistantText(b.Text), "model": turnModel, "cwd": cwd})
			if b.TokensIn > 0 {
				// The size of the turn's last request, as Cursor measured
				// it. Kept beside the reconciled usage, which may land on
				// another row.
				fields["request_tokens"] = b.TokensIn
			}
			ev := &event.Event{
				Ts: ts, SessionID: c.ID, Source: event.SourceCursor, Kind: event.KindTurnAssistant,
				Model: turnModel, Key: "cu-msg:" + b.ID, MsgID: msgID(b),
			}
			d, has := due[turnModel]
			if i == carrier && has && !d.zero() {
				in.carry(ev, fields, d, priced)
			}
			ev.Payload, _ = json.Marshal(fields)
			stored, err := in.record(ctx, ev, info)
			if err != nil {
				return err
			}
			if i == carrier && stored && has && !d.zero() {
				carried = turnModel
			}
		}
	}
	// Whatever no new reply carried — every model on a chat's first read but
	// the newest turn's, and usage that arrived after its reply was stored —
	// goes on a record of its own under its model, so the split by model is
	// Cursor's.
	for _, m := range sortedKeys(due) {
		if m == carried || due[m].zero() {
			continue
		}
		if err := in.usageOnly(ctx, c, m, due[m], want, priced, info, common); err != nil {
			return err
		}
	}
	in.mu.Lock()
	in.from[c.ID] = lastPrompt
	in.mu.Unlock()
	return nil
}

// upToDate reports whether the store already holds everything up to the
// chat's last change: a session whose last event is no older than Cursor's
// lastUpdatedAt was read through on an earlier run.
func (in *Ingester) upToDate(ctx context.Context, c Composer) bool {
	if c.Updated.IsZero() {
		return false
	}
	var last int64
	err := in.rec.Store.DB().QueryRowContext(ctx, `SELECT COALESCE(last_event_at,0) FROM sessions WHERE session_id = ?`, c.ID).Scan(&last)
	return err == nil && last >= c.Updated.UnixMilli()
}

// totals reads Cursor's totals for a chat. Tokens are summed per model from
// the messages' own fields, pulled out in SQL so a long chat is not copied
// into Go: a turn's tokens belong to the model its prompt names.
func (in *Ingester) totals(ctx context.Context, c Composer, ids []string) (totals, error) {
	out := totals{}
	toks, err := TokensByTurn(ctx, in.db, c.ID, ids)
	if err != nil {
		return nil, err
	}
	model := c.Model
	for _, t := range toks {
		if t.User {
			if t.Model != "" {
				model = t.Model
			}
			continue
		}
		if t.In == 0 && t.Out == 0 {
			continue
		}
		d := out[model]
		d.in += t.In
		d.out += t.Out
		out[model] = d
	}
	for m, u := range c.Usage {
		d := out[m]
		d.cost = u.Cents / 100
		d.requests = u.Requests
		out[m] = d
	}
	return out, nil
}

// msgID ties a row to the request it belongs to.
func msgID(b Bubble) string {
	if b.Call != "" {
		return "cursor/" + b.Call
	}
	return "cursor/" + b.ID
}

// delta is a difference between Cursor's totals and Caprock's, or one of
// the totals.
type delta struct {
	in, out  int64
	cost     float64
	requests int64
}

func (d delta) zero() bool { return d.in == 0 && d.out == 0 && d.cost == 0 && d.requests == 0 }

// pending compares Cursor's totals with the store's, model by model, clamped
// at zero: a total that went down (a chat Cursor rewound) is not turned into
// negative spend.
func (in *Ingester) pending(ctx context.Context, id string, want totals) (map[string]delta, error) {
	rows, err := in.rec.Store.DB().QueryContext(ctx, `
		SELECT COALESCE(model,''), COALESCE(SUM(tokens_in),0), COALESCE(SUM(tokens_out),0),
		       COALESCE(SUM(cost_usd),0), COALESCE(SUM(json_extract(payload,'$.requests')),0)
		FROM events
		WHERE sid = (SELECT sid FROM sessions WHERE session_id = ?) AND source = ? AND kind = 'turn.assistant'
		GROUP BY 1`, id, string(event.SourceCursor))
	if err != nil {
		return nil, fmt.Errorf("read stored usage: %w", err)
	}
	stored := map[string]delta{}
	for rows.Next() {
		var m string
		var d delta
		var req float64
		if err := rows.Scan(&m, &d.in, &d.out, &d.cost, &req); err != nil {
			_ = rows.Close()
			return nil, err
		}
		d.requests = int64(req)
		stored[m] = d
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := map[string]delta{}
	for m, w := range want {
		s := stored[m]
		d := delta{in: max(0, w.in-s.in), out: max(0, w.out-s.out), requests: max(0, w.requests-s.requests)}
		if c := w.cost - s.cost; c > 0 && math.Abs(c) >= 1e-9 {
			d.cost = c
		}
		if !d.zero() {
			out[m] = d
		}
	}
	return out, nil
}

// carry puts a difference on an event. priced says Cursor keeps a cost for
// this chat at all: then every token difference carries one (zero when the
// money is on another model's record), and a chat Cursor recorded no cost
// for leaves its tokens unpriced rather than acquiring a figure from
// Caprock's table (rule 6; .ai/25-cursor.md § Cost).
func (in *Ingester) carry(ev *event.Event, fields map[string]any, d delta, priced bool) {
	if d.in > 0 || d.out > 0 {
		ev.Tokens = &event.TokenDelta{In: d.in, Out: d.out}
	}
	if priced {
		c := d.cost
		ev.CostUSD = &c
		fields["cost_basis"] = "cursor"
		if d.requests > 0 {
			fields["requests"] = d.requests
		}
	} else {
		fields["cost_basis"] = "none"
	}
}

func (in *Ingester) usageOnly(ctx context.Context, c Composer, model string, d delta, want totals, priced bool, info rollup.SessionInfo, common func(map[string]any) map[string]any) error {
	ts := c.Updated
	if ts.IsZero() {
		ts = c.Created
	}
	w := want[model]
	fields := common(map[string]any{"usage_only": true, "model": model})
	ev := &event.Event{
		Ts: ts, SessionID: c.ID, Source: event.SourceCursor, Kind: event.KindTurnAssistant, Model: model,
		Key: fmt.Sprintf("cu-usage:%s:%s:%d:%d:%d:%s", c.ID, model, w.in, w.out, w.requests, strconv.FormatFloat(w.cost, 'f', -1, 64)),
	}
	in.carry(ev, fields, d, priced)
	ev.Payload, _ = json.Marshal(fields)
	_, err := in.record(ctx, ev, info)
	return err
}

// overhead records the estimate of what Cursor sent beyond the conversation
// on the chat's first request it measured (.ai/25-cursor.md § Overhead): the
// request's size minus everything readable that came before it in the first
// turn — the prompt, replies, thinking, tool calls and their results —
// counted at four bytes a token. What is left is Cursor's system prompt,
// its tool definitions, rules and the context it attached on its own.
func (in *Ingester) overhead(ctx context.Context, c Composer, bubbles []Bubble, cwd, model string, info rollup.SessionInfo) error {
	if len(bubbles) == 0 || !bubbles[0].User {
		return nil
	}
	first := bubbles[0]
	visible := 0
	calls := map[string]bool{}
	for i, b := range bubbles {
		if i > 0 && b.User {
			return nil // turn one ended unmeasured
		}
		if b.Call != "" {
			calls[b.Call] = true
		}
		if b.TokensIn > 0 && !b.User {
			m := first.Model
			if m == "" {
				m = model
			}
			est := Overhead{
				Model:         m,
				RequestTokens: b.TokensIn,
				TypedTokens:   int64(len(first.Text)) / BytesPerToken,
				VisibleTokens: int64(visible) / BytesPerToken,
				Requests:      max(1, len(calls)),
			}
			est.OverheadTokens = est.RequestTokens - est.VisibleTokens
			est.Clean = est.OverheadTokens > 0 && est.VisibleTokens*4 <= est.RequestTokens
			fields := map[string]any{
				"model": m, "cwd": cwd, "cursor_surface": "editor",
				"request_tokens": est.RequestTokens, "typed_tokens": est.TypedTokens,
				"visible_tokens": est.VisibleTokens, "overhead_tokens": est.OverheadTokens,
				"model_calls": est.Requests, "clean": est.Clean, "method": "first_request",
			}
			payload, _ := json.Marshal(fields)
			ts := b.At
			if ts.IsZero() {
				ts = c.Created
			}
			_, err := in.record(ctx, &event.Event{
				Ts: ts, SessionID: c.ID, Source: event.SourceCursor, Kind: event.KindContextOverhead,
				Model: m, Payload: payload, Key: "cu-overhead:" + c.ID,
			}, info)
			return err
		}
		visible += b.Visible
	}
	return nil
}

// BytesPerToken is the estimate's exchange rate: four bytes of UTF-8 to a
// token. Close for English and code; text in a script that takes more bytes
// per letter counts as more tokens, which is also roughly how tokenizers
// treat it.
const BytesPerToken = 4

// Overhead is one chat's first-request estimate.
type Overhead struct {
	Model          string
	RequestTokens  int64
	TypedTokens    int64
	VisibleTokens  int64
	OverheadTokens int64
	Requests       int
	// Clean is true when the conversation before the request was at most a
	// quarter of it, so the difference is mostly Cursor's own and not an
	// error in counting a long tool result.
	Clean bool
}

// record stores one event and counts it.
func (in *Ingester) record(ctx context.Context, ev *event.Event, info rollup.SessionInfo) (bool, error) {
	res, err := in.rec.Record(ctx, ev, info)
	if err != nil {
		return false, fmt.Errorf("record cursor %s: %w", ev.Kind, err)
	}
	if res.Stored {
		in.mu.Lock()
		in.stats.Events++
		if ev.Kind == event.KindTurnAssistant && ev.Tokens != nil && ev.Tokens.Total() > 0 && ev.CostUSD == nil {
			in.stats.Unpriced++
		}
		in.mu.Unlock()
	}
	return res.Stored, nil
}
