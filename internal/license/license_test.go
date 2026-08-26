package license

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"
)

func at(s string) time.Time {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestParse(t *testing.T) {
	for _, tc := range []struct {
		name    string
		key     string
		now     string
		active  bool
		grace   bool
		wantWhy string
	}{
		{name: "a key covering today is active", key: "CR-2026-12-31-A1B2C3D4", now: "2026-08-26", active: true},

		// The date names the last day covered. A key expiring 2026-08-26 that
		// stops at midnight on the 26th takes a day the customer paid for.
		{name: "the expiry day itself is covered", key: "CR-2026-08-26-A1B2C3D4", now: "2026-08-26", active: true},

		{name: "the day after expiry falls into grace", key: "CR-2026-08-26-A1B2C3D4", now: "2026-08-27", active: true, grace: true},
		{name: "the last day of grace still works", key: "CR-2026-08-26-A1B2C3D4", now: "2026-09-02", active: true, grace: true},
		{name: "after grace, features are off", key: "CR-2026-08-26-A1B2C3D4", now: "2026-09-05", active: false},

		// Every rejection has to say what is wrong. "Invalid" sends someone to
		// support; naming the problem lets them fix it.
		{name: "no key at all", key: "", now: "2026-08-26", wantWhy: "no key"},
		{name: "the wrong kind of string", key: "sk_live_abc123", now: "2026-08-26", wantWhy: "starts with"},
		{name: "prefix but no date", key: "CR-hello", now: "2026-08-26", wantWhy: "too short"},
		{name: "a date that is not one", key: "CR-2026-13-45-A1B2C3D4", now: "2026-08-26", wantWhy: "readable date"},
		{name: "date runs into the random part", key: "CR-2026-08-26A1B2C3D4", now: "2026-08-26", wantWhy: "separator"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := Parse(tc.key, at(tc.now))
			if got.Active != tc.active {
				t.Errorf("Active = %v, want %v (reason %q)", got.Active, tc.active, got.Reason)
			}
			if got.InGrace != tc.grace {
				t.Errorf("InGrace = %v, want %v", got.InGrace, tc.grace)
			}
			if tc.wantWhy != "" && !contains(got.Reason, tc.wantWhy) {
				t.Errorf("Reason = %q, want it to mention %q", got.Reason, tc.wantWhy)
			}
		})
	}
}

// Whitespace around a pasted key is the most likely thing to go wrong in the
// one interaction that turns a payment into a working feature.
func TestParseTolerantOfPasting(t *testing.T) {
	for _, k := range []string{
		"  CR-2026-12-31-A1B2C3D4",
		"CR-2026-12-31-A1B2C3D4  ",
		"\nCR-2026-12-31-A1B2C3D4\n",
		"\tCR-2026-12-31-A1B2C3D4 ",
	} {
		if s := Parse(k, at("2026-08-26")); !s.Active {
			t.Errorf("Parse(%q) refused a key that differs only in whitespace: %s", k, s.Reason)
		}
	}
}

// Grace has to be visible, not silent: someone whose renewal failed should be
// told while there is still time to fix it.
func TestGraceIsAnnounced(t *testing.T) {
	s := Parse("CR-2026-08-26-A1B2C3D4", at("2026-08-28"))
	if !s.Active || !s.InGrace {
		t.Fatalf("expected an active grace state, got %+v", s)
	}
	if s.Reason == "" {
		t.Fatal("grace said nothing — the user has no way to know their renewal failed")
	}
	if !contains(s.Reason, "2026-09-02") {
		t.Errorf("grace does not say when it runs out: %q", s.Reason)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (haystack == needle ||
		len(needle) == 0 || indexOf(haystack, needle) >= 0)
}

func indexOf(h, n string) int {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return i
		}
	}
	return -1
}

// The whole mechanism is one string surviving a round trip between two
// repositories and two languages. Nothing else makes the webhook that issues a
// key and the daemon that reads it agree, so this is where they are held
// together: the constants below are real output from
// `node scripts/check-webhook.mjs` in caprock-web, pasted verbatim.
//
// If a change over there stops this passing, the fix is not to edit the
// constant — it is that a paying customer would have been handed a key their
// dashboard rejects.
func TestKeyFormatIsWhatTheWebhookIssues(t *testing.T) {
	// Captured 2026-08-26 from the webhook's own output.
	const issuedByWebhook = "CR-2026-09-30-B9764123"
	if s := Parse(issuedByWebhook, at("2026-08-26")); !s.Active {
		t.Fatalf("the daemon refused a key the webhook issued: %s", s.Reason)
	}

	const issued = "CR-2027-08-26-7F3A9C21"
	s := Parse(issued, at("2026-08-26"))
	if !s.Active {
		t.Fatalf("a freshly issued key did not activate: %s", s.Reason)
	}
	if s.InGrace {
		t.Error("a fresh key should not be in grace")
	}
	if s.ExpiresAt == nil {
		t.Fatal("an active key reported no expiry")
	}
	if got := s.ExpiresAt.Format("2006-01-02"); got != "2027-08-27" {
		t.Errorf("expiry = %s, want the day after the date in the key", got)
	}
}

// Without a key there is no expiry, and the JSON must not carry one.
//
// A zero time.Time does not satisfy `omitempty`; it serialises as
// 0001-01-01T00:00:00Z, and the dashboard reads this field to say "renews …".
// Anyone who has never paid would have been told their licence renews in the
// year one.
func TestNoKeyReportsNoExpiry(t *testing.T) {
	s := Parse("", at("2026-08-26"))
	if s.ExpiresAt != nil {
		t.Fatalf("an absent key reported an expiry: %v", *s.ExpiresAt)
	}
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(b, []byte("expires_at")) {
		t.Errorf("expires_at present with no key: %s", b)
	}
}
