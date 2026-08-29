package premium

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"testing"
)

// The dashboard states a price and the site charges one. Two copies of a
// number drift; the only question is whether they drift silently.
//
// This reads the site's own pricing file and compares it to Current(). It is
// skipped when the site is not checked out beside the product — a contributor
// with only this repository is not failed for that — but on the owner's
// machine and anywhere both are present, a mismatch is a red build instead of
// a customer charged something the dashboard did not say.
func TestPricingMatchesTheSite(t *testing.T) {
	path := filepath.Join("..", "..", "..", "caprock-web", "src", "content", "pricing.ts")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("site not checked out beside the product (%v)", err)
	}
	src := string(b)

	num := func(field string) float64 {
		t.Helper()
		// `usd: 5,` / `perMonth: 2.5,` — the shape the file has had since it
		// was written. A change to that shape fails loudly here rather than
		// quietly matching nothing.
		re := regexp.MustCompile(field + `:\s*([0-9.]+)`)
		m := re.FindStringSubmatch(src)
		if m == nil {
			t.Fatalf("could not find %q in %s — the file's shape changed, so this check is no longer checking anything", field, path)
		}
		v, err := strconv.ParseFloat(m[1], 64)
		if err != nil {
			t.Fatalf("parse %s: %v", field, err)
		}
		return v
	}

	p := Current()
	// In file order: monthly, yearly, lifetime. Positional rather than named
	// because the file is TypeScript, not data — parsing it properly would be
	// a parser, and this check exists to notice a mismatch, not to be one.
	all := regexp.MustCompile(`usd:\s*([0-9.]+)`).FindAllStringSubmatch(src, -1)
	if len(all) != 3 {
		t.Fatalf("expected three `usd:` prices in %s, found %d — the file's shape changed, so this check is no longer checking what it says", path, len(all))
	}
	for i, want := range []struct {
		name string
		usd  float64
	}{
		{"monthly", p.Monthly.ChargedUSD},
		{"yearly", p.Yearly.ChargedUSD},
		{"lifetime", p.Lifetime.ChargedUSD},
	} {
		got, err := strconv.ParseFloat(all[i][1], 64)
		if err != nil {
			t.Fatalf("parse %s price: %v", want.name, err)
		}
		if got != want.usd {
			t.Errorf("%s price: site says %.2f, dashboard says %.2f", want.name, got, want.usd)
		}
	}
	if got := num("perMonth"); got != p.Yearly.PerMonthUSD {
		t.Errorf("yearly per-month: site says %.2f, dashboard says %.2f", got, p.Yearly.PerMonthUSD)
	}

	// The Claude price we compare against lives in the site's facts.ts, with
	// its own source and date. The dashboard states the same figure, so the
	// two can drift — and a comparison built on a stale competitor price is
	// worse than no comparison, because it reads as a claim about them.
	factsPath := filepath.Join("..", "..", "..", "caprock-web", "src", "content", "facts.ts")
	if fb, err := os.ReadFile(factsPath); err == nil {
		facts := string(fb)
		m := regexp.MustCompile(`proMonthlyUsd:\s*([0-9.]+)`).FindStringSubmatch(facts)
		if m == nil {
			t.Fatalf("could not find proMonthlyUsd in %s — the file's shape changed, so this check is no longer checking anything", factsPath)
		}
		got, err := strconv.ParseFloat(m[1], 64)
		if err != nil {
			t.Fatalf("parse proMonthlyUsd: %v", err)
		}
		if got != p.Compare.MonthlyUSD {
			t.Errorf("Claude Pro price: site says %.2f, dashboard says %.2f", got, p.Compare.MonthlyUSD)
		}
		// The date too: a figure that is still correct but was read a year ago
		// is a different claim from one read last week, and the UI shows it.
		if !regexp.MustCompile(regexp.QuoteMeta(p.Compare.ReadOn)).MatchString(facts) {
			t.Errorf("comparison date %s is not in %s — one of the two was updated without the other", p.Compare.ReadOn, factsPath)
		}
	}

	// The links matter as much as the figures: a correct price beside a link
	// to the wrong Stripe product charges the wrong amount.
	for _, want := range []string{p.Yearly.URL, p.Monthly.URL, p.Lifetime.URL} {
		if !regexp.MustCompile(regexp.QuoteMeta(want)).MatchString(src) {
			t.Errorf("payment link %s is not in %s", want, path)
		}
	}
}

// A price of zero would render as "free" beside a button that charges money.
func TestPricesArePositive(t *testing.T) {
	p := Current()
	for name, v := range map[string]float64{
		"yearly charged":    p.Yearly.ChargedUSD,
		"yearly per month":  p.Yearly.PerMonthUSD,
		"monthly charged":   p.Monthly.ChargedUSD,
		"monthly per month": p.Monthly.PerMonthUSD,
		"lifetime charged":  p.Lifetime.ChargedUSD,
	} {
		if v <= 0 {
			t.Errorf("%s is %.2f", name, v)
		}
	}
}
