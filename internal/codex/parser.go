package codex

import (
	"encoding/json"
	"sort"
	"strings"
	"time"
)

// parser is the state of reading one rollout, record by record. Parse runs it
// once over a whole file; a tail (tail.go) keeps it between polls, so a line
// appended to a live transcript costs the work of that line rather than of
// the whole history before it.
//
// Everything a later record can depend on is kept here, not re-derived from
// the file: the running cumulative usage the next turn is a delta of, prose
// waiting for the turn that bills it, the current request's open calls, call
// names for late outputs, the calls still waiting for their turn, and the
// session's own metadata. A reader that only seeked to the end would lose all
// of it, and with it pricing and message association.
//
// The item lists are absolute sequences of which a prefix may have been
// dropped once stored (trim): index i of a list lives at i-base. Parse never
// trims, so it sees every item.
type parser struct {
	path string
	// s holds the session's metadata as read so far. Its item lists are not
	// used: items live in the lists below until fill copies them out.
	s Session

	// lineNo is the line number of the last line fed; keys are built from it.
	lineNo int64
	// decoded counts the records json-decoded, for the import counters.
	decoded int64

	// prevTotal tracks the running cumulative token count so each turn can be
	// stored as a delta. See the package doc for why the transcript's own
	// per-turn field is not used.
	prevTotal *usage
	// pending holds assistant prose not yet tied to a turn. Codex writes a
	// message BEFORE the token_count of the sampling request that produced it,
	// so the text goes onto the next turn. taskStart is where the current user
	// request's turns begin (an absolute turn count), so a message left over
	// when a request ends joins that request's last turn rather than the next
	// request's first.
	pending   []string
	taskStart int64
	seenMeta  bool

	callNames map[string]string
	// open holds the calls of the current request still waiting for their
	// output, by call id. A request that ends with a call still open cut it
	// off (see closeCalls).
	open map[string]openCall
	// closed is the absolute index into results of each call closeCalls marked
	// interrupted, so a late output record drops the mark.
	closed map[string]int64

	turns     []Turn
	turnsBase int64
	// grown lists turns (absolute indices) whose text grew after they were
	// appended: a request's late prose joins its last turn when it ends.
	grown []int64

	tools []ToolCall
	// toolTurn is, per retained tool, the line of the turn that paid for it
	// (ToolCall.TurnKey), or 0 while no turn has followed it.
	toolTurn  []int64
	toolsBase int64
	// linkFrom is the absolute index of the first call no turn has followed
	// yet. Calls and turns both arrive in file order, so the unlinked calls
	// are always a suffix.
	linkFrom int64

	results     []resultItem
	resultsBase int64

	// Two records carry a prompt, by version: an `item_completed` UserMessage
	// (every rollout a person started on the owner's machine) and a
	// `user_message` event (seen there only beside the item, in imported
	// threads). Whichever the file has is read — the item when it has both,
	// so a prompt is never stored twice.
	itemPrompts  []Prompt
	itemBase     int64
	eventPrompts []Prompt
	eventBase    int64
}

// openCall is a call still waiting for its output.
type openCall struct {
	idx    int64 // absolute index into tools: closeCalls keeps file order
	line   int64
	name   string
	callID string
}

// resultItem is a result and whether a late output replaced it.
type resultItem struct {
	ToolResult
	dropped bool
}

// marks are absolute positions in a parser's lists: how far an import got.
type marks struct {
	turns, tools, results, itemPrompts, eventPrompts int64
}

func newParser(path string) *parser {
	return &parser{
		path:      path,
		s:         Session{Path: path},
		callNames: map[string]string{},
		open:      map[string]openCall{},
		closed:    map[string]int64{},
	}
}

func (p *parser) turnsTotal() int64   { return p.turnsBase + int64(len(p.turns)) }
func (p *parser) toolsTotal() int64   { return p.toolsBase + int64(len(p.tools)) }
func (p *parser) resultsTotal() int64 { return p.resultsBase + int64(len(p.results)) }

// totals is where every list ends now.
func (p *parser) totals() marks {
	return marks{
		turns: p.turnsTotal(), tools: p.toolsTotal(), results: p.resultsTotal(),
		itemPrompts:  p.itemBase + int64(len(p.itemPrompts)),
		eventPrompts: p.eventBase + int64(len(p.eventPrompts)),
	}
}

