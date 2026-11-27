package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/github"
	"github.com/dspv/caprock/internal/secret"
)

// Send secrets (ADR-107): the credentials this daemon keeps in its secret
// store that the owner may copy to a linked computer on a click, and where
// one that arrives from a computer is kept. Values pass through this file
// in memory only: read from the store for one send, written to the store
// when one arrives. Nothing here logs, publishes or saves a value.

// secretsReceivedFile records which names arrived, from which computer and
// when: names only, never a value. 0600 like the other per-machine lists.
const secretsReceivedFile = "secrets-received.json"

// secretsReceivedKeep bounds the record: the newest sends only.
const secretsReceivedKeep = 20

// maxSecretValue bounds one value on arrival; every credential here is a
// line of at most a few hundred characters.
const maxSecretValue = 4096

// shareable is one credential Send secrets offers.
type shareable struct {
	name, label string
	// get reads it from this machine's store; "" when it is not set here.
	get func(ctx context.Context) (string, error)
	// put writes an arriving value into this machine's store and makes it
	// the one in use, as entering it in Settings here would.
	put func(ctx context.Context, v string) error
	// note says why it is not set here when that is not obvious.
	note func() string
}

// secretShare is api.SecretShare.
type secretShare struct {
	d  *Daemon
	mu sync.Mutex // the record file
}

// shareables lists what may be sent, in the order Send secrets shows it.
// The Telegram bot token is not one: a bot answers one poller, and two
// computers polling it take each other's messages (ADR-107).
func (s *secretShare) shareables() []shareable {
	d := s.d
	return []shareable{
		{
			name: "github", label: "GitHub token",
			get: func(ctx context.Context) (string, error) {
				gh := d.ghLive.Load()
				if gh == nil {
					return "", nil
				}
				return gh.StoredToken(ctx)
			},
			put: func(ctx context.Context, v string) error {
				gh := d.ghLive.Load()
				if gh == nil {
					return errors.New("GitHub is not available in this build")
				}
				// The same path as a token pasted in Settings → GitHub here:
				// kept only once GitHub accepted it.
				if _, e := gh.Connect(ctx, github.SourceToken, v); e != nil {
					return errors.New(e.Message)
				}
				return nil
			},
			note: func() string {
				if gh := d.ghLive.Load(); gh != nil && gh.Status().Source == github.SourceGH {
					return "GitHub is connected through the GitHub CLI's sign-in here, which Caprock does not hold"
				}
				return ""
			},
		},
		{name: "deepseek", label: "DeepSeek key", get: d.deepSeekKey, put: s.keep(deepSeekSecret)},
		{name: "kimi", label: "Kimi key", get: d.kimiKey, put: s.keep(kimiSecret)},
	}
}

// keep writes an arriving provider key the way Settings does: the store
// first, then the in-memory copy and config.json's "stored" mark.
func (s *secretShare) keep(item secret.Item) func(ctx context.Context, v string) error {
	d := s.d
	return func(ctx context.Context, v string) error {
		if err := d.putSecret(ctx, item, v); err != nil {
			return fmt.Errorf("could not keep it in the %s: %w", d.secretStore(item).Kind(), err)
		}
		d.cfgMu.Lock()
		applySecret(&d.opt.Config, item, v)
		cfg := d.opt.Config
		d.cfgMu.Unlock()
		return config.Save(d.opt.DataDir, cfg)
	}
}

func (s *secretShare) find(name string) (shareable, bool) {
	for _, it := range s.shareables() {
		if it.name == name {
			return it, true
		}
	}
	return shareable{}, false
}

// SecretsHere lists every credential, set here or not. A store that cannot
// be read says not set; the send would say why.
func (s *secretShare) SecretsHere(ctx context.Context) []api.SecretItem {
	var out []api.SecretItem
	for _, it := range s.shareables() {
		v, _ := it.get(ctx)
		item := api.SecretItem{Name: it.name, Label: it.label, Set: strings.TrimSpace(v) != ""}
		if !item.Set && it.note != nil {
			item.Note = it.note()
		}
		out = append(out, item)
	}
	return out
}

// SecretValues reads the named credentials for one send.
func (s *secretShare) SecretValues(ctx context.Context, names []string) ([]api.SecretValue, error) {
	out := make([]api.SecretValue, 0, len(names))
	for _, n := range names {
		it, ok := s.find(n)
		if !ok {
			return nil, fmt.Errorf("no such secret: %q", n)
		}
		v, err := it.get(ctx)
		if err != nil {
			return nil, fmt.Errorf("could not read the %s here: %w", it.label, err)
		}
		if v = strings.TrimSpace(v); v == "" {
			return nil, fmt.Errorf("the %s is not set on this computer", it.label)
		}
		out = append(out, api.SecretValue{Name: it.name, Value: v})
	}
	return out, nil
}

// ReceiveSecrets keeps each arriving credential on its own: one that fails
// says why and leaves the others kept.
func (s *secretShare) ReceiveSecrets(ctx context.Context, from api.SecretSender, in []api.SecretValue) api.SecretReceipt {
	got := api.SecretReceipt{Stored: []string{}, Failed: []api.SecretFailure{}}
	seen := map[string]bool{}
	for _, sv := range in {
		name := strings.TrimSpace(sv.Name)
		if seen[name] {
			continue
		}
		seen[name] = true
		it, ok := s.find(name)
		if !ok {
			got.Failed = append(got.Failed, api.SecretFailure{Name: clip(name, 40), Error: "this computer does not keep a secret by that name"})
			continue
		}
		v := strings.TrimSpace(sv.Value)
		if v == "" || len(v) > maxSecretValue || strings.ContainsAny(v, "\r\n") {
			got.Failed = append(got.Failed, api.SecretFailure{Name: name, Error: "the value is not one line of text"})
			continue
		}
		if err := it.put(ctx, v); err != nil {
			got.Failed = append(got.Failed, api.SecretFailure{Name: name, Error: err.Error()})
			continue
		}
		got.Stored = append(got.Stored, name)
	}
	if len(got.Stored) > 0 {
		s.record(api.SecretArrival{FromID: from.ID, From: from.Name, Names: got.Stored, At: time.Now().UnixMilli()})
	}
	s.d.log.Info("secrets arrived from another computer", "component", "secrets", "from", from.Name, "stored", got.Stored, "failed", len(got.Failed))
	return got
}

// SecretsReceived is the record, newest first; a missing or unreadable file
// is none.
func (s *secretShare) SecretsReceived() []api.SecretArrival {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readLocked()
}

func (s *secretShare) path() string {
	return filepath.Join(s.d.opt.DataDir, secretsReceivedFile)
}

func (s *secretShare) readLocked() []api.SecretArrival {
	if s.d.opt.DataDir == "" {
		return nil
	}
	b, err := os.ReadFile(s.path())
	if err != nil {
		return nil
	}
	var list []api.SecretArrival
	if json.Unmarshal(b, &list) != nil {
		return nil
	}
	return list
}

func (s *secretShare) record(a api.SecretArrival) {
	if s.d.opt.DataDir == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	list := append([]api.SecretArrival{a}, s.readLocked()...)
	if len(list) > secretsReceivedKeep {
		list = list[:secretsReceivedKeep]
	}
	b, err := json.MarshalIndent(list, "", "  ")
	if err == nil {
		err = config.WriteFileAtomic(s.path(), b, 0o600)
	}
	if err != nil {
		s.d.log.Warn("could not record which secrets arrived", "component", "secrets", "err", err)
	}
}

// clip keeps a name a caller sent short in an answer.
func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}
