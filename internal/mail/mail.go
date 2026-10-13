// Package mail is Caprock Mail: an IMAP/SMTP client that keeps every inbox
// the user adds in one local database (mail.db, beside Caprock's own) and
// serves it to the dashboard under /v1/mail.
//
// It is an integration the user switches on by adding an account (ADR-047):
// until then nothing is opened, no goroutine runs and nothing leaves the
// machine. Once an account exists, Caprock talks only to the IMAP and SMTP
// servers the user typed in, and — when local AI is turned on — to the model
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
)

// Service owns Mail's database and sync engine, both opened on first use.
type Service struct {
	dir  string
	log  *slog.Logger
	sec  secrets.Store
	demo bool

	mu      sync.Mutex
	st      *store.Store
	eng     *engine.Engine
	cleanup func()
	version atomic.Int64 // bumped on every local change; the UI polls it
}

// New prepares Mail under dataDir. If Mail was used before (mail.db exists)
// its accounts start syncing at once; otherwise nothing happens until the
// dashboard asks.
//
// CAPROCK_MAIL_DEMO=1 replaces everything with two sample accounts on
// in-process fake servers and a throwaway database, for screenshots and for
// trying the screen without a real account.
func New(dataDir string, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	s := &Service{dir: dataDir, log: log.With("component", "mail"),
		sec: secrets.Fallback{Primary: secrets.Keychain{}, File: &secrets.File{Path: filepath.Join(dataDir, "mail-secrets.json")}}}
	if os.Getenv("CAPROCK_MAIL_DEMO") == "1" {
		s.demo = true
		s.sec = &secrets.Memory{}
	}
	if _, err := os.Stat(s.dbPath()); err == nil && !s.demo {
		if _, err := s.open(); err != nil {
			s.log.Warn("mail: open", "err", err)
		}
	}
	return s
}

func (s *Service) dbPath() string { return filepath.Join(s.dir, "mail.db") }

// open opens the database and starts the engine, once.
func (s *Service) open() (*store.Store, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.st != nil {
		return s.st, nil
	}
	path := s.dbPath()
	if s.demo {
		d, err := os.MkdirTemp("", "caprock-mail-demo-")
		if err != nil {
			return nil, err
		}
		path = filepath.Join(d, "mail.db")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	st, err := store.Open(path)
	if err != nil {
		return nil, err
	}
	if s.demo {
		cleanup, err := seedDemo(st, s.sec)
		if err != nil {
			st.Close()
			return nil, err
		}
		dir := filepath.Dir(path)
		s.cleanup = func() { cleanup(); os.RemoveAll(dir) }
	}
	s.eng = engine.New(st, s.sec, func(string, int64) { s.version.Add(1) })
	if err := s.eng.Start(); err != nil {
		st.Close()
		return nil, err
	}
	s.st = st
	return st, nil
}

// opened reports whether Mail has been used at all, without opening it.
func (s *Service) opened() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.st != nil
}

// Close stops syncing and closes the database.
func (s *Service) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.eng != nil {
		s.eng.Stop()
	}
	if s.st != nil {
		s.st.Close()
	}
	if s.cleanup != nil {
		s.cleanup()
	}
	s.st, s.eng = nil, nil
}

var errClosed = errors.New("mail is not open")

func (s *Service) parts(ctx context.Context) (*store.Store, *engine.Engine, error) {
	st, err := s.open()
	if err != nil {
		return nil, nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.eng == nil {
		return nil, nil, errClosed
	}
	return st, s.eng, ctx.Err()
}
