package store

import (
	"context"
	"encoding/json"
	"slices"
)

// EventsMark is the state of the events table as far as a kept answer needs
// to know it: the newest event id, how many rows were moved in from the
// legacy table (EventsVersion's second half), and every session's rewrite
// generation (session_gen, migration 0063). Two equal marks mean no event was
// written, changed or removed in between; two different ones say which
// sessions moved (MovedSince), without reading a single event.
//
// A new row always takes an id above the newest one (events.id is an
// AUTOINCREMENT rowid), so the sessions with new rows are the sids of the
// rows above the old mark's maxID — the few newest rows of the table, read by
// rowid. An update or delete of a session's events moves its generation in
// the same transaction, whatever code wrote it.
type EventsMark struct {
	maxID, moved int64
	gens         map[string]int64
}

// ReadEventsMark reads the mark: two single-row reads and session_gen, one
// small row per session that was ever rewritten.
func ReadEventsMark(ctx context.Context, q Querier) (EventsMark, error) {
	m := EventsMark{gens: map[string]int64{}}
	if err := q.QueryRowContext(ctx, `SELECT COALESCE((SELECT MAX(id) FROM events), 0),
		COALESCE((SELECT CAST(v AS INTEGER) FROM meta WHERE k = '`+metaMoved+`'), 0)`).Scan(&m.maxID, &m.moved); err != nil {
		return m, err
	}
	rows, err := q.QueryContext(ctx, `SELECT session_id, gen FROM session_gen`)
	if err != nil {
		return m, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var gen int64
		if err := rows.Scan(&id, &gen); err != nil {
			return m, err
		}
		m.gens[id] = gen
	}
	return m, rows.Err()
}

// Same reports whether nothing moved between the two marks.
func (m EventsMark) Same(o EventsMark) bool {
	if m.maxID != o.maxID || m.moved != o.moved || len(m.gens) != len(o.gens) {
		return false
	}
	for id, g := range m.gens {
		if h, ok := o.gens[id]; !ok || h != g {
			return false
		}
	}
	return true
}

// MovedSince returns the sids whose events changed between old and m, in
// order, or all = true when it cannot say: rows moved in from the legacy
// table, the newest id went down, or a rewritten session's row is gone so its
// sid cannot be named. Rows with no session are never among the sids; a
// reader that counts them reads them again itself.
func (m EventsMark) MovedSince(ctx context.Context, q Querier, old EventsMark) (sids []int64, all bool, err error) {
	if m.moved != old.moved || m.maxID < old.maxID {
		return nil, true, nil
	}
	seen := map[int64]bool{}
	var ids []string
	for id, g := range m.gens {
		if old.gens[id] != g {
			ids = append(ids, id)
		}
	}
	if len(ids) > 0 {
		list, _ := json.Marshal(ids)
		rows, err := q.QueryContext(ctx, `SELECT sid FROM sessions WHERE session_id IN (SELECT value FROM json_each(?))`, string(list))
		if err != nil {
			return nil, false, err
		}
		n := 0
		for rows.Next() {
			var sid int64
			if err := rows.Scan(&sid); err != nil {
				_ = rows.Close()
				return nil, false, err
			}
			seen[sid] = true
			n++
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, false, err
		}
		_ = rows.Close()
		if n < len(ids) {
			return nil, true, nil
		}
	}
	for id := range old.gens {
		if _, ok := m.gens[id]; !ok {
			return nil, true, nil // session_gen lost a row: nothing deletes them, so say all
		}
	}
	if m.maxID > old.maxID {
		// By rowid: the new rows alone. SQLite's own choice for DISTINCT sid
		// walks all of idx_events_session_id instead.
		rows, err := q.QueryContext(ctx, `SELECT DISTINCT sid FROM events NOT INDEXED WHERE id > ?`, old.maxID)
		if err != nil {
			return nil, false, err
		}
		defer rows.Close()
		for rows.Next() {
			var sid int64
			if err := rows.Scan(&sid); err != nil {
				return nil, false, err
			}
			seen[sid] = true
		}
		if err := rows.Err(); err != nil {
			return nil, false, err
		}
	}
	for sid := range seen {
		sids = append(sids, sid)
	}
	slices.Sort(sids)
	return sids, false, nil
}
