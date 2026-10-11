package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"sort"
	"strings"
)

// SubagentCall is one tool call a subagent made, joined to its result.
type SubagentCall struct {
	// ID is the call's tool.pre event id: the cursor "show earlier" pages by.
	ID        int64
	ToolUseID string
	Tool      string
	Input     json.RawMessage
	StartedAt int64
	// EndedAt is its result's time; 0 while it has none.
	EndedAt int64
	// Error is true when the result came back as an error.
	Error bool
}

// SubagentToolSpend is what one kind of tool cost inside a subagent: the
// turns that called it, each turn's cost split evenly over the tools it
// called. Calls counts the calls; Known is false when any of those turns
// could not be priced.
type SubagentToolSpend struct {
	Tool    string
	Calls   int
	CostUSD float64
	Known   bool
}

// SubagentTrail is everything Caprock holds about one subagent of a session:
// the task its parent gave it, its calls in order, what it answered, and its
// numbers. Read in two scans of the session's rows (idx_events_session_ts),
// so a parent with thousands of events is not paged through.
type SubagentTrail struct {
	AgentID   string
	AgentType string
	// Description, Prompt and SubagentType are the parent's Agent/Task call
	// input; ParentToolUseID that call's id. Empty when no call is linked.
	Description     string
	Prompt          string
	SubagentType    string
	ParentToolUseID string
	// Background is true when the parent launched it in the background.
	Background bool
	// StartedAt and LastAt are its first and newest events, StoppedAt its
	// newest SubagentStop when that is its newest event (unix ms).
	StartedAt, LastAt, StoppedAt int64
	// Result is the text it returned: its SubagentStop's last message, else
	// the parent call's result.
	Result string
	// Calls is every call, oldest first.
	Calls []SubagentCall
	// Asking is true while its newest event is a permission prompt.
	Asking bool
	// Turn figures: its own model calls, internal ones left out.
	Turns                                      int
	TokensIn, TokensOut, CacheRead, CacheWrite int64
	CostUSD                                    float64
	CostKnown                                  bool
	Model                                      string
	ByTool                                     []SubagentToolSpend
}

