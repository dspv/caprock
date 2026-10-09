package store

import (
	"context"
	"database/sql"
	"encoding/json"

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
}

// CallTool is one tool request of a model call, with its raw input.
type CallTool struct {
	Tool  string
	Input json.RawMessage
}

// SessionCalls returns the newest n priced main-thread model calls of a
// session, oldest first, each with the tool calls it requested. Internal
// model calls and unpriced turns are left out, as the cockpit's spark leaves
// them out; a subagent's calls are its own. Both queries pin the session's
// index (`+kind`), as the subagent queries do.
func SessionCalls(ctx context.Context, q Querier, sessionID string, n int) ([]SessionCall, error) {
	if n <= 0 || n > MaxSessionCalls {
		n = MaxSessionCalls
	}
	rows, err := q.QueryContext(ctx, `
		SELECT * FROM (
		  SELECT e.id, e.ts, COALESCE(e.model, ''), e.cost_usd, e.tokens_in, e.tokens_out, e.cache_read, e.cache_write, e.cache_write_1h, COALESCE(e.msg_id, '')
		    FROM events e
		   WHERE e.session_id = ? AND +e.kind = 'turn.assistant' AND e.cost_usd IS NOT NULL AND e.internal = 0 AND `+MainThreadWhere+`
		   ORDER BY e.ts DESC, e.id DESC LIMIT ?)
		 ORDER BY 2 ASC, 1 ASC`, sessionID, n)
	if err != nil {
		return nil, err
	}
	var out []SessionCall
	byMsg := map[string]int{}
	for rows.Next() {
		var c SessionCall
		var cost sql.NullFloat64
		var tin, tout, cr, cw, cw1h sql.NullInt64
		var msg string
		if err := rows.Scan(&c.ID, &c.Ts, &c.Model, &cost, &tin, &tout, &cr, &cw, &cw1h, &msg); err != nil {
			_ = rows.Close()
			return nil, err
		}
		c.CostUSD = cost.Float64
		if tin.Valid || tout.Valid || cr.Valid || cw.Valid {
			c.Tokens = &event.TokenDelta{In: tin.Int64, Out: tout.Int64, CacheRead: cr.Int64, CacheWrite: cw.Int64, CacheWrite1h: cw1h.Int64}
		}
		if msg != "" {
			byMsg[msg] = len(out)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if len(byMsg) == 0 {
		return out, nil
	}
	tools, err := q.QueryContext(ctx, `
		SELECT e.msg_id, COALESCE(e.tool, ''), COALESCE(json_extract(e.payload, '$.tool_input'), '')
		  FROM events e
		 WHERE e.session_id = ? AND +e.kind = 'tool.pre' AND COALESCE(e.msg_id, '') <> '' AND `+MainThreadWhere+`
		 ORDER BY e.ts ASC, e.id ASC`, sessionID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tools.Close() }()
	for tools.Next() {
		var msg, tool, input string
		if err := tools.Scan(&msg, &tool, &input); err != nil {
			return nil, err
		}
		i, ok := byMsg[msg]
		if !ok || tool == "" {
			continue
		}
		c := &out[i]
		c.ToolCount++
		if len(c.Tools) < callToolsMax {
			c.Tools = append(c.Tools, CallTool{Tool: tool, Input: json.RawMessage(input)})
		}
	}
	return out, tools.Err()
}
