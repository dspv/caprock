package codex

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// Agent is the value written to sessions.agent for Codex sessions.
const Agent = "codex"

// Ingester copies Codex's rollout transcripts into Caprock's store.
//
// It polls rather than watches. The transcripts are append-only files, so a
// poll that re-reads one it has already seen costs a read and produces nothing:
// every event carries a key derived from the record's ordinal, and
// `(session_id, key)` is unique in the store.
//
// Only files whose modification time moved are re-read, which on a machine with
// a hundred transcripts is one stat per file per tick and no parsing at all.
type Ingester struct {
	// dirs are the transcript roots: sessions/ and archived_sessions/ (Dirs).
	dirs  []string
	rec   *rollup.Recorder
	log   *slog.Logger
	every time.Duration

	// seen remembers each transcript's last modification time and size, so a
	// tick only re-reads what changed. Both are compared because a file
	// rewritten within the same second still changes length.
	mu    sync.Mutex
	seen  map[string]fileState
	stats Stats

	// namesAt is the state database's modification time when names were last
	// synced; the index is re-read only when it moves.
	// loaded is set once the files read by a previous run have been restored
	// from the store (see restoreSeen).
	loaded bool
	// limitsChecked is set once the first pass has made sure the store holds
	// Codex's plan limits (see backfillLimits).
	limitsChecked bool
	// textChecked is set once the first pass has given the turns stored
	// before prose was read their text (see backfillText).
	textChecked bool

	namesAt time.Time
	// namesFor is how many transcripts had been imported at that sync. A
	// thread can be indexed before its transcript is imported, and then its
	// name found no session to land on; a newly imported transcript forces
	// the next sync.
	namesFor int
}

type fileState struct {
	mod  time.Time
	size int64
	// session is the transcript's session id, kept so a restart can check the
	// store still holds that session before trusting the file as read.
	session string
}

// Stats is what the daemon reports about Codex ingest.
type Stats struct {
	Sessions int `json:"sessions"`
	Events   int `json:"events"`
	Unpriced int `json:"unpriced,omitempty"`
	// Repriced counts turns that were stored before the model could be read
	// and have since been given one from their transcript.
	Repriced int   `json:"repriced,omitempty"`
	LastPoll int64 `json:"last_poll_ms,omitempty"`
}

// NewIngester builds an ingester over Codex's transcript roots (see Dirs). The
// first root is the one whose parent holds Codex's state index (§ Names).
func NewIngester(dirs []string, rec *rollup.Recorder, log *slog.Logger, every time.Duration) *Ingester {
	if every <= 0 {
		every = 5 * time.Second
	}
	return &Ingester{dirs: dirs, rec: rec, log: log, every: every, seen: map[string]fileState{}}
}

// Stats returns a snapshot of what has been imported.
func (in *Ingester) Stats() Stats {
	in.mu.Lock()
	defer in.mu.Unlock()
	return in.stats
}

// Run polls until the context is cancelled. It imports once immediately so a
// fresh daemon shows history straight away rather than after the first tick.
func (in *Ingester) Run(ctx context.Context) error {
	t := time.NewTicker(in.every)
	defer t.Stop()
	if err := in.once(ctx); err != nil && ctx.Err() == nil {
		in.log.Warn("codex import failed", "component", "codex", "err", err)
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			if err := in.once(ctx); err != nil && ctx.Err() == nil {
				in.log.Warn("codex import failed", "component", "codex", "err", err)
			}
		}
	}
}