// SubagentTrailOf reads one subagent of a session. found is false when the
// session holds no event of that agent.
func SubagentTrailOf(ctx context.Context, q Querier, sessionID, agentID string) (tr SubagentTrail, found bool, err error) {
	tr.AgentID = agentID
	rows, err := q.QueryContext(ctx, `
		SELECT id, ts, kind, COALESCE(tool, ''),
		       COALESCE(json_extract(payload, '$.tool_use_id'), ''),
		       CASE WHEN kind = 'tool.pre' THEN json_extract(payload, '$.tool_input') END,
		       COALESCE(json_extract(payload, '$.is_error'), 0),
		       COALESCE(json_extract(payload, '$.agent_type'), ''),
		       CASE WHEN kind = 'agent.stop' THEN json_extract(payload, '$.last_assistant_message') END,
		       CASE WHEN kind = 'turn.assistant' THEN json_extract(payload, '$.tools') END,
		       COALESCE(model, ''), tokens_in, COALESCE(tokens_out, 0), COALESCE(cache_read, 0), COALESCE(cache_write, 0),
		       cost_usd, internal
		  FROM events
		 WHERE session_id = ? AND agent_id = ?
		 ORDER BY ts, id`, sessionID, agentID)
	if err != nil {
		return tr, false, err
	}
	defer func() { _ = rows.Close() }()
	byUse := map[string]int{}
	tools := map[string]*SubagentToolSpend{}
	var newestKind string
	tr.CostKnown = true
	for rows.Next() {
		var (
			id, ts                     int64
			kind, tool, use, agentType string
			input, last, turnTools     sql.NullString
			isErr                      int
			model                      string
			tokIn                      sql.NullInt64
			tokOut, cRead, cWrite      int64
			cost                       sql.NullFloat64
			internal                   int
		)
		if err := rows.Scan(&id, &ts, &kind, &tool, &use, &input, &isErr, &agentType, &last, &turnTools,
			&model, &tokIn, &tokOut, &cRead, &cWrite, &cost, &internal); err != nil {
			return tr, false, err
		}
		found = true
		if tr.StartedAt == 0 {
			tr.StartedAt = ts
		}
		tr.LastAt, newestKind = ts, kind
		if agentType != "" {
			tr.AgentType = agentType
		}
		switch kind {
		case "tool.pre":
			if use != "" {
				if _, seen := byUse[use]; seen {
					continue
				}
				byUse[use] = len(tr.Calls)
			}
			c := SubagentCall{ID: id, ToolUseID: use, Tool: tool, StartedAt: ts}
			if input.Valid {
				c.Input = json.RawMessage(input.String)
			}
			tr.Calls = append(tr.Calls, c)
			sp := tools[tool]
			if sp == nil {
				sp = &SubagentToolSpend{Tool: tool, Known: true}
				tools[tool] = sp
			}
			sp.Calls++
		case "tool.post":
			i, ok := byUse[use]
			if !ok || use == "" {
				// A result with no id takes the oldest open call of its tool.
				i = -1
				for j := range tr.Calls {
					if tr.Calls[j].EndedAt == 0 && tr.Calls[j].Tool == tool && tr.Calls[j].ToolUseID == "" {
						i = j
						break
					}
				}
			}
			if i >= 0 && tr.Calls[i].EndedAt == 0 {
				tr.Calls[i].EndedAt = max(ts, tr.Calls[i].StartedAt)
				tr.Calls[i].Error = isErr != 0
			}
		case "agent.stop":
			if last.Valid && strings.TrimSpace(last.String) != "" {
				tr.Result = last.String
			}
		case "turn.assistant":
			if internal != 0 {
				continue
			}
			tr.Turns++
			if model != "" {
				tr.Model = model
			}
			tr.TokensIn += tokIn.Int64
			tr.TokensOut += tokOut
			tr.CacheRead += cRead
			tr.CacheWrite += cWrite
			priced := cost.Valid || !tokIn.Valid
			if !priced {
				tr.CostKnown = false
			}
			tr.CostUSD += cost.Float64
			var called []string
			if turnTools.Valid {
				_ = json.Unmarshal([]byte(turnTools.String), &called)
			}
			if len(called) == 0 {
				called = []string{""} // a turn that only wrote
			}
			share := cost.Float64 / float64(len(called))
			for _, name := range called {
				sp := tools[name]
				if sp == nil {
					sp = &SubagentToolSpend{Tool: name, Known: true}
					tools[name] = sp
				}
				sp.CostUSD += share
				sp.Known = sp.Known && priced
			}
		}
	}
	if err := rows.Err(); err != nil {
		return tr, false, err
	}
	if !found {
		return tr, false, nil
	}
	if tr.Turns == 0 {
		tr.CostKnown = false
	}
	if newestKind == "agent.stop" {
		tr.StoppedAt = tr.LastAt
	}
	tr.Asking = newestKind == "permission.prompt"
	for _, t := range tools {
		tr.ByTool = append(tr.ByTool, *t)
	}
	sort.Slice(tr.ByTool, func(i, j int) bool {
		a, b := tr.ByTool[i], tr.ByTool[j]
		if a.CostUSD != b.CostUSD {
			return a.CostUSD > b.CostUSD
		}
		if a.Calls != b.Calls {
			return a.Calls > b.Calls
		}
		return a.Tool < b.Tool
	})
	if err := linkParentCall(ctx, q, sessionID, &tr); err != nil {
		return tr, false, err
	}
	return tr, true, nil
}

// parentCallSlackMs bounds the parent calls read to the subagent's own
// lifetime and this much either side: the launch comes just before its first
// event, a foreground call's result just after its last.
const parentCallSlackMs = 10 * 60_000

