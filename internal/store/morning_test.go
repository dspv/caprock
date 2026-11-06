package store

import (
	"context"
	"testing"
)

// FinishedSince counts ended sessions per project in the window, with the
// ones at a usage limit and the ones that exited with an error code, and
// leaves out chats, live sessions and work before the window.
func TestFinishedSince(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	db := s.DB()
	type row struct {
		id, project, status string
		last                int64
		exit                any
		limitAt             int64
		chat                int
		day                 string
	}
	for _, r := range []row{
		{"a", "caprock", "ended", 5000, 0, 0, 0, "2026-11-05"},
		{"b", "caprock", "ended", 6000, 1, 0, 0, "2026-11-05"},
		{"c", "caprock", "ended", 6500, 143, 0, 0, "2026-11-04"}, // a stop, not a failure
		{"d", "caprock", "ended", 7000, nil, 6900, 0, "2026-11-05"},
		{"e", "site", "ended", 5500, nil, 0, 0, "2026-11-05"},
		{"f", "site", "active", 5500, nil, 0, 0, "2026-11-05"}, // still running
		{"g", "site", "ended", 5500, nil, 0, 1, "2026-11-05"},  // a chat
		{"h", "site", "ended", 500, nil, 0, 0, "2026-11-05"},   // ended before the window
		{"i", "old", "ended", 5500, nil, 0, 0, "2026-11-01"},   // no work since fromDay
	} {
		if err := UpsertSession(ctx, db, r.id, SessionPatch{Agent: "claude", Cwd: "/w/" + r.project, StartedAt: 1, LastEventAt: r.last}); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`UPDATE sessions SET project = ?, status = ?, last_event_at = ?, exit_code = ?, limit_hit_at = ?, chat = ? WHERE session_id = ?`,
			r.project, r.status, r.last, r.exit, r.limitAt, r.chat, r.id); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT OR IGNORE INTO daily_sessions(day, project, session_id) VALUES(?, ?, ?)`, r.day, r.project, r.id); err != nil {
			t.Fatal(err)
		}
	}
	got, err := FinishedSince(ctx, db, "2026-11-04", 1000, 10000)
	if err != nil {
		t.Fatal(err)
	}
	want := []FinishedProject{{Project: "caprock", Finished: 4, AtLimit: 1, Errored: 1}, {Project: "site", Finished: 1}}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}
