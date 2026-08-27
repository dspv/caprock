// Package pairing lets a second device — a tablet, a phone — reach a daemon
// that is otherwise bound to loopback.
//
// NOTHING USES THIS YET. No listener is opened, no endpoint is served, and no
// screen offers to pair anything. It was built and tested first because it is
// the part that decides who gets in, and then the feature it belongs to was
// put on hold: nobody has asked to reach Caprock from a phone, and the three
// ways of arranging it differ so much in what they cost the user that
// choosing one before anyone wants it would be guessing. See FB-019 in
// .fdck/01-ledger.md.
//
// Kept rather than deleted because the reasoning here — single-use codes,
// constant-time comparison, immediate revocation, never binding 0.0.0.0 — is
// the expensive part to get right and does not change whichever route wins.
//
// The rule that shapes everything here is rule 4: all data stays on the
// machine. Nothing in this package reaches the network, registers a name, or
// opens a tunnel. What it does is narrower: when the user explicitly turns it
// on, the daemon also listens on the machine's LAN address, and a device on
// that same network can connect after proving it knows a code the user read
// off their own screen.
//
// That is a real reduction in safety and it is stated plainly rather than
// smoothed over. Bound to loopback, nothing outside the machine can connect at
// all. Bound to the LAN, everything on that network can *try* — the guest on
// the home wifi, the stranger in the coworking space. So:
//
//   - It is off until switched on, never a default, never remembered across a
//     daemon that was started without it.
//   - A device proves itself once with a short code the user reads aloud or
//     scans, and is issued a long random token it keeps.
//   - Codes are single-use and expire in minutes. A device token does not.
//   - Every paired device is listed, with when it was last seen, and can be
//     revoked one by one.
//
// Codes are short because a person has to type them on a tablet. Short means
// guessable, so the code is useless after one use or five minutes, whichever
// comes first, and repeated wrong guesses burn it. The device token that
// replaces it is full length.
package pairing

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// CodeTTL is how long a pairing code stays usable. Long enough to walk to the
// other device, short enough that a code left on screen is not a standing
// invitation.
const CodeTTL = 5 * time.Minute

// MaxAttempts is how many wrong guesses a code survives. A six-digit code has
// a million values, and this makes brute force pointless while leaving room
// for a person mistyping twice.
const MaxAttempts = 5

// Errors callers distinguish. Everything else is a bug.
var (
	// ErrNoCode means no code is outstanding: either none was issued, or the
	// last one was used or expired.
	ErrNoCode = errors.New("no pairing code is active")
	// ErrBadCode means the code did not match. The caller must not say
	// whether the code was wrong or expired — that is one bit an attacker
	// would otherwise get for free.
	ErrBadCode = errors.New("that code is not valid")
	// ErrUnknownDevice means the token does not belong to a paired device,
	// which is also what a revoked device gets.
	ErrUnknownDevice = errors.New("this device is not paired")
)

// Device is one thing that has been let in.
type Device struct {
	// ID identifies the device in the UI and for revocation. Not a secret.
	ID string `json:"id"`
	// Name is what the user sees: taken from the browser, so "iPad" or
	// "Android tablet" rather than anything the device asserts about itself.
	Name string `json:"name"`
	// Token is what the device presents on every request. Never sent to the
	// UI after the moment of pairing.
	Token string `json:"token"`
	// PairedAt and LastSeen are unix milliseconds.
	PairedAt int64 `json:"paired_at"`
	LastSeen int64 `json:"last_seen"`
}

// Public is a Device without its token, for listing in the dashboard.
type Public struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	PairedAt int64  `json:"paired_at"`
	LastSeen int64  `json:"last_seen"`
}

// Store holds the pairing state. The zero value is not usable; call New.
type Store struct {
	// Now is injectable so expiry is testable without sleeping.
	Now func() time.Time

	mu       sync.Mutex
	code     string
	codeAt   time.Time
	attempts int
	devices  map[string]*Device // by token
}

// New returns an empty Store with no code and no devices.
func New() *Store {
	return &Store{Now: time.Now, devices: map[string]*Device{}}
}

// NewCode issues a fresh six-digit code, replacing any outstanding one.
//
// Replacing rather than refusing: a user who cannot find the code they were
// shown will press the button again, and the sensible reading of that is "the
// old one no longer counts", not "you already have one somewhere".
func (s *Store) NewCode() (string, error) {
	code, err := randomDigits(6)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.code, s.codeAt, s.attempts = code, s.Now(), 0
	return code, nil
}

