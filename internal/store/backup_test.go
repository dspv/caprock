package store

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenKeepsACopyBeforeTheUpgrade(t *testing.T) {
	ctx := context.Background()
	path, raw := openAtSchema(t, 72)
	if _, err := raw.Exec(`INSERT INTO events(ts, session_id, source, kind, payload) VALUES (1, 's', 'hook', 'turn.user', '{}'), (2, 's', 'hook', 'turn.user', '{}')`); err != nil {
		t.Fatal(err)
	}
	_ = raw.Close()

	upgrades := 0
	s, err := Open(ctx, path, nil, OnUpgrade(func() func() { upgrades++; return func() {} }))
	if err != nil {
		t.Fatal(err)
	}
	_ = s.Close()
	copyPath := BackupPath(path, 73)
	if upgrades != 1 || filepath.Base(copyPath) != "c.pre-0073.db" {
		t.Fatalf("%d upgrades, copy at %s", upgrades, copyPath)
	}
	if got := Backups(path); len(got) != 1 || got[0] != copyPath {
		t.Fatalf("Backups = %v", got)
	}
	// The copy is the database as an older Caprock left it.
	old, err := sql.Open("sqlite", "file:"+copyPath+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	var version string
	var n int
	if err := old.QueryRow(`SELECT v FROM meta WHERE k = 'schema_version'`).Scan(&version); err != nil || version != "72" {
		t.Fatalf("copy at schema %q (%v)", version, err)
	}
	if err := old.QueryRow(`SELECT COUNT(*) FROM events WHERE session_id = 's'`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("copy holds %d events (%v)", n, err)
	}
	_ = old.Close()

	// Upgraded already: nothing is copied again.
	if err := os.Remove(copyPath); err != nil {
		t.Fatal(err)
	}
	if s, err = Open(ctx, path, nil, OnUpgrade(func() func() { upgrades++; return func() {} })); err != nil {
		t.Fatal(err)
	}
	_ = s.Close()
	if _, err := os.Stat(copyPath); !errors.Is(err, os.ErrNotExist) || upgrades != 1 {
		t.Fatalf("copied again on an upgraded database: %v, %d upgrades", err, upgrades)
	}
}

func TestTheUpgradeGoesOnWithoutRoomForACopy(t *testing.T) {
	free := diskFree
	diskFree = func(string) (int64, error) { return 0, nil }
	t.Cleanup(func() { diskFree = free })
	path, raw := openAtSchema(t, 72)
	_ = raw.Close()
	s, err := Open(context.Background(), path, nil)
	if err != nil {
		t.Fatal(err)
	}
	v, err := s.SchemaVersion(context.Background())
	_ = s.Close()
	if err != nil || v != 73 {
		t.Fatalf("schema %d after an upgrade with no copy (%v)", v, err)
	}
	if got := Backups(path); len(got) != 0 {
		t.Fatalf("a copy with no room for it: %v", got)
	}
}

func TestANewDatabaseKeepsNoCopy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c.db")
	s, err := Open(context.Background(), path, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = s.Close()
	if got := Backups(path); len(got) != 0 {
		t.Fatalf("a new database kept a copy: %v", got)
	}
}