// feed reads one line of the transcript, without its newline.
//
// A malformed line is skipped rather than failing the file: these are written
// by another program while it runs, so the last line of a live session is
// routinely a partial write, and refusing the whole transcript for it would
// mean a session is invisible until it ends.
func (p *parser) feed(line []byte) {
	p.lineNo++
	if len(line) == 0 {
		return
	}
	lineNo := p.lineNo
	s := &p.s
	p.decoded++
	var rec record
	if err := json.Unmarshal(line, &rec); err != nil {
		return // partial or malformed line: skip, do not fail the file
	}
	at := parseTime(rec.Timestamp)
	switch rec.Type {
	case "session_meta":
		// Decoded field by field rather than into a struct in one go.
		//
		// A single unexpected type anywhere in this payload fails the whole
		// unmarshal, and losing session_meta means losing the session id,
		// which makes the entire transcript "not a rollout file" and drops
		// every turn in it. That is far too much to lose to one field we do
		// not even own — Codex is free to change any of these between
		// releases. Each field is taken if it is the shape we expect and
		// skipped if it is not.
		var m sessionMeta
		raw := map[string]json.RawMessage{}
		if err := json.Unmarshal(rec.Payload, &raw); err != nil {
			return
		}
		m.SessionID = jsonString(raw["session_id"])
		m.ID = jsonString(raw["id"])
		m.Timestamp = jsonString(raw["timestamp"])
		m.Cwd = jsonString(raw["cwd"])
		m.CLIVersion = jsonString(raw["cli_version"])
		m.Originator = jsonString(raw["originator"])
		m.BaseInstructions = raw["base_instructions"]
		// A forked subagent's file holds its own session_meta and then a
		// copy of its parent's, so only the first one says what this
		// file is.
		if p.seenMeta {
			// The parent's session_meta, copied into a forked
			// subagent's file. It describes the parent: its session id
			// is the one the first record already named, and its cwd
			// and model are not this file's.
			return
		}
		s.Subagent = isSubagentSource(raw["source"])
		p.seenMeta = true
		s.ID = firstNonEmpty(m.SessionID, m.ID)
		s.ThreadID = firstNonEmpty(m.ID, m.SessionID)
		s.Cwd = m.Cwd
		s.CLIVersion = m.CLIVersion
		s.Originator = m.Originator
		// The model, from the one place nearly every transcript records
		// it. `turn_context` is the obvious source and is present in only
		// 4 of 100 real transcripts; this is present in 96, and the two
		// sets barely overlap — together they name a model for every
		// session that has any tokens at all.
		//
		// It is a recorded model id (`{"type":"model","model":"…"}`), not
		// an inference from the originator or the CLI version, which is
		// what makes pricing from it honest rather than a guess.
		if model := provenanceModel(m.BaseInstructions); model != "" {
			s.Model = model
		}
		if t := parseTime(m.Timestamp); !t.IsZero() {
			s.StartedAt = t
		} else {
			s.StartedAt = at
		}
	case "turn_context":
		var tc turnContext
		if err := json.Unmarshal(rec.Payload, &tc); err != nil {
			return
		}
		// turn_context wins over the base-instructions provenance when both
		// are present: provenance describes the prompt the session was
		// built with, this describes the turn actually being run. They
		// agreed in every transcript where both appear, and no model
		// changed mid-session in any of the 100 checked — but if one ever
		// does, the per-turn value is the truthful one.
		if tc.Model != "" {
			s.Model = tc.Model
		}
		if s.Cwd == "" {
			s.Cwd = tc.Cwd
		}
	case "event_msg":
		p.event(rec.Payload, at, lineNo)
	case "response_item":
		p.responseItem(rec.Payload, at, lineNo)
	}
}

