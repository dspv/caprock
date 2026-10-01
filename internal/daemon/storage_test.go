package daemon

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

// A directory is reported as the sum of everything under it, every entry is
// counted once in the total, and the largest comes first.
func TestDataDirSizesSumsDirectoriesAndSortsBySize(t *testing.T) {
	dir := t.TempDir()
	write := func(p string, n int) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, make([]byte, n), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(dir, "caprock.db"), 5000)
	write(filepath.Join(dir, "caprock.db-wal"), 100)
	write(filepath.Join(dir, "chats", "a", "x.json"), 300)
	write(filepath.Join(dir, "chats", "y.json"), 400)
	if err := os.MkdirAll(filepath.Join(dir, "paste"), 0o700); err != nil {
		t.Fatal(err)
	}

	files, total := dataDirSizes(dir)
	if total != 5800 {
		t.Fatalf("total %d", total)
	}
	want := []FileSize{{"caprock.db", 5000, false}, {"chats", 700, true}, {"caprock.db-wal", 100, false}, {"paste", 0, true}}
	if len(files) != len(want) {
		t.Fatalf("files %+v", files)
	}
	for i := range want {
		if files[i] != want[i] {
			t.Fatalf("files[%d] = %+v, want %+v", i, files[i], want[i])
		}
	}
	if f, n := dataDirSizes(filepath.Join(dir, "missing")); f != nil || n != 0 {
		t.Fatalf("missing dir: %v %d", f, n)
	}
}

// The growth estimate scales the last 30 days' payload by what a payload byte
// has cost on disk so far, and says nothing rather than guessing when there is
// nothing to scale by.
func TestGrowthPerDayScalesRecentPayloadByTheOnDiskRatio(t *testing.T) {
	db := &store.Storage{
		PayloadBytes: 1000,
		Tables:       []store.TableSize{{Name: "events", DataBytes: 1500, IndexBytes: 500}, {Name: "sessions", DataBytes: 9999}},
		Recent:       []store.WindowSize{{Days: 7, PayloadBytes: 70}, {Days: 30, PayloadBytes: 300}},
	}
	// 300 bytes over 30 days is 10 a day; each payload byte cost 2 on disk.
	if got := growthPerDay(db); got != 20 {
		t.Fatalf("growth %d, want 20", got)
	}
	if got := growthPerDay(&store.Storage{}); got != 0 {
		t.Fatalf("empty database: %d", got)
	}
	noDbstat := *db
	noDbstat.Tables = nil
	if got := growthPerDay(&noDbstat); got != 0 {
		t.Fatalf("without table sizes: %d", got)
	}
}
