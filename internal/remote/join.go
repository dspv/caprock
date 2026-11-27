package remote

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"strings"
)

// A join key (ADR-108): one paste that links a new computer to the one the
// user works on. The computer where the user works makes it; `caprock join
// <key>` on the new computer (or the key pasted in its Settings) uses it.
//
// The key names a rendezvous: a mailbox the issuing computer holds open on
// its relay for as long as the key is good, under a pair of keys made for
// this key alone and thrown away with it — its relay id and the X25519 key
// the new computer's handshake pins, exactly what a pairing link carries —
// and a secret only the issuer's hash of it can check. The new computer
// dials the rendezvous, proves it holds the secret, and hands over its own
// pairing link with a code that pre-approves the issuer's relay key and no
// other; the issuer then pairs with that link as `caprock machines add`
// does. Nothing in the key is a secret of the user's or a token: it carries
// no credential, and the access it ends in is the access a pasted link and
// Allow give.

// JoinKeyPrefix starts every join key: a version, and a word a person can
// tell from a pairing link.
const JoinKeyPrefix = "cj1-"

// JoinSecretSize is the secret's length, in bytes: 128 bits, against a
// rendezvous that also burns the key after a few wrong tries.
const JoinSecretSize = 16

// JoinKey is a parsed join key.
type JoinKey struct {
	// Target is the rendezvous: the relay, the id it waits under and the
	// key its handshake pins.
	Target
	// Secret proves to the rendezvous that the caller was given the key.
	Secret []byte
}

// MakeJoinKey makes a fresh rendezvous identity and secret for relay. The
// keys are the rendezvous host's, kept by the issuer until the key is spent
// or expires; the string is what the user carries to the new computer.
func MakeJoinKey(relay string) (*Keys, *JoinKey, error) {
	if err := CheckRelayURL(relay); err != nil {
		return nil, nil, err
	}
	_, sign, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	st, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	secret := make([]byte, JoinSecretSize)
	if _, err := rand.Read(secret); err != nil {
		return nil, nil, err
	}
	k := &Keys{Sign: sign, Static: st}
	return k, &JoinKey{Target: Target{Relay: relay, HostID: k.HostID(), Key: k.StaticPublic()}, Secret: secret}, nil
}

// String is the key as the user pastes it: the prefix, then base64url of
// one version byte, the rendezvous id (32 bytes), its static key (32), the
// secret (16) and the relay's address — left out when it is the hosted
// relay, which keeps the usual key at 112 characters.
func (k *JoinKey) String() string {
	id, _ := ParseHostID(k.HostID)
	st, _ := k.staticKey()
	var b bytes.Buffer
	b.WriteByte(1)
	b.Write(id)
	b.Write(st)
	b.Write(k.Secret)
	if k.Relay != DefaultRelay {
		b.WriteString(k.Relay)
	}
	return JoinKeyPrefix + base64.RawURLEncoding.EncodeToString(b.Bytes())
}

// ErrNotJoinKey is a pasted text that is not a join key.
var ErrNotJoinKey = errors.New("that is not a join key: make one on the computer you work on, in Settings → Computers → Add with a key")

// ParseJoinKey reads what String writes. It also takes the whole command
// pasted (`caprock join cj1-…`), quotes around it, and a key a terminal
// wrapped over lines.
func ParseJoinKey(raw string) (*JoinKey, error) {
	s := strings.Join(strings.Fields(raw), " ")
	if i := strings.Index(s, JoinKeyPrefix); i >= 0 {
		s = s[i:]
	} else {
		return nil, ErrNotJoinKey
	}
	s = strings.Join(strings.Fields(s), "")
	s = strings.TrimRight(s, "\"'`>")
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(s, JoinKeyPrefix))
	if err != nil || len(b) < 1+32+32+JoinSecretSize || b[0] != 1 {
		return nil, ErrNotJoinKey
	}
	k := &JoinKey{
		Target: Target{
			HostID: base64.RawURLEncoding.EncodeToString(b[1:33]),
			Key:    base64.RawURLEncoding.EncodeToString(b[33:65]),
			Relay:  DefaultRelay,
		},
		Secret: append([]byte(nil), b[65:65+JoinSecretSize]...),
	}
	if rest := b[65+JoinSecretSize:]; len(rest) > 0 {
		k.Relay = string(rest)
	}
	if err := k.check(); err != nil {
		return nil, err
	}
	return k, nil
}

// HandlerClient is an http.Client that serves every request with h, in
// this process: the rendezvous Host replays what a joining computer sends
// onto a handler of its own, never onto the daemon's API, so nothing but
// the join routes is reachable through it whatever path is asked for.
func HandlerClient(h http.Handler) *http.Client {
	return &http.Client{Transport: handlerTransport{h}}
}

type handlerTransport struct{ h http.Handler }

func (t handlerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	w := &recorder{header: http.Header{}, code: http.StatusOK}
	t.h.ServeHTTP(w, req)
	if req.Body != nil {
		_ = req.Body.Close()
	}
	return &http.Response{
		Status:        http.StatusText(w.code),
		StatusCode:    w.code,
		Proto:         "HTTP/1.1",
		ProtoMajor:    1,
		ProtoMinor:    1,
		Header:        w.header,
		Body:          io.NopCloser(bytes.NewReader(w.body.Bytes())),
		ContentLength: int64(w.body.Len()),
		Request:       req,
	}, nil
}

// recorder is the little of an http.ResponseWriter a join route uses.
// (net/http/httptest would do, but it registers a command-line flag in
// every binary that imports it.)
type recorder struct {
	header http.Header
	code   int
	wrote  bool
	body   bytes.Buffer
}

func (r *recorder) Header() http.Header { return r.header }

func (r *recorder) WriteHeader(code int) {
	if !r.wrote {
		r.code, r.wrote = code, true
	}
}

func (r *recorder) Write(b []byte) (int, error) {
	r.wrote = true
	return r.body.Write(b)
}
