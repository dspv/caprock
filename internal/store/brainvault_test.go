package store

import (
	"context"
	"os"
	"strings"
	"testing"
)

// Migration 0062 rebuilds brain_nodes and brain_edges to let the kind
// 'note' in. Run on a graph that exists, it keeps every node, edge and
// weight, and the edges still go with their nodes.
func TestMigration0062KeepsTheGraph(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	db := s.DB()
	a, _, err := InsertBrainNode(ctx, db, BrainNode{Kind: BrainDecision, Title: "Use WAL", Summary: "Why.", Pinned: true, Source: BrainSource{Project: "caprock"}}, 10)
	if err != nil {
		t.Fatal(err)
	}
	topic, err := EnsureBrainEntity(ctx, db, BrainTopic, "sqlite", BrainSource{}, false, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if err := LinkBrain(ctx, db, a.ID, topic, EdgePartOf, 3, 10); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile("migrations/0062_brain_obsidian.sql")
	if err != nil {
		t.Fatal(err)
	}
	src := string(b)
	end := strings.Index(src, "-- 2. The vaults.")
	if end < 0 {
		t.Fatal("the rebuild is not in the migration")
	}
	if err := s.WithTx(ctx, func(q Querier) error {
		_, err := q.ExecContext(ctx, src[:end])
		return err
	}); err != nil {
		t.Fatal(err)
	}
	// 0062's rebuild leaves brain_nodes and brain_edges as they were before
	// 0069; 0069's own rebuild, on that graph, keeps it too.
	applyMigration0069Brain(t, s)
	got, err := GetBrainNode(ctx, db, a.ID)
	if err != nil || got.Title != "Use WAL" || !got.Pinned || got.Summary != "Why." {
		t.Fatalf("node after the rebuild: %+v %v", got, err)
	}
	var w float64
	if err := db.QueryRowContext(ctx, `SELECT weight FROM brain_edges WHERE src = ? AND dst = ?`, a.ID, topic).Scan(&w); err != nil || w != 3 {
		t.Fatalf("edge after the rebuild: %v %v", w, err)
	}
	if _, _, err := InsertBrainNode(ctx, db, BrainNode{Kind: BrainNote, Title: "A note"}, 11); err != nil {
		t.Fatalf("a note after the rebuild: %v", err)
	}
	c, _, err := InsertBrainNode(ctx, db, BrainNode{Kind: BrainDecision, Title: "Use WAL2", Keywords: []string{"sqlite", "journal"}, Source: BrainSource{Project: "caprock"}}, 12)
	if err != nil || c.Keywords.String() != "sqlite, journal" {
		t.Fatalf("keywords after the rebuild: %+v %v", c, err)
	}
	if err := BrainSupersede(ctx, db, c.ID, a.ID, 12); err != nil {
		t.Fatalf("a supersedes edge after the rebuild: %v", err)
	}
	if err := DeleteBrainNode(ctx, db, a.ID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM brain_edges`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("edges did not go with their node: %d %v", n, err)
	}
}

// applyMigration0069Brain runs migration 0069's first two parts — the
// keywords column and the brain_edges rebuild — on a database whose brain
// tables are in their pre-0069 shape (sessions already has its column).
func applyMigration0069Brain(t *testing.T, s *Store) {
	t.Helper()
	b, err := os.ReadFile("migrations/0069_brain_find_decisions.sql")
	if err != nil {
		t.Fatal(err)
	}
	src := string(b)
	end := strings.Index(src, "-- 3. ")
	if end < 0 {
		t.Fatal("the sessions part is not in the migration")
	}
	if err := s.WithTx(context.Background(), func(q Querier) error {
		_, err := q.ExecContext(context.Background(), src[:end])
		return err
	}); err != nil {
		t.Fatal(err)
	}
}
