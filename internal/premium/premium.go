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

// Pricing is every way to buy, plus where to read more.
type Pricing struct {
	Yearly  Plan   `json:"yearly"`
	Monthly Plan   `json:"monthly"`
	InfoURL string `json:"info_url"`
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
		InfoURL: "https://caprock.dev/premium/",
	}
}
