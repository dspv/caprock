// Package license decides whether paid features are on.
//
// A key is a string the customer pastes into settings after paying. It carries
// its own expiry and is checked here, on the machine, with no network call and
// no signature — see ADR-022. The binary is Apache-2.0, so anyone determined to
// have the features can delete this file and rebuild; the key exists to make
// paying work, not to make not-paying fail.
//
// What that buys is reliability in the direction that matters. With no paying
// customers yet, the failure worth engineering against is not somebody
// stealing a feature — it is somebody paying and not receiving one. A check
// that needs nothing but the string cannot fail on a plane, behind a proxy, or
// while our servers are down, because there are none.
package license

import (
	"fmt"
	"strings"
	"time"
)

// Grace is how long features keep working after a key expires.
//
// A card that did not go through, a bank sitting on a renewal, an address that
// changed — none of those are a customer deciding to stop paying, and being cut
// off by their bank's timing produces an angry email that costs more than a
// week of features given away.
const Grace = 7 * 24 * time.Hour

// Prefix marks a Caprock key. Present so a user who pastes the wrong string —
// a Stripe receipt id, an API key — is told what is wrong rather than just
// "invalid".
const Prefix = "CR-"

// State is what the dashboard needs to know about a key.
type State struct {
	// Active is the only field a feature check should read.
	Active bool `json:"active"`
	// InGrace is true when the key expired but Grace has not run out. Features
	// are on; the dashboard says so.
	InGrace bool `json:"in_grace"`
	// ExpiresAt is the key's own date, absent when there is no valid key.
	//
	// A pointer because `omitempty` does not omit a zero time.Time — it
	// serialises as 0001-01-01, and a dashboard that reads the field to say
	// "renews …" would print the year one at anybody without a key.
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	// Reason explains an inactive state in words a person can act on.
	Reason string `json:"reason,omitempty"`
}

// Parse reads a key and reports what it grants at time `now`.
//
// The format is `CR-YYYY-MM-DD-XXXXXXXX`: a prefix, the expiry date, and eight
// characters of randomness so two keys issued on the same day differ. The date
// is in the key rather than in a database because there is no database — the
// key IS the record.
func Parse(key string, now time.Time) State {
	k := strings.TrimSpace(key)
	if k == "" {
		return State{Reason: "no key"}
	}
	if !strings.HasPrefix(k, Prefix) {
		return State{Reason: fmt.Sprintf("a Caprock key starts with %q", Prefix)}
	}
	rest := strings.TrimPrefix(k, Prefix)
	// YYYY-MM-DD- plus at least one character of randomness.
	if len(rest) < len("2006-01-02-")+1 {
		return State{Reason: "key is too short to carry a date"}
	}
	day := rest[:len("2006-01-02")]
	exp, err := time.Parse("2006-01-02", day)
	if err != nil {
		return State{Reason: "key does not carry a readable date"}
	}
	if rest[len(day)] != '-' {
		return State{Reason: "key is missing the separator after its date"}
	}
	// The date names the last day covered, so the key is good until the end of
	// it — an expiry of 2026-08-26 that stops working at midnight on the 26th
	// takes a day the customer paid for.
	exp = exp.AddDate(0, 0, 1)

	switch {
	case now.Before(exp):
		return State{Active: true, ExpiresAt: &exp}
	case now.Before(exp.Add(Grace)):
		return State{
			Active:    true,
			InGrace:   true,
			ExpiresAt: &exp,
			// The last day that still works, not the instant it stops. Grace
			// ends at the start of 2026-09-03, so printing that date tells
			// someone they have a day they do not have.
			Reason: fmt.Sprintf("expired %s — features keep working through %s",
				day, exp.Add(Grace).AddDate(0, 0, -1).Format("2006-01-02")),
		}
	default:
		return State{ExpiresAt: &exp, Reason: fmt.Sprintf("expired %s", day)}
	}
}
