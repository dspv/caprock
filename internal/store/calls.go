package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"sort"

	"github.com/dspv/caprock/internal/event"
)

// MaxSessionCalls bounds GET /v1/sessions/{id}/calls. A long session makes a
// few thousand model calls; this is several times that, and still a page the
// cockpit draws in one pass.
const MaxSessionCalls = 20000

// callToolsMax is how many of a call's tool requests are returned with it.
// A model call asks for one to a handful; the count says when there were more.
const callToolsMax = 6

// SessionCall is one priced model call of a session's main thread: what the
// cockpit's spend scrubber reads bar by bar.
type SessionCall struct {
	ID      int64
	Ts      int64
	Model   string
	CostUSD float64
	Tokens  *event.TokenDelta
	// Tools are the tool calls this model call asked for, joined by msg_id —
	// exact, the tool_use block and the usage billed for it share the
	// message id. Empty when it asked for none or its agent records no id.
	Tools []CallTool
	// ToolCount is how many it asked for, which Tools may hold fewer of.
	ToolCount int

	msg string // its message id, which its tool calls carry
}

// CallTool is one tool request of a model call, with its raw input.
type CallTool struct {
	Tool  string
	Input json.RawMessage

	ts, id int64 // its tool.pre's: a call's tools are kept in this order
}

// before reports whether t comes before o in a call's tool list.
func (t CallTool) before(o CallTool) bool {
	return t.ts < o.ts || (t.ts == o.ts && t.id < o.id)
}

// SessionCalls returns the newest n priced main-thread model calls of a
// session, oldest first, each with the tool calls it requested. Internal
// model calls and unpriced turns are left out, as the cockpit's spark leaves
// them out; a subagent's calls are its own. Both queries walk the session's
// rows on idx_events_attr_work, which holds the kind, cost and message id they
// test, so a row is read from the table only when it is a candidate: on the
// session's own (sid, ts) index every event of the session was, 203,608 of
// them for the owner's longest session to return its 10,222 calls (a copy
// of his database, 2026-11-18; timings in 03-contracts.md § Session calls).
func SessionCalls(ctx context.Context, q Querier, sessionID string, n int) ([]SessionCall, error) {
	s, err := readSessionCalls(ctx, q, sessionID, n, nil)
	if err != nil {
		return nil, err
	}
	return s.Calls, nil
}

// CallsMark is what a session's calls were read at: its calls generation
// (session_gen.calls_gen, migration 0091), which moves on every update of a
// column the calls read and on every delete, and its newest event id, which
// every insert raises.
type CallsMark struct {
	Gen   int64
	MaxID int64
}

// Older reports whether m was read before o: calls_gen only grows, and while
// it stands only inserts happen, which only raise MaxID.
func (m CallsMark) Older(o CallsMark) bool {
	return m.Gen < o.Gen || (m.Gen == o.Gen && m.MaxID < o.MaxID)
}

func readCallsMark(ctx context.Context, q Querier, sessionID string) (CallsMark, error) {
	var m CallsMark
	err := q.QueryRowContext(ctx, `
		SELECT COALESCE((SELECT calls_gen FROM session_gen WHERE session_id = ?1), 0),
		       COALESCE((SELECT MAX(id) FROM events INDEXED BY idx_events_session_id
		                  WHERE sid = (SELECT sid FROM sessions WHERE session_id = ?1)), 0)`,
		sessionID).Scan(&m.Gen, &m.MaxID)
	return m, err
}

// CallsSeries is a session's calls as SessionCalls answers them, read at
// Mark, with what it takes to extend them by what changed since instead of
// reading the session again. A series is not changed once returned:
// extending one makes a new one, so an answer built from the old one stays
// as it was.
type CallsSeries struct {
	Mark  CallsMark
	Calls []SessionCall

	session string
	n       int
	// pending is the session's tool calls (of any thread) that had no message
	// id when read: the transcript's copy of a hook's tool call writes one on
	// it later (LinkToolCall), which does not move the calls generation, so
	// they are read again, by id, each time the series is extended.
	pending []int64
	// orphans is the main thread's tool calls whose model call is not among
	// Calls, by message id: a model call recorded after its tool calls takes
	// them when it comes, as a whole read would have joined them.
	orphans     map[string]callTools
	orphanBytes int
	// whole is set when pending or the orphans outgrew their bounds: the
	// next read is a whole one.
	whole bool
}

