package cursor

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// TestLiveEditorDatabase reads the machine's own Cursor database into a
// throwaway store and prints what it found: the chats, Cursor's cost, and
// the first-request overhead by model. It opens the database immutable=1 —
// read-only, no lock, nothing written — and runs only when CAPROCK_CURSOR_LIVE
// is set, so CI and every other test never touch a real Cursor. It is how
// the figures in .ai/25-cursor.md were read.
func TestLiveEditorDatabase(t *testing.T) {
	if os.Getenv("CAPROCK_CURSOR_LIVE") == "" {
		t.Skip("set CAPROCK_CURSOR_LIVE=1 to read this machine's Cursor database")
	}
	path := DBPath()
	if path == "" {
		t.Skip("no Cursor database on this machine")
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=ro&immutable=1")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	defer db.Close()
	ctx := context.Background()
	lg := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	dir := os.Getenv("CAPROCK_CURSOR_LIVE_OUT")
	if dir == "" {
		dir = t.TempDir()
	}
	st, err := store.Open(ctx, filepath.Join(dir, "caprock.db"), lg)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	table, err := cost.Load("")
	if err != nil {
		t.Fatal(err)
	}
	rec := rollup.New(st, table, nil, lg)
	in := NewIngester(db, "", UserDir(), rec, lg, time.Minute)
	start := time.Now()
	if err := in.Once(ctx); err != nil {
		t.Fatal(err)
	}
	first := time.Since(start)
	start = time.Now()
	if err := in.Once(ctx); err != nil {
		t.Fatal(err)
	}
	t.Logf("first pass %s, second pass %s, stats %+v", first, time.Since(start), in.Stats())
	spend, err := store.CursorSpend(ctx, st.DB(), 0)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.MarshalIndent(spend, "", "  ")
	t.Logf("spend: %s", b)
	ov, err := store.ContextOverhead(ctx, st.DB(), 0)
	if err != nil {
		t.Fatal(err)
	}
	b, _ = json.MarshalIndent(ov, "", "  ")
	t.Logf("overhead: %s", b)
}
