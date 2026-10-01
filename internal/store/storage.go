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
	// One pass, grouped by agent and kind, with the windows as conditional
	// sums: four separate scans of an 800 MB table would cost four times as
	// much for the same rows. octet_length counts bytes; length() would count
	// characters, which undercounts any payload that is not ASCII.
	//
	// The agent comes from the session row — the one place it is recorded for
	// every agent. An event whose session row is missing is counted under the
	// default agent, which is what the sessions column itself defaults to.
	rows, err := db.QueryContext(ctx, `
		SELECT COALESCE(s.agent, 'claude'), e.kind,
		       COUNT(*), COALESCE(SUM(octet_length(e.payload)), 0), MIN(e.ts),
		       SUM(e.ts >= ?1), COALESCE(SUM(CASE WHEN e.ts >= ?1 THEN octet_length(e.payload) END), 0),
		       SUM(e.ts >= ?2), COALESCE(SUM(CASE WHEN e.ts >= ?2 THEN octet_length(e.payload) END), 0),
		       SUM(e.ts <  ?3), COALESCE(SUM(CASE WHEN e.ts <  ?3 THEN octet_length(e.payload) END), 0),
		       SUM(e.ts <  ?4), COALESCE(SUM(CASE WHEN e.ts <  ?4 THEN octet_length(e.payload) END), 0)
		FROM events AS e LEFT JOIN sessions AS s ON s.session_id = e.session_id
		GROUP BY 1, 2`, r7, r30, o30, o90)
	if err != nil {
		return fmt.Errorf("events breakdown: %w", err)
	}
	defer func() { _ = rows.Close() }()
	agents, kinds := map[string]*SliceSize{}, map[string]*SliceSize{}
	st.Recent = []WindowSize{{Days: recentWindows[0]}, {Days: recentWindows[1]}}
	st.Older = []WindowSize{{Days: olderWindows[0]}, {Days: olderWindows[1]}}
	add := func(m map[string]*SliceSize, name string, n, b int64) {
		s := m[name]
		if s == nil {
			s = &SliceSize{Name: name}
			m[name] = s
		}
		s.Events += n
		s.PayloadBytes += b
	}
	for rows.Next() {
		var agent, kind string
		var n, b, minTs, n7, b7, n30, b30, no30, bo30, no90, bo90 int64
		if err := rows.Scan(&agent, &kind, &n, &b, &minTs, &n7, &b7, &n30, &b30, &no30, &bo30, &no90, &bo90); err != nil {
			return err
		}
		add(agents, agent, n, b)
		add(kinds, kind, n, b)
		st.Events += n
		st.PayloadBytes += b
		if st.OldestTs == 0 || minTs < st.OldestTs {
			st.OldestTs = minTs
		}
		st.Recent[0].Events += n7
		st.Recent[0].PayloadBytes += b7
		st.Recent[1].Events += n30
		st.Recent[1].PayloadBytes += b30
		st.Older[0].Events += no30
		st.Older[0].PayloadBytes += bo30
		st.Older[1].Events += no90
		st.Older[1].PayloadBytes += bo90
	}
	if err := rows.Err(); err != nil {
		return err
	}
	st.Agents, st.Kinds = sortedSlices(agents), sortedSlices(kinds)
	return nil
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