// event reads an `event_msg` record.
func (p *parser) event(payload json.RawMessage, at time.Time, lineNo int64) {
	s := &p.s
	var k eventKind
	if err := json.Unmarshal(payload, &k); err != nil {
		return
	}
	if strings.HasPrefix(k.TurnID, importedTurnPrefix) {
		s.Imported = true
	}
	switch k.Type {
	case "task_started":
		// Prose from a request that produced no turn at all has no
		// row to sit on and is dropped. Measured: 36 of 2,120
		// messages on the owner's machine, all in subagent files
		// replaying their parent's history.
		p.pending, p.taskStart = nil, p.turnsTotal()
		p.closeCalls(at)
		return
	case "task_complete", "turn_aborted":
		p.closeCalls(at)
		if len(p.pending) > 0 && p.turnsTotal() > p.taskStart {
			// The last turn is never trimmed (trim), so it is here.
			last := &p.turns[len(p.turns)-1]
			last.Text = joinText(append([]string{last.Text}, p.pending...))
			p.grown = append(p.grown, p.turnsTotal()-1)
		}
		p.pending = nil
		return
	case "item_completed":
		var it userItem
		if json.Unmarshal(k.Item, &it) == nil && it.Type == "UserMessage" {
			var parts []string
			for _, c := range it.Content {
				if c.Type == "text" {
					parts = append(parts, strings.TrimSpace(c.Text))
				}
			}
			if t := joinText(parts); t != "" {
				p.itemPrompts = append(p.itemPrompts, Prompt{At: at, Key: keyFor(lineNo, "user"), Line: lineNo, Text: t})
			}
		}
		return
	case "user_message":
		var msg string
		_ = json.Unmarshal(k.Message, &msg)
		if t := joinText([]string{strings.TrimSpace(msg)}); t != "" {
			p.eventPrompts = append(p.eventPrompts, Prompt{At: at, Key: keyFor(lineNo, "user"), Line: lineNo, Text: t})
		}
		return
	case "token_count":
	default:
		return
	}
	var tc tokenCount
	if err := json.Unmarshal(payload, &tc); err != nil {
		return
	}
	if rl := tc.RateLimits; rl != nil && (rl.LimitID == "" || rl.LimitID == codexLimitID) && !at.IsZero() {
		l := &Limits{At: at}
		for _, w := range []*window{rl.Primary, rl.Secondary} {
			if w == nil || w.WindowMinutes <= 0 {
				continue
			}
			lw := LimitWindow{Minutes: w.WindowMinutes, UsedPercent: w.UsedPercent}
			if w.ResetsAt != nil {
				lw.ResetsAt = *w.ResetsAt
			}
			l.Windows = append(l.Windows, lw)
		}
		// A sample naming no window says nothing about the plan, and
		// must not replace an earlier one that did.
		if len(l.Windows) > 0 {
			s.Limits = l
		}
	}
	if tc.Info == nil || tc.Info.Total == nil {
		return
	}
	d, ok := delta(p.prevTotal, tc.Info.Total)
	cur := *tc.Info.Total
	p.prevTotal = &cur
	if !ok {
		return // a repeat of the previous sample: no new tokens
	}
	turn := Turn{
		At:         at,
		Key:        keyFor(lineNo, "turn"),
		Line:       lineNo,
		In:         d.InputTokens,
		CacheRead:  d.CachedInputTokens,
		CacheWrite: d.CacheWriteInputTok,
		Out:        d.OutputTokens,
		Reasoning:  d.ReasoningOutputToken,
	}
	// Some transcripts fill in `total_tokens` and leave every component
	// at zero — 114 of 233 samples on the machine this was built
	// against, one of them 4.4M tokens. Reading only the components
	// drops all of that: a real turn stored as if it had used nothing.
	//
	// The total is carried as input, which is the honest reading of a
	// number that says only "this much was used": input is what the
	// billing arithmetic treats as unqualified, so nothing is credited
	// a cache discount it was not reported to have earned. Splitting
	// the total across kinds by any ratio would be inventing the split
	// (rule 6); leaving the turn empty would be discarding the usage.
	if turn.In == 0 && turn.Out == 0 && turn.CacheRead == 0 && turn.CacheWrite == 0 && d.TotalTokens > 0 {
		turn.In = d.TotalTokens
		turn.TotalOnly = true
	}
	turn.Text = joinText(p.pending)
	p.pending = nil
	// Every call since the previous turn was paid for by this one (see
	// ToolCall.TurnKey): the first turn recorded after it.
	for i := p.linkFrom - p.toolsBase; i < int64(len(p.tools)); i++ {
		p.toolTurn[i] = lineNo
	}
	p.linkFrom = p.toolsTotal()
	p.turns = append(p.turns, turn)
}

