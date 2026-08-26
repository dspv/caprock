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
	// The monthly `usd` appears first in the file, then the yearly one.
	all := regexp.MustCompile(`usd:\s*([0-9.]+)`).FindAllStringSubmatch(src, -1)
	if len(all) != 2 {
		t.Fatalf("expected two `usd:` prices in %s, found %d", path, len(all))
	}
	monthly, _ := strconv.ParseFloat(all[0][1], 64)
	yearly, _ := strconv.ParseFloat(all[1][1], 64)

	if monthly != p.Monthly.ChargedUSD {
		t.Errorf("monthly price: site says %.2f, dashboard says %.2f", monthly, p.Monthly.ChargedUSD)
	}
	if yearly != p.Yearly.ChargedUSD {
		t.Errorf("yearly price: site says %.2f, dashboard says %.2f", yearly, p.Yearly.ChargedUSD)
	}
	if got := num("perMonth"); got != p.Yearly.PerMonthUSD {
		t.Errorf("yearly per-month: site says %.2f, dashboard says %.2f", got, p.Yearly.PerMonthUSD)
	}

	// The links matter as much as the figures: a correct price beside a link
	// to the wrong Stripe product charges the wrong amount.
	for _, want := range []string{p.Yearly.URL, p.Monthly.URL} {
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
	} {
		if v <= 0 {
			t.Errorf("%s is %.2f", name, v)
		}
	}
}