type callTools struct {
	count int
	tools []CallTool
}

// Bounds on what a series keeps to be extended; past one, the session is read
// whole next time instead.
const (
	callsPendingMax     = 1024
	callsOrphansMax     = 4096
	callsOrphanBytesMax = 4 << 20
)

// ReadSessionCalls is SessionCalls kept as a series, read in one snapshot of
// the database. Given prev — the series the same session and n were last read
// as — and a session whose calls generation has not moved since (so nothing
// the calls read was changed or deleted, and every new row took an id above
// prev's newest), it reads only the rows above prev.Mark.MaxID, a seek on
// idx_events_session_id, and prev's pending tool calls by id, and returns prev
// extended by them: the calls a whole read gives
// (TestSessionCallsExtendedMatchWhole). With nothing new it returns prev as it
// is. Otherwise it reads the session whole.
//
// Why: the cockpit's scrubber asks for a session's calls each time its tab
// opens, and a working session's events move every few seconds, so every ask
// read every priced turn and every tool call of the session again, payloads
// included: the largest reader of the owner's disk, 3.1 GB an hour
// (2026-11-23; § Session calls).
func ReadSessionCalls(ctx context.Context, db *sql.DB, sessionID string, n int, prev *CallsSeries) (*CallsSeries, error) {
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = conn.Close() }()
	// One read transaction: the mark and every read after it see the same
	// rows, so a row written meanwhile is neither missed nor taken twice.
	if _, err := conn.ExecContext(ctx, `BEGIN DEFERRED`); err != nil {
		return nil, err
	}
	defer func() { _, _ = conn.ExecContext(context.WithoutCancel(ctx), `ROLLBACK`) }()
	return readSessionCalls(ctx, conn, sessionID, n, prev)
}

func readSessionCalls(ctx context.Context, q Querier, sessionID string, n int, prev *CallsSeries) (*CallsSeries, error) {
	if n <= 0 || n > MaxSessionCalls {
		n = MaxSessionCalls
	}
	m, err := readCallsMark(ctx, q, sessionID)
	if err != nil {
		return nil, err
	}
	if prev != nil && !prev.whole && prev.session == sessionID && prev.n == n &&
		prev.Mark.Gen == m.Gen && prev.Mark.MaxID <= m.MaxID {
		if prev.Mark.MaxID == m.MaxID && len(prev.pending) == 0 {
			return prev, nil
		}
		return prev.extend(ctx, q, m)
	}
	s := &CallsSeries{Mark: m, session: sessionID, n: n, orphans: map[string]callTools{}}
	rows, err := q.QueryContext(ctx, `
		SELECT * FROM (
		  SELECT e.id, e.ts, COALESCE(e.model, ''), e.cost_usd, e.tokens_in, e.tokens_out, e.cache_read, e.cache_write, e.cache_write_1h, COALESCE(e.msg_id, '')
		    FROM events e INDEXED BY idx_events_attr_work
		   WHERE e.sid = (SELECT sid FROM sessions WHERE session_id = ?) AND e.kind = 'turn.assistant' AND e.cost_usd IS NOT NULL AND e.internal = 0 AND `+MainThreadWhere+`
		   ORDER BY e.ts DESC, e.id DESC LIMIT ?)
		 ORDER BY 2 ASC, 1 ASC`, sessionID, n)
	if err != nil {
		return nil, err
	}
	if s.Calls, err = scanSessionCalls(rows); err != nil {
		return nil, err
	}
	tools, err := q.QueryContext(ctx, `
		SELECT e.id, e.ts, e.msg_id, COALESCE(e.tool, ''), COALESCE(json_extract(`+ZPayloadE+`, '$.tool_input'), '')
		  FROM events e INDEXED BY idx_events_attr_work
		 WHERE e.sid = (SELECT sid FROM sessions WHERE session_id = ?) AND e.kind = 'tool.pre' AND COALESCE(e.msg_id, '') <> '' AND `+mainThreadToolWhere+`
		 ORDER BY e.ts ASC, e.id ASC`, sessionID)
	if err != nil {
		return nil, err
	}
	trs, err := scanCallToolRows(tools)
	if err != nil {
		return nil, err
	}
	// The index holds kind and msg_id: these are read without a row.
	pend, err := q.QueryContext(ctx, `
		SELECT e.id FROM events e INDEXED BY idx_events_attr_work
		 WHERE e.sid = (SELECT sid FROM sessions WHERE session_id = ?) AND e.kind = 'tool.pre' AND e.msg_id IS NULL`, sessionID)
	if err != nil {
		return nil, err
	}
	if s.pending, err = scanIDs(pend); err != nil {
		return nil, err
	}
	s.whole = len(s.pending) > callsPendingMax
	s.join(trs, nil)
	return s, nil
}

