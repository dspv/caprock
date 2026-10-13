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
// every event row: 4.8 s and the whole 2.2 GB file on the owner's machine
// (2026-10-13). It used to run a minute after every start and then every 30
// minutes whether or not anyone looked — the slow-query log put it beside the
// startup scans as the daemon's biggest reads. It is now measured only when it
// is wanted:
//
//   - when GET /v1/storage finds the cached figures older than storageMaxAge
//     (or none at all), it starts a measurement in the background and answers
//     at once with what it has, saying `measuring: true`;
//   - at most once per storageMaxAge when the daemon has been idle —
//     nothing recorded for idleFor — so the figures are there when the
//     Storage panel is next opened, measured at a moment nobody is working.
//
// A request reads the cache and stats the data directory, which is a few
// dozen files.
const storageMaxAge = 24 * time.Hour

// storageState is the cached measurement.
type storageState struct {
	mu   sync.Mutex
	db   *store.Storage
	at   time.Time
	took time.Duration
	err  string
	// running is set while a measurement is in flight; tried is when the
	// last one started, failed or not, so a failing measurement is retried
	// once per storageMaxAge rather than on every request.
	running bool
	tried   time.Time
}

// storageDue reports whether a measurement last started at tried is too old
// to serve as it is.
func storageDue(tried, now time.Time) bool {
	return tried.IsZero() || now.Sub(tried) >= storageMaxAge
}

// startMeasure starts a background measurement unless one is running or the
// last one is recent enough. It reports whether one is running now.
func (d *Daemon) startMeasure(now time.Time) bool {
	d.storage.mu.Lock()
	defer d.storage.mu.Unlock()
	if d.storage.running {
		return true
	}
	if !storageDue(d.storage.tried, now) {
		return false
	}
	d.storage.running, d.storage.tried = true, now
	ctx := d.baseCtx
	if ctx == nil {
		ctx = context.Background()
	}
	go d.measureStorage(ctx)
	return true
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
	// Measuring is true while a measurement runs in the background; the
	// figures above are the previous one's until it finishes.
	Measuring bool `json:"measuring,omitempty"`
	// ReclaimableBytes is the database's free pages: what a VACUUM would hand
	// back to the disk. Zero until measured.
	ReclaimableBytes int64 `json:"reclaimable_bytes"`
	// ReturnsFreeSpace is true when the database is in incremental
	// auto-vacuum mode: free pages go back to the disk on their own while
	// the daemon is idle (compact.go). False until the one VACUUM that
	// switches an older database over has run.
	ReturnsFreeSpace bool `json:"returns_free_space"`
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

func (d *Daemon) measureStorage(ctx context.Context) {
	t0 := time.Now()
	st, err := store.MeasureStorage(ctx, d.store.DB(), d.rec.Now())
	took := time.Since(t0)
	d.storage.mu.Lock()
	defer d.storage.mu.Unlock()
	d.storage.running = false
	if err != nil {
		// Keep the previous figures: a failed refresh should not blank a
		// panel that was right half an hour ago.
		d.storage.err = err.Error()
		d.log.Warn("storage measurement", "component", "daemon", "err", err)
		return
	}
	d.storage.db, d.storage.at, d.storage.took, d.storage.err = &st, time.Now(), took, ""
	d.log.Info("storage measured", "component", "daemon", "took_ms", took.Milliseconds(), "database_bytes", st.PageCount*st.PageSize)
}

// storageReport answers GET /v1/storage, starting a measurement when the
// cached one is older than storageMaxAge.
func (d *Daemon) storageReport(ctx context.Context) any {
	measuring := d.startMeasure(time.Now())
	files, total := dataDirSizes(d.opt.DataDir)
	r := StorageReport{
		DataDir: d.opt.DataDir, TotalBytes: total, Files: files,
		RetentionDays: d.config().RetentionDays,
	}
	d.storage.mu.Lock()
	db, at, took, errText := d.storage.db, d.storage.at, d.storage.took, d.storage.err
	d.storage.mu.Unlock()
	r.Error = errText
	r.Measuring = measuring
	if d.store != nil {
		if m, err := d.store.AutoVacuum(ctx); err == nil {
			r.ReturnsFreeSpace = m == store.AutoVacuumIncremental
		}
	}
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
