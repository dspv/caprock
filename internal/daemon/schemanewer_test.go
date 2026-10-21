package daemon

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"io"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/store"
)

// A database a newer Caprock migrated stops the daemon before anything
// touches it (ADR-082): the start fails with the store's own one-line
// refusal, the file is left byte for byte, and the doctor names the cause
// instead of suggesting `caprock up`.
func TestDaemonRefusesADatabaseFromANewerCaprock(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	path := config.DBPath(dir)
	st, err := store.Open(ctx, path, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = st.Close()
	latest, err := store.LatestSchema()
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE meta SET v = ? WHERE k = ?`, strconv.Itoa(latest+1), store.MetaSchemaVersion); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	_, err = newDaemon(ctx, Options{DataDir: dir, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	var newer *store.SchemaTooNewError
	if !errors.As(err, &newer) {
		t.Fatalf("start = %v, want a SchemaTooNewError", err)
	}
	if strings.HasPrefix(err.Error(), "open store:") {
		t.Errorf("the refusal is wrapped: %q", err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("the refused start changed the database")
	}

	f := OfflineFootprint(ctx, dir, 0)
	got := codes(f.Verdicts)
	if got["database_newer"] != "warn" || got["daemon_not_running"] != "" {
		t.Fatalf("doctor verdicts: %+v", f.Verdicts)
	}
	if !strings.Contains(f.SchemaNewer, "schema "+strconv.Itoa(latest+1)) {
		t.Errorf("doctor's text: %q", f.SchemaNewer)
	}
}

func TestFootprintWithoutANewerDatabaseSaysNotRunning(t *testing.T) {
	f := cleanFootprint()
	f.DaemonRunning = false
	f.finish()
	if got := codes(f.Verdicts); got["daemon_not_running"] != "warn" || got["database_newer"] != "" {
		t.Fatalf("verdicts: %+v", f.Verdicts)
	}
}
