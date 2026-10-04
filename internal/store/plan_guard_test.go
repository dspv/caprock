package store

import (
	"context"
	"database/sql"
	"strings"
	"testing"
)

// planRecorder records every statement a read path runs, with its arguments,
// so each can be explained afterwards against the same schema.
type planRecorder struct {
	Querier
	seen []recorded
}

type recorded struct {
	sql  string
	args []any
}

func (p *planRecorder) QueryContext(ctx context.Context, q string, args ...any) (*sql.Rows, error) {
	p.seen = append(p.seen, recorded{q, args})
	return p.Querier.QueryContext(ctx, q, args...)
}

func (p *planRecorder) QueryRowContext(ctx context.Context, q string, args ...any) *sql.Row {
	p.seen = append(p.seen, recorded{q, args})
	return p.Querier.QueryRowContext(ctx, q, args...)
}

// Every aggregate the dashboard polls must be answered from an index alone.
//
// Migration 0024 added `internal` and every aggregate began filtering on it;
// none of the covering indexes carried the column, so each read every full
// event row to test one flag. Nothing noticed for several releases — the
// test database is tiny — until the owner's 300k-event database had the Now
// screen waiting 30-60 seconds for today's totals. SQLite has no ANALYZE
// statistics here, so its plan is the same on ten rows as on ten million:
// checking the plan catches on a test database what timing only catches on a
// real one.
func TestPolledAggregatesReadOnlyFromCoveringIndexes(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	rec := &planRecorder{Querier: st.DB()}

	day := int64(86_400_000)
	for _, from := range []int64{0, 1_790_000_000_000} { // all time, and a recent range
		if _, err := SummarizeSparkFor(ctx, rec, from, SparkSpec{Buckets: 7, WidthMs: day, FromMs: from}, ""); err != nil {
			t.Fatal(err)
		}
		if _, err := History(ctx, rec, from); err != nil {
			t.Fatal(err)
		}
		if _, err := ToolDistribution(ctx, rec, from, 40); err != nil {
			t.Fatal(err)
		}
	}

	checked := 0
	for _, r := range rec.seen {
		if !strings.Contains(r.sql, "FROM events") {
			continue
		}
		rows, err := st.DB().QueryContext(ctx, "EXPLAIN QUERY PLAN "+r.sql, r.args...)
		if err != nil {
			t.Fatalf("explain %s: %v", oneLineSQL(r.sql), err)
		}
		var plan []string
		for rows.Next() {
			var id, parent, notused int
			var detail string
			if err := rows.Scan(&id, &parent, &notused, &detail); err != nil {
				t.Fatal(err)
			}
			plan = append(plan, detail)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		_ = rows.Close()
		for _, line := range plan {
			if !touchesEvents(line) {
				continue
			}
			if !strings.Contains(line, "COVERING INDEX") {
				t.Errorf("reads full event rows: %q\n  in: %s", line, oneLineSQL(r.sql))
			}
		}
		checked++
	}
	if checked < 10 {
		t.Fatalf("only %d event queries recorded; the read paths changed shape and this guard no longer sees them", checked)
	}
}

// touchesEvents is a plan line that reads the events table itself.
func touchesEvents(line string) bool {
	return strings.HasPrefix(line, "SCAN events") || strings.HasPrefix(line, "SEARCH events") ||
		strings.HasPrefix(line, "SCAN e ") || strings.HasPrefix(line, "SEARCH e ") ||
		line == "SCAN e" || line == "SCAN events"
}

func oneLineSQL(s string) string { return strings.Join(strings.Fields(s), " ") }

// A session's notes are read from that session's rows, not from every
// assistant turn on the machine. See sessionAssistantTextWhere.
func TestSessionNotesUsesTheSessionIndex(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	rec := &planRecorder{Querier: st.DB()}
	if _, err := SessionNotes(ctx, rec, "s1", 200); err != nil {
		t.Fatal(err)
	}
	if len(rec.seen) != 1 {
		t.Fatalf("expected one statement, saw %d", len(rec.seen))
	}
	rows, err := st.DB().QueryContext(ctx, "EXPLAIN QUERY PLAN "+rec.seen[0].sql, rec.seen[0].args...)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var plan []string
	for rows.Next() {
		var id, parent, notused int
		var detail string
		if err := rows.Scan(&id, &parent, &notused, &detail); err != nil {
			t.Fatal(err)
		}
		plan = append(plan, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(plan, " | ")
	if !strings.Contains(joined, "USING INDEX idx_events_session_id (session_id=?)") {
		t.Fatalf("SessionNotes must walk the session's own index; plan: %s", joined)
	}
}