// extend is s with what changed since: the rows above s.Mark.MaxID, and the
// pending tool calls that have a message id now; read at m.
func (s *CallsSeries) extend(ctx context.Context, q Querier, m CallsMark) (*CallsSeries, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT e.id, e.ts, COALESCE(e.model, ''), e.cost_usd, e.tokens_in, e.tokens_out, e.cache_read, e.cache_write, e.cache_write_1h, COALESCE(e.msg_id, '')
		  FROM events e INDEXED BY idx_events_session_id
		 WHERE e.sid = (SELECT sid FROM sessions WHERE session_id = ?) AND e.id > ?
		   AND e.kind = 'turn.assistant' AND e.cost_usd IS NOT NULL AND e.internal = 0 AND `+MainThreadWhere+`
		 ORDER BY e.id`, s.session, s.Mark.MaxID)
	if err != nil {
		return nil, err
	}
	added, err := scanSessionCalls(rows)
	if err != nil {
		return nil, err
	}
	// The new tool rows, those still without a message id among them, and the
	// pending ones by id; ordered as a whole read orders them.
	ids, _ := json.Marshal(s.pending)
	tools, err := q.QueryContext(ctx, `
		SELECT e.id, e.ts, e.msg_id, COALESCE(e.tool, ''),
		       CASE WHEN COALESCE(e.msg_id, '') <> '' AND `+mainThreadToolWhere+`
		            THEN COALESCE(json_extract(`+ZPayloadE+`, '$.tool_input'), '') END
		  -- NOT INDEXED: by rowid, never a walk of every tool call by kind
		  FROM events e NOT INDEXED
		 WHERE e.id IN (
		         SELECT id FROM events INDEXED BY idx_events_session_id
		          WHERE sid = (SELECT sid FROM sessions WHERE session_id = ?) AND id > ?
		         UNION ALL SELECT value FROM json_each(?))
		   AND e.kind = 'tool.pre'
		 ORDER BY e.ts ASC, e.id ASC`, s.session, s.Mark.MaxID, string(ids))
	if err != nil {
		return nil, err
	}
	var trs []callToolRow
	var pending []int64
	for tools.Next() {
		var t callToolRow
		var msg sql.NullString
		var input sql.NullString
		if err := tools.Scan(&t.id, &t.ts, &msg, &t.tool, &input); err != nil {
			_ = tools.Close()
			return nil, err
		}
		switch {
		case !msg.Valid:
			pending = append(pending, t.id)
		case input.Valid: // a main-thread tool call with a message id
			t.msg, t.input = msg.String, input.String
			trs = append(trs, t)
		}
	}
	if err := tools.Err(); err != nil {
		_ = tools.Close()
		return nil, err
	}
	if err := tools.Close(); err != nil {
		return nil, err
	}
	if len(added) == 0 && len(trs) == 0 {
		// Nothing the calls show moved: s's calls, at the new mark.
		next := *s
		next.Mark, next.pending = m, pending
		next.whole = s.whole || len(pending) > callsPendingMax
		return &next, nil
	}

	next := &CallsSeries{Mark: m, session: s.session, n: s.n, pending: pending,
		orphans: make(map[string]callTools, len(s.orphans)), orphanBytes: s.orphanBytes}
	next.whole = len(pending) > callsPendingMax
	for k, v := range s.orphans {
		next.orphans[k] = v
	}
	calls := make([]SessionCall, len(s.Calls), len(s.Calls)+len(added))
	copy(calls, s.Calls)
	sorted := true
	fresh := make([]int64, 0, len(added))
	for _, c := range added {
		if k := len(calls); k > 0 && (c.Ts < calls[k-1].Ts || (c.Ts == calls[k-1].Ts && c.ID < calls[k-1].ID)) {
			sorted = false
		}
		calls = append(calls, c)
		fresh = append(fresh, c.ID)
	}
	if !sorted {
		sort.SliceStable(calls, func(i, j int) bool {
			if calls[i].Ts != calls[j].Ts {
				return calls[i].Ts < calls[j].Ts
			}
			return calls[i].ID < calls[j].ID
		})
	}
	if len(calls) > s.n {
		calls = calls[len(calls)-s.n:]
	}
	next.Calls = calls
	next.join(trs, fresh)
	return next, nil
}

// join gives the series' calls their tool rows: first the orphans whose call
// has come (fresh: the calls just added), then trs, each to its call by
// message id or, with none among the calls, to the orphans. A call's tool
// list is copied before it is changed, so a call shared with an older series
// stays as it was there.
func (s *CallsSeries) join(trs []callToolRow, fresh []int64) {
	byMsg := make(map[string]int, len(s.Calls))
	for i, c := range s.Calls {
		if c.msg != "" {
			byMsg[c.msg] = i
		}
	}
	own := map[int]bool{}
	add := func(i int, t CallTool) {
		c := &s.Calls[i]
		if !own[i] {
			c.Tools = append([]CallTool(nil), c.Tools...)
			own[i] = true
		}
		c.ToolCount++
		c.Tools = insertTool(c.Tools, t)
	}
	if len(s.orphans) > 0 && len(fresh) > 0 {
		isFresh := make(map[int64]bool, len(fresh))
		for _, id := range fresh {
			isFresh[id] = true
		}
		for i, c := range s.Calls {
			o, ok := s.orphans[c.msg]
			if !ok || c.msg == "" || !isFresh[c.ID] {
				continue
			}
			delete(s.orphans, c.msg)
			for _, t := range o.tools {
				s.orphanBytes -= len(t.Input)
				add(i, t)
			}
			s.Calls[i].ToolCount += o.count - len(o.tools) // counted, not kept
		}
	}
	for _, t := range trs {
		if t.tool == "" {
			continue
		}
		ct := CallTool{Tool: t.tool, Input: json.RawMessage(t.input), ts: t.ts, id: t.id}
		if i, ok := byMsg[t.msg]; ok {
			add(i, ct)
			continue
		}
		o := s.orphans[t.msg]
		for _, x := range o.tools {
			s.orphanBytes -= len(x.Input)
		}
		o = callTools{count: o.count + 1, tools: insertTool(append([]CallTool(nil), o.tools...), ct)}
		for _, x := range o.tools {
			s.orphanBytes += len(x.Input)
		}
		s.orphans[t.msg] = o
		if len(s.orphans) > callsOrphansMax || s.orphanBytes > callsOrphanBytesMax {
			s.whole = true
		}
	}
}

// insertTool puts t into a call's tools in order, keeping the first
// callToolsMax.
func insertTool(tools []CallTool, t CallTool) []CallTool {
	at := len(tools)
	for at > 0 && t.before(tools[at-1]) {
		at--
	}
	if at >= callToolsMax {
		return tools
	}
	tools = append(tools, CallTool{})
	copy(tools[at+1:], tools[at:])
	tools[at] = t
	if len(tools) > callToolsMax {
		tools = tools[:callToolsMax]
	}
	return tools
}

func scanSessionCalls(rows *sql.Rows) ([]SessionCall, error) {
	var out []SessionCall
	for rows.Next() {
		var c SessionCall
		var cost sql.NullFloat64
		var tin, tout, cr, cw, cw1h sql.NullInt64
		if err := rows.Scan(&c.ID, &c.Ts, &c.Model, &cost, &tin, &tout, &cr, &cw, &cw1h, &c.msg); err != nil {
			_ = rows.Close()
			return nil, err
		}
		c.CostUSD = cost.Float64
		if tin.Valid || tout.Valid || cr.Valid || cw.Valid {
			c.Tokens = &event.TokenDelta{In: tin.Int64, Out: tout.Int64, CacheRead: cr.Int64, CacheWrite: cw.Int64, CacheWrite1h: cw1h.Int64}
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	return out, rows.Close()
}

// callToolRow is one tool.pre row a series joins to its call.
type callToolRow struct {
	id, ts           int64
	msg, tool, input string
}

func scanCallToolRows(rows *sql.Rows) ([]callToolRow, error) {
	var out []callToolRow
	for rows.Next() {
		var t callToolRow
		if err := rows.Scan(&t.id, &t.ts, &t.msg, &t.tool, &t.input); err != nil {
			_ = rows.Close()
			return nil, err
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	return out, rows.Close()
}

func scanIDs(rows *sql.Rows) ([]int64, error) {
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return nil, err
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	return out, rows.Close()
}