// responseItem reads a `response_item` record.
func (p *parser) responseItem(payload json.RawMessage, at time.Time, lineNo int64) {
	s := &p.s
	var k payloadKind
	if err := json.Unmarshal(payload, &k); err != nil {
		return
	}
	if k.Type == "message" {
		var m message
		if json.Unmarshal(payload, &m) != nil || m.Role != "assistant" {
			return
		}
		for _, b := range m.Content {
			if b.Type != "output_text" && b.Type != "text" {
				continue
			}
			t := strings.TrimSpace(b.Text)
			if t == importedMarker {
				s.Imported = true
			}
			if t != "" {
				p.pending = append(p.pending, t)
			}
		}
		return
	}
	if k.Type == "custom_tool_call_output" || k.Type == "function_call_output" {
		var op toolOutputPayload
		if err := json.Unmarshal(payload, &op); err != nil || op.CallID == "" {
			return
		}
		r := readOutput(op.Output)
		r.At, r.Key, r.Line, r.CallID, r.Name = at, keyFor(lineNo, "result"), lineNo, op.CallID, p.callNames[op.CallID]
		delete(p.open, op.CallID)
		if i, ok := p.closed[op.CallID]; ok {
			// The output came after all: the call finished, and the
			// mark closeCalls left for it is dropped. A mark already
			// stored and trimmed stays stored, as it always did.
			if i >= p.resultsBase {
				p.results[i-p.resultsBase].dropped = true
			}
			delete(p.closed, op.CallID)
		}
		p.results = append(p.results, resultItem{ToolResult: r})
		return
	}
	if k.Type != "custom_tool_call" && k.Type != "function_call" {
		return
	}
	var tp toolCallPayload
	if err := json.Unmarshal(payload, &tp); err != nil {
		return
	}
	in := tp.Input
	if len(in) == 0 {
		in = tp.Arguments
	}
	if tp.CallID != "" {
		p.callNames[tp.CallID] = tp.Name
		p.open[tp.CallID] = openCall{idx: p.toolsTotal(), line: lineNo, name: tp.Name, callID: tp.CallID}
	}
	p.tools = append(p.tools, ToolCall{
		At:     at,
		Key:    keyFor(lineNo, "tool"),
		Line:   lineNo,
		Name:   tp.Name,
		Input:  string(in),
		CallID: tp.CallID,
	})
	p.toolTurn = append(p.toolTurn, 0)
}

// closeCalls ends the request's calls that never got an output: each becomes
// an interrupted result (ToolResult.Interrupted), so the chat stops saying
// "running" for a call nothing will ever answer.
//
// Codex brackets a request with task_started and task_complete or
// turn_aborted. On the owner's machine (2026-10-09: 16,152 calls in 207
// rollouts) every call has its output, and none of the 11 turn_aborted
// records cut a call off mid-flight — but a call that is cut off before its
// output is written has nothing else that would ever end it, and read as
// running forever. A request that ends, or a new one that starts, is the
// point after which nothing more can arrive for it. The key is the call's
// line under its own kind, `codex:interrupted:<line>`, so it never collides
// with a result.
func (p *parser) closeCalls(at time.Time) {
	if len(p.open) == 0 {
		return
	}
	calls := make([]openCall, 0, len(p.open))
	for _, c := range p.open {
		calls = append(calls, c)
	}
	sort.Slice(calls, func(i, j int) bool { return calls[i].idx < calls[j].idx })
	for _, c := range calls {
		p.closed[c.callID] = p.resultsTotal()
		p.results = append(p.results, resultItem{ToolResult: ToolResult{
			At: at, Key: keyFor(c.line, "interrupted"), Line: c.line,
			CallID: c.callID, Name: c.name, Interrupted: true,
		}})
	}
	clear(p.open)
}

// header is the session as read so far, with no items: its id, metadata and
// flags, finalized the way the items' keys depend on them.
func (p *parser) header() *Session {
	s := p.s
	if s.Subagent && s.ThreadID == s.ID && p.path != "" {
		// No id of its own was recorded (never seen): the file name,
		// which Codex derives from the thread id, still tells two
		// subagents of one parent apart.
		s.ThreadID = rolloutName(p.path)
	}
	return &s
}

