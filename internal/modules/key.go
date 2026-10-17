// Package modules is the slot for private modules (ADR-076): a signed admin
// key that names which modules may run, a folder of static files installed
// from this machine, and the checks that decide whether one is shown.
//
// The slot holds no module. A module is somebody's own code, installed by
// them from a local folder; the public build carries only the way to verify
// a key and host what it names, so patching the check out unlocks nothing.
package modules

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
)

// KeyPrefix starts every admin key: CRA1.<payload>.<sig>, where payload is
// base64url of the claims' JSON and sig is base64url of an Ed25519 signature
// over the ASCII bytes of the payload part.
const KeyPrefix = "CRA1."

// PublicKey is the raw Ed25519 key admin keys are verified with. Its private
// half never touches this repository.
const PublicKey = "M6U1zOTAnYbdEaukyaZUQ1VGOfZPdQT+Ol0OCACP504="

var publicKey = mustPublicKey(PublicKey)

func mustPublicKey(b64 string) ed25519.PublicKey {
	b, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(b) != ed25519.PublicKeySize {
		panic("modules: the embedded public key is not a raw Ed25519 key")
	}
	return ed25519.PublicKey(b)
}

// Grant is what a verified admin key allows: who it was issued to and which
// modules may be installed and opened.
type Grant struct {
	Subject  string   `json:"subject"`
	Modules  []string `json:"modules"`
	IssuedAt string   `json:"issued_at,omitempty"`
}

// Allows reports whether the key names module id.
func (g Grant) Allows(id string) bool { return slices.Contains(g.Modules, id) }

// claims is the payload as it is signed.
type claims struct {
	V       int      `json:"v"`
	Sub     string   `json:"sub"`
	Role    string   `json:"role"`
	Modules []string `json:"modules"`
	Iat     string   `json:"iat"`
}

// LooksLikeKey reports whether s is meant as an admin key, so a field that
// takes both kinds of key can send it the right way.
func LooksLikeKey(s string) bool { return strings.HasPrefix(strings.TrimSpace(s), KeyPrefix) }

// ParseKey verifies an admin key against the embedded public key.
func ParseKey(key string) (Grant, error) { return ParseKeyWith(key, publicKey) }

// ParseKeyWith verifies an admin key against pub: the embedded key in the
// build, a key pair of their own in tests.
func ParseKeyWith(key string, pub ed25519.PublicKey) (Grant, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return Grant{}, errors.New("no key")
	}
	if !strings.HasPrefix(key, KeyPrefix) {
		return Grant{}, fmt.Errorf("not an admin key: it should start with %q", KeyPrefix)
	}
	payload, sigPart, ok := strings.Cut(strings.TrimPrefix(key, KeyPrefix), ".")
	if !ok || payload == "" || sigPart == "" || strings.Contains(sigPart, ".") {
		return Grant{}, errors.New("the key is cut short or has extra parts")
	}
	sig, err := b64url(sigPart)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return Grant{}, errors.New("the key's signature is not readable")
	}
	// The signature covers the payload exactly as written, before decoding.
	if !ed25519.Verify(pub, []byte(payload), sig) {
		return Grant{}, errors.New("the key's signature does not match")
	}
	raw, err := b64url(payload)
	if err != nil {
		return Grant{}, errors.New("the key's payload is not readable")
	}
	var c claims
	if err := json.Unmarshal(raw, &c); err != nil {
		return Grant{}, errors.New("the key's payload is not readable")
	}
	if c.V != 1 {
		return Grant{}, fmt.Errorf("key version %d is not one this build reads", c.V)
	}
	if c.Role != "admin" {
		return Grant{}, fmt.Errorf("the key's role is %q, not admin", c.Role)
	}
	mods := []string{}
	for _, m := range c.Modules {
		if !ValidID(m) {
			return Grant{}, fmt.Errorf("the key names a module id that is not valid: %q", m)
		}
		if !slices.Contains(mods, m) {
			mods = append(mods, m)
		}
	}
	return Grant{Subject: c.Sub, Modules: mods, IssuedAt: c.Iat}, nil
}

// b64url decodes base64url with or without padding.
func b64url(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
}
