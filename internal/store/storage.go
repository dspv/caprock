package store

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"time"
)

// Storage is what the database is made of: how many pages it has, how many of
// them are free, which tables and indexes hold the rest, and what the events
// table — nearly all of it — records.
//
// Every figure is counted, not modelled. The one derived number, the growth
// estimate, is labelled as such by the caller.
//
// Expensive by design: dbstat walks every page of the file and the events
// breakdown reads every row. On an 857 MB database the two took seconds, so
// the daemon computes this in the background and serves a cached copy; nothing
// on a request path may call it.
type Storage struct {
	PageSize  int64 `json:"page_size"`
	PageCount int64 `json:"page_count"`
	// FreePages is the freelist: pages the file holds but no table uses. They
	// are reused by new rows before the file grows, and only VACUUM returns
	// them to the disk.
	FreePages int64 `json:"free_pages"`
	// Tables is every table with its own pages and its indexes' pages, largest
	// first. Absent when this SQLite build has no dbstat.
	Tables []TableSize `json:"tables,omitempty"`
	// Events and PayloadBytes count the events table: rows, and the bytes of
	// the raw JSON each row keeps.
	Events       int64 `json:"events"`
	PayloadBytes int64 `json:"payload_bytes"`
	// OldestTs is the oldest event's time, unix ms; 0 when there are none.
	OldestTs int64 `json:"oldest_ts"`
	// Agents and Kinds split the events by who produced them and what they
	// are, largest payload first.
	Agents []SliceSize `json:"agents"`
	Kinds  []SliceSize `json:"kinds"`
	// Recent is what the last 7 and 30 days added; Older is what is older than
	// 30 and 90 days — what a retention setting of that length would delete.
	Recent []WindowSize `json:"recent"`
	Older  []WindowSize `json:"older"`
}

// TableSize is one table's footprint on disk.
type TableSize struct {
	Name       string `json:"name"`
	DataBytes  int64  `json:"data_bytes"`
	IndexBytes int64  `json:"index_bytes"`
}

// SliceSize is one group of events.
type SliceSize struct {
	Name         string `json:"name"`
	Events       int64  `json:"events"`
	PayloadBytes int64  `json:"payload_bytes"`
}

// WindowSize is the events on one side of a day boundary.
type WindowSize struct {
	Days         int   `json:"days"`
	Events       int64 `json:"events"`
	PayloadBytes int64 `json:"payload_bytes"`
}

// storageWindows are the day counts Recent and Older report.
var (
	recentWindows = []int{7, 30}
	olderWindows  = []int{30, 90}
)

// MeasureStorage reads the database's composition. See Storage for its cost.
func MeasureStorage(ctx context.Context, db *sql.DB, now time.Time) (Storage, error) {
	var st Storage
	for _, p := range []struct {
		name string
		dst  *int64
	}{{"page_size", &st.PageSize}, {"page_count", &st.PageCount}, {"freelist_count", &st.FreePages}} {
		if err := db.QueryRowContext(ctx, "PRAGMA "+p.name).Scan(p.dst); err != nil {
			return st, fmt.Errorf("pragma %s: %w", p.name, err)
		}
	}
	tables, err := tableSizes(ctx, db)
	if err != nil {
		// dbstat is a compile-time option. The pure-Go driver has it; a build
		// without it still gets every other figure rather than none.
		tables = nil
	}
	st.Tables = tables
	if err := eventBreakdown(ctx, db, now, &st); err != nil {
		return st, err
	}
	return st, nil
}