// ClearCode withdraws the outstanding code, if any.
func (s *Store) ClearCode() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.code, s.attempts = "", 0
}

// CodeActive reports whether a code is outstanding and still valid, and how
// long it has left. For showing a countdown, never for deciding access.
func (s *Store) CodeActive() (bool, time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.code == "" {
		return false, 0
	}
	left := CodeTTL - s.Now().Sub(s.codeAt)
	if left <= 0 {
		return false, 0
	}
	return true, left
}

// Redeem exchanges a pairing code for a device token.
//
// The comparison is constant-time. Six digits is small enough that timing a
// character-by-character compare is not far-fetched, and the cost of doing it
// properly is nothing.
func (s *Store) Redeem(code, name string) (*Device, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.code == "" {
		return nil, ErrNoCode
	}
	if s.Now().Sub(s.codeAt) > CodeTTL {
		s.code, s.attempts = "", 0
		return nil, ErrNoCode
	}
	if subtle.ConstantTimeCompare([]byte(code), []byte(s.code)) != 1 {
		s.attempts++
		if s.attempts >= MaxAttempts {
			// Burn it. A code being guessed at is a code that must stop
			// existing, whether the guesser is an attacker or a person
			// reading the wrong screen.
			s.code, s.attempts = "", 0
		}
		return nil, ErrBadCode
	}

	tok, err := randomHex(32)
	if err != nil {
		return nil, err
	}
	id, err := randomHex(8)
	if err != nil {
		return nil, err
	}
	now := s.Now().UnixMilli()
	d := &Device{ID: id, Name: cleanName(name), Token: tok, PairedAt: now, LastSeen: now}
	s.devices[tok] = d
	// Single use: the code is spent whether or not another device is waiting.
	s.code, s.attempts = "", 0
	return d, nil
}

// Check validates a device token and records that the device was seen.
func (s *Store) Check(token string) (*Device, error) {
	if token == "" {
		return nil, ErrUnknownDevice
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	d, ok := s.devices[token]
	if !ok {
		return nil, ErrUnknownDevice
	}
	d.LastSeen = s.Now().UnixMilli()
	return d, nil
}

// Devices lists what is paired, without tokens, oldest first.
func (s *Store) Devices() []Public {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Public, 0, len(s.devices))
	for _, d := range s.devices {
		out = append(out, Public{ID: d.ID, Name: d.Name, PairedAt: d.PairedAt, LastSeen: d.LastSeen})
	}
	// Stable order so the list does not shuffle between polls.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].PairedAt < out[j-1].PairedAt; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// Revoke removes one device by id. Its token stops working immediately.
func (s *Store) Revoke(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for tok, d := range s.devices {
		if d.ID == id {
			delete(s.devices, tok)
			return true
		}
	}
	return false
}

// RevokeAll unpairs everything. What the user reaches for when they no longer
// trust the network they are on.
func (s *Store) RevokeAll() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := len(s.devices)
	s.devices = map[string]*Device{}
	s.code, s.attempts = "", 0
	return n
}

// Load restores devices from disk at start-up. Codes are deliberately not
// persisted: an outstanding code must not survive a restart.
func (s *Store) Load(ds []Device) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.devices = make(map[string]*Device, len(ds))
	for i := range ds {
		d := ds[i]
		if d.Token == "" {
			continue
		}
		s.devices[d.Token] = &d
	}
}

// Snapshot returns every device, tokens included, for persisting.
func (s *Store) Snapshot() []Device {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Device, 0, len(s.devices))
	for _, d := range s.devices {
		out = append(out, *d)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].PairedAt < out[j-1].PairedAt; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// cleanName keeps a device label short and free of anything that would be
// awkward on screen. The name comes from a request body, so it is untrusted
// text — it is shown, never interpreted.
func cleanName(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	if s == "" {
		return "a device"
	}
	if len([]rune(s)) > 40 {
		return string([]rune(s)[:40])
	}
	return s
}

// randomDigits returns n cryptographically random decimal digits.
//
// Rejection sampling rather than modulo: `b % 10` over bytes makes 0–5 more
// likely than 6–9, which is a real bias in a six-digit secret.
func randomDigits(n int) (string, error) {
	var sb strings.Builder
	buf := make([]byte, 1)
	for sb.Len() < n {
		if _, err := rand.Read(buf); err != nil {
			return "", fmt.Errorf("generate code: %w", err)
		}
		if buf[0] >= 250 { // 250..255 would skew the distribution
			continue
		}
		sb.WriteByte('0' + buf[0]%10)
	}
	return sb.String(), nil
}

func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	return hex.EncodeToString(buf), nil
}
