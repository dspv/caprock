package store

import (
	"context"
	"time"
)

// TaxCall is one tool call priced against the turn that issued it: the context
// that turn re-read, and what the turn produced.
//
// The link is exact, not reconstructed. A tool.pre event carries the msg_id of
// the assistant message whose usage was billed, so a call's context is that
// turn's own reading. Nearest-preceding-turn guessing recovers 38.7% of these
// correctly (see internal/ingest/parser.go), which is why it is not attempted.
type TaxCall struct {
	Ts      time.Time
	Tool    string
	Context int64
	Result  int64
	Model   string
}

// LoopTaxCalls returns the tool calls of one session in a time window, each
// carrying the context of the turn that issued it.
//
// It exists to price a loop alert: the detector knows which calls repeated but
// stores no tokens, and the tax of a series is the sum of exactly these
// contexts. Calls whose turn carried no usage come back with Context 0 and are
// the caller's to drop -- a call that cannot be priced must not be priced as
// free.
// It also returns how many calls in the window carried no message id and so
// could not be attached to any turn. They are not a defect: a tool call
// arriving on the hook plane has no message id to carry, and 13% of all calls
// on the owner's archive are of that kind. But a tax summed over 87% of a
// loop's calls is an understatement, and an understatement nobody is told
// about is an invented number (rule 6). The caller reports the shortfall
// rather than presenting a partial figure as complete.
func LoopTaxCalls(ctx context.Context, q Querier, sessionID string, from, to time.Time) ([]TaxCall, int, error) {
	// Two passes over one small window: the turns of the session keyed by
	// message id, then the calls that name them. A join would be tidier, but
	// the events table holds both sides in one table and SQLite plans the
	// self-join badly without stats -- and nothing in the daemon runs ANALYZE.
	rows, err := q.QueryContext(ctx, `
		SELECT COALESCE(msg_id,''), COALESCE(kind,''), COALESCE(tool,''), ts,
		       COALESCE(tokens_in,0), COALESCE(cache_read,0), COALESCE(cache_write,0),
		       COALESCE(tokens_out,0), COALESCE(model,'')
		FROM events
		WHERE session_id = ? AND ts >= ? AND ts <= ?
		  AND kind IN ('tool.pre','turn.assistant')
		ORDER BY ts, id`, sessionID, from.UnixMilli(), to.UnixMilli())
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	type turn struct {
		context int64
		result  int64
		model   string
	}
	// A call is held with the message id that will price it until the whole
	// window has been read.
	type pending struct {
		call TaxCall
		msg  string
	}
	turns := map[string]turn{}
	var calls []pending
	for rows.Next() {
		var msg, kind, tool, model string
		var ts, in, cr, cw, out int64
		if err := rows.Scan(&msg, &kind, &tool, &ts, &in, &cr, &cw, &out, &model); err != nil {
			return nil, 0, err
		}
		if kind == "turn.assistant" {
			if msg != "" {
				turns[msg] = turn{context: in + cr + cw, result: out, model: model}
			}
			continue
		}
		calls = append(calls, pending{call: TaxCall{Ts: time.UnixMilli(ts), Tool: tool}, msg: msg})
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	// Resolve after the scan, not during it: a turn's own tool calls are
	// written to the transcript on a later line than the turn, so a call can
	// appear before the turn that issued it in id order (see touch.go).
	priced := make([]TaxCall, 0, len(calls))
	var unlinked int
	for _, p := range calls {
		t, ok := turns[p.msg]
		if !ok {
			unlinked++
			continue
		}
		p.call.Context, p.call.Result, p.call.Model = t.context, t.result, t.model
		priced = append(priced, p.call)
	}
	return priced, unlinked, nil
}
