package config

import (
	"os"
	"testing"
)

// Anthropic renamed Max 5× to Max and Max 20× to Ultra (2026-10). A plan
// Caprock's own picker wrote under an old name reads back under the new one;
// anything the user typed, or set at another price, stays their words.
func TestCurrentPlanLabel(t *testing.T) {
	cases := []struct {
		kind, label string
		usd         float64
		want        string
	}{
		{"flat", "Max 5×", 100, "Max"},
		{"flat", "Max 20×", 200, "Ultra"},
		{"flat", "Max 20×", 180, "Max 20×"}, // not the preset's price: the user's own
		{"flat", "Max 20x", 200, "Max 20x"}, // typed, never written by the picker
		{"metered", "Max 20×", 200, "Max 20×"},
		{"flat", "Pro", 20, "Pro"},
		{"flat", "Ultra", 200, "Ultra"},
		{"", "", 0, ""},
	}
	for _, c := range cases {
		if got := CurrentPlanLabel(c.kind, c.label, c.usd); got != c.want {
			t.Errorf("CurrentPlanLabel(%q, %q, %v) = %q, want %q", c.kind, c.label, c.usd, got, c.want)
		}
	}
}

func TestLoadRenamesOldPlanPresets(t *testing.T) {
	dir := t.TempDir()
	body := `{"plan_kind":"flat","plan_label":"Max 20×","plan_usd_per_month":200,
	  "subscriptions":[
	    {"id":"work","label":"Work","agent":"claude","plan":{"kind":"flat","label":"Max 5×","usd_per_month":100}},
	    {"id":"home","label":"Home","agent":"claude","plan":{"kind":"flat","label":"My Max 20×","usd_per_month":200}},
	    {"id":"none","label":"None","agent":"claude"}
	  ]}`
	if err := os.WriteFile(ConfigPath(dir), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PlanLabel != "Ultra" || cfg.PlanUSDPerMonth != 200 {
		t.Errorf("main plan = %q at %v, want Ultra at 200", cfg.PlanLabel, cfg.PlanUSDPerMonth)
	}
	if got := cfg.Subscriptions[0].Plan.Label; got != "Max" {
		t.Errorf("work plan = %q, want Max", got)
	}
	if got := cfg.Subscriptions[1].Plan.Label; got != "My Max 20×" {
		t.Errorf("home plan = %q, want the user's own words kept", got)
	}
	if cfg.Subscriptions[2].Plan != nil {
		t.Errorf("a subscription with no plan gained one: %+v", cfg.Subscriptions[2].Plan)
	}
}
