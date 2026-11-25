package ingest

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// overloadedLine is an API error that ended a turn once Claude Code's own
// retries were spent, in the shape of the usage-limit line (limit.go) with
// the error Claude Code's StopFailure hook names for an overload.
const overloadedLine = `{"parentUuid":"p1","isSidechain":false,"type":"assistant","uuid":"u-err","timestamp":"2026-11-25T09:11:00.471Z",` +
	`"error":"server_error","isApiErrorMessage":true,"apiErrorStatus":529,"sessionId":"s1","cwd":"/home/u/proj","version":"2.1.330",` +
	`"message":{"id":"e1","model":"<synthetic>","role":"assistant","type":"message","usage":{"input_tokens":0,"output_tokens":0},` +
	`"content":[{"type":"text","text":"API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"}]}}`

func synthetic(fields, text string) string {
	return `{"type":"assistant","timestamp":"2026-11-25T10:00:00Z","sessionId":"s1",` + fields +
		`"message":{"model":"<synthetic>","content":[{"type":"text","text":"` + text + `"}]}}`
}

func parseAPIError(t *testing.T, raw string) (store.APIError, bool) {
	t.Helper()
	l, err := ParseLine([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return APIErrorLine(l, []byte(raw), time.Unix(0, 0))
}

func TestClassifyAPIError(t *testing.T) {
	for _, c := range []struct {
		name   string
		field  string
		status int
		text   string
		retry  bool
	}{
		{"overloaded 529", "server_error", 529, "API Error: 529 Overloaded.", true},
		{"500 in the text only", "", 0, "API Error: 500 Internal server error", true},
		{"502 bad gateway", "unknown", 502, "API Error: 502 Bad Gateway", true},
		{"timeout", "unknown", 0, "API Error: Request timed out.", true},
		{"network", "", 0, "API Error: Connection error.", true},
		{"socket", "", 0, "API Error: socket hang up", true},
		{"408", "", 408, "API Error: 408", true},
		{"usage limit", "rate_limit", 429, "You've hit your session limit", false},
		{"429 rate limit", "", 429, "API Error: 429 rate_limit_error", false},
		{"auth", "authentication_failed", 401, "Invalid API key · Please run /login", false},
		{"billing", "billing_error", 400, "Credit balance is too low", false},
		{"prompt too long", "invalid_request", 400, "Prompt is too long", false},
		{"prompt too long on a 5xx field", "server_error", 0, "API Error: prompt is too long: 210000 tokens > 200000 maximum", false},
		{"400", "", 400, "API Error: 400 something odd", false},
		{"404 model", "", 0, "API Error: 404 model not found", false},
		{"max output", "max_output_tokens", 0, "Response exceeded the output token maximum", false},
		{"unknown and unplaced", "unknown", 0, "Something happened", false},
	} {
		if got := ClassifyAPIError(c.field, c.status, c.text); got != c.retry {
			t.Errorf("%s: retryable = %v, want %v", c.name, got, c.retry)
		}
	}
}

func TestAPIErrorLineReadsTheErrorThatEndedTheTurn(t *testing.T) {
	e, ok := parseAPIError(t, overloadedLine)
	if !ok || !e.Retryable {
		t.Fatalf("overloaded: %+v %v", e, ok)
	}
	at := time.Date(2026, 11, 25, 9, 11, 0, 471e6, time.UTC).UnixMilli()
	if e.At != at || e.Reason != "529 Overloaded" {
		t.Fatalf("error = %+v", e)
	}
	e, ok = parseAPIError(t, synthetic(`"error":"authentication_failed","isApiErrorMessage":true,`, "Invalid API key · Please run /login"))
	if !ok || e.Retryable {
		t.Fatalf("auth: %+v %v", e, ok)
	}
	if e, ok = parseAPIError(t, synthetic(`"isApiErrorMessage":true,`, "API Error: 529 Overloaded.")); !ok || !e.Retryable || e.Reason != "529 Overloaded" {
		t.Fatalf("plain: %+v %v", e, ok)
	}
}

// A usage limit is the limit flow's, a real reply that quotes an error is
// not one, and nothing Claude Code writes while it still retries is either.
func TestAPIErrorLineIgnoresLimitsRepliesAndRetries(t *testing.T) {
	for name, raw := range map[string]string{
		"usage limit": limitLine,
		"quoted by the model": `{"type":"assistant","sessionId":"s1","message":{"model":"claude-opus-5","id":"m","content":[{"type":"text",` +
			`"text":"API Error: 529 Overloaded is what you saw"}]}}`,
		"retrying": `{"type":"system","subtype":"api_error","level":"error","sessionId":"s1","timestamp":"2026-11-25T09:10:00Z",` +
			`"retryAttempt":2,"maxRetries":10,"retryInMs":1200,"error":{"status":529}}`,
		"synthetic, not an error": synthetic(``, "No response requested."),
	} {
		if e, ok := parseAPIError(t, raw); ok {
			t.Errorf("%s: read as an API error: %+v", name, e)
		}
	}
}

// The tailer sets the session's API error from the line and clears it when
// a real reply follows; a resume in flight becomes "recovered".
func TestTailerSetsAndClearsTheAPIError(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	tl, st := newTailerAt(t, root)
	path := filepath.Join(root, "-home-u-proj", "s1.jsonl")
	writeTranscript(t, path, "s1")
	appendLine(t, path, overloadedLine)
	if err := tl.discover(nil); err != nil {
		t.Fatal(err)
	}
	tl.pass(ctx, false)
	s, err := store.GetSession(ctx, st.DB(), "s1")
	if err != nil {
		t.Fatal(err)
	}
	if s.APIError == nil || !s.APIError.Retryable || s.APIError.At == 0 || s.LimitHit != nil {
		t.Fatalf("api_error = %+v, limit = %+v", s.APIError, s.LimitHit)
	}
	if ok, err := store.SetAPIResume(ctx, st.DB(), "s1", s.APIError.At, store.ResumeResumed, 1, s.APIError.At+60_000); err != nil || !ok {
		t.Fatalf("set resume: %v %v", ok, err)
	}
	appendLine(t, path, `{"type":"assistant","uuid":"u-2","sessionId":"s1","cwd":"/home/u/proj","timestamp":"2026-11-25T09:13:00.000Z",`+
		`"message":{"model":"claude-opus-5","id":"m-2","role":"assistant","content":[{"type":"text","text":"back"}],"usage":{"input_tokens":1,"output_tokens":1}}}`)
	tl.pass(ctx, false)
	s, _ = store.GetSession(ctx, st.DB(), "s1")
	if s.APIError == nil || s.APIError.At != 0 || s.APIError.Resume != store.ResumeRecovered || s.APIError.Tries != 1 {
		t.Fatalf("after the reply: %+v", s.APIError)
	}
}
