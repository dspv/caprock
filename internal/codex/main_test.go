package codex

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

// templateDir holds one database store.Open created and migrated, made the
// first time a test asks for a store and removed when the package's tests end.
var (
	templateDir  string
	templateOnce sync.Once
	templateErr  error
)

func TestMain(m *testing.M) {
	code := m.Run()
	if templateDir != "" {
		_ = os.RemoveAll(templateDir)
	}
	os.Exit(code)
}

// openStore opens a throwaway store for t. Every test used to migrate a new
// database from nothing — over 70 migrations and their backfills, about a
// second each under -race, paid more than a hundred times across the
// package. The schema is migrated once instead and each test opens its own
// copy of the file, through the same store.Open, so what a test sees is what
// a fresh open gives it. Migrating from nothing is the store package's to test.
func openStore(t testing.TB, lg *slog.Logger) *store.Store {
	t.Helper()
	templateOnce.Do(func() {
		dir, err := os.MkdirTemp("", "caprock-codex-template-")
		if err != nil {
			templateErr = err
			return
		}
		templateDir = dir
		st, err := store.Open(context.Background(), filepath.Join(dir, "caprock.db"), lg)
		if err != nil {
			templateErr = err
			return
		}
		// Closing the last connection checkpoints the WAL into the main
		// file, so the file alone is the whole database.
		templateErr = st.Close()
	})
	if templateErr != nil {
		t.Fatalf("template store: %v", templateErr)
	}
	b, err := os.ReadFile(filepath.Join(templateDir, "caprock.db"))
	if err != nil {
		t.Fatalf("read template store: %v", err)
	}
	path := filepath.Join(t.TempDir(), "caprock.db")
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatalf("copy template store: %v", err)
	}
	st, err := store.Open(context.Background(), path, lg)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}
