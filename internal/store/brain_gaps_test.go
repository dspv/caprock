package store

import (
	"context"
	"path/filepath"
	"testing"
)

// Migration 0068 on a database that already has reads: every successful
// read is listed as a gap to measure, failed and skipped ones are not, and
// the reads keep counting as regular ones.
func TestMigration0068ListsThePastReadsAsGaps(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "caprock.db")
	s, err := Open(ctx, path, nil)
	if err != nil {
		t.Fatal(err)
	}
	db := s.DB()
	// Back to schema 67, as a database from before the migration is.
	for _, q := range []string{
		`DROP TABLE brain_gaps`,
		`ALTER TABLE brain_runs DROP COLUMN gap_id`,
		`ALTER TABLE brain_runs DROP COLUMN held`,
		`UPDATE meta SET v = '67' WHERE k = 'schema_version'`,
		`INSERT INTO brain_runs (session_id, from_event_id, through_event_id, status, started_at, finished_at) VALUES
			('a', 0, 40, 'ok', 1, 1), ('a', 40, 90, 'ok', 2, 2), ('b', 0, 10, 'skipped', 3, 3), ('c', 0, 20, 'failed', 4, 4)`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	_ = s.Close()
	s, err = Open(ctx, path, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	db = s.DB()
	gaps, err := UnmeasuredBrainGaps(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if len(gaps) != 2 || gaps[0].SessionID != "a" || gaps[0].FromEventID != 0 || gaps[0].RunThrough != 40 ||
		gaps[1].FromEventID != 40 || gaps[1].Cursor != 40 || gaps[1].RunThrough != 90 || gaps[1].Status != BrainGapPending {
		t.Fatalf("gaps: %+v", gaps)
	}
	var gapRuns, held int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(gap_id), SUM(held) FROM brain_runs`).Scan(&gapRuns, &held); err != nil || gapRuns != 0 || held != 0 {
		t.Fatalf("the past reads became catch-up or held reads: %d %d %v", gapRuns, held, err)
	}
	// Measured: one with a span, one with nothing skipped.
	if err := MeasureBrainGap(ctx, db, gaps[0].ID, 30, 2, 5); err != nil {
		t.Fatal(err)
	}
	if err := MeasureBrainGap(ctx, db, gaps[1].ID, 0, 0, 5); err != nil {
		t.Fatal(err)
	}
	if done, total, left, err := BrainCatchUp(ctx, db); err != nil || done != 0 || total != 2 || left != 1 {
		t.Fatalf("catch-up: %d/%d, %d left, %v", done, total, left, err)
	}
	// One read, then the second reaches the end: done, and the total is
	// what it took.
	if err := AdvanceBrainGap(ctx, db, gaps[0].ID, 12, 6); err != nil {
		t.Fatal(err)
	}
	if err := AdvanceBrainGap(ctx, db, gaps[0].ID, 30, 7); err != nil {
		t.Fatal(err)
	}
	if done, total, left, err := BrainCatchUp(ctx, db); err != nil || done != 2 || total != 2 || left != 0 {
		t.Fatalf("catch-up after reading: %d/%d, %d left, %v", done, total, left, err)
	}
}
