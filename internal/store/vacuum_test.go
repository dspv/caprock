package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

// NoneDB creates a database the way every version before 2026-10-13 did:
// auto_vacuum NONE, with a table in it so the mode is fixed.
func NoneDB(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE legacy(x)`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

// A new database is incremental from its first table; an old one opens as it
// was and turns incremental with one VACUUM.
func TestAutoVacuumNewAndOld(t *testing.T) {
	ctx := context.Background()
	fresh := openCompactTest(t)
	if m, err := fresh.AutoVacuum(ctx); err != nil || m != AutoVacuumIncremental {
		t.Fatalf("new database auto_vacuum %d %v", m, err)
	}
	old, err := Open(ctx, NoneDB(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = old.Close() })
	if m, _ := old.AutoVacuum(ctx); m != 0 {
		t.Fatalf("an old database changed mode on open: %d", m)
	}
	if err := old.EnableIncrementalVacuum(ctx); err != nil {
		t.Fatal(err)
	}
	if m, _ := old.AutoVacuum(ctx); m != AutoVacuumIncremental {
		t.Fatalf("after VACUUM auto_vacuum %d", m)
	}
}

// An interrupted VACUUM leaves the database as it was.
func TestEnableIncrementalVacuumCancelled(t *testing.T) {
	ctx := context.Background()
	old, err := Open(ctx, NoneDB(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = old.Close() })
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if err := old.EnableIncrementalVacuum(cctx); err == nil {
		t.Fatal("a cancelled VACUUM reported success")
	}
	if m, _ := old.AutoVacuum(ctx); m != 0 {
		t.Fatalf("a cancelled VACUUM changed the mode to %d", m)
	}
}

// Free pages go back to the disk a step at a time, never more than asked.
func TestIncrementalVacuumSteps(t *testing.T) {
	ctx := context.Background()
	st := openCompactTest(t)
	if _, err := st.DB().Exec(`CREATE TABLE filler(b TEXT)`); err != nil {
		t.Fatal(err)
	}
	big := strings.Repeat("z", 64<<10)
	for i := 0; i < 64; i++ { // 4 MiB
		if _, err := st.DB().Exec(`INSERT INTO filler VALUES(?)`, big); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.DB().Exec(`DELETE FROM filler`); err != nil {
		t.Fatal(err)
	}
	before, err := st.Pages(ctx)
	if err != nil || before.Free < 1000 {
		t.Fatalf("freelist %d %v", before.Free, err)
	}
	n, err := st.IncrementalVacuum(ctx, 100)
	if err != nil || n != 100 {
		t.Fatalf("one step returned %d pages, %v", n, err)
	}
	var total = n
	for {
		n, err := st.IncrementalVacuum(ctx, 100)
		if err != nil {
			t.Fatal(err)
		}
		total += n
		if n < 100 {
			break
		}
	}
	after, _ := st.Pages(ctx)
	if after.Free != 0 || total != before.Free || after.Pages > before.Pages-before.Free {
		t.Fatalf("before %+v after %+v returned %d", before, after, total)
	}
	if _, err := st.CheckpointTruncate(ctx); err != nil {
		t.Fatal(err)
	}
	// Nothing free: a step is a no-op.
	if n, err := st.IncrementalVacuum(ctx, 100); err != nil || n != 0 {
		t.Fatalf("empty freelist returned %d %v", n, err)
	}
}
