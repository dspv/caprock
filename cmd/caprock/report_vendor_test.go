package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// The owner's own report printed "$14,919 of Claude Code at API list prices"
// and "Priced from captured tokens at Anthropic list prices" above a Top
// models list holding gpt-5.6-sol — Codex turns priced from OpenAI's list. A
// figure that includes another vendor's models must not be credited to one.
func TestReportNamesEveryVendorInTheTotal(t *testing.T) {
	mixed := strings.Replace(sampleSummary,
		`"models": [{"model":"claude-opus-5","cost_usd":600,"turns":100}]`,
		`"models": [{"model":"claude-opus-5","cost_usd":500,"turns":90},{"model":"gpt-5.6-sol","cost_usd":140,"turns":30},{"model":"","cost_usd":0,"turns":3}]`, 1)
	if mixed == sampleSummary {
		t.Fatal("fixture did not change")
	}
	for _, args := range [][]string{{"report"}, {"report", "--markdown"}, {"report", "--json"}} {
		fakeDaemon(t, reportRoutes(mixed, flatPlan, sampleHistory))
		out, err := runCLI(t, args...)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(out, "of Claude Code") {
			t.Fatalf("%v: a mixed total credited to Claude Code:\n%s", args, out)
		}
		if strings.Contains(out, "at Anthropic list prices") {
			t.Fatalf("%v: a mixed total priced 'at Anthropic list prices':\n%s", args, out)
		}
		if args[len(args)-1] == "--markdown" {
			continue // the table carries no caveat line, only "At API list prices"
		}
		if !strings.Contains(out, "Anthropic and OpenAI list prices") {
			t.Fatalf("%v: caveat does not name both vendors:\n%s", args, out)
		}
		// The caveat's meaning is intact: still not a bill on a flat plan.
		if !strings.Contains(out, "Not a bill") {
			t.Fatalf("%v: caveat lost its meaning:\n%s", args, out)
		}
	}

	fakeDaemon(t, reportRoutes(mixed, flatPlan, sampleHistory))
	out, err := runCLI(t, "report", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatal(err)
	}
	if _, leaked := got["Subject"]; leaked {
		t.Fatal("the JSON shape the site reads grew a field")
	}
}

func TestListPrices(t *testing.T) {
	sum := func(models ...string) reportSummary {
		var s reportSummary
		for i, m := range models {
			s.Models = append(s.Models, struct {
				Model   string  `json:"model"`
				CostUSD float64 `json:"cost_usd"`
				Turns   int64   `json:"turns"`
			}{Model: m, CostUSD: float64(len(models) - i)})
		}
		return s
	}
	for _, tc := range []struct {
		models []string
		want   string
		claude bool
	}{
		{nil, "Anthropic list prices", true},
		{[]string{"claude-opus-5", "us.anthropic.claude-sonnet-4-5"}, "Anthropic list prices", true},
		{[]string{"gpt-5.6-sol"}, "OpenAI list prices", false},
		{[]string{"claude-opus-5", "gpt-5.6-sol", "gemini-2.5-pro"}, "Anthropic, OpenAI and Google list prices", false},
		{[]string{"claude-opus-5", "some-new-model"}, "the model makers' API list prices", false},
		// OpenCode's provider/model spelling, as on the owner's machine. MiniMax
		// ties OpenAI on cost here, and a tie is ordered by name.
		{[]string{"claude-opus-5", "openai/gpt-5.5", "minimax/minimax-m3", "MiniMax-M2.7"}, "Anthropic, MiniMax and OpenAI list prices", false},
	} {
		got, claude := listPrices(sum(tc.models...))
		if got != tc.want || claude != tc.claude {
			t.Errorf("%v: %q %v, want %q %v", tc.models, got, claude, tc.want, tc.claude)
		}
	}
}
