//go:build smoke

package smoke

import (
	"context"
	"database/sql"
	"net"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/daemon"
	"github.com/dspv/caprock/internal/store"
)

func TestTheMoveComesBeforeTheFill(t *testing.T) {
	dataDir := t.TempDir()
	path := config.DBPath(dataDir)
	st, err := store.Open(context.Background(), path, nil)
	if err != nil {
		t.Fatal(err)
	}
	// What the migration leaves on a database that had 1,501 tool calls: the
	// newest moved, the rest in the old shape, their fields never filled.
	for _, stmt := range []string{
		`INSERT INTO sessions(session_id, started_at, last_event_at, status) VALUES ('s', 1, 1501, 'ended')`,
		`CREATE TABLE events_legacy (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, session_id TEXT NOT NULL,
			source TEXT NOT NULL, kind TEXT NOT NULL, tool TEXT, payload TEXT NOT NULL, tokens_in INTEGER,
			tokens_out INTEGER, cache_read INTEGER, cache_write INTEGER, cost_usd REAL, key TEXT, model TEXT,
			cache_write_1h INTEGER, agent_id TEXT, msg_id TEXT, touch_dir TEXT, tool_bytes INTEGER NOT NULL DEFAULT 0,
			internal INTEGER NOT NULL DEFAULT 0, inner_tool TEXT)`,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500)
		 INSERT INTO events_legacy(id, ts, session_id, source, kind, tool, payload, key)
		   SELECT i, i, 's', 'hook', 'tool.pre', 'Bash', '{"tool_input":{"command":"go test"}}', 'pre:' || i FROM n`,
		`INSERT INTO events(id, ts, sid, source, kind, tool, payload, key)
		   SELECT 1501, 1501, sid, 'hook', 'tool.pre', 'Bash', '{"tool_input":{"command":"go vet"}}', 'pre:1501' FROM sessions`,
		`INSERT INTO meta(k, v) VALUES ('events_move_total', 1501), ('events_moved', 1)`,
		`DELETE FROM tool_fields`,
		`DELETE FROM meta WHERE k IN ('tool_fields_version', 'tool_fields_pending')`,
	} {
		if _, err := st.DB().Exec(stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	_ = st.Close()

	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan string, 1)
	done := make(chan error, 1)
	go func() {
		done <- daemon.Run(ctx, daemon.Options{DataDir: dataDir, Config: config.Defaults(), Version: "smoke", Listener: ln, DisableIngest: true, OnReady: func(u string) { ready <- u }})
	}()
	stopped := false
	t.Cleanup(func() {
		cancel()
		if !stopped {
			<-done
		}
	})
	select {
	case <-ready:
	case err := <-done:
		stopped = true
		t.Fatalf("daemon exited: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("daemon did not start")
	}

	// Read beside the daemon without a Store, whose Open would end a move
	// it found empty under the daemon's feet.
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	deadline := time.After(20 * time.Second)
	for {
		var legacy int
		var pending string
		_ = db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE name = 'events_legacy'`).Scan(&legacy)
		_ = db.QueryRow(`SELECT COALESCE((SELECT v FROM meta WHERE k = 'tool_fields_pending'), '')`).Scan(&pending)
		if legacy == 0 && pending == "0" {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("not done: events_legacy %d, tool_fields_pending %q", legacy, pending)
		case <-time.After(100 * time.Millisecond):
		}
	}
	var events, fields int
	if err := db.QueryRow(`SELECT (SELECT COUNT(*) FROM events), (SELECT COUNT(*) FROM tool_fields)`).Scan(&events, &fields); err != nil {
		t.Fatal(err)
	}
	if events != 1501 || fields != 1501 {
		t.Fatalf("%d events and %d with fields, want 1501 of each", events, fields)
	}
}
