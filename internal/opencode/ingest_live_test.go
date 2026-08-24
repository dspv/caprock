package opencode

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// TestIngestLive imports whatever OpenCode database is on this machine into a
// throwaway Caprock store. It is the check that matters: the schema claims are
// verified against real data rather than a fixture written from the same
// assumptions as the code.
func TestIngestLive(t *testing.T) {
	p := DBPath()
	if p == "" {
		t.Skip("no OpenCode database on this machine")
	}
	src, err := Open(p)
	if err != nil {
		t.Fatalf("open opencode: %v", err)
	}
	defer src.Close()

	dir := t.TempDir()
	lg := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	st, err := store.Open(context.Background(), filepath.Join(dir, "caprock.db"), lg)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	table, err := cost.Load("")
	if err != nil {
		t.Fatalf("pricing: %v", err)
	}
	rec := rollup.New(st, table, nil, lg)

	in := NewIngester(src, rec, lg, time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	if err := in.once(ctx); err != nil {
		t.Fatalf("ingest: %v", err)
	}
	t.Logf("imported: %d sessions, %d events", in.Stats().Sessions, in.Stats().Events)

	var sessions, events int
	var cost float64
	row := st.DB().QueryRowContext(ctx,
		`SELECT COUNT(*), COALESCE(SUM(cost_usd),0) FROM events WHERE source='opencode'`)
	if err := row.Scan(&events, &cost); err != nil {
		t.Fatalf("scan events: %v", err)
	}
	if err := st.DB().QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sessions WHERE agent='opencode'`).Scan(&sessions); err != nil {
		t.Fatalf("scan sessions: %v", err)
	}
	t.Logf("in store: %d sessions tagged opencode, %d events, $%.2f", sessions, events, cost)

	if sessions == 0 {
		t.Fatal("no session was tagged as opencode; the agent column is not being written")
	}
	if events == 0 {
		t.Fatal("no events stored")
	}
	if cost == 0 {
		t.Error("total cost is zero; OpenCode's own cost figures are not being carried across")
	}

	// Per-repository attribution is the headline feature; it must have data.
	rows, err := st.DB().QueryContext(ctx, `
		SELECT s.project, ROUND(SUM(e.cost_usd),2) c
		FROM events e JOIN sessions s USING(session_id)
		WHERE e.source='opencode' AND s.project IS NOT NULL
		GROUP BY s.project ORDER BY c DESC LIMIT 3`)
	if err != nil {
		t.Fatalf("per-repo: %v", err)
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var proj string
		var c float64
		if err := rows.Scan(&proj, &c); err != nil {
			t.Fatal(err)
		}
		t.Logf("  %s: $%.2f", proj, c)
		n++
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("per-repo rows: %v", err)
	}
	if n == 0 {
		t.Error("no per-repository rows; attribution would be empty on the Cost screen")
	}

	// A second pass must store nothing new: re-reading is how the poller works.
	before := in.Stats().Events
	in.seen = map[string]int64{}
	if err := in.once(ctx); err != nil {
		t.Fatalf("second pass: %v", err)
	}
	if in.Stats().Events != before {
		t.Errorf("second pass stored %d new events; ingest is not idempotent",
			in.Stats().Events-before)
	}
}
