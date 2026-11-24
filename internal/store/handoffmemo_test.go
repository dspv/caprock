package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// countingQ counts the statements that read events.
type countingQ struct {
	Querier
	events int
}

func (c *countingQ) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	if strings.Contains(query, "FROM events") {
		c.events++
	}
	return c.Querier.QueryContext(ctx, query, args...)
}

func (c *countingQ) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	if strings.Contains(query, "FROM events") {
		c.events++
	}
	return c.Querier.QueryRowContext(ctx, query, args...)
}

// With a memo, a session's first edit is read once: the next status refresh
// reads no event for it. A session with no edit yet is read again only after
// its newest event moved, and then its edit is found. The figures are the
// same as without a memo every time.
func TestHandoffEffectMemoReadsEachFirstEditOnce(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	db := s.DB()
	start := time.Date(2026, 11, 24, 9, 0, 0, 0, time.UTC)
	n := 0
	tool := func(id, name string, at time.Time) {
		t.Helper()
		n++
		ev := &event.Event{SessionID: id, Source: event.SourceHook, Kind: event.KindToolPre, Tool: name,
			Key: id + name + at.String(), Ts: at, Payload: json.RawMessage(`{}`)}
		if _, err := InsertEvent(ctx, db, ev); err != nil {
			t.Fatal(err)
		}
		if err := UpsertSession(ctx, db, id, SessionPatch{LastEventAt: at.UnixMilli()}); err != nil {
			t.Fatal(err)
		}
	}
	for i, id := range []string{"served", "withheld", "waiting"} {
		if err := UpsertSession(ctx, db, id, SessionPatch{Cwd: "/w/caprock", StartedAt: start.UnixMilli(), LastEventAt: start.UnixMilli()}); err != nil {
			t.Fatal(err)
		}
		state := HandoffServed
		if i == 1 {
			state = HandoffWithheld
		}
		if err := SetHandoff(ctx, db, id, state); err != nil {
			t.Fatal(err)
		}
	}
	tool("served", "Read", start.Add(time.Second))
	tool("served", "Edit", start.Add(5*time.Minute))
	tool("withheld", "Read", start.Add(time.Second))
	tool("withheld", "Read", start.Add(2*time.Second))
	tool("withheld", "Write", start.Add(15*time.Minute))
	tool("waiting", "Read", start.Add(time.Second))

	var memo HandoffMemo
	check := func(wantReads int, wantServed HandoffGroup) {
		t.Helper()
		cq := &countingQ{Querier: db}
		s1, w1, err := HandoffEffect(ctx, cq, &memo)
		if err != nil {
			t.Fatal(err)
		}
		s0, w0, err := HandoffEffect(ctx, db, nil)
		if err != nil {
			t.Fatal(err)
		}
		if s1 != s0 || w1 != w0 {
			t.Fatalf("with the memo %+v %+v, without %+v %+v", s1, w1, s0, w0)
		}
		if s1 != wantServed {
			t.Fatalf("served = %+v, want %+v", s1, wantServed)
		}
		if w1 != (HandoffGroup{Sessions: 1, Reached: 1, MedianMin: 15, MedianCall: 2}) {
			t.Fatalf("withheld = %+v", w1)
		}
		if cq.events != wantReads {
			t.Fatalf("%d statements read events, want %d", cq.events, wantReads)
		}
	}
	// First: each session's first edit, and the calls before the two found.
	check(5, HandoffGroup{Sessions: 2, Reached: 1, MedianMin: 5, MedianCall: 1})
	// Nothing moved: nothing read.
	check(0, HandoffGroup{Sessions: 2, Reached: 1, MedianMin: 5, MedianCall: 1})
	// The waiting session read on without editing: looked at again, once.
	tool("waiting", "Grep", start.Add(time.Minute))
	check(1, HandoffGroup{Sessions: 2, Reached: 1, MedianMin: 5, MedianCall: 1})
	check(0, HandoffGroup{Sessions: 2, Reached: 1, MedianMin: 5, MedianCall: 1})
	// Then it edits: found, counted, and kept.
	tool("waiting", "Edit", start.Add(7*time.Minute))
	check(2, HandoffGroup{Sessions: 2, Reached: 2, MedianMin: 6, MedianCall: 1.5})
	check(0, HandoffGroup{Sessions: 2, Reached: 2, MedianMin: 6, MedianCall: 1.5})
	// A session no longer handed anything leaves the memo.
	if err := SetHandoff(ctx, db, "waiting", HandoffNone); err != nil {
		t.Fatal(err)
	}
	check(0, HandoffGroup{Sessions: 1, Reached: 1, MedianMin: 5, MedianCall: 1})
	memo.mu.Lock()
	_, kept := memo.m["waiting"]
	memo.mu.Unlock()
	if kept {
		t.Fatal("a session no longer handed anything stayed in the memo")
	}
}
