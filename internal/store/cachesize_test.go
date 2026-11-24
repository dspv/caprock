package store

import (
	"context"
	"path/filepath"
	"testing"
)

// Every pooled connection gets a 4 MiB page cache (store.go: 16 MiB held
// 367 MB of SQLite's allocator on a stand at the owner's scale, 4 MiB 98 MB).
func TestPageCacheIsFourMiB(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "caprock.db"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var kib int
	if err := s.DB().QueryRowContext(ctx, `PRAGMA cache_size`).Scan(&kib); err != nil {
		t.Fatal(err)
	}
	if kib != -4096 {
		t.Fatalf("cache_size = %d, want -4096 (4 MiB)", kib)
	}
}
