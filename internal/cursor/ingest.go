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
	"github.com/dspv/caprock/internal/store"
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
	// repairChecked is set once the store's earlier imports were checked
	// against this reader (see repair); redo holds the chats whose repair
	// failed, so the next pass repairs them again rather than reconciling
	// against rows still filed under the old model.
	repairChecked bool
	redo          map[string]bool
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
		redo: map[string]bool{},
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
	repairAll := false
	if !in.repairChecked && in.rec != nil && in.rec.Store != nil {
		// Each version of the reader that records more of a chat than the
		// one before reads every stored chat again once (repair).
		for _, k := range repairMetas {
			if done, _ := in.rec.Store.GetMeta(ctx, k); done != "1" {
				repairAll = true
			}
		}
	}
	repaired := 0
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
		redo := repairAll || in.redo[c.ID]
		in.mu.Unlock()
		if same && !redo {
			continue
		}
		if err := in.chat(ctx, c, redo); err != nil {
			in.log.Debug("cursor chat failed", "component", "cursor", "chat", c.ID, "err", err)
			if redo {
				in.mu.Lock()
				in.redo[c.ID] = true
				in.mu.Unlock()
			}
			continue
		}
		if redo {
			repaired++
		}
		in.mu.Lock()
		in.seen[c.ID] = fp
		delete(in.redo, c.ID)
		in.stats.Chats = len(in.seen)
		in.mu.Unlock()
	}
	if repairAll && ctx.Err() == nil {
		// Set even when a chat failed: that chat is in redo, and is
		// repaired on its own on a later pass.
		var err error
		for _, k := range repairMetas {
			if err == nil {
				err = in.rec.Store.SetMeta(ctx, k, "1")
			}
		}
		if err == nil {
			in.repairChecked = true
			in.log.Info("cursor chats read again for models, readings, results, compactions, turn ends, legacy chats, names, paths and modes",
				"component", "cursor", "chats", repaired)
		}
	} else if !repairAll {
		in.repairChecked = true
	}
	in.mu.Lock()
	in.stats.Priced = priced
	in.stats.LastPoll = time.Now().UnixMilli()
	in.mu.Unlock()
	return nil
}

// repairMetas are the one-time repairs of stored chats (repair), in order.
var repairMetas = []string{store.MetaCursorParityRepaired, store.MetaCursorParity2Repaired}

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

