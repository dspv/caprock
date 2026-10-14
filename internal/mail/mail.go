// Package mail is Caprock Mail: an IMAP/SMTP client that keeps every inbox
// the user adds in one local database (mail.db, beside Caprock's own) and
// serves it to the dashboard under /v1/mail.
//
// It is an integration the user switches on by adding an account (ADR-047):
// until then nothing is opened, no goroutine runs and nothing leaves the
// machine. Once an account exists, Caprock talks only to the IMAP and SMTP
// servers the user typed in (for an account signed in with Google or
// Microsoft: that provider's servers and token endpoint, internal/mail/oauth),
// and — when local AI is turned on — to the model
// server at the address in Mail's settings (loopback by default).
package mail

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"

	"github.com/dspv/caprock/internal/mail/engine"
	store "github.com/dspv/caprock/internal/mail/mailstore"
	"github.com/dspv/caprock/internal/mail/secrets"
	"github.com/dspv/caprock/internal/secret"
)

// Service owns Mail's database and sync engine, both opened on first use.
//
// Sample mode (POST /v1/mail/sample, or CAPROCK_MAIL_DEMO=1 for the whole
// run) puts a second, throwaway instance in front of the real one: two sample
// accounts on in-process fake servers, a temporary database and passwords
// kept in memory. While it is on every route serves the sample; the real
// mail.db and the keychain are not touched, and turning it off drops the
// sample and leaves the real instance as it was (or still unopened).
type Service struct {
	dir  string
	log  *slog.Logger
	sec  secrets.Store
	demo bool   // CAPROCK_MAIL_DEMO=1: sample mode for the whole run
	home string // the user's home dir, for importing other clients' accounts

	mu      sync.Mutex
	st      *store.Store
	eng     *engine.Engine
	sample  *sampleBox   // non-nil while sample mode is on
	version atomic.Int64 // bumped on every local change; the UI polls it
	oauth   oauthFlows   // sign-ins with Google/Microsoft waiting for the browser
}

// sampleBox is the throwaway instance behind sample mode.
type sampleBox struct {
	st      *store.Store
	eng     *engine.Engine
	sec     secrets.Store
	cleanup func()
}

// New prepares Mail under dataDir. If Mail was used before (mail.db exists)
// its accounts start syncing at once; otherwise nothing happens until the
// dashboard asks.
//
// CAPROCK_MAIL_DEMO=1 starts in sample mode and keeps it on, for screenshots;
// the real mail.db is then never opened.
func New(dataDir string, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	s := &Service{dir: dataDir, log: log.With("component", "mail"),
		sec: secrets.Default(dataDir), demo: os.Getenv("CAPROCK_MAIL_DEMO") == "1"}
	if _, err := os.Stat(s.dbPath()); err == nil && !s.demo {
		if _, err := s.open(); err != nil {
			s.log.Warn("mail: open", "err", err)
		}
	}
	return s
}

func (s *Service) dbPath() string { return filepath.Join(s.dir, "mail.db") }

// homeDir is the user's home directory, read once and cached. The account
// importer reads another mail client's local files under it.
func (s *Service) homeDir() string {
	if s.home == "" {
		s.home = secret.UserHome(context.Background())
	}
	return s.home
}

// open opens the real database and starts its engine, once.
func (s *Service) open() (*store.Store, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.openLocked()
}

func (s *Service) openLocked() (*store.Store, error) {
	if s.st != nil {
		return s.st, nil
	}
	path := s.dbPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	st, err := store.Open(path)
	if err != nil {
		return nil, err
	}
	eng := engine.New(st, s.sec, func(string, int64) { s.version.Add(1) })
	if err := eng.Start(); err != nil {
		st.Close()
		return nil, err
	}
	s.st, s.eng = st, eng
	return st, nil
}

// startSampleLocked builds the sample instance; a no-op while it is on.
func (s *Service) startSampleLocked() error {
	if s.sample != nil {
		return nil
	}
	dir, err := os.MkdirTemp("", "caprock-mail-sample-")
	if err != nil {
		return err
	}
	st, err := store.Open(filepath.Join(dir, "mail.db"))
	if err != nil {
		_ = os.RemoveAll(dir)
		return err
	}
	sec := &secrets.Memory{}
	stop, err := seedDemo(st, sec)
	if err != nil {
		st.Close()
		_ = os.RemoveAll(dir)
		return err
	}
	eng := engine.New(st, sec, func(string, int64) { s.version.Add(1) })
	if err := eng.Start(); err != nil {
		stop()
		st.Close()
		_ = os.RemoveAll(dir)
		return err
	}
	s.sample = &sampleBox{st: st, eng: eng, sec: sec, cleanup: func() { stop(); _ = os.RemoveAll(dir) }}
	s.version.Add(1)
	return nil
}

func (s *Service) stopSampleLocked() {
	b := s.sample
	if b == nil {
		return
	}
	s.sample = nil
	b.eng.Stop()
	b.st.Close()
	b.cleanup()
	s.version.Add(1)
}

var errDemoForced = errors.New("sample mode is on for this run (CAPROCK_MAIL_DEMO=1)")

// SetSample turns sample mode on or off. Under CAPROCK_MAIL_DEMO=1 it cannot
// be turned off.
func (s *Service) SetSample(on bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if on {
		return s.startSampleLocked()
	}
	if s.demo {
		return errDemoForced
	}
	s.stopSampleLocked()
	return nil
}

// leaveSample ends sample mode before a real account is added, so the
// account lands in the real mail.db and the user's own mail replaces the
// sample (Mail opens on the sample while no account exists, and another
// window may have turned it back on while this one showed the form).
// Under CAPROCK_MAIL_DEMO=1 the sample stays: that run never opens the real
// database.
func (s *Service) leaveSample() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.demo {
		s.stopSampleLocked()
	}
}

// inSample reports whether the routes serve the sample instance.
func (s *Service) inSample() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sample != nil || s.demo
}

// opened reports whether Mail has been used at all, without opening it.
func (s *Service) opened() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.st != nil || s.sample != nil
}

// secrets is where the passwords of the instance being served live: the
// system keychain, or memory while sample mode is on.
func (s *Service) secrets() secrets.Store {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sample != nil {
		return s.sample.sec
	}
	return s.sec
}

// Close stops syncing and closes the database (and the sample, if on).
func (s *Service) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stopSampleLocked()
	if s.eng != nil {
		s.eng.Stop()
	}
	if s.st != nil {
		s.st.Close()
	}
	s.st, s.eng = nil, nil
}

var errClosed = errors.New("mail is not open")

// parts hands a route the instance it serves: the sample while sample mode is
// on, else the real one (opened on first use).
func (s *Service) parts(ctx context.Context) (*store.Store, *engine.Engine, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.demo && s.sample == nil {
		if err := s.startSampleLocked(); err != nil {
			return nil, nil, err
		}
	}
	if b := s.sample; b != nil {
		return b.st, b.eng, ctx.Err()
	}
	if _, err := s.openLocked(); err != nil {
		return nil, nil, err
	}
	if s.eng == nil {
		return nil, nil, errClosed
	}
	return s.st, s.eng, ctx.Err()
}