// once imports every transcript that changed since the last pass.
func (in *Ingester) once(ctx context.Context) error {
	files, err := ListAll(in.dirs)
	if err != nil {
		return err
	}
	if !in.loaded {
		in.loaded = true
		in.restoreSeen(ctx)
	}
	changed := in.forgetMoved(files)
	defer func() {
		if changed {
			in.saveSeen(ctx)
		}
	}()
	if !in.limitsChecked {
		in.limitsChecked = true
		in.backfillLimits(ctx, files)
	}
	readNow := map[string]bool{}
	for _, f := range files {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		in.mu.Lock()
		prev, ok := in.seen[f.Path]
		in.mu.Unlock()
		if ok && prev.mod.Equal(f.Modified) && prev.size == f.Size {
			continue // unchanged since the last pass
		}
		s, err := ParseFile(f.Path)
		if err != nil {
			// A file that is not a transcript, or is unreadable, is skipped
			// and remembered so it is not retried every tick. A transcript
			// being written right now parses fine — Parse tolerates a partial
			// final line — so this is a genuinely broken file, not a live one.
			in.mu.Lock()
			in.seen[f.Path] = fileState{mod: f.Modified, size: f.Size}
			in.mu.Unlock()
			continue
		}
		if err := in.session(ctx, s); err != nil {
			return err
		}
		in.recordLimits(ctx, s)
		readNow[f.Path] = true
		changed = true
		in.mu.Lock()
		in.seen[f.Path] = fileState{mod: f.Modified, size: f.Size, session: s.ID}
		// Updated inside the loop, not after it. The first pass over a real
		// machine's hundred transcripts takes seconds, and `caprock status`
		// read during it reported "0 transcripts read" beside a rising event
		// count — a progress figure that only appears once there is no longer
		// any progress to report.
		in.stats.Sessions = len(in.seen)
		in.mu.Unlock()
	}
	in.syncNames(ctx)
	if !in.textChecked {
		in.textChecked = true
		in.backfillText(ctx, files, readNow)
	}
	in.mu.Lock()
	in.stats.LastPoll = time.Now().UnixMilli()
	in.mu.Unlock()
	return nil
}

// syncNames copies Codex's own thread names onto the sessions already
// imported (FB-035). Separate from the transcript pass because a session's
// events are written once and deduplicated after that, while its name arrives
// later and can change. Best-effort: a failure costs a description, never an
// import.
func (in *Ingester) syncNames(ctx context.Context) {
	if len(in.dirs) == 0 {
		return
	}
	path := StateDB(in.dirs[0])
	if path == "" || in.rec == nil || in.rec.Store == nil {
		return
	}
	stamp := stateStamp(path)
	in.mu.Lock()
	known := len(in.seen)
	in.mu.Unlock()
	if !stamp.After(in.namesAt) && known == in.namesFor {
		return
	}
	names, err := ReadThreadNames(ctx, path)
	if err != nil {
		in.log.Debug("codex thread names unavailable", "component", "codex", "err", err)
		in.namesAt, in.namesFor = stamp, known // do not retry an unreadable index every tick
		return
	}
	db := in.rec.Store.DB()
	for id, n := range names {
		if err := store.SetTitle(ctx, db, id, n.Name); err != nil {
			in.log.Warn("record codex thread name", "component", "codex", "err", err)
			return
		}
		if err := store.SetPrompt(ctx, db, id, n.FirstMessage); err != nil {
			in.log.Warn("record codex first message", "component", "codex", "err", err)
			return
		}
	}
	in.namesAt, in.namesFor = stamp, known
}

// session records one parsed transcript: its turns and its tool calls, in the
// order they happened.
func (in *Ingester) session(ctx context.Context, s *Session) error {
	info := rollup.SessionInfo{Cwd: s.Cwd, Model: s.Model, Version: s.CLIVersion, Agent: Agent}

	// Turns and tools are interleaved by time so the session's event stream
	// reads the way it happened, rather than as all turns followed by all
	// tools. The dashboard's narration walks this order.
	type item struct {
		at   time.Time
		turn *Turn
		tool *ToolCall
	}
	items := make([]item, 0, len(s.Turns)+len(s.Tools))
	for i := range s.Turns {
		items = append(items, item{at: s.Turns[i].At, turn: &s.Turns[i]})
	}
	for i := range s.Tools {
		items = append(items, item{at: s.Tools[i].At, tool: &s.Tools[i]})
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].at.Before(items[j].at) })

	for _, it := range items {
		var err error
		switch {
		case it.turn != nil:
			err = in.turn(ctx, s, *it.turn, info)
		case it.tool != nil:
			err = in.tool(ctx, s, *it.tool, info)
		}
		if err != nil {
			return err
		}
	}
	// Rows written before this importer could find the model are corrected
	// here, from the transcript they came from. Best-effort: a failure to
	// repair history must not stop the import of what is current.
	if err := in.repriceSession(ctx, s); err != nil {
		in.log.Debug("codex reprice failed", "component", "codex", "session_id", s.ID, "err", err)
	}
	// A turn's text can arrive after its row: a message written after the
	// request's last token_count joins that turn when the request ends. And
	// rows imported before prose was read have none. Both are filled here.
	if _, err := in.syncText(ctx, s); err != nil {
		in.log.Debug("codex text sync failed", "component", "codex", "session_id", s.ID, "err", err)
	}
	return nil
}

