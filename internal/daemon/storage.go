package daemon

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// How the storage figures stay cheap.
//
// The database's composition costs a walk of every page (dbstat) and a read of
// every event row. Against the owner's 857 MB database that measured 8
// seconds warm and 14 cold through this driver — fine once in a while in the
// background, and out of the question on a request a screen polls. So the composition is
// measured on a timer and cached; a request reads the cache and stats the data
// directory, which is a few dozen files.
//
// The first measurement waits a minute after start: a fresh daemon is already
// backfilling transcripts, and a full-file read competing with that only makes
// both slower.
const (
	storageFirstDelay = time.Minute
	storageEvery      = 30 * time.Minute
)

// storageState is the cached measurement.
type storageState struct {
	mu   sync.Mutex
	db   *store.Storage
	at   time.Time
	took time.Duration
	err  string
}

// StorageReport is what GET /v1/storage returns. See 03-contracts.md § Storage.
type StorageReport struct {
	DataDir string `json:"data_dir"`
	// TotalBytes is every file under the data directory, the database
	// included; Files splits it by top-level entry, largest first.
	TotalBytes int64      `json:"total_bytes"`
	Files      []FileSize `json:"files"`
	// Database is the cached composition, absent until it has been measured
	// once; MeasuredAt and MeasureMs say when and how long it took.
	Database   *store.Storage `json:"database,omitempty"`
	MeasuredAt int64          `json:"measured_at,omitempty"`
	MeasureMs  int64          `json:"measure_ms,omitempty"`
	Error      string         `json:"error,omitempty"`
	// ReclaimableBytes is the database's free pages: what a VACUUM would hand
	// back to the disk. Zero until measured.
	ReclaimableBytes int64 `json:"reclaimable_bytes"`
	// GrowthBytesPerDayEst is an estimate, and named as one: the bytes of
	// event payload recorded over the last 30 days, per day, scaled by how
	// many bytes on disk each payload byte has cost so far (the events table
	// and its indexes over the payload they hold). Zero when there is too
	// little to scale by.
	GrowthBytesPerDayEst int64 `json:"growth_bytes_per_day_est"`
	RetentionDays        int   `json:"retention_days"`
}

// FileSize is one top-level entry of the data directory; a directory is the
// sum of the files under it.
type FileSize struct {
	Name  string `json:"name"`
	Bytes int64  `json:"bytes"`
	Dir   bool   `json:"dir,omitempty"`
}

// storageLoop keeps the cached composition fresh.
func (d *Daemon) storageLoop(ctx context.Context) {
	t := time.NewTimer(storageFirstDelay)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			d.measureStorage(ctx)
			t.Reset(storageEvery)
		}
	}
}

func (d *Daemon) measureStorage(ctx context.Context) {
	t0 := time.Now()
	st, err := store.MeasureStorage(ctx, d.store.DB(), d.rec.Now())
	took := time.Since(t0)
	d.storage.mu.Lock()
	defer d.storage.mu.Unlock()
	if err != nil {
		// Keep the previous figures: a failed refresh should not blank a
		// panel that was right half an hour ago.
		d.storage.err = err.Error()
		d.log.Warn("storage measurement", "component", "daemon", "err", err)
		return
	}
	d.storage.db, d.storage.at, d.storage.took, d.storage.err = &st, time.Now(), took, ""
	d.log.Debug("storage measured", "component", "daemon", "took", took)
}

// storageReport answers GET /v1/storage.
func (d *Daemon) storageReport(_ context.Context) any {
	files, total := dataDirSizes(d.opt.DataDir)
	r := StorageReport{
		DataDir: d.opt.DataDir, TotalBytes: total, Files: files,
		RetentionDays: d.config().RetentionDays,
	}
	d.storage.mu.Lock()
	db, at, took, errText := d.storage.db, d.storage.at, d.storage.took, d.storage.err
	d.storage.mu.Unlock()
	r.Error = errText
	if db != nil {
		r.Database = db
		r.MeasuredAt, r.MeasureMs = at.UnixMilli(), took.Milliseconds()
		r.ReclaimableBytes = db.FreePages * db.PageSize
		r.GrowthBytesPerDayEst = growthPerDay(db)
	}
	return r
}

// growthPerDay is the estimate StorageReport.GrowthBytesPerDayEst describes.
func growthPerDay(db *store.Storage) int64 {
	if db.PayloadBytes <= 0 {
		return 0
	}
	var onDisk int64
	for _, t := range db.Tables {
		if t.Name == "events" {
			onDisk = t.DataBytes + t.IndexBytes
		}
	}
	var recent *store.WindowSize
	for i := range db.Recent {
		if db.Recent[i].Days == 30 {
			recent = &db.Recent[i]
		}
	}
	if onDisk == 0 || recent == nil {
		return 0
	}
	perDay := float64(recent.PayloadBytes) / float64(recent.Days)
	return int64(perDay * float64(onDisk) / float64(db.PayloadBytes))
}

// dataDirSizes sums every regular file under dir by top-level entry. Errors are
// skipped rather than returned: a file that vanishes mid-walk (a rotated log,
// a checkpointed WAL) is a normal event, and a partial total is still the
// right order of magnitude.
func dataDirSizes(dir string) ([]FileSize, int64) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, 0
	}
	var out []FileSize
	var total int64
	for _, e := range entries {
		f := FileSize{Name: e.Name(), Dir: e.IsDir()}
		if e.IsDir() {
			_ = filepath.WalkDir(filepath.Join(dir, e.Name()), func(_ string, de fs.DirEntry, walkErr error) error {
				// An unreadable entry is skipped, not fatal; see above.
				if walkErr == nil && !de.IsDir() {
					if info, err := de.Info(); err == nil && info.Mode().IsRegular() {
						f.Bytes += info.Size()
					}
				}
				return nil
			})
		} else if info, err := e.Info(); err == nil && info.Mode().IsRegular() {
			f.Bytes = info.Size()
		}
		total += f.Bytes
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Bytes != out[j].Bytes {
			return out[i].Bytes > out[j].Bytes
		}
		return out[i].Name < out[j].Name
	})
	return out, total
}
