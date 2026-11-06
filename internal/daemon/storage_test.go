package daemon

import (
	"os"
	"path/filepath"
	"testing"
	"time"

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

// The sidebar's offer to compress is copied from the cached measurement: none
// before one, none with the switch on, none once anything is compressed or
// with no estimate, and otherwise the measured size and the estimate.
func TestCompressOfferFollowsTheSwitchAndTheMeasurement(t *testing.T) {
	d := &Daemon{}
	if o := d.compressOffer(); o != nil {
		t.Fatalf("offer before any measurement: %+v", o)
	}
	at := time.UnixMilli(1_790_000_000_000)
	measured := store.Storage{PageSize: 4096, PageCount: 610_000, Compression: store.ToolCompression{
		EligibleBytes: 1_400_000_000, SampleRows: 2000, SamplePlain: 10_000_000, SampleStored: 4_000_000, EstSavingBytes: 840_000_000,
	}}
	d.storage.db, d.storage.at = &measured, at
	o := d.compressOffer()
	want := CompressOffer{DBBytes: 4096 * 610_000, EstSavingBytes: 840_000_000, SampleRows: 2000, MeasuredAt: at.UnixMilli()}
	if o == nil || *o != want {
		t.Fatalf("offer %+v, want %+v", o, want)
	}
	on := true
	d.opt.Config.CompressToolOutput = &on
	if o := d.compressOffer(); o != nil {
		t.Fatalf("offer with the switch on: %+v", o)
	}
	off := false
	d.opt.Config.CompressToolOutput = &off
	used := measured
	used.Compression.Rows = 10
	d.storage.db = &used
	if o := d.compressOffer(); o != nil {
		t.Fatalf("offer once something is compressed: %+v", o)
	}
	none := measured
	none.Compression.EstSavingBytes, none.Compression.SampleRows = 0, 0
	d.storage.db = &none
	if o := d.compressOffer(); o != nil {
		t.Fatalf("offer with no estimate: %+v", o)
	}
}
