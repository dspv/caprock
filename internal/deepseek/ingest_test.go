package deepseek

import (
	"context"
	"database/sql"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
	"github.com/klauspost/compress/zstd"
)

// ingestFixture is a session with one priced turn, one tool call and one user
// prompt, so the ingester's three record paths are exercised end to end.
const ingestFixture = `{"type":"session","version":3,"id":"session-ingest","createdAt":1789135258998,"cwd":"/home/u/proj","isSeeded":false,"agentPreset":"standard"}
{"type":"user/message","seq":8,"time":1789135308420,"data":{"content":[{"type":"text","text":"what is in this repo"}]}}
{"type":"assistant/message","seq":16,"time":1789135312847,"data":{"message":{"role":"assistant","content":[{"type":"text","text":"it has a Go module"}],"source":{"kind":"model","model":"deepseek-v4-pro"}},"usage":{"inputTokens":1904,"outputTokens":250,"totalTokens":13034,"cacheReadTokens":10880,"reasoningTokens":114}}}
{"type":"tool/call","seq":17,"time":1789135312848,"data":{"turn":1,"step":1,"callId":"c1","name":"bash","arguments":"{\"command\":\"ls\"}"}}
`

func newIngestHarness(t *testing.T) (context.Context, *Ingester, *store.Store, string) {
	t.Helper()
	ctx := context.Background()
	lg := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "caprock.db"), lg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	table, err := cost.Load("")
	if err != nil {
		t.Fatal(err)
	}
	rec := rollup.New(st, table, nil, lg)
	dir := t.TempDir()
	return ctx, NewIngester(dir, rec, lg, time.Second), st, dir
}

// writeSessionFile compresses content into dir/sessions/ws/session.v3.jsonl.zstd.
func writeSessionFile(t *testing.T, dir, content string) {
	t.Helper()
	sub := filepath.Join(dir, "sessions", "ws")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(filepath.Join(sub, "session.v3.jsonl.zstd"))
	if err != nil {
		t.Fatal(err)
	}
	enc, err := zstd.NewWriter(f)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := enc.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if err := enc.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestIngestRecordsTurnsToolsAndUsers(t *testing.T) {
	ctx, in, st, dir := newIngestHarness(t)
	writeSessionFile(t, dir, ingestFixture)
	if err := in.once(ctx); err != nil {
		t.Fatal(err)
	}

	// One assistant turn, priced by our table from DSH's own token counts.
	var turns, tools, users int
	if err := st.DB().QueryRowContext(ctx,
		`SELECT COUNT(*) FROM events WHERE kind = 'turn.assistant' AND source = 'deepseek'`).Scan(&turns); err != nil {
		t.Fatal(err)
	}
	if err := st.DB().QueryRowContext(ctx,
		`SELECT COUNT(*) FROM events WHERE kind = 'tool.pre' AND source = 'deepseek'`).Scan(&tools); err != nil {
		t.Fatal(err)
	}
	if err := st.DB().QueryRowContext(ctx,
		`SELECT COUNT(*) FROM events WHERE kind = 'turn.user' AND source = 'deepseek'`).Scan(&users); err != nil {
		t.Fatal(err)
	}
	if turns != 1 || tools != 1 || users != 1 {
		t.Fatalf("turns=%d tools=%d users=%d, want 1/1/1", turns, tools, users)
	}

	// The token delta is taken straight through: fresh input, cache read and
	// output are already separate in DSH's usage.
	var tin, tout, tcr, tcw int64
	if err := st.DB().QueryRowContext(ctx,
		`SELECT COALESCE(tokens_in,0), COALESCE(tokens_out,0), COALESCE(cache_read,0), COALESCE(cache_write,0)
		   FROM events WHERE kind = 'turn.assistant' AND source = 'deepseek'`).Scan(&tin, &tout, &tcr, &tcw); err != nil {
		t.Fatal(err)
	}
	if tin != 1904 || tout != 250 || tcr != 10880 || tcw != 0 {
		t.Fatalf("tokens in/out/cr/cw = %d/%d/%d/%d, want 1904/250/10880/0", tin, tout, tcr, tcw)
	}

	// The turn is priced (deepseek-v4-pro is in the table), so cost is non-zero.
	var costUSD float64
	if err := st.DB().QueryRowContext(ctx,
		`SELECT COALESCE(cost_usd,0) FROM events WHERE kind = 'turn.assistant' AND source = 'deepseek'`).Scan(&costUSD); err != nil {
		t.Fatal(err)
	}
	if costUSD <= 0 {
		t.Fatalf("turn was not priced: cost=%v", costUSD)
	}

	// A re-poll over the unchanged file is a no-op — the seq-derived keys are
	// idempotent.
	if err := in.once(ctx); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := st.DB().QueryRowContext(ctx, `SELECT COUNT(*) FROM events WHERE source = 'deepseek'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Fatalf("events after re-poll = %d, want 3", n)
	}
}

func TestIngestIgnoresSessionsWithNoModel(t *testing.T) {
	ctx, in, st, dir := newIngestHarness(t)
	content := `{"type":"session","version":3,"id":"s-nomodel","createdAt":1789135258998,"cwd":"/home/u/proj"}
{"type":"assistant/message","seq":6,"time":1789135312847,"data":{"message":{"content":[{"type":"text","text":"hi"}]},"usage":{"inputTokens":100,"outputTokens":10}}}
`
	writeSessionFile(t, dir, content)
	if err := in.once(ctx); err != nil {
		t.Fatal(err)
	}
	// The turn is stored with its tokens but no model, and reported unpriced —
	// rule 6 prefers a missing number to an invented one.
	var model string
	var costUSD sql.NullFloat64
	if err := st.DB().QueryRowContext(ctx,
		`SELECT COALESCE(model,''), cost_usd FROM events WHERE kind='turn.assistant' AND source='deepseek'`).Scan(&model, &costUSD); err != nil {
		t.Fatal(err)
	}
	if model != "" || costUSD.Valid {
		t.Fatalf("model=%q cost=%v, want empty model and no cost", model, costUSD)
	}
	if st := in.Stats(); st.Unpriced != 1 {
		t.Fatalf("unpriced = %d, want 1", st.Unpriced)
	}
}
