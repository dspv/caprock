package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"slices"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// A summary cut by session.
//
// WHY. The wide summaries (7d, 30d, all time) are what the dashboard asks for
// most and what reads most: /v1/history?range=all once a minute from the Now
// screen, /v1/stats/summary for the Cost screen, the cockpit's period and the
// projects panel. Each answer read every event in its range again — the
// per-kind totals, the distinct sessions, the model mix, the per-session
// spend, the carry-forward scan and the tool distribution, ~150 MB of index
// for all time on a 680k-event database — and while agents work the data
// version moves on every commit, so every expired answer was counted again
// from the start. On a machine short of memory those pages are evicted
// between polls and every count is real disk I/O: the owner's daemon read
// 1.6 GB an hour against a 500 MB line (2026-11-20, 2.1 GB database).
//
// WHAT. Every figure a summary sums is summed per session first
// (sessionPart), from one ordered scan of idx_events_attr_work, which covers
// every column they read (migration 0087). A session's part depends only on
// its own events and the range's start, so a range's parts are kept
// (PartsCache) and, when asked again, only the sessions whose events moved
// since are read again — a seek per session on the same index. Which moved is
// known without reading events: a new row takes an id above the newest one
// seen, and every update or delete of a session's events moves its
// session_gen (migration 0063). The answer is then built from the parts in
// Go: the summary of a range nobody worked in reads nothing, and one with two
// live agents reads their rows in range.
//
// The parts are the same whether kept or counted afresh, so a cached summary
// is the uncached one (SummarizeSparkFor builds from parts too); only the
// order floating-point sums are added in differs from the SQL aggregates they
// replace, far below the cent the screen shows.

// kindPart is one session's events of one kind in range, non-internal.
type kindPart struct {
	kind                 string
	n, tin, tout, cr, cw int64
	cost                 float64
	// paid sums only the positive costs: SpendPartsBetween's cost_usd > 0.
	paid float64
}

// modelPart is one session's non-internal assistant turns of one model.
type modelPart struct {
	model                 string
	tokens                int64
	cost                  float64
	turns, out, cacheRead int64
}

// countPart is turns and tokens of one model: unpriced turns (non-internal,
// no cost, tokens > 0) and background ones (internal; model as stored,
// resolved against the session's model when the summary is built).
type countPart struct {
	model         string
	turns, tokens int64
}

// hourPart is one session's non-internal assistant turns in one clock hour
// and one sparkline column, both counted from the parts' base (-1 for turns
// before it); the column is the hour itself when the parts are kept.
type hourPart struct {
	bucket, hr           int64
	tokens, input, turns int64
	priced               int64
	cost                 float64
}

// attrPart is the turns carry-forward put in one directory and the work kind
// they did (the carry-forward scan's turns, summed instead of kept one by one).
type attrPart struct {
	dir     string
	hasDir  bool
	work    WorkKind
	hasWork bool
	tokens  int64
	cost    float64
	turns   int64
}

// toolPart is one tool's calls and bytes handed back (ToolDistribution).
type toolPart struct {
	tool         string
	calls, bytes int64
}

// usagePart is usageRows' row for one session.
type usagePart struct {
	model string
	sub   bool
	c     usageCount
}

// hermesPart is HermesSpend's row for one session.
type hermesPart struct {
	basis, source   string
	background      int
	turns, unpriced int64
	usd             float64
}

// cursorPart is CursorSpend's row for one session.
type cursorPart struct {
	model            string
	usd              float64
	requests, tokens int64
	hasCost          bool
}

// sessionPart is what one session put into every figure a summary sums.
type sessionPart struct {
	kinds      []kindPart
	models     []modelPart
	unpriced   []countPart
	background []countPart
	hours      []hourPart
	attr       []attrPart
	unlinked   int64
	tools      []toolPart
	usage      []usagePart
	hermes     []hermesPart
	cursor     []cursorPart
}

func (p *sessionPart) empty() bool {
	return len(p.kinds) == 0 && len(p.background) == 0 && len(p.tools) == 0 &&
		len(p.usage) == 0 && len(p.hermes) == 0 && len(p.cursor) == 0
}

// rangeParts are the parts of every session with events in range, by sid
// (events.sid is NOT NULL, migration 0073: every row has a session).
type rangeParts struct {
	sids map[int64]*sessionPart
	// base and width are the grid the hours were counted on: hours and
	// columns of width ms from base.
	base, width int64
}

// partsScope is the sessions a parts read covers: all (a whole range) or the
// sids listed (the ones that moved).
type partsScope struct {
	all  bool
	sids []int64
}

func (sc partsScope) clause(col string) (string, []any) {
	if sc.all {
		return col + " IS NOT NULL", nil
	}
	list, _ := json.Marshal(sc.sids)
	return col + " IN (SELECT value FROM json_each(?))", []any{string(list)}
}

// readParts reads the parts of the sessions in scope for the range starting
// at from, hours and columns of width ms (an hour when 0) counted from base.
// A whole range within seekSessionsWithin seeks the sessions with rows in it
// instead of walking the index: past 48 hours most of the index is in range
// anyway and the seeks cost more than the scan they skip (on a copy of the
// owner's database, 2026-10-14: 7 days 114 ms scanned and 139 ms sought, 30
// days 225 ms and 325 ms, today 79 ms scanned and 52 ms sought).
func readParts(ctx context.Context, q Querier, from, base, width int64, sc partsScope) (rangeParts, error) {
	if width <= 0 {
		width = 3600000
	}
	out := rangeParts{sids: map[int64]*sessionPart{}, base: base, width: width}
	where, args := sc.clause("sid")
	if sc.all && nowMs()-from <= seekSessionsWithin.Milliseconds() {
		where, args = `sid IN (SELECT DISTINCT sid FROM events INDEXED BY idx_events_ts_cover WHERE ts >= ?)`, []any{from}
	}
	if err := scanEventParts(ctx, q, from, where, args, &out); err != nil {
		return out, err
	}
	if err := readAgentParts(ctx, q, from, sc, &out); err != nil {
		return out, err
	}
	return out, nil
}