// chat imports one editor chat from its last prompt on. full reads it
// whole and first brings what an earlier version stored of it up to this
// reader (repair).
func (in *Ingester) chat(ctx context.Context, c Composer, full bool) error {
	var ids []string
	if c.Messages > 0 {
		var err error
		if ids, err = ChatIDs(ctx, in.db, c); err != nil {
			return err
		}
	}
	in.mu.Lock()
	start, started := in.from[c.ID]
	in.mu.Unlock()
	if start > len(ids) || full {
		start = 0
	}
	if !full && !started && in.upToDate(ctx, c) {
		// Read on an earlier run and nothing has moved since: a restart
		// does not re-read the whole history.
		in.mu.Lock()
		in.from[c.ID] = max(0, len(ids)-1)
		in.mu.Unlock()
		return nil
	}
	bubbles, err := ChatBubbles(ctx, in.db, c, ids[start:])
	if err != nil {
		return err
	}
	cwd := in.folder(ctx, c, bubbles)
	model := ""
	for _, b := range bubbles {
		if b.User {
			if m, _ := turnModel(c, b.Model); m != "" {
				model = m
			}
		}
	}
	if model == "" {
		model = sessionModel(c)
	}
	info := rollup.SessionInfo{Cwd: cwd, Model: model, Agent: Agent, Title: c.Name}
	if full {
		if err := in.repair(ctx, c, bubbles, model, cwd); err != nil {
			return err
		}
	}
	common := func(f map[string]any) map[string]any {
		f["cursor_surface"] = "editor"
		if c.Mode != "" {
			f["cursor_mode"] = c.Mode
		}
		if c.MaxMode {
			f["max_mode"] = true
		}
		if c.Legacy {
			f["cursor_format"] = "legacy"
		}
		return f
	}

	want, err := in.totals(ctx, c, ids)
	if err != nil {
		return err
	}
	if start == 0 {
		if err := in.overhead(ctx, c, bubbles, cwd, info); err != nil {
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
	carried, didCarry := "", false // "" is a model too: one Cursor did not record
	turn, source := turnModel(c, "")
	// The turn being read, for its end (agent.stop) and its timings.
	var tt *turnSpan
	endTurn := func(next time.Time, finished bool) error {
		if tt == nil || tt.rows == 0 {
			return nil
		}
		ev, ok := tt.stop(c, next, finished)
		if !ok {
			return nil
		}
		ev.Payload, _ = json.Marshal(common(ev.fields))
		_, err := in.record(ctx, &ev.Event, as(info, tt.model))
		return err
	}
	lastTs := time.Time{}
	for i, b := range bubbles {
		ts := b.At
		if ts.IsZero() {
			ts = c.Updated
		}
		// A row Cursor did not date is placed after the last dated one for
		// what is new here (a compaction, a turn's end); the rows themselves
		// keep the chat's last update, as they were stored.
		near := b.At
		if near.IsZero() {
			near = lastTs
		}
		if near.IsZero() {
			near = ts
		}
		if !b.At.IsZero() {
			lastTs = b.At
		}
		if b.User {
			if err := endTurn(b.At, false); err != nil {
				return err
			}
			turn, source = turnModel(c, b.Model)
			tt = &turnSpan{prompt: b.ID, at: b.At, model: turn}
		} else if tt != nil {
			tt.add(b, ts)
		}
		if b.Summary != nil {
			if err := in.compaction(ctx, c, bubbles, i, near, cwd, as(info, turn), common); err != nil {
				return err
			}
		}
		switch {
		case b.User:
			if b.Text == "" {
				continue
			}
			fields := common(map[string]any{"prompt": ingest.ClipAssistantText(b.Text), "cwd": cwd, "model": turn, "model_source": source})
			reading(fields, b.ContextUsed, b.ContextLimit)
			if m := chatMode(c.Mode); m != "" {
				fields["permission_mode"] = m
			}
			payload, _ := json.Marshal(fields)
			if _, err := in.record(ctx, &event.Event{
				Ts: ts, SessionID: c.ID, Source: event.SourceCursor, Kind: event.KindTurnUser,
				Payload: payload, Key: "cu-user:" + b.ID,
			}, as(info, turn)); err != nil {
				return err
			}
		case b.Tool != nil:
			name := callName(b.Tool)
			input, _ := json.Marshal(ToolInput(b.Tool.Name, b.Tool.Args, cwd))
			capped := event.CapToolField(input)
			fields := common(map[string]any{
				"tool_name":   name,
				"tool_input":  capped,
				"tool_use_id": useID(b),
				"cwd":         cwd,
				"cursor_tool": b.Tool.Name,
			})
			if b.Tool.Error {
				fields["error"] = true
			}
			if m := callMode(b.Tool); m != "" {
				fields["permission_mode"] = m
			}
			payload, _ := json.Marshal(fields)
			if _, err := in.record(ctx, &event.Event{
				Ts: ts, SessionID: c.ID, Source: event.SourceCursor, Kind: event.KindToolPre,
				Tool: name, Payload: payload, Key: "cu-tool:" + b.ID, MsgID: msgID(b),
			}, as(info, turn)); err != nil {
				return err
			}
			if post, ok := toolPost(b, capped); ok {
				post.Ts, post.SessionID = ts, c.ID
				f := common(post.fields)
				f["cwd"] = cwd
				post.Payload, _ = json.Marshal(f)
				if _, err := in.record(ctx, &post.Event, as(info, turn)); err != nil {
					return err
				}
			}
		case b.Text != "" || b.TokensIn > 0:
			fields := common(map[string]any{"text": ingest.ClipAssistantText(b.Text), "model": turn, "model_source": source, "cwd": cwd})
			if b.TokensIn > 0 {
				// The size of the turn's last request, as Cursor measured
				// it. Kept beside the reconciled usage, which may land on
				// another row.
				fields["request_tokens"] = b.TokensIn
			}
			if start+i == len(ids)-1 && (c.Status == "completed" || c.Status == "aborted") {
				// The chat's last reply, finished: Cursor's own reading
				// of the window after it (composerData.contextTokensUsed).
				reading(fields, c.ContextUsed, c.ContextLimit)
			}
			ev := &event.Event{
				Ts: ts, SessionID: c.ID, Source: event.SourceCursor, Kind: event.KindTurnAssistant,
				Model: turn, Key: "cu-msg:" + b.ID, MsgID: msgID(b),
			}
			d, has := due[turn]
			if i == carrier && has && !d.zero() {
				in.carry(ev, fields, d, priced)
			}
			ev.Payload, _ = json.Marshal(fields)
			stored, err := in.record(ctx, ev, as(info, turn))
			if err != nil {
				return err
			}
			if i == carrier && stored && has && !d.zero() {
				carried, didCarry = turn, true
			}
		}
	}
	// The newest turn ends when Cursor says the chat stopped: its status, and
	// nothing still being written (generatingBubbleIds).
	if len(bubbles) > 0 && bubbles[len(bubbles)-1].ID == ids[len(ids)-1] && c.Finished() {
		if err := endTurn(time.Time{}, true); err != nil {
			return err
		}
	}
	// Whatever no new reply carried — every model on a chat's first read but
	// the newest turn's, and usage that arrived after its reply was stored —
	// goes on a record of its own under its model, so the split by model is
	// Cursor's.
	for _, m := range sortedKeys(due) {
		if didCarry && m == carried || due[m].zero() {
			continue
		}
		if err := in.usageOnly(ctx, c, m, due[m], want, priced, as(info, m), common); err != nil {
			return err
		}
	}
	// Each row was recorded under its own turn's model, which moves the
	// session's as it goes; the session is named by its newest turn, else
	// by its bill (sessionModel).
	if model != "" && in.rec != nil && in.rec.Store != nil {
		if _, err := in.rec.Store.DB().ExecContext(ctx, `UPDATE sessions SET model = ? WHERE session_id = ? AND model IS NOT ?`, model, c.ID, model); err != nil {
			return err
		}
	}
	in.mu.Lock()
	in.from[c.ID] = lastPrompt
	in.mu.Unlock()
	return nil
}

// as is info with the model one row ran on. The recorder files a row that
// names no model under info's, so a turn Cursor recorded no model for is
// recorded with none here, not under the session's.
func as(info rollup.SessionInfo, model string) rollup.SessionInfo {
	info.Model = model
	return info
}

// autoModel is the name Cursor gives its Auto setting, in the picker and on
// a prompt: not a model, the choice of one left to Cursor.
const autoModel = "default"

// turnModel is the model a turn ran on, and where that was read, for a
// prompt that named promptModel (modelInfo.modelName, "" when the prompt
// kept none: only 1,284 of 3,956 prompts on the owner's machine keep one).
//
//   - The prompt's own model, unless it is Auto: "prompt".
//   - Else the bill, when it names one model: every request of the chat
//     was charged to it, so the turn ran on it: "usage".
//   - Else Auto as the prompt said, when the bill names several.
//   - Else nothing, when the bill names several: which of them ran this
//     turn is not recorded anywhere: "unknown".
//   - Else, for a chat Cursor kept no bill for, the model picked in the
//     chat now (modelConfig) — the only hint there is: "picker".
//
// The picker is never taken over the bill: on the owner's machine 11 of 22
// priced chats were billed for a model the picker did not show (2026-11-17).
func turnModel(c Composer, promptModel string) (model, source string) {
	if promptModel != "" && promptModel != autoModel {
		return promptModel, "prompt"
	}
	if len(c.Usage) == 1 {
		for m := range c.Usage {
			return m, "usage"
		}
	}
	if promptModel != "" {
		return promptModel, "prompt"
	}
	if len(c.Usage) > 1 || c.Model == "" {
		return "", "unknown"
	}
	return c.Model, "picker"
}

// sessionModel names a chat whose newest prompt says nothing usable: the
// model the bill charged most to, else the picker's.
func sessionModel(c Composer) string {
	best, cents := "", -1.0
	for _, m := range sortedKeys(c.Usage) {
		if u := c.Usage[m]; u.Cents > cents {
			best, cents = m, u.Cents
		}
	}
	if best != "" {
		return best
	}
	return c.Model
}

// reading puts Cursor's own context reading on a turn's payload, in the
// fields the Context meter reads first (api.contextFill): how many tokens
// the window held and how big it was.
func reading(fields map[string]any, used, limit int64) {
	if used <= 0 {
		return
	}
	fields["context_tokens"] = used
	if limit > 0 {
		fields["context_window"] = limit
	}
}

// useID pairs a call with its result: Cursor's toolCallId, else the row's
// own id.
func useID(b Bubble) string {
	if b.Tool != nil && b.Tool.ID != "" {
		return b.Tool.ID
	}
	return b.ID
}

// postEvent is a tool.post in the making: the event and the payload fields
// the caller completes.
type postEvent struct {
	event.Event
	fields map[string]any
}

// toolPost is the `tool.post` for a finished call, in the shape Claude
// Code's hook gives one — `tool_use_id`, `tool_input`, `tool_response`,
// `is_error` — so the chat shows the call's outcome, the tool sizes count
// it, a failure reaches the timeline and loop alerts, and the pull request
// and branch readers (internal/gitremote) find a `gh pr create`'s URL and
// a `git push`'s branch in a terminal call's `stdout`. A call that is still
// running has none yet: the next pass, which re-reads its turn, adds it.
//
// Failed is: Cursor's status error (its message is the response), the
// person rejecting the call, or a terminal command that exited non-zero, as
// Claude Code marks a failed Bash. A cancelled call is `interrupted`, as
// Codex marks one.
func toolPost(b Bubble, input json.RawMessage) (postEvent, bool) {
	t := b.Tool
	switch t.Status {
	case "completed", "error", "cancelled":
	default:
		return postEvent{}, false
	}
	name := callName(t)
	fields := map[string]any{
		"tool_name":   name,
		"tool_input":  input,
		"tool_use_id": useID(b),
		"cursor_tool": t.Name,
	}
	var res map[string]any
	if t.Result != "" {
		_ = json.Unmarshal([]byte(t.Result), &res)
	}
	failed := false
	var resp any
	switch {
	case name == "Bash" && res != nil:
		out, _ := res["output"].(string)
		resp = map[string]any{"stdout": out}
		if code, ok := res["exitCodeV2"].(float64); ok {
			fields["exit_code"] = int(code)
			failed = code != 0
		}
		if rej, _ := res["rejected"].(bool); rej {
			failed = true
			fields["rejected"] = true
		}
	case res != nil:
		delete(res, "outputRaw") // the terminal's raw bytes, a second copy
		resp = res
	case t.Result != "":
		resp = t.Result
	}
	if t.Status == "error" {
		failed = true
		if t.ErrorText != "" {
			resp = t.ErrorText
		}
	}
	if t.Decision == "rejected" {
		failed = true
		fields["rejected"] = true
		if resp == nil {
			resp = "rejected by user"
		}
	}
	if t.Status == "cancelled" && !failed {
		fields["interrupted"] = true
	}
	if t.Decision != "" {
		// The person's answer to the call, recorded after the fact:
		// accepted or rejected (11.6% of calls on the owner's machine
		// carry one, 2026-11-17).
		fields["user_decision"] = t.Decision
	}
	fields["is_error"] = failed
	var size int64
	if resp != nil {
		raw, _ := json.Marshal(resp)
		size = int64(len(raw))
		fields["tool_response"] = event.CapToolField(raw)
	}
	return postEvent{
		Event: event.Event{
			Source: event.SourceCursor, Kind: event.KindToolPost, Tool: name,
			Key: "cu-post:" + b.ID, ToolBytes: size,
		},
		fields: fields,
	}, true
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
// into Go: a turn's tokens belong to the model it ran on (turnModel).
func (in *Ingester) totals(ctx context.Context, c Composer, ids []string) (totals, error) {
	out := totals{}
	toks, err := ChatTokens(ctx, in.db, c, ids)
	if err != nil {
		return nil, err
	}
	model, _ := turnModel(c, "")
	for _, t := range toks {
		if t.User {
			model, _ = turnModel(c, t.Model)
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
func (in *Ingester) overhead(ctx context.Context, c Composer, bubbles []Bubble, cwd string, info rollup.SessionInfo) error {
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
			// A turn whose model Cursor did not record (a chat billed to
			// several) is still a sample: it is reported as an unnamed
			// model, as the estimate was before the turn model came from
			// the bill.
			m, _ := turnModel(c, first.Model)
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
			}, as(info, m))
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
