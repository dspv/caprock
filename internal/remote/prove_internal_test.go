package remote

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"
)

// A proof holds for the channel it was made on and no other: signed over one
// handshake's hash, it fails against another's, and a key that did not sign
// it is refused.
func TestAProofHoldsForItsOwnChannelOnly(t *testing.T) {
	_, id, _ := ed25519.GenerateKey(rand.Reader)
	h1, h2 := make([]byte, 32), make([]byte, 32)
	h2[0] = 1
	body := proveBody(id, h1)
	key, err := checkProof(body, h1)
	if err != nil || key != HostID(id.Public().(ed25519.PublicKey)) {
		t.Fatalf("own proof: %q, %v", key, err)
	}
	if _, err := checkProof(body, h2); err == nil {
		t.Fatal("a proof replayed on another channel verified")
	}
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	forged := proveBody(other, h1)
	// Swap in the first key with the second key's signature.
	forged = []byte(`{"k":"` + HostID(id.Public().(ed25519.PublicKey)) + `",` + string(forged[len(`{"k":"`+HostID(other.Public().(ed25519.PublicKey))+`",`):]))
	if _, err := checkProof(forged, h1); err == nil {
		t.Fatal("a signature by another key verified")
	}
	for _, b := range []string{"", "{}", `{"k":"x","s":"y"}`} {
		if _, err := checkProof([]byte(b), h1); err == nil {
			t.Fatalf("%q verified", b)
		}
	}
}
