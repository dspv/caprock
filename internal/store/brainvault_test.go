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
	if err := DeleteBrainNode(ctx, db, a.ID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM brain_edges`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("edges did not go with their node: %d %v", n, err)
	}
}
