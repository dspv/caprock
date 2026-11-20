package store

import (
	"context"
	"encoding/json"
	"sync"
)

// EventCounter is CountEvents kept by session: asked again, it counts only
// the sessions whose events moved since (EventsMark), each a seek on
// idx_events_session_id, and with nothing moved it reads no event at all.
//
// The status strip asks every 30 s, and COUNT(*) walked an index of every
// row each time: 11 MB of pages for 680k events, on a machine short of
// memory read from disk again on every ask (9.7 s on the owner's 1M rows
// under load, 2026-11-15). The zero value is ready to use and safe for
// concurrent use.
type EventCounter struct {
	mu    sync.Mutex
	ok    bool
	mark  EventsMark
	per   map[int64]int64
	total int64
}

// Count returns the number of stored events.
func (c *EventCounter) Count(ctx context.Context, q Querier) (int64, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	mark, err := ReadEventsMark(ctx, q)
	if err != nil {
		return 0, err
	}
	if c.ok && mark.Same(c.mark) {
		return c.total, nil
	}
	var changed []int64
	all := !c.ok
	if !all {
		if changed, all, err = mark.MovedSince(ctx, q, c.mark); err != nil {
			return 0, err
		}
		all = all || len(changed) > partsMaxChanged
	}
	if all {
		per, err := countBySession(ctx, q, nil)
		if err != nil {
			return 0, err
		}
		c.per, c.total = per, 0
		for _, n := range per {
			c.total += n
		}
	} else if len(changed) > 0 {
		per, err := countBySession(ctx, q, changed)
		if err != nil {
			return 0, err
		}
		for _, sid := range changed {
			c.total += per[sid] - c.per[sid]
			if per[sid] == 0 {
				delete(c.per, sid)
			} else {
				c.per[sid] = per[sid]
			}
		}
	}
	c.mark, c.ok = mark, true
	return c.total, nil
}

// countBySession counts the events of the sessions listed (every session
// when nil), off idx_events_session_id.
func countBySession(ctx context.Context, q Querier, sids []int64) (map[int64]int64, error) {
	where, args := "", []any(nil)
	if sids != nil {
		list, _ := json.Marshal(sids)
		where, args = ` WHERE sid IN (SELECT value FROM json_each(?))`, []any{string(list)}
	}
	rows, err := q.QueryContext(ctx, `SELECT sid, COUNT(*) FROM events INDEXED BY idx_events_session_id`+where+` GROUP BY sid`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]int64{}
	for rows.Next() {
		var sid, n int64
		if err := rows.Scan(&sid, &n); err != nil {
			return nil, err
		}
		out[sid] = n
	}
	return out, rows.Err()
}
