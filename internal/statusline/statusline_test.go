package statusline

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
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
