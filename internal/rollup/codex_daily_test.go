package rollup

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

func dailyRow(t *testing.T, r *Recorder, day string) (int64, float64) {
	t.Helper()
	var tok int64
	var c float64
	if err := r.Store.DB().QueryRow(`SELECT SUM(tokens_total), SUM(cost_usd) FROM daily_stats WHERE day = ? AND model = 'gpt-5.6-sol'`, day).Scan(&tok, &c); err != nil {
		t.Fatal(err)
	}
	return tok, c
}

// The shape migrations 0022/0023 left behind: the Codex events were deleted
// and re-imported, daily_stats kept the first import too. The rebuild brings
// Codex's rows back to what the events say, leaves a day it cannot separate,
// leaves days retention may have pruned, and runs once.
func TestRebuildCodexDailyUndoesTheDoubleImport(t *testing.T) {
	r, _ := newRecorder(t)
	ctx := context.Background()
	rec := func(key, source, model string, at time.Time) {
		ev := event.Event{Ts: at, SessionID: "s-" + source, Source: event.Source(source), Kind: event.KindTurnAssistant, Model: model, Key: key,
			Tokens: &event.TokenDelta{In: 1_000_000}}
		if _, err := r.Record(ctx, &ev, SessionInfo{Cwd: "/repo", Agent: source}); err != nil {
			t.Fatal(err)
		}
	}
	d1 := time.Date(2026, 8, 27, 10, 0, 0, 0, time.UTC)
	d2 := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	old := time.Date(2026, 1, 5, 10, 0, 0, 0, time.UTC)
	rec("a", "codex", "gpt-5.6-sol", d1)
	rec("b", "codex", "gpt-5.6-sol", d2)
	rec("c", "opencode", "gpt-5.6-sol", d2) // another source, same model and day
	rec("d", "codex", "gpt-5.6-sol", old)
	want1, wantC1 := dailyRow(t, r, "2026-08-27")
	want2, wantC2 := dailyRow(t, r, "2026-08-30")
	wantOld, _ := dailyRow(t, r, "2026-01-05")

	// The stale first import, still in daily_stats.
	if _, err := r.Store.DB().Exec(`UPDATE daily_stats SET tokens_total = tokens_total * 2, cost_usd = cost_usd * 2 WHERE model = 'gpt-5.6-sol'`); err != nil {
		t.Fatal(err)
	}
	n, err := r.RebuildCodexDaily(ctx, time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC))
	if err != nil || n != 1 {
		t.Fatalf("rebuilt %d rows, err %v", n, err)
	}
	if tok, c := dailyRow(t, r, "2026-08-27"); tok != want1 || math.Abs(c-wantC1) > 1e-9 {
		t.Fatalf("Codex-only day: %d/%v, want %d/%v", tok, c, want1, wantC1)
	}
	if tok, c := dailyRow(t, r, "2026-08-30"); tok != 2*want2 || math.Abs(c-2*wantC2) > 1e-9 {
		t.Fatalf("mixed day was rewritten: %d/%v", tok, c)
	}
	if tok, _ := dailyRow(t, r, "2026-01-05"); tok != 2*wantOld {
		t.Fatalf("a day retention may have pruned was rewritten: %d", tok)
	}
	if done, _ := r.Store.GetMeta(ctx, store.MetaCodexDailyRebuilt); done != "1" {
		t.Fatal("marker not set")
	}
	if n, _ := r.RebuildCodexDaily(ctx, time.Time{}); n != 0 {
		t.Fatalf("ran twice: %d", n)
	}
}
