package daemon

import (
	"context"
	"database/sql"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// A daemon that started before OpenCode had ever run must start reading
// OpenCode once its database appears, without a restart and without Caprock
// having started an OpenCode session itself. Found on Linux (2026-10-09): an
// `opencode run` in a terminal stayed off /v1/sessions until New agent ran.
func TestAwaitOpenCodeStartsReaderWhenDatabaseAppears(t *testing.T) {
	// Keep the service streamer away from this machine's real OpenCode 2.
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	// Not t.TempDir: on Windows the reader may still hold the file open while
	// the directory is removed, which fails the test for no fault of its own.
	dir, err := os.MkdirTemp("", "caprock-oc-await-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	db := filepath.Join(dir, "opencode.db")

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	d := &Daemon{
		log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		opt: Options{OpenCodeDB: db, OpenCodeURL: "http://127.0.0.1:1"},
	}
	if d.startOpenCode(ctx) {
		t.Fatal("the reader started with no database")
	}
	go d.awaitOpenCode(ctx, 10*time.Millisecond)

	time.Sleep(50 * time.Millisecond)
	if d.openCodeIngester() != nil {
		t.Fatal("the reader started before the database existed")
	}

	// OpenCode 2.0.26's own tables, empty, written beside the final name and
	// renamed into place so the waiter never sees a half-made file.
	dump, err := os.ReadFile(filepath.Join("..", "opencode", "testdata", "opencode-2.0.26.sql"))
	if err != nil {
		t.Fatal(err)
	}
	tmp := db + ".new"
	w, err := sql.Open("sqlite", tmp)
	if err != nil {
		t.Fatal(err)
	}
	for _, stmt := range strings.Split(string(dump), ";\n") {
		if strings.HasPrefix(strings.TrimSpace(stmt), "CREATE TABLE") {
			if _, err := w.Exec(stmt); err != nil {
				t.Fatal(err)
			}
		}
	}
	_ = w.Close()
	if err := os.Rename(tmp, db); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for d.openCodeIngester() == nil {
		if time.Now().After(deadline) {
			t.Fatal("the reader did not start after the database appeared")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// "off" means off: the waiter gives up rather than polling forever.
func TestAwaitOpenCodeStopsWhenOff(t *testing.T) {
	d := &Daemon{
		log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		opt: Options{OpenCodeDB: "off"},
	}
	done := make(chan struct{})
	go func() { d.awaitOpenCode(context.Background(), time.Millisecond); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("awaitOpenCode kept polling with OpenCode turned off")
	}
}