// linkParentCall finds the parent's Agent/Task call that launched the
// subagent: the call whose result names it (a background launch at once, a
// foreground one when it returns), else — a foreground call still running —
// the newest unanswered call of its type made before the subagent's first
// event. That call gives the task; its result, the answer when no
// SubagentStop carried one.
func linkParentCall(ctx context.Context, q Querier, sessionID string, tr *SubagentTrail) error {
	rows, err := q.QueryContext(ctx, `
		SELECT ts, kind, COALESCE(json_extract(payload, '$.tool_use_id'), ''),
		       COALESCE(json_extract(payload, '$.tool_input'), '{}'),
		       CASE WHEN kind = 'tool.post' THEN json_extract(payload, '$.tool_response') END
		  FROM events
		 WHERE session_id = ? AND +kind IN ('tool.pre', 'tool.post') AND tool IN ('Agent', 'Task')
		   AND COALESCE(agent_id, '') = '' AND ts BETWEEN ? AND ?
		 ORDER BY ts, id`, sessionID, tr.StartedAt-parentCallSlackMs, tr.LastAt+parentCallSlackMs)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	type call struct {
		ts       int64
		use      string
		input    string
		response string
		answered bool
	}
	var pres []*call
	byUse := map[string]*call{}
	var named *call
	for rows.Next() {
		var ts int64
		var kind, use, input string
		var resp sql.NullString
		if err := rows.Scan(&ts, &kind, &use, &input, &resp); err != nil {
			return err
		}
		if kind == "tool.pre" {
			if use != "" && byUse[use] != nil {
				continue
			}
			c := &call{ts: ts, use: use, input: input}
			pres = append(pres, c)
			if use != "" {
				byUse[use] = c
			}
			continue
		}
		c := byUse[use]
		if c == nil {
			c = &call{ts: ts, use: use, input: input}
			if use != "" {
				byUse[use] = c
			}
		}
		c.answered = true
		c.response = resp.String
		if named == nil && resp.Valid && agentIDOf(resp.String) == tr.AgentID {
			named = c
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if named == nil {
		for i := len(pres) - 1; i >= 0; i-- {
			c := pres[i]
			if c.answered || c.ts > tr.StartedAt {
				continue
			}
			var in struct {
				SubagentType string `json:"subagent_type"`
			}
			_ = json.Unmarshal([]byte(c.input), &in)
			want := in.SubagentType
			if want == "" {
				want = "general-purpose"
			}
			if tr.AgentType == "" || want == tr.AgentType {
				named = c
			}
			break
		}
	}
	if named == nil {
		return nil
	}
	var in struct {
		Description  string `json:"description"`
		Prompt       string `json:"prompt"`
		SubagentType string `json:"subagent_type"`
		Background   bool   `json:"run_in_background"`
	}
	_ = json.Unmarshal([]byte(named.input), &in)
	tr.Description, tr.Prompt, tr.SubagentType, tr.ParentToolUseID = in.Description, in.Prompt, in.SubagentType, named.use
	var resp struct {
		IsAsync     bool            `json:"isAsync"`
		Description string          `json:"description"`
		Prompt      string          `json:"prompt"`
		Content     json.RawMessage `json:"content"`
	}
	if named.response != "" && json.Unmarshal([]byte(named.response), &resp) == nil {
		tr.Background = in.Background || resp.IsAsync
		if tr.Description == "" {
			tr.Description = resp.Description
		}
		if tr.Prompt == "" {
			tr.Prompt = resp.Prompt
		}
		if tr.Result == "" && !resp.IsAsync {
			tr.Result = contentText(resp.Content)
		}
	} else if named.response != "" && tr.Result == "" {
		// A transcript result is the text itself, or a list of text blocks.
		tr.Result = contentText(json.RawMessage(named.response))
	}
	return nil
}

func agentIDOf(response string) string {
	var r struct {
		AgentID string `json:"agentId"`
	}
	_ = json.Unmarshal([]byte(response), &r)
	return r.AgentID
}

// contentText is a tool result's text: a string, or the text of its blocks
// joined by blank lines.
func contentText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return strings.TrimSpace(s)
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	var parts []string
	for _, b := range blocks {
		if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
			parts = append(parts, strings.TrimSpace(b.Text))
		}
	}
	return strings.Join(parts, "\n\n")
}