// tableSizes sums dbstat per b-tree and folds each index into its table.
func tableSizes(ctx context.Context, db *sql.DB) ([]TableSize, error) {
	// aggregate=TRUE returns one row per b-tree rather than one per page,
	// which is the same walk with a much smaller result set.
	rows, err := db.QueryContext(ctx, `
		SELECT COALESCE(m.tbl_name, d.name), m.type, d.pgsize
		FROM dbstat AS d LEFT JOIN sqlite_schema AS m ON m.name = d.name
		WHERE d.aggregate = TRUE`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	by := map[string]*TableSize{}
	for rows.Next() {
		var name string
		var typ sql.NullString
		var size int64
		if err := rows.Scan(&name, &typ, &size); err != nil {
			return nil, err
		}
		t := by[name]
		if t == nil {
			t = &TableSize{Name: name}
			by[name] = t
		}
		// An automatic index (a UNIQUE or PRIMARY KEY on a non-rowid column)
		// is in sqlite_schema with type 'index' too, so it lands here as well.
		if typ.String == "index" {
			t.IndexBytes += size
		} else {
			t.DataBytes += size
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]TableSize, 0, len(by))
	for _, t := range by {
		out = append(out, *t)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i].DataBytes+out[i].IndexBytes, out[j].DataBytes+out[j].IndexBytes
		if a != b {
			return a > b
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// eventBreakdown reads the events table once and fills every per-row figure.
func eventBreakdown(ctx context.Context, db *sql.DB, now time.Time, st *Storage) error {
	day := int64(24 * time.Hour / time.Millisecond)
	nowMs := now.UnixMilli()
	r7, r30 := nowMs-int64(recentWindows[0])*day, nowMs-int64(recentWindows[1])*day
	o30, o90 := nowMs-int64(olderWindows[0])*day, nowMs-int64(olderWindows[1])*day
	// One pass in rowid order, folded here rather than in SQL.
	//
	// This was a GROUP BY over a join, with the windows as conditional sums.
	// SQLite answered it with a temporary b-tree, and the sorter records it
	// spilled to disk carried each row's payload rather than its length (an
	// aggregate's argument is evaluated after the sort), so the whole table
	// went through temp files every half hour: 11 s in the sqlite3 shell on
	// the owner's 1.8 GB database (2026-10-10), against 0.4 s for the plain
	// scan below. octet_length counts bytes without reading a payload's
	// overflow pages; length() would count characters, which undercounts
	// any payload that is not ASCII.
	//
	// The agent comes from the session row — the one place it is recorded for
	// every agent.
	agentOf, err := sessionAgents(ctx, db)
	if err != nil {
		return fmt.Errorf("events breakdown: %w", err)
	}
	rows, err := db.QueryContext(ctx, `SELECT sid, kind, ts, COALESCE(octet_length(payload), 0) FROM events`)
	if err != nil {
		return fmt.Errorf("events breakdown: %w", err)
	}
	defer func() { _ = rows.Close() }()
	agents, kinds := map[string]*SliceSize{}, map[string]*SliceSize{}
	st.Recent = []WindowSize{{Days: recentWindows[0]}, {Days: recentWindows[1]}}
	st.Older = []WindowSize{{Days: olderWindows[0]}, {Days: olderWindows[1]}}
	add := func(m map[string]*SliceSize, name []byte, b int64) {
		s := m[string(name)] // no allocation for the lookup
		if s == nil {
			s = &SliceSize{Name: string(name)}
			m[s.Name] = s
		}
		s.Events++
		s.PayloadBytes += b
	}
	window := func(w *WindowSize, b int64) {
		w.Events++
		w.PayloadBytes += b
	}
	defaultAgent := []byte("claude")
	for rows.Next() {
		var kind sql.RawBytes
		var sid, ts, b int64
		if err := rows.Scan(&sid, &kind, &ts, &b); err != nil {
			return err
		}
		agent := defaultAgent
		if a, ok := agentOf[sid]; ok {
			agent = a
		}
		add(agents, agent, b)
		add(kinds, kind, b)
		st.Events++
		st.PayloadBytes += b
		if st.OldestTs == 0 || ts < st.OldestTs {
			st.OldestTs = ts
		}
		if ts >= r7 {
			window(&st.Recent[0], b)
		}
		if ts >= r30 {
			window(&st.Recent[1], b)
		}
		if ts < o30 {
			window(&st.Older[0], b)
		}
		if ts < o90 {
			window(&st.Older[1], b)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	st.Agents, st.Kinds = sortedSlices(agents), sortedSlices(kinds)
	return nil
}

// sessionAgents maps each session to the agent that ran it, as bytes so the
// breakdown can name a slice without converting per row.
func sessionAgents(ctx context.Context, db *sql.DB) (map[int64][]byte, error) {
	rows, err := db.QueryContext(ctx, `SELECT sid, COALESCE(agent, 'claude') FROM sessions`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[int64][]byte{}
	for rows.Next() {
		var id int64
		var agent string
		if err := rows.Scan(&id, &agent); err != nil {
			return nil, err
		}
		out[id] = []byte(agent)
	}
	return out, rows.Err()
}

func sortedSlices(m map[string]*SliceSize) []SliceSize {
	out := make([]SliceSize, 0, len(m))
	for _, s := range m {
		out = append(out, *s)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].PayloadBytes != out[j].PayloadBytes {
			return out[i].PayloadBytes > out[j].PayloadBytes
		}
		return out[i].Name < out[j].Name
	})
	return out
}
