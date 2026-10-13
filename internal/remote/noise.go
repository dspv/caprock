// Package remote lets a phone reach this daemon from anywhere, through a relay
// that only ever sees ciphertext (ADR-058).
//
// The daemon dials out to the relay and waits; a phone dials the same relay
// naming this machine, and the relay splices the two. Inside that splice the
// phone and the daemon run a Noise handshake against the daemon's static key,
// which the phone read off the pairing QR, so the relay — ours or anyone's —
// carries bytes it cannot read or alter. Past the handshake, the phone's
// requests are replayed onto this daemon's own loopback listener marked as
// coming off the network: the device token, the viewer and controller roles
// and revocation are exactly the ones LAN pairing uses, not a second set.
package remote

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
)

// Noise_NK_25519_AESGCM_SHA256, as the Noise Protocol Framework (revision 34)
// specifies it. NK because the phone knows the daemon's static key before it
// connects (the QR) and the daemon learns who the phone is from its device
// token, one layer up — so pairing, roles and revocation stay where they are.
// AESGCM and SHA256 because Go's standard library has both and so does every
// browser; the phone side is ui/src/remote/noise.ts, and the two are held to
// the same bytes by testdata/remote/noise-vector.json.
const (
	protocolName = "Noise_NK_25519_AESGCM_SHA256"
	// Prologue binds the handshake to this protocol's use: a transcript from
	// anything else that happens to speak NK will not verify here.
	prologue = "caprock-remote-v1"
	// MaxMessage is the longest Noise message, ciphertext and tag included.
	MaxMessage = 65535
	tagLen     = 16
	// MaxPlaintext is the most one transport message carries.
	MaxPlaintext = MaxMessage - tagLen
)

var (
	errShort     = errors.New("noise: message too short")
	errDecrypt   = errors.New("noise: message failed to authenticate")
	errTooLong   = errors.New("noise: message too long")
	errLowOrder  = errors.New("noise: key agreement produced zero")
	errExhausted = errors.New("noise: nonce space exhausted")
)

// cipherState is one direction of a channel: a key and the count of messages
// sent under it, which is the nonce.
type cipherState struct {
	aead cipher.AEAD
	n    uint64
}

func newCipherState(k []byte) *cipherState {
	block, err := aes.NewCipher(k)
	if err != nil {
		panic(err) // k is always 32 bytes
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		panic(err)
	}
	return &cipherState{aead: aead}
}

// nonce is AESGCM's: four zero bytes, then the counter big-endian.
func (c *cipherState) nonce() []byte {
	var b [12]byte
	binary.BigEndian.PutUint64(b[4:], c.n)
	return b[:]
}

func (c *cipherState) encrypt(ad, plaintext []byte) ([]byte, error) {
	if c.n == ^uint64(0) {
		return nil, errExhausted
	}
	out := c.aead.Seal(nil, c.nonce(), plaintext, ad)
	c.n++
	return out, nil
}

func (c *cipherState) decrypt(ad, ciphertext []byte) ([]byte, error) {
	if c.n == ^uint64(0) {
		return nil, errExhausted
	}
	out, err := c.aead.Open(nil, c.nonce(), ciphertext, ad)
	if err != nil {
		return nil, errDecrypt
	}
	c.n++
	return out, nil
}

// symmetricState is the handshake's running hash and chaining key.
type symmetricState struct {
	ck, h []byte
	k     *cipherState
}

func newSymmetricState() *symmetricState {
	h := make([]byte, 32)
	copy(h, protocolName) // shorter than the hash: padded with zeros
	s := &symmetricState{ck: append([]byte(nil), h...), h: h}
	s.mixHash([]byte(prologue))
	return s
}

func (s *symmetricState) mixHash(data []byte) {
	d := sha256.New()
	d.Write(s.h)
	d.Write(data)
	s.h = d.Sum(nil)
}

func (s *symmetricState) mixKey(ikm []byte) {
	ck, k := hkdf2(s.ck, ikm)
	s.ck = ck
	s.k = newCipherState(k)
}

func (s *symmetricState) encryptAndHash(plaintext []byte) ([]byte, error) {
	if s.k == nil {
		s.mixHash(plaintext)
		return plaintext, nil
	}
	ct, err := s.k.encrypt(s.h, plaintext)
	if err != nil {
		return nil, err
	}
	s.mixHash(ct)
	return ct, nil
}

func (s *symmetricState) decryptAndHash(ciphertext []byte) ([]byte, error) {
	if s.k == nil {
		s.mixHash(ciphertext)
		return ciphertext, nil
	}
	pt, err := s.k.decrypt(s.h, ciphertext)
	if err != nil {
		return nil, err
	}
	s.mixHash(ciphertext)
	return pt, nil
}

// split ends the handshake: the initiator sends with the first key and
// receives with the second.
func (s *symmetricState) split() (*cipherState, *cipherState) {
	k1, k2 := hkdf2(s.ck, nil)
	return newCipherState(k1), newCipherState(k2)
}

