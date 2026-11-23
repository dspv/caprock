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
	// parts is every session's parts generation (session_gen.parts,
	// migration 0091): it moves only when a column a summary part sums
	// changes or a row goes. links and linksFrom are the newest and the
	// oldest kept entry of parts_links, the tool calls linked to their
	// message since.
	parts            map[string]int64
	links, linksFrom int64
}

// ReadEventsMark reads the mark: two single-row reads and session_gen, one
// small row per session that was ever rewritten.
func ReadEventsMark(ctx context.Context, q Querier) (EventsMark, error) {
	m := EventsMark{gens: map[string]int64{}, parts: map[string]int64{}}
	if err := q.QueryRowContext(ctx, `SELECT COALESCE((SELECT MAX(id) FROM events), 0),
		COALESCE((SELECT CAST(v AS INTEGER) FROM meta WHERE k = '`+metaMoved+`'), 0),
		COALESCE((SELECT MAX(seq) FROM parts_links), 0), COALESCE((SELECT MIN(seq) FROM parts_links), 0)`).Scan(
		&m.maxID, &m.moved, &m.links, &m.linksFrom); err != nil {
		return m, err
	}
	rows, err := q.QueryContext(ctx, `SELECT session_id, gen, parts FROM session_gen`)
	if err != nil {
		return m, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var gen, parts int64
		if err := rows.Scan(&id, &gen, &parts); err != nil {
			return m, err
		}
		m.gens[id] = gen
		if parts != 0 {
			m.parts[id] = parts
		}
	}
	return m, rows.Err()
}

// Same reports whether nothing moved between the two marks.
func (m EventsMark) Same(o EventsMark) bool {
	if m.maxID != o.maxID || m.moved != o.moved || m.links != o.links || len(m.gens) != len(o.gens) {
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
		byID, err := sidsOf(ctx, q, ids)
		if err != nil {
			return nil, false, err
		}
		if len(byID) < len(ids) {
			return nil, true, nil
		}
		for _, sid := range byID {
			seen[sid] = true
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

// sidsOf maps session ids to their sids; an id with no session row is left
// out.
func sidsOf(ctx context.Context, q Querier, ids []string) (map[string]int64, error) {
	list, _ := json.Marshal(ids)
	rows, err := q.QueryContext(ctx, `SELECT session_id, sid FROM sessions WHERE session_id IN (SELECT value FROM json_each(?))`, string(list))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var id string
		var sid int64
		if err := rows.Scan(&id, &sid); err != nil {
			return nil, err
		}
		out[id] = sid
	}
	return out, rows.Err()
}

// partsMoves is what moved between two marks as a session's summary parts
// see it (PartsCache).
type partsMoves struct {
	// rewritten are the sessions where a column a part sums changed or a
	// row went (session_gen.parts moved): their parts are read again.
	rewritten []int64
	// added are the sessions with rows above the old mark's newest id, each
	// with the oldest ts among those rows: a session whose new rows all come
	// after what was read of it only needs the new rows.
	added map[int64]int64
	// touched are the sessions whose rows changed in no column a part sums
	// (a payload: a response's later line merged into its turn): only the
	// figures read from payloads, Cursor's and Hermes's, can have moved.
	touched []int64
	// links are the tool calls given their message id since, oldest first.
	links []partsLink
}

// partsLink is one parts_links row: a stored tool call given its message id.
type partsLink struct {
	sid, id int64
	msg     string
}

// count is how many sessions moved.
func (mv partsMoves) count() int {
	seen := map[int64]bool{}
	for _, sid := range mv.rewritten {
		seen[sid] = true
	}
	for _, sid := range mv.touched {
		seen[sid] = true
	}
	for sid := range mv.added {
		seen[sid] = true
	}
	for _, l := range mv.links {
		seen[l.sid] = true
	}
	return len(seen)
}

// partsMovedSince is MovedSince split by how each session moved, or all =
// true when it cannot say: MovedSince's cases, and links dropped from
// parts_links before they were read.
func (m EventsMark) partsMovedSince(ctx context.Context, q Querier, old EventsMark) (mv partsMoves, all bool, err error) {
	if m.moved != old.moved || m.maxID < old.maxID || m.links < old.links {
		return mv, true, nil
	}
	if m.links > old.links && m.linksFrom > old.links+1 {
		return mv, true, nil
	}
	for id := range old.gens {
		if _, ok := m.gens[id]; !ok {
			return mv, true, nil
		}
	}
	var ids []string
	rewritten := map[string]bool{}
	for id, g := range m.gens {
		if old.gens[id] == g {
			continue
		}
		ids = append(ids, id)
		if m.parts[id] != old.parts[id] {
			rewritten[id] = true
		}
	}
	if len(ids) > 0 {
		byID, err := sidsOf(ctx, q, ids)
		if err != nil {
			return mv, false, err
		}
		if len(byID) < len(ids) {
			return mv, true, nil
		}
		for id, sid := range byID {
			if rewritten[id] {
				mv.rewritten = append(mv.rewritten, sid)
			} else {
				mv.touched = append(mv.touched, sid)
			}
		}
		slices.Sort(mv.rewritten)
		slices.Sort(mv.touched)
	}
	if m.maxID > old.maxID {
		// By rowid, as MovedSince: the new rows alone.
		rows, err := q.QueryContext(ctx, `SELECT sid, MIN(ts) FROM events NOT INDEXED WHERE id > ? GROUP BY sid`, old.maxID)
		if err != nil {
			return mv, false, err
		}
		mv.added = map[int64]int64{}
		for rows.Next() {
			var sid, ts int64
			if err := rows.Scan(&sid, &ts); err != nil {
				_ = rows.Close()
				return mv, false, err
			}
			mv.added[sid] = ts
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return mv, false, err
		}
		_ = rows.Close()
	}
	if m.links > old.links {
		rows, err := q.QueryContext(ctx, `SELECT sid, event_id, msg_id FROM parts_links WHERE seq > ? ORDER BY seq`, old.links)
		if err != nil {
			return mv, false, err
		}
		defer rows.Close()
		for rows.Next() {
			var l partsLink
			if err := rows.Scan(&l.sid, &l.id, &l.msg); err != nil {
				return mv, false, err
			}
			mv.links = append(mv.links, l)
		}
		if err := rows.Err(); err != nil {
			return mv, false, err
		}
	}
	return mv, false, nil
}