// scanEventParts is the one ordered scan every covered figure comes from:
// each session's events in range, in (sid, ts, id) order on
// idx_events_attr_work, which holds every column read (migration 0087), so
// no row is read from the table.
//
// The order is what the carry-forward rule needs (§ Touch attribution DDL):
// a turn belongs to the directory of the newest file touched at or before it
// in its session, so tool calls and turns are read together in event order
// and the carry is threaded through them here, reset at every session — a
// window function was rejected because whether a carried directory is inside
// the repository needs the ingest path's own path normalization. A turn's
// work kind is its OWN tool calls' (§ Work attribution DDL), by message id,
// and those calls come after the turn's row, so the kinds are applied once
// the session's rows are all read (partAcc.finish). A tool call with no
// message id is counted, not guessed at (work_unlinked_calls).
func scanEventParts(ctx context.Context, q Querier, from int64, where string, args []any, out *rangeParts) error {
	rows, err := q.QueryContext(ctx, `
		SELECT sid, kind, internal, COALESCE(model,''), COALESCE(msg_id,''), COALESCE(touch_dir,''),
		       COALESCE(inner_tool, tool, ''), COALESCE(tool,''), COALESCE(tool_bytes,0),
		       tokens_in, tokens_out, cache_read, cache_write, cost_usd, ts
		FROM events INDEXED BY idx_events_attr_work
		WHERE `+where+` AND ts >= ?
		ORDER BY sid, ts, id`, append(args, from)...)
	if err != nil {
		return err
	}
	defer rows.Close()
	var (
		cur      *sessionPart
		curSid   int64
		acc      partAcc
		carryDir string
		carried  bool
	)
	flush := func() {
		if cur == nil {
			return
		}
		acc.finish(cur)
		if !cur.empty() {
			out.sids[curSid] = cur
		}
	}
	for rows.Next() {
		var sid int64
		var kind, model, msg, dir, workTool, tool string
		var internal int
		var bytes int64
		var tin, tout, cr, cw sql.NullInt64
		var cost sql.NullFloat64
		var ts int64
		if err := rows.Scan(&sid, &kind, &internal, &model, &msg, &dir, &workTool, &tool, &bytes,
			&tin, &tout, &cr, &cw, &cost, &ts); err != nil {
			return err
		}
		if cur == nil || sid != curSid {
			flush()
			cur, curSid = &sessionPart{}, sid
			acc.reset()
			carryDir, carried = "", false
		}
		tokens := tin.Int64 + tout.Int64 + cr.Int64 + cw.Int64
		if internal != 0 {
			// Internal model work counts only as background.
			if kind == string(event.KindTurnAssistant) {
				acc.background(model, tokens)
			}
			continue
		}
		acc.kind(kind, tin.Int64, tout.Int64, cr.Int64, cw.Int64, cost)
		isTool := kind == string(event.KindToolPre) || kind == string(event.KindToolPost)
		if isTool && tool != "" {
			acc.tool(tool, kind == string(event.KindToolPre), bytes)
		}
		switch kind {
		case string(event.KindTurnAssistant):
			acc.model(model, tokens, cost, tout.Int64, cr.Int64)
			if !cost.Valid && tokens > 0 {
				acc.unpricedTurn(model, tokens)
			}
			b, hr := int64(-1), int64(-1)
			if ts >= out.base {
				b, hr = (ts-out.base)/out.width, (ts-out.base)/3600000
			}
			acc.hour(b, hr, tokens, tin.Int64+cr.Int64+cw.Int64, cost)
			acc.turn(turnSpend{tokens: tokens, cost: cost.Float64,
				touched: TouchDirs{Dir: carryDir, HasDir: carried}, msgKey: msg, hasMsg: msg != ""})
		case string(event.KindToolPre):
			if msg == "" {
				cur.unlinked++
			} else {
				acc.workOf(msg, workKindOf(workTool))
			}
			// Only a tool that named a file moves the carry; a pathless one
			// (Bash, Grep) is part of the same stretch of work.
			if dir != "" {
				carryDir, carried = dir, true
			}
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	flush()
	return nil
}

// partAcc gathers one session's part while its rows are scanned.
type partAcc struct {
	kinds    []kindPart
	models   []modelPart
	unpriced []countPart
	bg       []countPart
	hours    map[[2]int64]*hourPart
	hourKeys [][2]int64
	tools    []toolPart
	turns    []turnSpend
	works    map[string]WorkKind
}

func (a *partAcc) reset() {
	a.kinds, a.models, a.unpriced, a.bg, a.tools = nil, nil, nil, nil, nil
	a.hourKeys, a.turns = a.hourKeys[:0], a.turns[:0]
	if a.hours == nil {
		a.hours, a.works = map[[2]int64]*hourPart{}, map[string]WorkKind{}
	}
	clear(a.hours)
	clear(a.works)
}

func (a *partAcc) kind(kind string, tin, tout, cr, cw int64, cost sql.NullFloat64) {
	i := slices.IndexFunc(a.kinds, func(k kindPart) bool { return k.kind == kind })
	if i < 0 {
		a.kinds = append(a.kinds, kindPart{kind: kind})
		i = len(a.kinds) - 1
	}
	k := &a.kinds[i]
	k.n++
	k.tin += tin
	k.tout += tout
	k.cr += cr
	k.cw += cw
	k.cost += cost.Float64
	if cost.Float64 > 0 {
		k.paid += cost.Float64
	}
}

func (a *partAcc) model(model string, tokens int64, cost sql.NullFloat64, out, cacheRead int64) {
	i := slices.IndexFunc(a.models, func(m modelPart) bool { return m.model == model })
	if i < 0 {
		a.models = append(a.models, modelPart{model: model})
		i = len(a.models) - 1
	}
	m := &a.models[i]
	m.tokens += tokens
	m.cost += cost.Float64
	m.turns++
	m.out += out
	m.cacheRead += cacheRead
}

func addCount(list []countPart, model string, tokens int64) []countPart {
	i := slices.IndexFunc(list, func(c countPart) bool { return c.model == model })
	if i < 0 {
		list = append(list, countPart{model: model})
		i = len(list) - 1
	}
	list[i].turns++
	list[i].tokens += tokens
	return list
}

func (a *partAcc) unpricedTurn(model string, tokens int64) {
	a.unpriced = addCount(a.unpriced, model, tokens)
}
func (a *partAcc) background(model string, tokens int64) { a.bg = addCount(a.bg, model, tokens) }

func (a *partAcc) hour(b, hr, tokens, input int64, cost sql.NullFloat64) {
	k := [2]int64{b, hr}
	h := a.hours[k]
	if h == nil {
		h = &hourPart{bucket: b, hr: hr}
		a.hours[k] = h
		a.hourKeys = append(a.hourKeys, k)
	}
	h.tokens += tokens
	h.input += input
	h.turns++
	h.cost += cost.Float64
	if cost.Valid {
		h.priced++
	}
}

func (a *partAcc) tool(tool string, pre bool, bytes int64) {
	i := slices.IndexFunc(a.tools, func(t toolPart) bool { return t.tool == tool })
	if i < 0 {
		a.tools = append(a.tools, toolPart{tool: tool})
		i = len(a.tools) - 1
	}
	if pre {
		a.tools[i].calls++
	}
	a.tools[i].bytes += bytes
}

func (a *partAcc) turn(t turnSpend) { a.turns = append(a.turns, t) }

// workOf keeps the strongest kind of work a message's tool calls did.
func (a *partAcc) workOf(msg string, k WorkKind) {
	if cur, seen := a.works[msg]; !seen || workKindRank(k) < workKindRank(cur) {
		a.works[msg] = k
	}
}

// finish resolves the session's turns once all its rows are read (a turn's
// tool calls come after it) and sums them by directory and work kind, in the
// order each first appears.
func (a *partAcc) finish(p *sessionPart) {
	p.kinds, p.models, p.unpriced, p.background, p.tools = a.kinds, a.models, a.unpriced, a.bg, a.tools
	for _, k := range a.hourKeys {
		p.hours = append(p.hours, *a.hours[k])
	}
	resolveWork(a.turns, a.works)
	type key struct {
		dir     string
		hasDir  bool
		work    WorkKind
		hasWork bool
	}
	idx := map[key]int{}
	for _, t := range a.turns {
		k := key{t.touched.Dir, t.touched.HasDir, t.work, t.hasWork}
		i, ok := idx[k]
		if !ok {
			i = len(p.attr)
			idx[k] = i
			p.attr = append(p.attr, attrPart{dir: k.dir, hasDir: k.hasDir, work: k.work, hasWork: k.hasWork})
		}
		p.attr[i].tokens += t.tokens
		p.attr[i].cost += t.cost
		p.attr[i].turns++
	}
}

// readAgentParts reads the figures only Cursor's and Hermes's sessions have,
// from their payloads: usage records and request counts (usageRows), Hermes's
// cost basis (HermesSpend) and Cursor's requests (CursorSpend). Each reads
// those agents' sessions alone, as the queries it replaces did.
func readAgentParts(ctx context.Context, q Querier, from int64, sc partsScope, out *rangeParts) error {
	where, args := sc.clause("s.sid")
	part := func(sid int64) *sessionPart {
		p := out.sids[sid]
		if p == nil {
			p = &sessionPart{}
			out.sids[sid] = p
		}
		return p
	}
	rows, err := q.QueryContext(ctx, `
		SELECT e.sid, COALESCE(e.model,''), COALESCE(e.agent_id,'') <> '',
		       COALESCE(SUM(substr(e.key,1,9) IN ('cu-usage:','hm-usage:')),0),
		       COALESCE(SUM(CASE WHEN e.source = 'cursor' AND e.cost_usd IS NOT NULL AND json_valid(e.payload)
		                         THEN json_extract(e.payload,'$.requests') END),0),
		       COALESCE(SUM(CASE WHEN e.source = 'cursor' THEN e.cost_usd END),0)
		FROM sessions s JOIN events e INDEXED BY idx_events_session_ts
		  ON e.sid = s.sid AND e.ts >= ?
		WHERE `+where+` AND s.agent IN ('cursor','hermes') AND e.kind = 'turn.assistant'`+nonInternalEventE+`
		GROUP BY 1, 2, 3`, append([]any{from}, args...)...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var sid int64
		var u usagePart
		var req float64
		if err := rows.Scan(&sid, &u.model, &u.sub, &u.c.Records, &req, &u.c.CostUSD); err != nil {
			_ = rows.Close()
			return err
		}
		u.c.Requests = int64(req)
		if u.c.Records != 0 || u.c.Requests != 0 {
			p := part(sid)
			p.usage = append(p.usage, u)
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	_ = rows.Close()
	rows, err = q.QueryContext(ctx, `
		SELECT s.sid, COALESCE(json_extract(e.payload,'$.cost_basis'),''),
		       COALESCE(json_extract(e.payload,'$.hermes_source'),''),
		       COALESCE(json_extract(e.payload,'$.background'),0),
		       COUNT(*),
		       COALESCE(SUM(e.cost_usd),0),
		       COALESCE(SUM(CASE WHEN e.cost_usd IS NULL
		            AND COALESCE(e.tokens_in,0)+COALESCE(e.tokens_out,0)+COALESCE(e.cache_read,0)+COALESCE(e.cache_write,0) > 0
		            THEN 1 ELSE 0 END),0)
		FROM sessions s JOIN events e INDEXED BY idx_events_session_ts
		  ON e.sid = s.sid AND e.ts >= ?
		WHERE `+where+` AND s.agent = 'hermes' AND e.source = 'hermes' AND e.kind = 'turn.assistant'
		  AND json_valid(e.payload) AND json_extract(e.payload,'$.cost_basis') IS NOT NULL`+nonInternalEventE+`
		GROUP BY 1, 2, 3, 4`, append([]any{from}, args...)...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var sid int64
		var h hermesPart
		if err := rows.Scan(&sid, &h.basis, &h.source, &h.background, &h.turns, &h.usd, &h.unpriced); err != nil {
			_ = rows.Close()
			return err
		}
		p := part(sid)
		p.hermes = append(p.hermes, h)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	_ = rows.Close()
	rows, err = q.QueryContext(ctx, `
		SELECT s.sid, COALESCE(e.model,''),
		       COALESCE(SUM(e.cost_usd),0),
		       COALESCE(SUM(json_extract(e.payload,'$.requests')),0),
		       COALESCE(SUM(COALESCE(e.tokens_in,0)+COALESCE(e.tokens_out,0)),0),
		       COALESCE(MAX(e.cost_usd IS NOT NULL),0)
		FROM sessions s JOIN events e INDEXED BY idx_events_session_ts
		  ON e.sid = s.sid AND e.ts >= ?
		WHERE `+where+` AND s.agent = 'cursor' AND e.source = 'cursor' AND e.kind = 'turn.assistant'`+nonInternalEventE+`
		GROUP BY 1, 2`, append([]any{from}, args...)...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var sid int64
		var c cursorPart
		var hasCost int
		if err := rows.Scan(&sid, &c.model, &c.usd, &c.requests, &c.tokens, &hasCost); err != nil {
			return err
		}
		c.hasCost = hasCost == 1
		p := part(sid)
		p.cursor = append(p.cursor, c)
	}
	return rows.Err()
}

// sessionInfo is what a summary reads of a session row.
type sessionInfo struct {
	id, label, root, path, cwd, model string
	// agent is the column as stored (NULL read as ""); agentOr is it with
	// NULL as "claude", the agent filter's own reading.
	agent, agentOr, subscription string
	lastEventAt                  int64
}

func readSessionInfos(ctx context.Context, q Querier) (map[int64]sessionInfo, []int64, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT sid, session_id, COALESCE(project,''), COALESCE(repo_root,''), COALESCE(repo_path,''), COALESCE(cwd,''),
		       COALESCE(model,''), COALESCE(agent,''), COALESCE(agent,'claude'), COALESCE(subscription,''), COALESCE(last_event_at,0)
		FROM sessions ORDER BY sid`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	out := map[int64]sessionInfo{}
	var order []int64
	for rows.Next() {
		var sid int64
		var in sessionInfo
		if err := rows.Scan(&sid, &in.id, &in.label, &in.root, &in.path, &in.cwd, &in.model, &in.agent, &in.agentOr,
			&in.subscription, &in.lastEventAt); err != nil {
			return nil, nil, err
		}
		out[sid] = in
		order = append(order, sid)
	}
	return out, order, rows.Err()
}

// buildSummary is SummarizeSparkFor's answer, and SpendPartsBetween's for the
// same range and agent, from a range's parts whose hours count from base.
// Every rule is the one the per-range queries it replaces applied, including
// which figures the agent filter narrows (the work breakdown it never did).
func buildSummary(ctx context.Context, q Querier, from int64, spark SparkSpec, agent AgentFilter, rp rangeParts) (Summary, SpendParts, error) {
	s := Summary{FromMs: from}
	infos, order, err := readSessionInfos(ctx, q)
	if err != nil {
		return s, nil, err
	}
	sids := make([]int64, 0, len(rp.sids))
	for sid := range rp.sids {
		sids = append(sids, sid)
	}
	slices.Sort(sids)
	// inScope is the agent filter: a session of that agent (COALESCE(agent,
	// 'claude')), which a session whose row is gone never is.
	inScope := func(sid int64) bool {
		if agent == "" {
			return true
		}
		in, ok := infos[sid]
		return ok && in.agentOr == string(agent)
	}
	type scoped struct {
		sid int64
		p   *sessionPart
	}
	var parts []scoped
	for _, sid := range sids {
		if inScope(sid) {
			parts = append(parts, scoped{sid: sid, p: rp.sids[sid]})
		}
	}

	// Totals by kind, distinct sessions, the model mix and what was unpriced.
	models := map[string]*ModelShare{}
	var modelOrder []string
	unpriced := map[string]*countPart{}
	var unpricedOrder []string
	// unpricedCursor marks the unpriced models a Cursor chat contributed to
	// (Unpriced.Cursor): Cursor recorded no cost, the table is not missing.
	unpricedCursor := map[string]bool{}
	var cost SpendParts
	for _, x := range parts {
		var paid float64
		for _, k := range x.p.kinds {
			s.TokensIn += k.tin
			s.TokensOut += k.tout
			s.CacheRead += k.cr
			s.CacheWrite += k.cw
			s.CostUSD += k.cost
			paid += k.paid
			switch k.kind {
			case string(event.KindTurnAssistant):
				s.Turns += k.n
			case string(event.KindToolPre):
				s.ToolCalls += k.n
			}
		}
		if len(x.p.kinds) > 0 {
			s.Sessions++
		}
		// Spend whose session row is gone is the own sign-in's Claude Code
		// (SpendPartsBetween).
		a, sub := "claude", ""
		if in, ok := infos[x.sid]; ok {
			a, sub = in.agent, in.subscription
		}
		cost = cost.Add(a, sub, paid)
		for _, m := range x.p.models {
			ms := models[m.model]
			if ms == nil {
				ms = &ModelShare{Model: m.model}
				models[m.model] = ms
				modelOrder = append(modelOrder, m.model)
			}
			ms.Tokens += m.tokens
			ms.CostUSD += m.cost
			ms.Turns += m.turns
			ms.Output += m.out
			ms.CacheRead += m.cacheRead
		}
		for _, u := range x.p.unpriced {
			c := unpriced[u.model]
			if c == nil {
				c = &countPart{model: u.model}
				unpriced[u.model] = c
				unpricedOrder = append(unpricedOrder, u.model)
			}
			c.turns += u.turns
			c.tokens += u.tokens
			if a == "cursor" {
				unpricedCursor[u.model] = true
			}
		}
	}
	for _, m := range modelOrder {
		// A model can be priced in one chat and unpriced in another (Cursor
		// records a cost for some chats and not others): the row carries
		// both, so the priced part is not hidden behind "unpriced".
		if u := unpriced[m]; u != nil {
			models[m].UnpricedTokens = u.tokens
		}
		s.Models = append(s.Models, *models[m])
	}
	sort.SliceStable(s.Models, func(i, j int) bool { return s.Models[i].CostUSD > s.Models[j].CostUSD })
	// "Active" means active now, so it is not range-scoped, but it is bounded
	// in time: a first-run backfill marks every historical session active
	// before the reaper gets to them.
	active, activeArgs := `SELECT COUNT(*) FROM sessions WHERE status = 'active' AND last_event_at >= ?`, []any{nowMs() - int64(activeWindow/time.Millisecond)}
	if agent != "" {
		active, activeArgs = active+` AND COALESCE(agent,'claude') = ?`, append(activeArgs, string(agent))
	}
	if err := q.QueryRowContext(ctx, active, activeArgs...).Scan(&s.Active); err != nil {
		return s, nil, err
	}

	// Usage records out of the turn counts, Cursor's requests on its models
	// (usageRows' rule): those agents' sessions that were seen in range.
	if agent == "" || agent == "cursor" || agent == "hermes" {
		u := map[usageKey]usageCount{}
		for _, sid := range sids {
			in, ok := infos[sid]
			if !ok || in.lastEventAt < from || (agent == "" && in.agent != "cursor" && in.agent != "hermes") || (agent != "" && in.agent != string(agent)) {
				continue
			}
			for _, x := range rp.sids[sid].usage {
				u[usageKey{Sid: sid, Model: x.model, Sub: x.sub}] = x.c
			}
		}
		applyUsage(u, &s)
	}
	if len(unpricedOrder) > 0 {
		var un Unpriced
		sort.SliceStable(unpricedOrder, func(i, j int) bool { return unpriced[unpricedOrder[i]].tokens > unpriced[unpricedOrder[j]].tokens })
		for _, m := range unpricedOrder {
			un.Turns += unpriced[m].turns
			un.Tokens += unpriced[m].tokens
			un.Models = append(un.Models, m)
			if unpricedCursor[m] {
				un.Cursor = append(un.Cursor, m)
			}
		}
		if un.Turns > 0 {
			s.Unpriced = &un
		}
	}
	// Background: internal turns of sessions that have a row, named by the
	// session's model when the turn named none.
	bg := map[string]*countPart{}
	var bgOrder []string
	for _, x := range parts {
		in, ok := infos[x.sid]
		if !ok {
			continue
		}
		for _, c := range x.p.background {
			m := c.model
			if m == "" {
				m = in.model
			}
			b := bg[m]
			if b == nil {
				b = &countPart{model: m}
				bg[m] = b
				bgOrder = append(bgOrder, m)
			}
			b.turns += c.turns
			b.tokens += c.tokens
		}
	}
	if len(bgOrder) > 0 {
		var b BackgroundUsage
		sort.SliceStable(bgOrder, func(i, j int) bool { return bg[bgOrder[i]].tokens > bg[bgOrder[j]].tokens })
		for _, m := range bgOrder {
			b.Turns += bg[m].turns
			b.Tokens += bg[m].tokens
			b.Models = append(b.Models, m)
		}
		if b.Turns > 0 {
			s.Background = &b
		}
	}
	if agent == "" || agent == "hermes" {
		s.Hermes = hermesFromParts(sids, rp, infos)
	}
	if agent == "" || agent == "cursor" {
		s.Cursor = cursorFromParts(sids, rp, infos)
	}

	// The projects: per-session spend by repository, its sparkline and its
	// per-directory breakdown (SummarizeSparkFor's own comments say why
	// each rule is what it is).
	sparkOn := spark.Buckets > 0 && spark.WidthMs > 0
	type sessTotal struct {
		tokens int64
		cost   float64
	}
	totals := map[int64]sessTotal{}
	sparks := map[int64][]sessionBucket{}
	for _, x := range parts {
		if len(x.p.hours) == 0 {
			continue
		}
		var t sessTotal
		var series []sessionBucket
		for _, h := range x.p.hours {
			t.tokens += h.tokens
			t.cost += h.cost
			if !sparkOn || h.hr < 0 {
				continue
			}
			// Kept parts count columns an hour wide from the range's start,
			// which a sparkline's grid starts at too (PartsCache.Summary).
			b := h.bucket
			if rp.width != spark.WidthMs || rp.base != spark.FromMs {
				b = h.hr * 3600000 / spark.WidthMs
			}
			if b >= int64(spark.Buckets) {
				continue
			}
			if series == nil {
				series = make([]sessionBucket, spark.Buckets)
			}
			series[b].tokens += h.tokens
			series[b].cost += h.cost
			series[b].input += h.input
			series[b].turns += h.turns
			if h.priced >= UsualMinCalls && h.cost > 0 {
				series[b].activeHours++
				series[b].activeCost += h.cost
			}
		}
		totals[x.sid] = t
		if series != nil {
			sparks[x.sid] = series
		}
	}
	roots := map[string]bool{}
	for _, in := range infos {
		if in.root != "" {
			roots[in.root] = true
		}
	}
	byRoot := map[string]int{}
	rootLabel := map[string]string{}
	pathIdx := map[[2]string]int{}
	for _, sid := range order {
		in := infos[sid]
		if agent != "" && in.agentOr != string(agent) {
			continue
		}
		t, spent := totals[sid]
		if !spent {
			continue
		}
		delete(totals, sid)
		key := in.root
		if key == "" {
			if roots[in.cwd] {
				key = in.cwd
			} else {
				key = "cwd:" + in.cwd
			}
		}
		if key == "cwd:" {
			key = "label:" + in.label
		}
		i, ok := byRoot[key]
		if !ok {
			i = len(s.Projects)
			byRoot[key] = i
			rootLabel[key] = in.label
			dir := in.root
			if dir == "" {
				dir = in.cwd
			}
			s.Projects = append(s.Projects, ProjectShare{Project: in.label, Agent: in.agentOr, Dir: dir})
		}
		p := &s.Projects[i]
		if p.Agent != in.agentOr {
			p.Agent = ""
		}
		p.Tokens += t.tokens
		p.CostUSD += t.cost
		p.Sessions++
		if sparkOn {
			addSpark(p, spark, sparks[sid])
		}
		for _, a := range rp.sids[sid].attr {
			seg, _ := AttributeDir(TouchDirs{Dir: a.dir, HasDir: a.hasDir}, in.root)
			pk := [2]string{key, seg}
			j, ok := pathIdx[pk]
			if !ok {
				j = len(p.Paths)
				pathIdx[pk] = j
				p.Paths = append(p.Paths, PathShare{Path: seg})
			}
			ps := &p.Paths[j]
			ps.Tokens += a.tokens
			ps.CostUSD += a.cost
			ps.Turns += a.turns
		}
	}
	// Spend whose session row is gone still belongs in the totals (rule 6).
	if len(totals) > 0 {
		var orphan ProjectShare
		left := make([]int64, 0, len(totals))
		for sid := range totals {
			left = append(left, sid)
		}
		slices.Sort(left)
		for _, sid := range left {
			t := totals[sid]
			orphan.Tokens += t.tokens
			orphan.CostUSD += t.cost
			orphan.Sessions++
			if sparkOn {
				addSpark(&orphan, spark, sparks[sid])
			}
		}
		s.Projects = append(s.Projects, orphan)
	}
	finishProjects(&s, byRoot, rootLabel)

	// The work breakdown, over every session's turns whatever the agent
	// filter, as the per-range carry-forward scan's was.
	byKind := map[WorkKind]*WorkShare{}
	var unlinked int64
	for _, sid := range sids {
		p := rp.sids[sid]
		unlinked += p.unlinked
		for _, a := range p.attr {
			k := WorkNone
			if a.hasWork {
				k = a.work
			}
			w := byKind[k]
			if w == nil {
				w = &WorkShare{Kind: k}
				byKind[k] = w
			}
			w.Turns += a.turns
			w.Tokens += a.tokens
			w.CostUSD += a.cost
		}
	}
	s.Work, s.WorkUnlinkedCalls = orderWork(byKind), unlinked
	finishWork(&s)
	return s, cost.Sorted(), nil
}

// applyUsage takes the usage records out of a summary's turn counts and puts
// Cursor's request counts on its models.
func applyUsage(u map[usageKey]usageCount, s *Summary) {
	if len(u) == 0 {
		return
	}
	by := usageByModel(u)
	for i := range s.Models {
		c, ok := by[s.Models[i].Model]
		if !ok {
			continue
		}
		s.Models[i].Turns = max(0, s.Models[i].Turns-c.Records)
		if c.Requests > 0 {
			s.Models[i].Requests = c.Requests
			s.Models[i].RequestsCostUSD = c.CostUSD
		}
		s.Turns = max(0, s.Turns-c.Records)
	}
}

func hermesFromParts(sids []int64, rp rangeParts, infos map[int64]sessionInfo) *HermesCost {
	var out HermesCost
	seen := false
	bySource := map[string]float64{}
	for _, sid := range sids {
		if in, ok := infos[sid]; !ok || in.agent != "hermes" {
			continue
		}
		for _, h := range rp.sids[sid].hermes {
			seen = true
			out.TotalUSD += h.usd
			out.UnpricedTurns += h.unpriced
			switch h.basis {
			case "actual":
				out.ActualUSD += h.usd
			case "included":
				out.IncludedTurns += h.turns
			default:
				out.EstimatedUSD += h.usd
			}
			if h.background == 1 {
				out.BackgroundUSD += h.usd
				bySource[h.source] += h.usd
			}
		}
	}
	if !seen {
		return nil
	}
	for src, usd := range bySource {
		out.Sources = append(out.Sources, HermesSource{Source: src, CostUSD: usd})
	}
	sort.Slice(out.Sources, func(i, j int) bool {
		if out.Sources[i].CostUSD != out.Sources[j].CostUSD {
			return out.Sources[i].CostUSD > out.Sources[j].CostUSD
		}
		return out.Sources[i].Source < out.Sources[j].Source
	})
	return &out
}

func cursorFromParts(sids []int64, rp rangeParts, infos map[int64]sessionInfo) *CursorCost {
	var out CursorCost
	chats, priced := 0, 0
	byModel := map[string]*CursorModel{}
	for _, sid := range sids {
		if in, ok := infos[sid]; !ok || in.agent != "cursor" {
			continue
		}
		rows := rp.sids[sid].cursor
		if len(rows) == 0 {
			continue
		}
		chats++
		anyCost := false
		for _, c := range rows {
			m := byModel[c.model]
			if m == nil {
				m = &CursorModel{Model: c.model}
				byModel[c.model] = m
			}
			m.CostUSD += c.usd
			m.Requests += c.requests
			m.Tokens += c.tokens
			out.TotalUSD += c.usd
			out.Requests += c.requests
			if c.hasCost {
				anyCost = true
				m.Priced = true
			} else {
				out.UnpricedTokens += c.tokens
			}
		}
		if anyCost {
			priced++
		}
	}
	if chats == 0 {
		return nil
	}
	out.Chats, out.PricedChats = int64(chats), int64(priced)
	for _, m := range byModel {
		out.Models = append(out.Models, *m)
	}
	sort.Slice(out.Models, func(i, j int) bool {
		if out.Models[i].CostUSD != out.Models[j].CostUSD {
			return out.Models[i].CostUSD > out.Models[j].CostUSD
		}
		if out.Models[i].Tokens != out.Models[j].Tokens {
			return out.Models[i].Tokens > out.Models[j].Tokens
		}
		return out.Models[i].Model < out.Models[j].Model
	})
	return &out
}

// toolsFromParts is ToolDistribution from a range's parts; tools with the
// same count are ordered by name.
func toolsFromParts(rp rangeParts, limit int) []ToolCount {
	if limit <= 0 {
		limit = 50
	}
	by := map[string]*ToolCount{}
	add := func(p *sessionPart) {
		for _, t := range p.tools {
			c := by[t.tool]
			if c == nil {
				c = &ToolCount{Tool: t.tool}
				by[t.tool] = c
			}
			c.Count += t.calls
			c.Bytes += t.bytes
		}
	}
	for _, p := range rp.sids {
		add(p)
	}
	out := make([]ToolCount, 0, len(by))
	for _, c := range by {
		out = append(out, *c)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Tool < out[j].Tool
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// PartsCache keeps each wide range's parts between requests, so a summary
// asked again reads only the sessions whose events moved since (see the top
// of this file). Safe for concurrent use; one range is refreshed by one
// caller at a time, and concurrent callers for it wait for that refresh.
type PartsCache struct {
	mu     sync.Mutex
	ranges map[int64]*keptParts
	// now is time.Now, swapped in tests.
	now func() time.Time
	// throttle is partsThrottle, 0 in tests that want every move at once.
	throttle time.Duration
	// hurry counts Hurry calls; a range that has not seen the newest reads
	// what moved on its next ask whatever the throttle says. Guarded by mu.
	hurry uint64
	// keep is set by Keep: ranges are started from and written to
	// parts_kept (keptparts.go), stamped with version.
	keep    bool
	version string
	saving  sync.WaitGroup
}

// partsMaxChanged is how many moved sessions are read one by one before a
// refresh reads the whole range instead: past it the seeks cost more than
// the scan they save.
const partsMaxChanged = 256

// partsIdle is how long a range's parts are kept unasked: yesterday's 7d is
// not asked again once the day turns.
const partsIdle = 15 * time.Minute

// partsRebuild bounds how long parts are kept on what moved alone: a change
// no counter sees (the events of a session whose row is gone) is picked up
// by then.
const partsRebuild = 6 * time.Hour

// partsThrottle is how soon after a range's events were read they are read
// again for what moved: within it, an ask is answered from the parts as they
// are and every move in the window is read together on the first ask past
// it (the moved sessions since the kept mark, so nothing is skipped). With
// agents working every commit moves a session, and today's summary and
// history, asked every two or three seconds by the Now screen, read each
// moved session's whole range again on every ask, once per kept range: 966
// reads an hour on a stand with two writing sessions, 288 with the window
// (2026-11-22, § Pricing table's cache notes in 03-contracts.md). The cost is that a figure built from the parts — today's
// cost and tokens included — may be up to this far behind; an answer built
// on parts that are behind says so (NoteLag), so the answer caches above do
// not keep it as current.
const partsThrottle = 15 * time.Second

// partsLagKey carries the flag NoteLag hands out.
type partsLagKey struct{}

// NoteLag returns ctx carrying a flag that a PartsCache read through it sets
// when the parts it answered from are behind the events: something moved and
// the throttle held the read back. A caller that keeps the answer keyed by
// the data's version must not record that version for it.
func NoteLag(ctx context.Context) (context.Context, *atomic.Bool) {
	f := &atomic.Bool{}
	return context.WithValue(ctx, partsLagKey{}, f), f
}

// keptParts is one range's parts and the state of the events they were read
// at.
type keptParts struct {
	mu    sync.Mutex
	ok    bool
	parts rangeParts
	mark  EventsMark
	built time.Time
	used  time.Time
	// read is when events were last read for these parts (whole or what
	// moved), which the throttle counts from; hurry is the cache's Hurry
	// count they were read at.
	read  time.Time
	hurry uint64
	// reads counts the reads made (for tests): full scans and partial ones.
	full, partial int
	// tried is set once parts_kept was looked at for this range; saved is
	// when the parts were last written there.
	tried bool
	saved time.Time
	// unsaved is set when a write to parts_kept failed (a writer held the
	// database past the busy timeout): the next refresh writes again.
	unsaved atomic.Bool
	// loaded counts ranges started from parts_kept (for tests).
	loaded int
}

// NewPartsCache returns an empty cache.
func NewPartsCache() *PartsCache {
	return &PartsCache{ranges: map[int64]*keptParts{}, now: time.Now, throttle: partsThrottle}
}

// Hurry makes every kept range read what moved on its next ask, throttle or
// not: a removal the owner just made shows at once.
func (c *PartsCache) Hurry() {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.hurry++
	c.mu.Unlock()
}

// Keep makes the cache start each range from what parts_kept holds for it
// and write the parts there (keptparts.go). version is the build's: a row
// another build wrote is not used.
func (c *PartsCache) Keep(version string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.keep, c.version = true, version
	c.mu.Unlock()
}

// WaitSaved waits for the writes to parts_kept under way. For tests and
// shutdown.
func (c *PartsCache) WaitSaved() {
	if c != nil {
		c.saving.Wait()
	}
}

// SetThrottle replaces partsThrottle; 0 reads every move on the next ask.
// For tests.
func (c *PartsCache) SetThrottle(d time.Duration) {
	c.mu.Lock()
	c.throttle = d
	c.mu.Unlock()
}

// SetClock replaces time.Now, for tests that move the clock the answer
// caches read.
func (c *PartsCache) SetClock(now func() time.Time) {
	c.mu.Lock()
	c.now = now
	c.mu.Unlock()
}

// Summary is SummarizeSparkFor and SpendPartsBetween(from, 0, agent) for one
// range, from its kept parts. A sparkline whose grid does not start at from,
// or whose columns are not whole hours, is counted afresh, as is everything
// on a nil cache.
func (c *PartsCache) Summary(ctx context.Context, q Querier, from int64, spark SparkSpec, agent AgentFilter) (Summary, SpendParts, error) {
	if c == nil || spark.Buckets > 0 && spark.WidthMs > 0 && (spark.FromMs != from || spark.WidthMs%3600000 != 0) {
		s, err := SummarizeSparkFor(ctx, q, from, spark, agent)
		if err != nil {
			return s, nil, err
		}
		parts, err := SpendPartsBetween(ctx, q, from, 0, agent)
		return s, parts, err
	}
	var s Summary
	var parts SpendParts
	err := c.with(ctx, q, from, func(rp rangeParts) error {
		var err error
		s, parts, err = buildSummary(ctx, q, from, spark, agent, rp)
		return err
	})
	return s, parts, err
}

// Tools is ToolDistribution(from, limit) from the range's kept parts.
func (c *PartsCache) Tools(ctx context.Context, q Querier, from int64, limit int) ([]ToolCount, error) {
	if c == nil {
		return ToolDistribution(ctx, q, from, limit)
	}
	var out []ToolCount
	err := c.with(ctx, q, from, func(rp rangeParts) error {
		out = toolsFromParts(rp, limit)
		return nil
	})
	return out, err
}

// with brings the range's parts up to date and hands them to fn while they
// are held.
func (c *PartsCache) with(ctx context.Context, q Querier, from int64, fn func(rangeParts) error) error {
	c.mu.Lock()
	now := c.now()
	for k, kp := range c.ranges {
		if k != from && now.Sub(kp.used) > partsIdle && kp.mu.TryLock() {
			delete(c.ranges, k)
			kp.mu.Unlock()
		}
	}
	kp := c.ranges[from]
	if kp == nil {
		kp = &keptParts{}
		c.ranges[from] = kp
	}
	kp.used = now
	throttle, hurry := c.throttle, c.hurry
	var k *keeper
	if c.keep {
		k = &keeper{version: c.version, wg: &c.saving}
	}
	c.mu.Unlock()

	kp.mu.Lock()
	defer kp.mu.Unlock()
	behind, err := kp.refresh(ctx, q, from, now, throttle, hurry, k)
	if err != nil {
		return err
	}
	if f, ok := ctx.Value(partsLagKey{}).(*atomic.Bool); ok && behind {
		f.Store(true)
	}
	return fn(kp.parts)
}

// refresh reads what moved since the parts were read (EventsMark): the
// sessions with a new row or a new generation, one seek each; the whole range
// on the first read, when too many moved, or when the mark cannot say which.
//
// The mark is read before the events, so what is read is never older than
// it: a write landing in between is read now and again next time, never
// missed.
//
// Within throttle of the last read (partsThrottle) what moved waits: the
// parts are handed back as they are and behind is true. The kept mark stays
// where it was, so the first read past the window reads every session that
// moved in it, once. hurry is the cache's Hurry count: one this range has
// not seen lifts the throttle for this ask.
func (kp *keptParts) refresh(ctx context.Context, q Querier, from int64, now time.Time, throttle time.Duration, hurry uint64, k *keeper) (behind bool, err error) {
	if k != nil && !kp.ok && !kp.tried {
		// The first ask of this run: start from the parts a run before
		// wrote, and read below only what moved since their mark.
		kp.tried = true
		if rp, mark, built, ok := loadKept(ctx, q, from, k.version, now); ok {
			kp.parts, kp.mark, kp.ok, kp.built, kp.saved, kp.hurry = rp, mark, true, built, now, hurry
			kp.loaded++
		}
	}
	mark, err := ReadEventsMark(ctx, q)
	if err != nil {
		return false, err
	}
	stale := now.Sub(kp.built) >= partsRebuild
	if kp.ok && !stale && mark.Same(kp.mark) {
		return false, nil
	}
	if kp.ok && !stale && hurry == kp.hurry && throttle > 0 && now.Sub(kp.read) < throttle {
		return true, nil
	}
	full := !kp.ok || stale
	var changed []int64
	if !full {
		changed, full, err = mark.MovedSince(ctx, q, kp.mark)
		if err != nil {
			return false, err
		}
		full = full || len(changed) > partsMaxChanged
	}
	if full {
		rp, err := readParts(ctx, q, from, from, 0, partsScope{all: true})
		if err != nil {
			return false, err
		}
		kp.parts, kp.mark, kp.ok, kp.built, kp.read, kp.hurry = rp, mark, true, now, now, hurry
		kp.full++
		kp.save(q, from, now, k)
		return false, nil
	}
	if len(changed) > 0 {
		rp, err := readParts(ctx, q, from, from, 0, partsScope{sids: changed})
		if err != nil {
			return false, err
		}
		for _, sid := range changed {
			if p, ok := rp.sids[sid]; ok {
				kp.parts.sids[sid] = p
			} else {
				delete(kp.parts.sids, sid)
			}
		}
		kp.read = now
	}
	kp.mark, kp.hurry = mark, hurry
	kp.partial++
	if now.Sub(kp.saved) >= partsSaveEvery || kp.unsaved.Load() {
		kp.save(q, from, now, k)
	}
	return false, nil
}

// keeper is how a refresh reaches parts_kept: the build's version and the
// cache's count of writes under way.
type keeper struct {
	version string
	wg      *sync.WaitGroup
}

// save writes the parts as they are now to parts_kept, encoded while they
// are held and written in the background: a writer waiting on the database
// must not hold up the answer. A write that fails is tried again at the
// next refresh; a restart then reads more of what moved, never less.
func (kp *keptParts) save(q Querier, from int64, now time.Time, k *keeper) {
	if k == nil {
		return
	}
	blob, err := encodeKept(kp.parts, kp.mark)
	if err != nil {
		return
	}
	kp.saved = now
	kp.unsaved.Store(false)
	built := kp.built
	k.wg.Add(1)
	go func() {
		defer k.wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := saveKept(ctx, q, from, k.version, built, blob); err != nil {
			kp.unsaved.Store(true)
		}
	}()
}
