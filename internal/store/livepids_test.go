package store

import (
	"context"
	"testing"
)

// EndedByPID answers only ended sessions, the newest per pid, and only for
// the pids asked about.
func TestEndedByPID(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	for _, r := range []struct {
		id     string
		pid    int
		status string
		start  int64
		last   int64
	}{
		{"a", 10, "ended", 100, 200},
		{"b", 10, "ended", 300, 400}, // the same pid later: this one wins
		{"c", 11, "active", 100, 500},
		{"d", 12, "ended", 100, 150},
	} {
		if _, err := s.DB().Exec(`INSERT INTO sessions(session_id, pid, status, started_at, last_event_at) VALUES (?, ?, ?, ?, ?)`, r.id, r.pid, r.status, r.start, r.last); err != nil {
			t.Fatal(err)
		}
	}
	got, err := EndedByPID(ctx, s.DB(), []int{10, 11, 99})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[10].SessionID != "b" || got[10].StartedAt != 300 || got[10].LastEventAt != 400 {
		t.Errorf("got %+v", got)
	}
	if none, err := EndedByPID(ctx, s.DB(), nil); err != nil || len(none) != 0 {
		t.Errorf("no pids: %v %v", none, err)
	}
}