// hkdf2 is Noise's HKDF with two outputs.
func hkdf2(ck, ikm []byte) ([]byte, []byte) {
	tmp := hmacSHA256(ck, ikm)
	o1 := hmacSHA256(tmp, []byte{1})
	o2 := hmacSHA256(tmp, append(append([]byte(nil), o1...), 2))
	return o1, o2
}

func hmacSHA256(key, data []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(data)
	return m.Sum(nil)
}

func dh(priv *ecdh.PrivateKey, pub []byte) ([]byte, error) {
	p, err := ecdh.X25519().NewPublicKey(pub)
	if err != nil {
		return nil, err
	}
	out, err := priv.ECDH(p)
	if err != nil {
		return nil, errLowOrder // crypto/ecdh refuses an all-zero result
	}
	return out, nil
}

// Session is an established channel: Encrypt for what this side sends,
// Decrypt for what it receives. Not safe for concurrent use in either
// direction; the caller orders its own sends.
type Session struct {
	send, recv *cipherState
}

// Encrypt seals one transport message.
func (s *Session) Encrypt(plaintext []byte) ([]byte, error) {
	if len(plaintext) > MaxPlaintext {
		return nil, errTooLong
	}
	return s.send.encrypt(nil, plaintext)
}

// Decrypt opens one transport message. A failure means the stream is not
// ours, or was altered, and the connection should be dropped.
func (s *Session) Decrypt(ciphertext []byte) ([]byte, error) {
	if len(ciphertext) > MaxMessage {
		return nil, errTooLong
	}
	if len(ciphertext) < tagLen {
		return nil, errShort
	}
	return s.recv.decrypt(nil, ciphertext)
}

// Respond runs the responder's half of NK: it reads the phone's first message
// (-> e, es), and returns the reply (<- e, ee) carrying replyPayload, the
// payload the phone sent, and the established session.
//
// e is the ephemeral key; nil makes a fresh one, which is every real use.
// Tests pass a fixed one to pin the bytes against the TypeScript side.
func Respond(static *ecdh.PrivateKey, msg1, replyPayload []byte, e *ecdh.PrivateKey) (reply, payload []byte, sess *Session, err error) {
	if len(msg1) < 32+tagLen || len(msg1) > MaxMessage {
		return nil, nil, nil, errShort
	}
	s := newSymmetricState()
	s.mixHash(static.PublicKey().Bytes()) // <- s, the pre-message

	re := msg1[:32]
	s.mixHash(re)
	es, err := dh(static, re)
	if err != nil {
		return nil, nil, nil, err
	}
	s.mixKey(es)
	payload, err = s.decryptAndHash(msg1[32:])
	if err != nil {
		return nil, nil, nil, err
	}

	if e == nil {
		if e, err = ecdh.X25519().GenerateKey(rand.Reader); err != nil {
			return nil, nil, nil, err
		}
	}
	reply = append(reply, e.PublicKey().Bytes()...)
	s.mixHash(e.PublicKey().Bytes())
	ee, err := dh(e, re)
	if err != nil {
		return nil, nil, nil, err
	}
	s.mixKey(ee)
	ct, err := s.encryptAndHash(replyPayload)
	if err != nil {
		return nil, nil, nil, err
	}
	reply = append(reply, ct...)
	if len(reply) > MaxMessage {
		return nil, nil, nil, errTooLong
	}
	toPhone, fromPhone := s.split()
	// The initiator sends with the first key; this side receives with it.
	return reply, payload, &Session{send: fromPhone, recv: toPhone}, nil
}

// Initiator is the phone's half of NK, kept in Go for the tests and for
// `caprock remote check`, which proves a relay round trip from the machine
// itself.
type Initiator struct {
	s *symmetricState
	e *ecdh.PrivateKey
}

// Initiate writes the first message to the daemon whose static public key is
// rs. e is the ephemeral key, nil for a fresh one.
func Initiate(rs, payload []byte, e *ecdh.PrivateKey) (*Initiator, []byte, error) {
	var err error
	if e == nil {
		if e, err = ecdh.X25519().GenerateKey(rand.Reader); err != nil {
			return nil, nil, err
		}
	}
	s := newSymmetricState()
	s.mixHash(rs)
	msg := append([]byte(nil), e.PublicKey().Bytes()...)
	s.mixHash(e.PublicKey().Bytes())
	es, err := dh(e, rs)
	if err != nil {
		return nil, nil, err
	}
	s.mixKey(es)
	ct, err := s.encryptAndHash(payload)
	if err != nil {
		return nil, nil, err
	}
	return &Initiator{s: s, e: e}, append(msg, ct...), nil
}

// Finish reads the daemon's reply and returns its payload and the session.
func (i *Initiator) Finish(msg2 []byte) ([]byte, *Session, error) {
	if len(msg2) < 32+tagLen {
		return nil, nil, errShort
	}
	re := msg2[:32]
	i.s.mixHash(re)
	ee, err := dh(i.e, re)
	if err != nil {
		return nil, nil, err
	}
	i.s.mixKey(ee)
	payload, err := i.s.decryptAndHash(msg2[32:])
	if err != nil {
		return nil, nil, err
	}
	send, recv := i.s.split()
	return payload, &Session{send: send, recv: recv}, nil
}
