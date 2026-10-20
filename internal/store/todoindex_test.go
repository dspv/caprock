package store

import (
	"context"
	"strings"
	"testing"
)

// The task list is read through idx_events_todo, and the index holds every
// tool the fold reads: a tool missing from its WHERE would vanish from every
// task list without an error (F18).
func TestTaskListReadsItsPartialIndex(t *testing.T) {
	raw, err := migrationFS.ReadFile("migrations/0066_events_todo.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range todoTools {
		if !strings.Contains(string(raw), "'"+tool+"'") {
			t.Errorf("idx_events_todo leaves out %s", tool)
		}
	}
	s := openTest(t)
	rows, err := s.DB().QueryContext(context.Background(), `EXPLAIN QUERY PLAN
		SELECT ts FROM events INDEXED BY idx_events_todo
		 WHERE session_id = 'x' AND kind = 'tool.pre'
		   AND tool IN ('TodoWrite', 'TaskCreate', 'TaskUpdate', 'update_plan')
		 ORDER BY ts, id`)
	if err != nil {
		t.Fatalf("the query cannot use the index: %v", err)
	}
	defer rows.Close()
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
	if p := strings.Join(plan, "; "); !strings.Contains(p, "idx_events_todo") || strings.Contains(p, "TEMP B-TREE") {
		t.Fatalf("plan = %q, want idx_events_todo and no sort", p)
	}
}
