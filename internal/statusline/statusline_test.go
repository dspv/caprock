package statusline

import (
	"bytes"
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
