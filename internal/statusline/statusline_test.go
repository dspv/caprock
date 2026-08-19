package statusline

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/config"
)

// The command prints a status line from the stdin JSON and never fails — malformed
// input, empty input, and missing rate_limits all produce clean output/exit.
func TestRenderFromStdin(t *testing.T) {
	in := `{"session_id":"s1","model":{"display_name":"Opus"},"context_window":{"used_percentage":8},` +
		`"cost":{"total_cost_usd":0.012},"rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1900000000}}}`
	var out bytes.Buffer
	Run(strings.NewReader(in), &out)
	got := out.String()
	for _, want := range []string{"Opus", "ctx 8%", "$0.012", "5h", "24", "resets"} {
		if !strings.Contains(got, want) {
			t.Fatalf("status line missing %q: %q", want, got)
		}
	}
}

func TestNoRateLimitsStillRenders(t *testing.T) {
	var out bytes.Buffer
	Run(strings.NewReader(`{"model":{"display_name":"Sonnet"},"context_window":{"used_percentage":3}}`), &out)
	got := out.String()
	if !strings.Contains(got, "Sonnet") || strings.Contains(got, "5h") {
		t.Fatalf("unexpected line without rate limits: %q", got)
	}
}

func TestMalformedAndEmptyInputAreSafe(t *testing.T) {
	var out bytes.Buffer
	Run(strings.NewReader("not json at all"), &out) // must not panic
	if out.Len() != 0 {
		t.Fatalf("malformed input produced output: %q", out.String())
	}
	out.Reset()
	Run(strings.NewReader(""), &out) // empty stdin
	if out.Len() != 0 {
		t.Fatalf("empty stdin produced output: %q", out.String())
	}
}

// Colour thresholds: >85 red, 60–85 amber, else green.
func TestColorThresholds(t *testing.T) {
	cases := map[float64]string{20: "32", 70: "33", 95: "31"}
	for pct, code := range cases {
		got := colorPct("5h", pct)
		if !strings.Contains(got, "\x1b["+code+"m") {
			t.Fatalf("pct %.0f: want SGR %s, got %q", pct, code, got)
		}
	}
}

// A 5-hour window without resets_at must not leave a trailing space that turns
// the " · " separator into a double space.
func TestRenderNoTrailingSpaceWithoutReset(t *testing.T) {
	var in input
	if err := json.Unmarshal([]byte(`{"rate_limits":{"five_hour":{"used_percentage":40},"seven_day":{"used_percentage":20}}}`), &in); err != nil {
		t.Fatal(err)
	}
	out := render(in)
	if strings.Contains(out, "  ") {
		t.Fatalf("double space in render output: %q", out)
	}
}

// resetIn is empty for a missing/zero/negative reset time, and formatted otherwise.
func TestResetIn(t *testing.T) {
	if resetIn(0) != "" || resetIn(-5) != "" {
		t.Fatal("resetIn should be empty for non-positive input")
	}
	if got := resetIn(1_000_000_000); !strings.HasPrefix(got, "resets ") {
		t.Fatalf("resetIn format: %q", got)
	}
}

// post forwards only the whitelisted rate-limit windows to the daemon, with the
// bearer token, and is fire-and-forget. This exercises the happy path and, more
// importantly, asserts the whitelist: no prompt/model/cost content is ever sent.
func TestPostForwardsWhitelistedBodyWithAuth(t *testing.T) {
	var gotAuth, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	// Point the statusline at a data dir whose runtime.json names the test server.
	dir := t.TempDir()
	t.Setenv(config.EnvDataDir, dir)
	port, _ := strconv.Atoi(strings.TrimPrefix(srv.URL, "http://127.0.0.1:"))
	rt, err := config.NewRuntime(port, "test")
	if err != nil {
		t.Fatal(err)
	}
	if err := config.WriteRuntime(dir, rt); err != nil {
		t.Fatal(err)
	}

	post(forward{
		SessionID: "sess-1",
		FiveHour:  &window{UsedPercentage: 42, ResetsAt: 1_900_000_000},
	})

	if !strings.HasPrefix(gotAuth, "Bearer ") || !strings.Contains(gotAuth, rt.Token) {
		t.Fatalf("auth header wrong: %q", gotAuth)
	}
	if !strings.Contains(gotBody, "sess-1") || !strings.Contains(gotBody, "five_hour") || !strings.Contains(gotBody, "42") {
		t.Fatalf("body missing whitelisted fields: %q", gotBody)
	}
	// The whitelist is a promise: no room for prompt/model/cost content.
	for _, forbidden := range []string{"prompt", "model", "cost", "display_name"} {
		if strings.Contains(gotBody, forbidden) {
			t.Fatalf("forbidden field %q leaked into the forwarded body: %q", forbidden, gotBody)
		}
	}
}

// post must not panic or block when the daemon is down (no runtime.json).
func TestPostSilentWhenDaemonDown(t *testing.T) {
	t.Setenv(config.EnvDataDir, t.TempDir()) // no runtime.json
	post(forward{SessionID: "x", FiveHour: &window{UsedPercentage: 1}})
	// Reaching here without panic/hang is the assertion.
}
