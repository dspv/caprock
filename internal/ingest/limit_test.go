package ingest

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// limitLine is the refusal as Claude Code 2.1.316 wrote it (2026-11-02),
// trimmed to the fields that matter; the shape is the real one.
const limitLine = `{"parentUuid":"p1","isSidechain":false,"type":"assistant","uuid":"u-lim","timestamp":"2026-11-02T09:11:00.471Z",` +
	`"apiError":"usage_limit_reached","apiErrorParams":{"rate_limit_info":{"status":"rejected","resetsAt":1793613600,"rateLimitType":"seven_day"}},` +
	`"quotaLimits":{"status":"rejected","resetsAt":1793613600,"unifiedRateLimitFallbackAvailable":false,"rateLimitType":"seven_day","overageStatus":"rejected"},` +
	`"error":"rate_limit","isApiErrorMessage":true,"apiErrorStatus":429,"sessionId":"s1","cwd":"/home/u/proj","version":"2.1.316",` +
	`"message":{"id":"d368c833","model":"<synthetic>","role":"assistant","type":"message","usage":{"input_tokens":0,"output_tokens":0},` +
	`"content":[{"type":"text","text":"You've hit your weekly limit · resets 12pm (Asia/Jerusalem)"}]}}`

func parseLimit(t *testing.T, raw string) (store.LimitHit, bool) {
	t.Helper()
	l, err := ParseLine([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return LimitHit(l, []byte(raw), time.Unix(0, 0))
}

func TestLimitHitReadsTheCurrentShape(t *testing.T) {
	hit, ok := parseLimit(t, limitLine)
	if !ok {
		t.Fatal("the refusal was not read as a limit")
	}
	at := time.Date(2026, 11, 2, 9, 11, 0, 471e6, time.UTC).UnixMilli()
	if hit.At != at || hit.ResetsAt != 1793613600*1000 || hit.Window != "seven_day" {
		t.Fatalf("hit = %+v", hit)
	}
}

// 2.1.285 had quotaLimits and no apiError; older versions put the reset in
// the text.
func TestLimitHitReadsOlderShapes(t *testing.T) {
	old := `{"type":"assistant","timestamp":"2026-10-04T12:18:01.116Z","error":"rate_limit","isApiErrorMessage":true,"sessionId":"s1",` +
		`"quotaLimits":{"status":"rejected","resetsAt":1791116400,"rateLimitType":"five_hour"},` +
		`"message":{"model":"<synthetic>","content":[{"type":"text","text":"You've hit your session limit · resets 3:20pm (Asia/Jerusalem)"}]}}`
	hit, ok := parseLimit(t, old)
	if !ok || hit.ResetsAt != 1791116400*1000 || hit.Window != "five_hour" {
		t.Fatalf("2.1.285: %+v %v", hit, ok)
	}
	legacy := `{"type":"assistant","timestamp":"2026-06-01T10:00:00Z","isApiErrorMessage":true,"sessionId":"s1",` +
		`"message":{"model":"<synthetic>","content":[{"type":"text","text":"Claude AI usage limit reached|1780308000"}]}}`
	hit, ok = parseLimit(t, legacy)
	if !ok || hit.ResetsAt != 1780308000*1000 || hit.Window != "" {
		t.Fatalf("legacy: %+v %v", hit, ok)
	}
}

func TestLimitHitIgnoresOtherErrorsAndRealReplies(t *testing.T) {
	for name, raw := range map[string]string{
		"auth": `{"type":"assistant","error":"authentication_failed","isApiErrorMessage":true,"sessionId":"s1",` +
			`"message":{"model":"<synthetic>","content":[{"type":"text","text":"Login expired · Please run /login"}]}}`,
		"overloaded": `{"type":"assistant","error":"server_error","isApiErrorMessage":true,"apiErrorStatus":529,"sessionId":"s1",` +
			`"message":{"model":"<synthetic>","content":[{"type":"text","text":"API Error: 529 Overloaded."}]}}`,
		"quoted by the model": `{"type":"assistant","sessionId":"s1","message":{"model":"claude-opus-5","id":"m","content":[{"type":"text",` +
			`"text":"Claude AI usage limit reached|1780308000 is what the old message said"}]}}`,
	} {
		if hit, ok := parseLimit(t, raw); ok {
			t.Errorf("%s: read as a limit: %+v", name, hit)
		}
	}
}

// The tailer sets the session's limit from the refusal and clears it when a
// real reply follows.
func TestTailerSetsAndClearsTheLimit(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	tl, st := newTailerAt(t, root)
	path := filepath.Join(root, "-home-u-proj", "s1.jsonl")
	writeTranscript(t, path, "s1")
	appendLine(t, path, limitLine)
	if err := tl.discover(nil); err != nil {
		t.Fatal(err)
	}
	tl.pass(ctx, false)
	s, err := store.GetSession(ctx, st.DB(), "s1")
	if err != nil {
		t.Fatal(err)
	}
	if s.LimitHit == nil || s.LimitHit.Window != "seven_day" || s.LimitHit.ResetsAt != 1793613600*1000 {
		t.Fatalf("limit_hit = %+v", s.LimitHit)
	}
	appendLine(t, path, `{"type":"assistant","uuid":"u-2","sessionId":"s1","cwd":"/home/u/proj","timestamp":"2026-11-02T10:00:00.000Z",`+
		`"message":{"model":"claude-opus-5","id":"m-2","role":"assistant","content":[{"type":"text","text":"back"}],"usage":{"input_tokens":1,"output_tokens":1}}}`)
	tl.pass(ctx, false)
	s, _ = store.GetSession(ctx, st.DB(), "s1")
	if s.LimitHit != nil {
		t.Fatalf("a reply after the limit must clear it: %+v", s.LimitHit)
	}
}

// A tailer that starts mid-file (a restart) and reads a reply older than the
// stored limit leaves the limit alone.
func TestAnOlderReplyDoesNotClearANewerLimit(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := store.UpsertSession(ctx, st.DB(), "s1", store.SessionPatch{Cwd: "/r"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetLimitHit(ctx, st.DB(), "s1", store.LimitHit{At: 2000, ResetsAt: 9000, Window: "five_hour"}); err != nil {
		t.Fatal(err)
	}
	if cleared, _ := store.ClearLimitHit(ctx, st.DB(), "s1", 1000); cleared {
		t.Fatal("an older reply cleared a newer limit")
	}
	if err := store.SetLimitHit(ctx, st.DB(), "s1", store.LimitHit{At: 1500}); err != nil {
		t.Fatal(err)
	}
	s, _ := store.GetSession(ctx, st.DB(), "s1")
	if s.LimitHit == nil || s.LimitHit.At != 2000 {
		t.Fatalf("an older refusal replaced a newer one: %+v", s.LimitHit)
	}
	if cleared, _ := store.ClearLimitHit(ctx, st.DB(), "s1", 2500); !cleared {
		t.Fatal("a newer reply did not clear the limit")
	}
}

func appendLine(t *testing.T, path, line string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	if _, err := f.WriteString(line + "\n"); err != nil {
		t.Fatal(err)
	}
}
