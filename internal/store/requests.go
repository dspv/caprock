package store

import (
	"context"
)

// Usage records are not turns.
//
// Cursor and Hermes keep their usage as running totals per chat (Cursor per
// chat and model, `usageData`), and their importers reconcile those totals
// into Caprock's store as differences: on the newest reply a pass stores, or
// — when no new reply arrived to carry it — on a `turn.assistant` of the
// importer's own marked `usage_only` (internal/cursor, internal/hermes). Such
// a record holds the money of hundreds of requests and is nobody's turn.
// Counted with COUNT(*) it was: on the owner's machine Cursor's
// claude-4.1-opus-thinking was 7 rows, $623 and about 2,153 requests, and
// the Cost screen priced it at "$89 per turn" (2026-11-17).
//
// Cursor also says how many requests a figure covers (`requests`, Cursor's
// own `usageData.amount`), which is the honest unit for a cost Cursor
// reports per chat. Hermes keeps an API-call count but its importer does not
// store it on the row, so Hermes rows only stop being counted as turns.

// usageCount is one group's usage records and the requests Cursor counted
// on its rows.
type usageCount struct {
	// Records are `usage_only` rows: subtracted from a turn count.
	Records int64
	// Requests are Cursor's request counts, summed over every Cursor row —
	// a carrier reply's as well as a usage record's — and CostUSD is what
	// those rows cost: the part of a model's cost a price per request is
	// read from, since one model id can also have been run by another agent.
	Requests int64
	CostUSD  float64
}

// usageKey groups usage rows the way the turn counts they correct are
// grouped: by session, model and whether the row is a subagent's.
type usageKey struct {
	Sid   int64
	Model string
	Sub   bool
}

// usageRows reads the usage records and request counts of the agents that
// write them, in [from, to) (to 0 means no upper bound), with an extra
// clause on e.sid (the Week's hand-run filter) and an agent filter.
//
// It walks only those agents' sessions, by idx_events_session_ts, rather
// than adding a payload read to the range aggregates: those run off covering
// indexes, and a JSON column in their select list would turn every one into
// a read of every row in the range.
//
// A usage record is told by its key — `cu-usage:` and `hm-usage:` are the
// importers' own, and a stored key never changes — so the count reads no
// payload. Only a priced Cursor row can carry a request count (cursor.carry
// writes `requests` beside a cost), so only those rows' payloads are read:
// a reply's payload is its prose. On a copy of the owner's database
// (2026-11-17: 58 Cursor chats, 9,005 assistant rows) the query is 0.07-0.14 s
// warm at range=all and 0.4-1.1 s cold, waiting on the disk; a range that
// starts after the agents' last session reads no row at all (last_event_at).
func usageRows(ctx context.Context, q Querier, from, to int64, skipE string, agent AgentFilter) (map[usageKey]usageCount, error) {
	out := map[usageKey]usageCount{}
	if agent != "" && agent != "cursor" && agent != "hermes" {
		return out, nil
	}
	upper, args := "", []any{from, from}
	if to > 0 {
		upper, args = " AND e.ts < ?", append(args, to)
	}
	who := ` AND s.agent IN ('cursor','hermes')`
	if agent != "" {
		who, args = ` AND s.agent = ?`, append(args, string(agent))
	}
	rows, err := q.QueryContext(ctx, `
		SELECT e.sid, COALESCE(e.model,''), COALESCE(e.agent_id,'') <> '',
		       COALESCE(SUM(substr(e.key,1,9) IN ('cu-usage:','hm-usage:')),0),
		       COALESCE(SUM(CASE WHEN e.source = 'cursor' AND e.cost_usd IS NOT NULL AND json_valid(e.payload)
		                         THEN json_extract(e.payload,'$.requests') END),0),
		       COALESCE(SUM(CASE WHEN e.source = 'cursor' THEN e.cost_usd END),0)
		FROM sessions s JOIN events e INDEXED BY idx_events_session_ts
		  ON e.sid = s.sid AND e.ts >= ?
		WHERE s.last_event_at >= ? AND e.kind = 'turn.assistant'`+upper+who+nonInternalEventE+skipE+`
		GROUP BY 1, 2, 3`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var k usageKey
		var c usageCount
		var req float64
		if err := rows.Scan(&k.Sid, &k.Model, &k.Sub, &c.Records, &req, &c.CostUSD); err != nil {
			return nil, err
		}
		c.Requests = int64(req)
		if c.Records != 0 || c.Requests != 0 {
			out[k] = c
		}
	}
	return out, rows.Err()
}

// usageByModel folds usage rows by model.
func usageByModel(u map[usageKey]usageCount) map[string]usageCount {
	out := map[string]usageCount{}
	for k, c := range u {
		m := out[k.Model]
		m.Records += c.Records
		m.Requests += c.Requests
		m.CostUSD += c.CostUSD
		out[k.Model] = m
	}
	return out
}

// discountUsageRecords takes the usage records out of a summary's turn
// counts and puts Cursor's request counts on its models.
func discountUsageRecords(ctx context.Context, q Querier, fromMs int64, agent AgentFilter, s *Summary) error {
	u, err := usageRows(ctx, q, fromMs, 0, "", agent)
	if err != nil || len(u) == 0 {
		return err
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
	return nil
}
