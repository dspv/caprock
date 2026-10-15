package daemon

import (
	"strings"
	"testing"
)

// The message carries the phone's page and nothing that lets anyone in: no
// code, no key, no token. A paired phone reconnects with its own token.
func TestPhoneLinkMessageIsTheAddressAlone(t *testing.T) {
	msg := PhoneLinkMessage("https://m.caprock.dev")
	if !strings.Contains(msg, "https://m.caprock.dev/") {
		t.Fatalf("no address in %q", msg)
	}
	for _, secret := range []string{"#/pair", "?c=", "&k=", "&h=", "token"} {
		if strings.Contains(msg, secret) {
			t.Errorf("message carries %q: %q", secret, msg)
		}
	}
	if got := PhoneLinkMessage("https://m.example.org/ "); !strings.Contains(got, "https://m.example.org/\n") {
		t.Errorf("a self-hosted page: %q", got)
	}
}
