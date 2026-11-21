package store

import (
	"context"
	"testing"

	"github.com/dspv/caprock/internal/diskio"
)

func TestShortFunc(t *testing.T) {
	for in, want := range map[string]string{
		"github.com/dspv/caprock/internal/store.scanEventParts":             "store.scanEventParts",
		"github.com/dspv/caprock/internal/rollup.(*Recorder).PriceUnpriced": "rollup.(*Recorder).PriceUnpriced",
		"github.com/dspv/caprock/internal/api.(*Server).routes.func3.1":     "api.(*Server).routes",
		"github.com/dspv/caprock/internal/store.(*PartsCache).read.funcy":   "store.(*PartsCache).read.funcy",
		"main.main": "main.main",
	} {
		if got := shortFunc(in); got != want {
			t.Errorf("shortFunc(%q) = %q, want %q", in, got, want)
		}
	}
}

// askingForIt is the function whose name the statement's reads go under.
func askingForIt(t *testing.T, s *Store) {
	t.Helper()
	var n int
	if err := s.DB().QueryRowContext(context.Background(), `SELECT count(*) FROM sqlite_schema`).Scan(&n); err != nil {
		t.Fatal(err)
	}
}

func TestStatementsCountUnderTheirCaller(t *testing.T) {
	s, err := Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	const name = "sql store.askingForIt"
	before := diskio.Snapshot()[name].Ops
	askingForIt(t, s)
	if got := diskio.Snapshot()[name].Ops; got != before+1 {
		t.Errorf("%q ran %d operations, want %d", name, got, before+1)
	}
}
