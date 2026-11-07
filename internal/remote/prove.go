package remote

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

// A computer's token bound to its own key (ADR-067, Phase 4). A computer that
// reaches this one (peers.Manager, through Client) holds a device token here;
// on its own, a token copied off that computer works from anywhere. So a
// Client given an Identity proves, as the first frame on every channel, that
// it holds the private half of its relay id: an Ed25519 signature over the
// handshake hash, which is the same on both ends and on no other channel, so
// a proof cannot be replayed on another. The Host keeps the proven key for
// the channel's life and marks every request it replays with it
// (PeerHeader); the gate binds a computer's token to the first key it is
// proven with and refuses it from any other channel. Phones send no proof and
// are unaffected.

// KindProve is the client's proof of its key: {"k": public key, "s":
// signature}, base64url, on stream 0, once, before anything else.
const KindProve byte = 0x0e

// proveContext separates this signature from anything else the key signs
// (the relay's challenge, ADR-058).
const proveContext = "caprock-computer-proof-v1:"

// PeerHeader carries the proven key of the channel a replayed request came
// through, with a MAC only this process can make, so neither a phone (its
// headers are allowlisted, requestHeaders) nor anything else on loopback can
// claim a key.
const PeerHeader = "X-Caprock-Peer"

type proof struct {
	Key string `json:"k"`
	Sig string `json:"s"`
}

// proveBody is what a Client sends: its public key and its signature over
// the handshake hash.
func proveBody(id ed25519.PrivateKey, hash []byte) []byte {
	pub := id.Public().(ed25519.PublicKey)
	sig := ed25519.Sign(id, append([]byte(proveContext), hash...))
	b, _ := json.Marshal(proof{Key: HostID(pub), Sig: base64.RawURLEncoding.EncodeToString(sig)})
	return b
}

// checkProof answers the key a proof proves for hash, as HostID spells it.
func checkProof(body, hash []byte) (string, error) {
	var p proof
	if err := json.Unmarshal(body, &p); err != nil {
		return "", errors.New("a proof that is not JSON")
	}
	pub, err := base64.RawURLEncoding.DecodeString(p.Key)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return "", errors.New("a proof without a key")
	}
	sig, err := base64.RawURLEncoding.DecodeString(p.Sig)
	if err != nil || !ed25519.Verify(ed25519.PublicKey(pub), append([]byte(proveContext), hash...), sig) {
		return "", errors.New("a proof whose signature does not verify")
	}
	return HostID(ed25519.PublicKey(pub)), nil
}

// peerSecret signs PeerHeader in this process; a new one each start, since
// the header never outlives the request it is on.
var peerSecret = func() []byte {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("remote: no randomness for the peer header: " + err.Error())
	}
	return b
}()

func peerMAC(key string) string {
	m := hmac.New(sha256.New, peerSecret)
	m.Write([]byte(key))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// SetPeerKey marks h as having come through a channel that proved key:
// the Host does it on every request it replays, and a test in this process
// can do it too. Nothing outside the process can.
func SetPeerKey(h http.Header, key string) { h.Set(PeerHeader, key+"."+peerMAC(key)) }

// PeerKey is the key the channel a request came through proved, or "" when
// it proved none or the header was not written by this process's Host.
func PeerKey(r *http.Request) string {
	v := r.Header.Get(PeerHeader)
	key, mac, ok := strings.Cut(v, ".")
	if !ok || key == "" || !hmac.Equal([]byte(mac), []byte(peerMAC(key))) {
		return ""
	}
	return key
}
