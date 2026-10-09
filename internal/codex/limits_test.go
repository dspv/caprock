package codex

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// Archiving a thread renames its rollout into archived_sessions/. The session
// must stay counted once — not lost, not doubled — and the moved file must
// not be parsed again.
func TestAnArchivedTranscriptIsNeitherLostNorDoubled(t *testing.T) {
	h := newHarness(t)
	h.put()
	h.poll()
	const events = `SELECT COUNT(*) FROM events WHERE source='codex'`
	const cost = `SELECT CAST(SUM(cost_usd)*1e9 AS INTEGER) FROM events WHERE source='codex'`
	before, costBefore := count(t, h.out, events), count(t, h.out, cost)

	if err := os.MkdirAll(h.archived, 0o755); err != nil {
		t.Fatal(err)
	}
	to := filepath.Join(h.archived, "rollout-a.jsonl")
	if err := os.Rename(filepath.Join(h.dir, "2026", "09", "06", "rollout-a.jsonl"), to); err != nil {
		t.Fatal(err)
	}
	h.poll()
	if n := count(t, h.out, events); n != before {
		t.Fatalf("archiving changed the event count: %d, want %d", n, before)
	}
	if c := count(t, h.out, cost); c != costBefore {
		t.Fatalf("archiving changed the cost: %d, want %d", c, costBefore)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM sessions WHERE agent='codex'`); n != 1 {
		t.Fatalf("%d codex sessions after archiving, want 1", n)
	}
	if st := h.in.Stats(); st.Sessions != 1 {
		t.Fatalf("transcripts read after a move: %d, want 1", st.Sessions)
	}
	h.in.mu.Lock()
	_, carried := h.in.seen[to]
	h.in.mu.Unlock()
	if !carried {
		t.Fatal("the moved file was not recognised as already read")
	}
}

// A transcript that only ever lived in archived_sessions/ — archived before
// Caprock was installed — is imported like any other.
func TestATranscriptArchivedBeforeInstallIsImported(t *testing.T) {
	h := newHarness(t)
	b, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(h.archived, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(h.archived, "rollout-a.jsonl"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	h.poll()
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='codex'`); n != 6 {
		t.Fatalf("archived transcript: %d events, want 6", n)
	}
}

// writeLimits writes a minimal transcript whose only token_count carries rl.
func (h *harness) writeLimits(name, id, ts, rl string) {
	h.t.Helper()
	src := `{"timestamp":"` + ts + `","type":"session_meta","payload":{"id":"` + id + `","cwd":"/Users/dev/proj"}}` + "\n" +
		`{"timestamp":"` + ts + `","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":` + rl + `}}` + "\n"
	sub := filepath.Join(h.dir, "2026", "10", "01")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		h.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, name), []byte(src), 0o600); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) codexLimits() map[string][2]float64 {
	h.t.Helper()
	got, err := store.RateLimitsWithPrefix(context.Background(), h.out, store.CodexRateLimitPrefix)
	if err != nil {
		h.t.Fatal(err)
	}
	out := map[string][2]float64{}
	for _, s := range got {
		out[s.Window] = [2]float64{s.UsedPercentage, float64(s.ResetsAt)}
	}
	return out
}

// Real rate_limits records from the owner's machine (2026-10-01), trimmed.
const (
	plusLimits    = `{"limit_id":"codex","limit_name":null,"primary":{"used_percent":16.0,"window_minutes":300,"resets_at":1789482335},"secondary":{"used_percent":11.0,"window_minutes":10080,"resets_at":1789833741},"plan_type":"plus"}`
	proliteLimits = `{"limit_id":"codex","limit_name":null,"primary":{"used_percent":5.0,"window_minutes":10080,"resets_at":1791067416},"secondary":null,"plan_type":"prolite"}`
)

// The latest sample is stored as Codex's windows, beside — never over —
// Claude Code's rows, and a newer sample replaces the whole set: a plan with
// no five-hour window must not keep showing the old plan's.
func TestPlanLimitsAreStoredAsCodexsAndReplacedAsASet(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	if err := store.RecordRateLimit(ctx, h.out, store.RateLimitSnapshot{Window: "five_hour", Ts: 1, UsedPercentage: 77}, "claude-session"); err != nil {
		t.Fatal(err)
	}
	h.writeLimits("rollout-1.jsonl", "s-1", "2026-09-14T12:00:00.000Z", plusLimits)
	h.poll()
	got := h.codexLimits()
	if got["five_hour"] != [2]float64{16, 1789482335} || got["seven_day"] != [2]float64{11, 1789833741} {
		t.Fatalf("plus windows: %+v", got)
	}

	h.writeLimits("rollout-2.jsonl", "s-2", "2026-10-01T12:06:17.317Z", proliteLimits)
	h.poll()
	got = h.codexLimits()
	if len(got) != 1 || got["seven_day"] != [2]float64{5, 1791067416} {
		t.Fatalf("after the plan change: %+v, want only the weekly window", got)
	}

	// An older sample read later (a transcript touched out of order) does not
	// win over a newer one.
	h.writeLimits("rollout-3.jsonl", "s-3", "2026-09-20T00:00:00.000Z", plusLimits)
	h.poll()
	if got = h.codexLimits(); len(got) != 1 {
		t.Fatalf("an older sample replaced a newer one: %+v", got)
	}

	// Claude Code's own row is untouched.
	snap, ok, err := store.LatestRateLimit(ctx, h.out, "five_hour")
	if err != nil || !ok || snap.UsedPercentage != 77 {
		t.Fatalf("Claude Code's window disturbed: %+v %v %v", snap, ok, err)
	}
}

// Transcripts read by an earlier version are not parsed again, so the first
// pass after an upgrade reads the newest one for its limits.
func TestLimitsAreBackfilledFromTranscriptsAlreadyRead(t *testing.T) {
	h := newHarness(t)
	h.writeLimits("rollout-1.jsonl", "s-1", "2026-10-01T12:06:17.317Z", proliteLimits)
	h.poll()
	if _, err := h.out.Exec(`DELETE FROM rate_limit_latest`); err != nil {
		t.Fatal(err)
	}
	restarted := NewIngester(h.in.dirs, h.in.rec, h.in.log, time.Second)
	restarted.seen = h.in.seen // everything already read, as restoreSeen would find it
	if err := restarted.once(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := h.codexLimits(); got["seven_day"] != [2]float64{5, 1791067416} {
		t.Fatalf("limits not backfilled: %+v", got)
	}
}

// An unknown window length or an implausible figure is dropped, not labelled.
func TestLimitSnapshotsDropWhatTheyCannotName(t *testing.T) {
	at := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	got := limitSnapshots(&Limits{At: at, Windows: []LimitWindow{
		{Minutes: 60, UsedPercent: 10},
		{Minutes: 300, UsedPercent: 140},
		{Minutes: 10080, UsedPercent: 5, ResetsAt: at.Unix() + 30*24*3600},
		{Minutes: 10080, UsedPercent: 5, ResetsAt: at.Unix() + 3600},
	}})
	if len(got) != 1 || got[0].Window != "seven_day" || got[0].Ts != at.UnixMilli() {
		t.Fatalf("snapshots: %+v", got)
	}
}
