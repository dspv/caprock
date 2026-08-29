// Package premium holds what the paid plan costs and where to buy it.
//
// The dashboard has to state a price: a dialog that explains a paid feature
// and then sends someone away to find out what it costs is asking them to
// leave in order to be sold to. But a price is also the single most damaging
// thing to get wrong — a page that says $5 and a card that is charged $6 is
// how the first ten customers are lost.
//
// It cannot be fetched, either: rule 4 means the dashboard makes no outbound
// calls, so the figure ships in the binary whatever we do.
//
// So it lives here, once, and `TestPricingMatchesTheSite` in this package
// reads the site's own pricing file and fails when the two disagree. That
// turns "two copies that will drift" into "two copies that cannot drift
// silently" — the check runs in CI, where a mismatch is a red build rather
// than a support email.
package premium

// Plan is what a subscription costs and the Stripe link that sells it.
type Plan struct {
	// USD per month. For Yearly this is the yearly price divided by twelve —
	// what the plan works out to, which is the number people compare.
	PerMonthUSD float64 `json:"per_month_usd"`
	// USD actually charged, per billing period.
	ChargedUSD float64 `json:"charged_usd"`
	// How often ChargedUSD is taken: "month" or "year".
	Period string `json:"period"`
	// The Stripe payment link. Opened in a new tab; never embedded.
	URL string `json:"url"`
}

// Compare is a price someone is already paying, for scale.
//
// Caprock's own price means nothing on its own — $30 is only cheap or dear
// against something. The thing every user of this dashboard is already paying
// for is a Claude subscription, so that is the ruler.
//
// It is a quoted price with a source and a date, per rule 6. It is not a claim
// that the two are substitutes: a Claude plan buys the model, Caprock buys a
// view of what the model did. The comparison is of magnitude, and the UI has
// to say so rather than implying an either/or.
type Compare struct {
	// What the plan is called on the vendor's own page.
	Plan string `json:"plan"`
	// USD per month, billed monthly.
	MonthlyUSD float64 `json:"monthly_usd"`
	// Where the figure was read, and when. Shown to the user — an unsourced
	// number about someone else's pricing is the kind rule 6 exists to stop.
	Source string `json:"source"`
	ReadOn string `json:"read_on"`
}

// Pricing is every way to buy, plus where to read more.
type Pricing struct {
	Yearly   Plan   `json:"yearly"`
	Monthly  Plan   `json:"monthly"`
	Lifetime Plan   `json:"lifetime"`
	InfoURL  string `json:"info_url"`
	// Compare is what a Claude Pro subscription costs, for scale.
	Compare Compare `json:"compare"`
}

// Current is the live pricing. Changing anything here means changing
// caprock-web's src/content/pricing.ts in the same commit, and the test in
// this package is what enforces that.
func Current() Pricing {
	return Pricing{
		Yearly: Plan{
			PerMonthUSD: 2.50,
			ChargedUSD:  30,
			Period:      "year",
			URL:         "https://buy.stripe.com/bJe9ATcKkgBy9ye8vN1sQ0A",
		},
		Monthly: Plan{
			PerMonthUSD: 5,
			ChargedUSD:  5,
			Period:      "month",
			URL:         "https://buy.stripe.com/28E7sLdOobhe6m23bt1sQ0z",
		},
		// Bought once. PerMonthUSD is zero because there is no per-month
		// figure to state — dividing $100 by a lifetime is arithmetic on an
		// unknown, and inventing a denominator to make a smaller number is
		// exactly what rule 6 forbids.
		Lifetime: Plan{
			ChargedUSD: 100,
			Period:     "once",
			URL:        "https://buy.stripe.com/4gM14naCc9967q6h2j1sQ0B",
		},
		InfoURL: "https://caprock.dev/premium/",
		// Read off claude.com/pricing on the date below. Pro billed monthly;
		// the annual plan is cheaper per month and Max starts at $100, so this
		// is the *lowest* monthly figure a Claude Code user is likely paying —
		// which is the conservative choice for a comparison in our favour.
		Compare: Compare{
			Plan:       "Claude Pro",
			MonthlyUSD: 20,
			Source:     "claude.com/pricing",
			ReadOn:     "2026-08-28",
		},
	}
}
