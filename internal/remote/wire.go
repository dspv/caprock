package remote

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"errors"
)

// The relay's wire, between it and a daemon. A phone's side of the relay is
// simpler: one WebSocket per phone, each binary message one Noise message,
// passed through untouched.
//
// A daemon holds one WebSocket to the relay at /v1/host/<host id> and every
// phone that connects is multiplexed over it, numbered by the relay:
//
//	relay → daemon   FrameOpen  conn            a phone connected
//	both ways        FrameData  conn  bytes     one Noise message
//	both ways        FrameClose conn            that phone is gone / drop it
//
// Before any of that the daemon proves it holds the host id's private key:
// the relay sends FrameChallenge with 32 random bytes and the daemon answers
// FrameProof with an Ed25519 signature over hostProofContext, the id and the
// nonce. Nothing else the relay does depends on trusting the daemon — it
// cannot read what it carries — but without the proof anyone could register a
// machine's id and take its phones' connections, which is a denial of service
// even when it is not a breach.
//
// Keepalive is the text message "ping", answered "pong", either way round;
// Cloudflare answers it without waking the relay (setWebSocketAutoResponse).
const (
	FrameOpen      byte = 0x01
	FrameData      byte = 0x02
	FrameClose     byte = 0x03
	FrameChallenge byte = 0x10
	FrameProof     byte = 0x11
	FrameReady     byte = 0x12

	// CloseOffline is the WebSocket close code a phone gets when the machine
	// it named is not connected to the relay.
	CloseOffline = 4404
	// CloseReplaced is what an older daemon connection gets when the same
	// machine connects again.
	CloseReplaced = 4409
	// MaxRelayMessage bounds every WebSocket message on either side: one Noise
	// message plus the five-byte frame header.
	MaxRelayMessage = MaxMessage + 5

	hostProofContext = "caprock-relay-host-v1\x00"
)

// HostID names a machine on a relay: its Ed25519 public key, base64url without
// padding. Self-certifying, so a relay needs no account or database to know
// who may register it.
func HostID(pub ed25519.PublicKey) string {
	return base64.RawURLEncoding.EncodeToString(pub)
}

// ParseHostID is HostID's inverse, refusing anything that is not a key.
func ParseHostID(id string) (ed25519.PublicKey, error) {
	b, err := base64.RawURLEncoding.DecodeString(id)
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, errors.New("not a host id")
	}
	return ed25519.PublicKey(b), nil
}

// ProofMessage is what a daemon signs to answer a relay's challenge.
func ProofMessage(hostID string, nonce []byte) []byte {
	m := append([]byte(hostProofContext), hostID...)
	return append(m, nonce...)
}

// VerifyProof checks a daemon's answer to nonce.
func VerifyProof(hostID string, nonce, sig []byte) bool {
	pub, err := ParseHostID(hostID)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(pub, ProofMessage(hostID, nonce), sig)
}

// Frame builds one relay↔daemon frame.
func Frame(kind byte, conn uint32, data []byte) []byte {
	b := make([]byte, 5, 5+len(data))
	b[0] = kind
	binary.BigEndian.PutUint32(b[1:], conn)
	return append(b, data...)
}

// ParseFrame splits a relay↔daemon frame.
func ParseFrame(b []byte) (kind byte, conn uint32, data []byte, err error) {
	if len(b) < 5 {
		return 0, 0, nil, errors.New("short frame")
	}
	return b[0], binary.BigEndian.Uint32(b[1:5]), b[5:], nil
}