// fill copies the items from position `from` on into s, finalized: keyed for
// a subagent, prose cleared where it is not this thread's, prompts chosen,
// each call given its turn. s is a header() of this parser. Items before a
// list's base were trimmed and are not available; from is clamped to it.
func (p *parser) fill(s *Session, from marks) {
	s.Turns = nil
	for i := max(from.turns, p.turnsBase); i < p.turnsTotal(); i++ {
		s.Turns = append(s.Turns, p.turnAt(s, i))
	}
	s.Tools = nil
	for i := max(from.tools, p.toolsBase); i < p.toolsTotal(); i++ {
		s.Tools = append(s.Tools, p.toolAt(s, i))
	}
	s.Results = nil
	for i := max(from.results, p.resultsBase); i < p.resultsTotal(); i++ {
		if r, ok := p.resultAt(s, i); ok {
			s.Results = append(s.Results, r)
		}
	}
	s.Prompts = nil
	if !s.Imported && !s.Subagent {
		if p.itemBase+int64(len(p.itemPrompts)) > 0 {
			s.Prompts = appendFrom(nil, p.itemPrompts, p.itemBase, from.itemPrompts)
		} else {
			s.Prompts = appendFrom(nil, p.eventPrompts, p.eventBase, from.eventPrompts)
		}
	}
}

func appendFrom(dst, src []Prompt, base, from int64) []Prompt {
	for i := max(from, base); i < base+int64(len(src)); i++ {
		dst = append(dst, src[i-base])
	}
	return dst
}

// turnAt is turn i (absolute), finalized for s.
func (p *parser) turnAt(s *Session, i int64) Turn {
	t := p.turns[i-p.turnsBase]
	if s.Subagent {
		// A subagent's file carries its parent's session id, and its line
		// numbers are the same small integers as the parent's own. Keyed
		// `codex:turn:<line>` like the parent, each of its records collided
		// with the parent's on the same line, and whichever file was read
		// second lost it as a "duplicate" — 885 of 1,864 subagent turns on
		// the owner's machine. Its keys carry its own thread id instead.
		t.Key = subagentKey(s.ThreadID, t.Line, "turn")
	}
	if s.Imported || s.Subagent {
		// Imported prose is another agent's, already stored from its own
		// transcript. A subagent's would be hidden from Memory anyway, as
		// Claude Code's sidechains are.
		t.Text = ""
	}
	return t
}

// toolAt is call i (absolute), finalized for s.
func (p *parser) toolAt(s *Session, i int64) ToolCall {
	c := p.tools[i-p.toolsBase]
	if s.Subagent {
		c.Key = subagentKey(s.ThreadID, c.Line, "tool")
	}
	if line := p.toolTurn[i-p.toolsBase]; line != 0 {
		c.TurnKey = keyFor(line, "turn")
		if s.Subagent {
			c.TurnKey = subagentKey(s.ThreadID, line, "turn")
		}
	}
	return c
}

// resultAt is result i (absolute), finalized for s; false for an interrupted
// mark a late output replaced.
func (p *parser) resultAt(s *Session, i int64) (ToolResult, bool) {
	it := p.results[i-p.resultsBase]
	if it.dropped {
		return ToolResult{}, false
	}
	r := it.ToolResult
	if s.Subagent {
		kind := "result"
		if r.Interrupted {
			kind = "interrupted"
		}
		r.Key = subagentKey(s.ThreadID, r.Line, kind)
	}
	return r, true
}

// trim drops what an import has stored and nothing later can need: items
// before done, except the last turn (a request's late prose can still join
// it) and calls no turn has followed yet (their turn is still to come).
func (p *parser) trim(done marks) {
	keepTurn := min(done.turns, p.turnsTotal()-1)
	if n := keepTurn - p.turnsBase; n > 0 {
		p.turns = append(p.turns[:0:0], p.turns[n:]...)
		p.turnsBase = keepTurn
	}
	keepTool := min(done.tools, p.linkFrom)
	if n := keepTool - p.toolsBase; n > 0 {
		p.tools = append(p.tools[:0:0], p.tools[n:]...)
		p.toolTurn = append(p.toolTurn[:0:0], p.toolTurn[n:]...)
		p.toolsBase = keepTool
	}
	if n := done.results - p.resultsBase; n > 0 {
		p.results = append(p.results[:0:0], p.results[n:]...)
		p.resultsBase = done.results
	}
	if n := done.itemPrompts - p.itemBase; n > 0 {
		p.itemPrompts = append(p.itemPrompts[:0:0], p.itemPrompts[n:]...)
		p.itemBase = done.itemPrompts
	}
	if n := done.eventPrompts - p.eventBase; n > 0 {
		p.eventPrompts = append(p.eventPrompts[:0:0], p.eventPrompts[n:]...)
		p.eventBase = done.eventPrompts
	}
	p.grown = p.grown[:0]
}