// syncText writes each parsed turn's prose onto its stored row where the row's
// text differs, and returns how many rows changed.
//
// Event keys are idempotent, so a re-read never rewrites a row; this is the one
// place a Codex turn's payload is updated after it is stored, and it touches
// only `payload.text`. A row is matched on its key AND its timestamp: a
// subagent's file carries its parent's session id and keys by line number, so
// a key alone can name a row that came from a different file.
func (in *Ingester) syncText(ctx context.Context, s *Session) (int, error) {
	want := map[string]Turn{}
	for _, t := range s.Turns {
		if t.Text != "" && !t.At.IsZero() {
			want[t.Key] = t
		}
	}
	if len(want) == 0 || in.rec == nil || in.rec.Store == nil {
		return 0, nil
	}
	rows, err := in.rec.Store.DB().QueryContext(ctx,
		`SELECT id, COALESCE(key,''), ts, COALESCE(json_extract(payload,'$.text'),'')
		   FROM events
		  WHERE session_id = ? AND source = ? AND kind = ?`,
		s.ID, string(event.SourceCodex), string(event.KindTurnAssistant))
	if err != nil {
		return 0, err
	}
	type fix struct {
		id   int64
		text string
	}
	var todo []fix
	for rows.Next() {
		var id, ts int64
		var key, text string
		if err := rows.Scan(&id, &key, &ts, &text); err != nil {
			_ = rows.Close()
			return 0, err
		}
		t, ok := want[key]
		if !ok || t.At.UnixMilli() != ts || t.Text == text {
			continue
		}
		todo = append(todo, fix{id: id, text: t.Text})
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return 0, err
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	if len(todo) == 0 {
		return 0, nil
	}
	err = in.rec.Store.WithTx(ctx, func(q store.Querier) error {
		for _, f := range todo {
			if _, err := q.ExecContext(ctx,
				`UPDATE events SET payload = json_set(payload, '$.text', ?) WHERE id = ? AND json_valid(payload)`,
				f.text, f.id); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return len(todo), nil
}

// backfillText gives the turns imported before this importer read prose their
// text, once.
//
// The ordinary pass cannot: it skips every file it has already read (see
// restoreSeen), and re-recording a file would change nothing anyway, because a
// stored key is never rewritten. So each transcript the pass did not just
// read is parsed once more and only syncText runs on it — no event is
// recorded. It runs in the importer's own goroutine after the first pass, so
// it never delays the daemon starting or the first import; it is cancelled
// with the daemon and, unfinished, simply runs again on the next start, which
// is safe because syncText only changes rows whose text differs.
func (in *Ingester) backfillText(ctx context.Context, files []Transcript, readNow map[string]bool) {
	if in.rec == nil || in.rec.Store == nil {
		return
	}
	if done, _ := in.rec.Store.GetMeta(ctx, store.MetaCodexTextBackfilled); done == "1" {
		return
	}
	start := time.Now()
	var parsed, filled int
	for _, f := range files {
		if ctx.Err() != nil {
			return
		}
		if readNow[f.Path] {
			continue // the pass just read it, and syncText ran then
		}
		s, err := ParseFile(f.Path)
		if err != nil {
			continue
		}
		parsed++
		n, err := in.syncText(ctx, s)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			in.log.Debug("codex text backfill", "component", "codex", "session_id", s.ID, "err", err)
			continue
		}
		filled += n
	}
	if err := in.rec.Store.SetMeta(ctx, store.MetaCodexTextBackfilled, "1"); err != nil {
		return
	}
	in.log.Info("codex replies given their text from the transcripts",
		"component", "codex", "transcripts", parsed, "turns", filled,
		"took_ms", time.Since(start).Milliseconds())
}

// turn stores one assistant turn.
//
// Unlike OpenCode, Codex reports no cost of its own — only token counts — so
// the cost is left for the recorder to compute from the pricing table. When the
// transcript never named a model there is nothing to price against, and the
// turn is stored with its real tokens and no cost rather than with a guessed
// one: rule 6 prefers a missing number to an invented one. This is common, not
// exceptional — most Codex Desktop transcripts carry no `turn_context` at all.
func (in *Ingester) turn(ctx context.Context, s *Session, t Turn, info rollup.SessionInfo) error {
	fields := map[string]any{
		"model":      s.Model,
		"cwd":        s.Cwd,
		"originator": s.Originator,
		"reasoning":  t.Reasoning,
	}
	if t.Text != "" {
		// The same key Claude Code's turns carry, so the Memory screen and
		// its search read Codex's prose with no source-specific code.
		fields["text"] = t.Text
	}
	if t.TotalOnly {
		// Recorded so the figure can be traced later: this turn's transcript
		// gave a total with no breakdown, so its whole usage is counted as
		// input and its cost is an upper bound.
		fields["tokens_total_only"] = true
	}
	payload, _ := json.Marshal(fields)
	ev := &event.Event{
		Ts:        t.At,
		SessionID: s.ID,
		Source:    event.SourceCodex,
		Kind:      event.KindTurnAssistant,
		Model:     s.Model,
		Payload:   payload,
		Key:       t.Key,
		// Codex's `input_tokens` is the TOTAL prompt, with `cached_input_tokens`
		// a subset of it — verified on all 239 token samples in 100 real
		// transcripts, where input+output always equals the reported total.
		// Caprock's TokenDelta.In means *fresh* input, billed separately from
		// CacheRead, so the cached part has to come out: passing Codex's figure
		// straight through bills every cached token twice, once at full price.
		Tokens: &event.TokenDelta{
			In: fresh(t.In, t.CacheRead), Out: t.Out,
			CacheRead: t.CacheRead, CacheWrite: t.CacheWrite,
		},
	}
	res, err := in.rec.Record(ctx, ev, info)
	if err != nil {
		return fmt.Errorf("record codex turn: %w", err)
	}
	if res.Stored {
		in.mu.Lock()
		in.stats.Events++
		if s.Model == "" {
			in.stats.Unpriced++
		}
		in.mu.Unlock()
	}
	return nil
}

// fresh is the uncached part of a prompt: Codex counts cached tokens inside its
// input total, Caprock counts them beside it. Clamped at zero because a cached
// count larger than the input it belongs to has never been observed and would
// otherwise produce a negative charge.
func fresh(in, cacheRead int64) int64 {
	if n := in - cacheRead; n > 0 {
		return n
	}
	return 0
}

// tool stores one tool call.
//
// Shaped like a Claude Code hook payload rather than like Codex's own record,
// for the same reason OpenCode's is: per-directory attribution derives
// touch_dir from the payload itself, and the work-kind and narration code reads
// that one shape. A second shape here would mean a second implementation of
// everything downstream.
func (in *Ingester) tool(ctx context.Context, s *Session, c ToolCall, info rollup.SessionInfo) error {
	payload, _ := json.Marshal(map[string]any{
		"session_id": s.ID,
		"cwd":        s.Cwd,
		"tool_name":  c.Name,
		"tool_input": toolInput(c),
	})
	ev := &event.Event{
		Ts:        c.At,
		SessionID: s.ID,
		Source:    event.SourceCodex,
		Kind:      event.KindToolPre,
		Tool:      c.Name,
		Payload:   payload,
		Key:       c.Key,
	}
	res, err := in.rec.Record(ctx, ev, info)
	if err != nil {
		return fmt.Errorf("record codex tool: %w", err)
	}
	if res.Stored {
		in.mu.Lock()
		in.stats.Events++
		in.mu.Unlock()
	}
	return nil
}

// toolInput normalises a call's arguments to an object.
//
// Codex spells them two ways: a `custom_tool_call` carries a JSON string of
// JavaScript, a `function_call` carries a JSON object. Downstream code reads
// `tool_input` as an object, so a string is wrapped under `command` — which is
// what it is in every observed case (`shell`, `exec`).
func toolInput(c ToolCall) any {
	raw := c.Input
	if raw == "" {
		return map[string]any{}
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(raw), &obj); err == nil {
		return obj
	}
	var str string
	if err := json.Unmarshal([]byte(raw), &str); err == nil {
		return map[string]any{"command": str}
	}
	return map[string]any{"command": raw}
}

// repriceSession fills in the model on turns already stored without one, and
// prices them.
//
// It exists because the first release of this importer read the model from
// `turn_context` alone, which 96 of 100 real transcripts do not carry — so
// those turns were stored with real tokens and no model, and no cost. Reading
// the second source fixes every *future* import and reaches none of the rows
// already written: event keys are idempotent by design, so a re-read is a
// no-op rather than a correction.
//
// A migration could not do this. `events.payload` is stored verbatim and the
// answer can normally be read back out of it — that is how the /clear
// reclassification worked — but here the payload records `"model": ""`,
// because the model was never captured. The transcripts on disk are the only
// place the answer exists.
//
// It invents nothing: it reads the same file the row came from, and touches
// only rows of ours that have no model at all. A turn that already names one
// is left alone, whatever it says.
func (in *Ingester) repriceSession(ctx context.Context, s *Session) error {
	if s.Model == "" || in.rec == nil || in.rec.Table == nil {
		return nil
	}
	db := in.rec.Store.DB()
	rows, err := db.QueryContext(ctx,
		`SELECT id, ts, tokens_in, tokens_out, cache_read, cache_write
		   FROM events
		  WHERE session_id = ? AND source = ? AND kind = ?
		    AND COALESCE(model, '') = ''`,
		s.ID, string(event.SourceCodex), string(event.KindTurnAssistant))
	if err != nil {
		return err
	}
	type row struct {
		id     int64
		ts     int64
		tokens event.TokenDelta
	}
	var todo []row
	for rows.Next() {
		var r row
		var in64, out64, cr, cw sql.NullInt64
		if err := rows.Scan(&r.id, &r.ts, &in64, &out64, &cr, &cw); err != nil {
			_ = rows.Close()
			return err
		}
		r.tokens = event.TokenDelta{In: in64.Int64, Out: out64.Int64, CacheRead: cr.Int64, CacheWrite: cw.Int64}
		todo = append(todo, r)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if len(todo) == 0 {
		return nil
	}
	loc := in.rec.Location
	if loc == nil {
		loc = time.Local
	}
	for _, r := range todo {
		// Priced at the turn's own timestamp, like every other turn: a price
		// that has since changed was the real one for the work that ran under
		// it.
		at := time.UnixMilli(r.ts)
		usd, ok := in.rec.Table.PriceAt(s.Model, r.tokens, at)
		if !ok {
			continue
		}
		// The totals move with the event, in one transaction. Updating the
		// event alone left the session total without the cost and the day's
		// tokens filed under a model with no name — every screen reading the
		// rollups disagreeing with the events they were built from.
		err := in.rec.Store.WithTx(ctx, func(q store.Querier) error {
			res, err := q.ExecContext(ctx,
				`UPDATE events SET model = ?, cost_usd = ? WHERE id = ? AND COALESCE(model,'') = ''`,
				s.Model, usd, r.id)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n == 0 {
				return nil
			}
			if _, err := store.AddStats(ctx, q, store.Stats{SessionID: s.ID, CostUSD: usd}); err != nil {
				return err
			}
			day := at.In(loc).Format("2006-01-02")
			project := store.ProjectFromCwd(s.Cwd)
			tokens := r.tokens.Total()
			if err := store.AddDaily(ctx, q, day, project, "", -tokens, 0, false); err != nil {
				return err
			}
			return store.AddDaily(ctx, q, day, project, s.Model, tokens, usd, false)
		})
		if err != nil {
			return err
		}
	}
	in.mu.Lock()
	in.stats.Repriced += len(todo)
	in.mu.Unlock()
	in.log.Info("codex turns repriced from the transcript",
		"component", "codex", "session_id", s.ID, "model", s.Model, "turns", len(todo))
	return nil
}

// Every start used to re-read every transcript: on the owner's machine 161
// files, 1.1GB, 30k events each written again only to be found a duplicate —
// minutes of parsing and a write transaction per event, at the moment the
// daemon is busiest. While it ran, the dashboard's reads queued and hook
// writes waited on the lock. The files already read are now remembered in
// the store, and a restart reads only what changed.

type savedFile struct {
	Mod     int64  `json:"m"`
	Size    int64  `json:"s"`
	Session string `json:"id"`
}

// restoreSeen trusts a remembered file only while the store still has its
// session's Codex events. A migration that deletes them to re-import (0022
// and 0023 did) must find the file unread, or the re-import never happens.
func (in *Ingester) restoreSeen(ctx context.Context) {
	if in.rec == nil || in.rec.Store == nil {
		return
	}
	raw, err := in.rec.Store.GetMeta(ctx, store.MetaCodexSeen)
	if err != nil || raw == "" {
		return
	}
	var saved map[string]savedFile
	if json.Unmarshal([]byte(raw), &saved) != nil {
		return
	}
	db := in.rec.Store.DB()
	in.mu.Lock()
	defer in.mu.Unlock()
	for path, f := range saved {
		if f.Session == "" {
			continue
		}
		var one int
		err := db.QueryRowContext(ctx,
			`SELECT 1 FROM events WHERE session_id = ? AND source = ? LIMIT 1`,
			f.Session, string(event.SourceCodex)).Scan(&one)
		if err != nil {
			continue
		}
		in.seen[path] = fileState{mod: time.Unix(0, f.Mod), size: f.Size, session: f.Session}
	}
	in.stats.Sessions = len(in.seen)
}

// forgetMoved drops files that are no longer on disk from the read set, and
// reports whether it changed anything.
//
// Archiving a Codex thread renames its rollout from sessions/YYYY/MM/DD/ into
// archived_sessions/. Nothing is double-counted when the file turns up at its
// new path: every event's key is `codex:{turn,tool}:<line>` scoped to the
// session id the file carries, and neither changes in a rename, so a re-read
// finds every event a duplicate. But a re-read is still a full parse of a file
// that can be tens of megabytes, and the old path would linger in the read set
// and in `caprock status`'s transcript count. So a file that vanished is
// forgotten, and one that reappears elsewhere with the same name, modification
// time and size — which a rename preserves — keeps its "already read" state.
func (in *Ingester) forgetMoved(files []Transcript) bool {
	present := make(map[string]bool, len(files))
	for _, f := range files {
		present[f.Path] = true
	}
	in.mu.Lock()
	defer in.mu.Unlock()
	changed := false
	gone := map[string]fileState{}
	for p, st := range in.seen {
		if present[p] {
			continue
		}
		delete(in.seen, p)
		changed = true
		if st.session != "" {
			gone[filepath.Base(p)] = st
		}
	}
	if len(gone) > 0 {
		for _, f := range files {
			if _, ok := in.seen[f.Path]; ok {
				continue
			}
			if st, ok := gone[filepath.Base(f.Path)]; ok && st.mod.Equal(f.Modified) && st.size == f.Size {
				in.seen[f.Path] = st
			}
		}
	}
	if changed {
		in.stats.Sessions = len(in.seen)
	}
	return changed
}

func (in *Ingester) saveSeen(ctx context.Context) {
	if in.rec == nil || in.rec.Store == nil {
		return
	}
	in.mu.Lock()
	saved := make(map[string]savedFile, len(in.seen))
	for path, f := range in.seen {
		if f.session != "" {
			saved[path] = savedFile{Mod: f.mod.UnixNano(), Size: f.size, Session: f.session}
		}
	}
	in.mu.Unlock()
	b, err := json.Marshal(saved)
	if err != nil {
		return
	}
	if err := in.rec.Store.SetMeta(ctx, store.MetaCodexSeen, string(b)); err != nil {
		in.log.Debug("remember codex files read", "component", "codex", "err", err)
	}
}
