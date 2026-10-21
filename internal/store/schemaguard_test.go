package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func latestSchema(t *testing.T) int {
	t.Helper()
	n, err := LatestSchema()
	if err != nil {
		t.Fatal(err)
	}
	if n < 1 {
		t.Fatalf("latest schema %d", n)
	}
	return n
}

// setRawSchema writes meta.schema_version with a plain connection, the way a
// newer Caprock would have left it, and optionally switches the journal mode.
func setRawSchema(t *testing.T, path string, version int, journal string) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if journal != "" {
		if _, err := db.Exec(`PRAGMA journal_mode=` + journal); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
		MetaSchemaVersion, strconv.Itoa(version)); err != nil {
		t.Fatal(err)
	}
}

// newDiskDB is a fully migrated database file, closed.
func newDiskDB(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "caprock.db")
	s, err := Open(context.Background(), path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetMeta(context.Background(), MetaPricingVersion, "kept"); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestOpenRefusesADatabaseFromANewerCaprock(t *testing.T) {
	// WAL is how every Caprock leaves its database; DELETE is the case where
	// Open's own DSN would rewrite the header (journal_mode(WAL)) if the check
	// ran after it.
	for _, journal := range []string{"", "DELETE"} {
		t.Run("journal="+journal, func(t *testing.T) {
			ctx := context.Background()
			latest := latestSchema(t)
			path := newDiskDB(t)
			setRawSchema(t, path, latest+1, journal)
			before := readFile(t, path)

			s, err := Open(ctx, path, nil)
			if err == nil {
				_ = s.Close()
				t.Fatal("Open accepted a database from a newer Caprock")
			}
			var newer *SchemaTooNewError
			if !errors.As(err, &newer) {
				t.Fatalf("err = %v, want *SchemaTooNewError", err)
			}
			if newer.Database != latest+1 || newer.Binary != latest || newer.Path != path {
				t.Fatalf("error = %+v, want database %d, binary %d, path %s", newer, latest+1, latest, path)
			}
			msg := err.Error()
			for _, want := range []string{"schema " + strconv.Itoa(latest+1), "knows up to " + strconv.Itoa(latest), "install the newer Caprock", "nothing was changed"} {
				if !strings.Contains(msg, want) {
					t.Errorf("message %q lacks %q", msg, want)
				}
			}
			if strings.Contains(msg, "\n") {
				t.Errorf("message spans lines: %q", msg)
			}
			if after := readFile(t, path); !bytes.Equal(before, after) {
				t.Fatalf("the refused database changed on disk (%d bytes before, %d after)", len(before), len(after))
			}
			if fi, err := os.Stat(path + "-wal"); err == nil && fi.Size() > 0 {
				t.Fatalf("the refused open left a %d-byte write-ahead log", fi.Size())
			}
			// The file is not held open: a newer Caprock (or the test's
			// cleanup, on Windows) can have it at once.
			if err := os.Rename(path, path+".moved"); err != nil {
				t.Fatalf("database still held after the refusal: %v", err)
			}
		})
	}
}

func TestOpenAcceptsADatabaseAtThisSchema(t *testing.T) {
	ctx := context.Background()
	latest := latestSchema(t)
	path := newDiskDB(t)
	s, err := Open(ctx, path, nil)
	if err != nil {
		t.Fatalf("reopen at the same schema: %v", err)
	}
	defer s.Close()
	if v, _ := s.SchemaVersion(ctx); v != latest {
		t.Fatalf("schema %d, want %d", v, latest)
	}
	if v, _ := s.GetMeta(ctx, MetaPricingVersion); v != "kept" {
		t.Fatalf("meta lost: %q", v)
	}
}

func TestOpenMigratesAnOlderDatabase(t *testing.T) {
	ctx := context.Background()
	latest := latestSchema(t)
	migs, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	// A database an older Caprock left: every migration but the last.
	path := filepath.Join(t.TempDir(), "caprock.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range migs[:len(migs)-1] {
		if _, err := db.Exec(m.sql); err != nil {
			_ = db.Close()
			t.Fatalf("%s: %v", m.name, err)
		}
	}
	if _, err := db.Exec(`INSERT INTO meta(k, v) VALUES(?, ?)`, MetaSchemaVersion, strconv.Itoa(latest-1)); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	if err := CheckSchema(ctx, path); err != nil {
		t.Fatalf("CheckSchema on an older database: %v", err)
	}
	s, err := Open(ctx, path, nil)
	if err != nil {
		t.Fatalf("open an older database: %v", err)
	}
	defer s.Close()
	if v, _ := s.SchemaVersion(ctx); v != latest {
		t.Fatalf("schema %d after migrating, want %d", v, latest)
	}
}

func TestCheckSchemaPassesWhatIsNotNewer(t *testing.T) {
	ctx := context.Background()
	if err := CheckSchema(ctx, filepath.Join(t.TempDir(), "absent.db")); err != nil {
		t.Fatalf("missing file: %v", err)
	}
	empty := filepath.Join(t.TempDir(), "empty.db")
	if err := os.WriteFile(empty, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := CheckSchema(ctx, empty); err != nil {
		t.Fatalf("empty file: %v", err)
	}
	if fi, err := os.Stat(empty); err != nil || fi.Size() != 0 {
		t.Fatalf("CheckSchema wrote to an empty file (size %v, err %v)", fi.Size(), err)
	}
	latest := latestSchema(t)
	for _, tc := range []struct {
		recorded string
		newer    bool
	}{
		{strconv.Itoa(latest + 1), true},
		{strconv.Itoa(latest + 40), true},
		{strconv.Itoa(latest), false},
		{strconv.Itoa(latest - 1), false},
		{"0", false},
		{"", false},
		{"not a number", false},
	} {
		err := schemaNewer("x.db", tc.recorded, latest)
		if got := err != nil; got != tc.newer {
			t.Errorf("recorded %q: newer = %v, want %v", tc.recorded, got, tc.newer)
		}
	}
}

func TestMigrateRefusesANewerSchemaInMemory(t *testing.T) {
	// The second line behind CheckSchema: migrate itself, which an in-memory
	// database and a race past the check both reach.
	ctx := context.Background()
	s := openTest(t)
	latest := latestSchema(t)
	if err := s.SetMeta(ctx, MetaSchemaVersion, strconv.Itoa(latest+1)); err != nil {
		t.Fatal(err)
	}
	err := s.migrate(ctx)
	var newer *SchemaTooNewError
	if !errors.As(err, &newer) || newer.Database != latest+1 || newer.Binary != latest {
		t.Fatalf("migrate = %v, want a SchemaTooNewError for %d over %d", err, latest+1, latest)
	}
	if v, _ := s.SchemaVersion(ctx); v != latest+1 {
		t.Fatalf("migrate rewrote schema_version to %d", v)
	}
}

func TestSchemaTooNewErrorMessage(t *testing.T) {
	e := &SchemaTooNewError{Path: "/data/caprock.db", Database: 67, Binary: 66}
	want := "the database /data/caprock.db is from a newer Caprock (schema 67; this Caprock knows up to 66): install the newer Caprock to open it — nothing was changed"
	if e.Error() != want {
		t.Fatalf("got  %q\nwant %q", e.Error(), want)
	}
}
