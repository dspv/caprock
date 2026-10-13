package remote

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/dspv/caprock/internal/config"
)

// Defaults: the relay and the phone's page Caprock runs. Both can be replaced
// by the owner's own (`caprock remote on --relay … --app …`); the phone reads
// the relay from the pairing link, so nothing on the phone is hard-wired.
const (
	DefaultRelay = "wss://relay.caprock.dev"
	DefaultApp   = "https://m.caprock.dev"
)

// remoteFile holds this machine's two keys and whether remote access is on.
// Its own file, 0600, like devices.json: config.json is edited by hand and
// pasted into support threads, and this one is a private key.
const remoteFile = "remote.json"

// Settings is what remote access remembers.
//
// Unlike LAN access, the decision to be on survives a restart (ADR-058): the
// machine this is for is a Mac mini in a cupboard, and a switch that resets
// whenever it reboots is a switch that is off when you are out with the dog.
// It cannot be turned on from a phone — only on the machine, or by a command
// run on it.
type Settings struct {
	Enabled bool   `json:"enabled"`
	Relay   string `json:"relay,omitempty"`
	App     string `json:"app,omitempty"`
	// Sign is the Ed25519 seed the machine proves its id to a relay with.
	Sign []byte `json:"sign"`
	// Static is the X25519 private key phones run the Noise handshake against.
	Static []byte `json:"static"`
}

// Keys are Settings' keys, parsed.
type Keys struct {
	Sign   ed25519.PrivateKey
	Static *ecdh.PrivateKey
}

// HostID is this machine's name on a relay.
func (k *Keys) HostID() string {
	return HostID(k.Sign.Public().(ed25519.PublicKey))
}

// StaticPublic is the key a phone pins, base64url.
func (k *Keys) StaticPublic() string {
	return base64.RawURLEncoding.EncodeToString(k.Static.PublicKey().Bytes())
}

// Keys parses the stored keys.
func (s *Settings) Keys() (*Keys, error) {
	if len(s.Sign) != ed25519.SeedSize {
		return nil, errors.New("remote: no signing key")
	}
	st, err := ecdh.X25519().NewPrivateKey(s.Static)
	if err != nil {
		return nil, fmt.Errorf("remote: static key: %w", err)
	}
	return &Keys{Sign: ed25519.NewKeyFromSeed(s.Sign), Static: st}, nil
}

// RelayURL is the relay in force.
func (s *Settings) RelayURL() string {
	if s.Relay != "" {
		return s.Relay
	}
	return DefaultRelay
}

// AppURL is the phone's page in force.
func (s *Settings) AppURL() string {
	if s.App != "" {
		return s.App
	}
	return DefaultApp
}

// Load reads the settings, making keys on first use. A machine has one
// identity for its life: replacing the keys unpairs every phone, which is what
// `caprock remote reset` is for and nothing else does.
func Load(dir string) (*Settings, error) {
	var s Settings
	b, err := os.ReadFile(filepath.Join(dir, remoteFile))
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return nil, err
	default:
		if err := json.Unmarshal(b, &s); err != nil {
			return nil, fmt.Errorf("remote: %s: %w", remoteFile, err)
		}
	}
	if len(s.Sign) == ed25519.SeedSize && len(s.Static) == 32 {
		return &s, nil
	}
	s.Sign = make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(s.Sign); err != nil {
		return nil, err
	}
	st, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	s.Static = st.Bytes()
	if err := Save(dir, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// Save writes the settings, 0600.
func Save(dir string, s *Settings) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return config.WriteFileAtomic(filepath.Join(dir, remoteFile), b, 0o600)
}

// Reset forgets the keys, so the next Load makes new ones and every phone
// paired over the relay has to pair again.
func Reset(dir string) error {
	err := os.Remove(filepath.Join(dir, remoteFile))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

// CheckRelayURL accepts wss:// anywhere and ws:// only to this machine: a
// relay sees who talks to whom and when, and in clear text so would anyone
// on the path.
func CheckRelayURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return fmt.Errorf("%q is not a relay address", raw)
	}
	switch u.Scheme {
	case "wss":
		return nil
	case "ws":
		h := u.Hostname()
		if h == "localhost" || h == "127.0.0.1" || h == "::1" {
			return nil
		}
		return fmt.Errorf("%q: a relay off this machine must be wss://", raw)
	}
	return fmt.Errorf("%q: a relay address starts wss://", raw)
}

// CheckAppURL accepts https:// anywhere and http:// only on this machine: the
// phone's page holds its keys, and a page fetched in clear text is a page
// anyone on the path can replace.
func CheckAppURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return fmt.Errorf("%q is not a page address", raw)
	}
	switch u.Scheme {
	case "https":
		return nil
	case "http":
		h := u.Hostname()
		if h == "localhost" || h == "127.0.0.1" || h == "::1" || strings.HasSuffix(h, ".localhost") {
			return nil
		}
	}
	return fmt.Errorf("%q: the phone's page must be https://", raw)
}

// PairLink is what the pairing QR holds: the phone's page, told which relay,
// which machine, which key to pin, the code, and what to call the machine.
// All of it after the #, so none of it reaches the page's server.
func PairLink(s *Settings, k *Keys, code, name string) string {
	q := url.Values{}
	q.Set("r", s.RelayURL())
	q.Set("h", k.HostID())
	q.Set("k", k.StaticPublic())
	if code != "" {
		q.Set("c", code)
	}
	if name != "" {
		// Short, so a long host name cannot push the link past what one QR
		// holds (internal/qr.MaxBytes).
		if r := []rune(name); len(r) > 24 {
			name = string(r[:24])
		}
		q.Set("n", name)
	}
	return strings.TrimRight(s.AppURL(), "/") + "/#/pair?" + q.Encode()
}
