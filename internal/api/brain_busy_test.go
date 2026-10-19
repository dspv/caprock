package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"runtime"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// fileServer is a server on a database file, so writers lock it the way the
// daemon's do (the shared in-memory database locks tables instead).
func fileServer(t *testing.T) (*Server, *rollup.Recorder, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "c.db")
	st, err := store.Open(context.Background(), path, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	tb, _ := cost.Embedded()
	b := bus.New()
	rec := rollup.New(st, tb, b, nil)
	s := New(Deps{Store: st, Bus: b, Table: tb, Version: "test", Token: "tok", Now: time.Now})
	return s, rec, path
}

// Memories kept while a backfill imports many transcripts at once all land.
// On the measuring stand (2026-10-19) 252 of 300 answered 500 SQLITE_BUSY.
func TestABrainWriteDuringABackfillSucceeds(t *testing.T) {
	s, rec, _ := fileServer(t)
	ctx, stop := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	for g := 0; g < 6; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			b := rec.Batch(ctx)
			defer b.Abort()
			for i := 0; ctx.Err() == nil; i++ {
				session := fmt.Sprintf("backfill-%d", g)
				ev := &event.Event{
					Ts: time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC).Add(time.Duration(i) * time.Millisecond), SessionID: session,
					Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
					Key: fmt.Sprintf("msg:%s-%d", session, i), MsgID: fmt.Sprintf("%s-%d", session, i),
					Model: "claude-opus-4-1", Tokens: &event.TokenDelta{In: 10, Out: 5},
				}
				if _, err := b.Record(ctx, ev, rollup.SessionInfo{Cwd: "/p"}); err != nil {
					return
				}
				if b.Due() {
					if _, _, err := b.Flush(); err != nil {
						return
					}
				}
			}
		}(g)
	}
	defer func() {
		stop()
		wg.Wait()
	}()
	time.Sleep(100 * time.Millisecond)
	for i := 0; i < 30; i++ {
		start := time.Now()
		rr := inboxDo(t, s, http.MethodPost, "/v1/brain/nodes", map[string]any{
			"kind": "decision", "text": fmt.Sprintf("Memory %d kept during the backfill", i), "project": "caprock", "topics": []string{"storage"},
		})
		if rr.Code != http.StatusOK {
			t.Fatalf("memory %d: %d %s", i, rr.Code, rr.Body.String())
		}
		// Windows runners are slower at a write under contention: the first
		// one took 2.4 s there (2026-10-19) against well under a second here.
		limit := time.Second
		if runtime.GOOS == "windows" {
			limit = 5 * time.Second
		}
		if d := time.Since(start); d > limit {
			t.Fatalf("memory %d waited %v for the database", i, d)
		}
	}
}

// When a write still finds the database busy, the answer says so with a 503
// the dashboard retries, not a bare 500.
func TestABusyDatabaseAnswers503(t *testing.T) {
	s, _, path := fileServer(t)
	ctx := context.Background()
	conn, err := s.d.Store.DB().Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `BEGIN IMMEDIATE`); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = conn.ExecContext(ctx, `ROLLBACK`) }()
	// A second handle that does not wait gives the error at once.
	other, err := sql.Open("sqlite", "file:"+path+"?_txlock=immediate&_pragma=busy_timeout(0)")
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	_, busy := other.ExecContext(ctx, `INSERT INTO meta(k, v) VALUES('x', 'y')`)
	if !store.IsBusy(busy) {
		t.Fatalf("expected a busy error, got %v", busy)
	}
	rr := httptest.NewRecorder()
	s.fail(rr, fmt.Errorf("insert brain node: %w", busy))
	if rr.Code != http.StatusServiceUnavailable || rr.Header().Get("Retry-After") == "" {
		t.Fatalf("got %d, Retry-After %q", rr.Code, rr.Header().Get("Retry-After"))
	}
	var body map[string]string
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	if body["error"] == "" || body["detail"] == "" {
		t.Fatalf("the answer does not say what happened: %v", body)
	}
}
