package daemon

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/procstat"
	"github.com/dspv/caprock/internal/store"
)

// Packing the database when the user asks (POST /v1/storage/pack; ADR-093,
// amended 2026-11-07).
//
// The VACUUM that packs the pages compression left half empty waits for 30
// minutes with nothing recorded (compact.go), which a machine running agents
// around the clock never has. So the status strip offers it, with an estimate of
// how long it takes and what it frees, and the user starts it.
//
// **Writes during a pack.** The idle VACUUM stands down for any write; this
// one does not, or it would never finish on such a machine. Instead the
// recorder — the one path every hook event, transcript line and import
// takes into the database — is held (rollup.Recorder.Exclusive) from just
// before the VACUUM until it commits:
//
//   - **A hook.** The shim posts and gives up after its 900 ms (5 s for
//     Stop, 1.5 s for SessionStart) and exits 0, as it does whenever the
//     daemon is slow (rule 3): the session never waits. The handler keeps
//     the event in memory, waits for the recorder, and writes it when the
//     VACUUM commits, on a context nothing cancels. Nothing is lost; what
//     the session misses is an answer — a task runner's Stop decision or a
//     SessionStart handoff that comes after the write.
//   - **A transcript line.** The tailer waits in the recorder the same way;
//     it reads the line again anyway if a write ever fails.
//   - **Anything else that writes** — a setting saved, a queued message —
//     waits in SQLite's busy handler for its usual 5 s and may fail with
//     "database is locked", which the screen that sent it shows. The
//     strip's popover says new events wait before the user starts it.
//
// The fold of the write-ahead log back into the file (a fifth of the run)
// happens after the recorder is let go: it takes no lock a writer needs.
const (
	// packRateDefault is the rate of a pack on a machine that has never run
	// one: bytes of the database's used size per second of the whole run.
	// Measured on copies of the owner's database (2026-11-07): 2,001 MiB in
	// 49 s and in 56 s (40.7 and 35.7 MiB/s), 2,595 MiB in 108 s (24.0
	// MiB/s, the machine busier). The slowest, so the estimate errs long;
	// each pack stores its own rate (metaPackRate) for the next estimate.
	packRateDefault = 24 << 20
	// packHoldShare is the part of a pack during which new events wait: the
	// copy and the write into the log, before the fold. 43 s of 56 and 84 s
	// of 108 on the runs above.
	packHoldShare = 0.78
	// packEstimateMaxAge is how long a sampled estimate is reused.
	packEstimateMaxAge = 15 * time.Minute
	// packSampleEvery is how often a running pack's progress is read.
	packSampleEvery = 500 * time.Millisecond
	// packBusyTries is how many more times a VACUUM that found the database
	// locked is tried, a second apart.
	packBusyTries = 5
	// packTruncateWait is how long the TRUNCATE checkpoint after a pack waits
	// for readers, holding the write lock meanwhile.
	packTruncateWait = 200 * time.Millisecond
	// metaPackRate is the rate the last pack on this machine ran at, in
	// bytes of used size per second.
	metaPackRate = "pack_rate_bps"
)

// Pack phases, in order.
const (
	packWaiting   = "waiting"   // for the background step or a write in flight
	packCopying   = "copying"   // SQLite builds the packed copy in a temporary file
	packWriting   = "writing"   // the copy goes into the write-ahead log
	packFinishing = "finishing" // the log is folded back into the file
)

// PackReport is GET /v1/storage/pack: where compression is, and the pack —
// running, offered or last done. Cheap to poll: a few meta reads, one
// indexed lookup and PRAGMAs; the page sample behind the offer is cached.
type PackReport struct {
	Compression CompressionReport `json:"compression"`
	Pack        PackStatus        `json:"pack"`
}

// PackStatus is the pack's part of PackReport.
type PackStatus struct {
	// DBBytes is the file's size now (page_count × page_size).
	DBBytes int64         `json:"db_bytes"`
	Running *PackProgress `json:"running,omitempty"`
	Offer   *PackOffer    `json:"offer,omitempty"`
	// Estimating is true while the sample behind the offer is being read.
	Estimating bool      `json:"estimating,omitempty"`
	Last       *PackLast `json:"last,omitempty"`
}

// PackOffer is what a pack would do now, before the user starts it.
type PackOffer struct {
	UsedBytes int64 `json:"used_bytes"`
	// FreeBytesEst is what it would give back to the disk: an estimate from
	// SampledPages random pages (store.EstimatePack), named as one.
	FreeBytesEst int64 `json:"free_bytes_est"`
	SampledPages int   `json:"sampled_pages"`
	// EstSeconds is how long it would take, and HoldSecondsEst how long new
	// events would wait meanwhile: UsedBytes over the rate of the last pack
	// on this machine (RateMeasured), or over the default rate measured on
	// the owner's machine.
	EstSeconds     int64 `json:"est_seconds"`
	HoldSecondsEst int64 `json:"hold_seconds_est"`
	RateMeasured   bool  `json:"rate_measured,omitempty"`
	// Worth is true when the status strip offers it: the saving is at least
	// packOfferMin and compression is not part-way through a pass.
	Worth bool `json:"worth"`
}

// PackProgress is a running pack. Progress is measured, not timed: the
// bytes SQLite has written in the current phase against what the phase
// writes in all, the three phases a third each — the packed copy's growth
// in its temporary file, the write-ahead log's growth, and the bytes the
// process has written while folding the log back. -1 where this OS gives no
// such reading (the temporary file on Windows, the process's written bytes
// on Windows): the bar then moves with the phases only.
type PackProgress struct {
	Phase     string  `json:"phase"`
	Progress  float64 `json:"progress"`
	StartedMs int64   `json:"started_ms"`
	ElapsedMs int64   `json:"elapsed_ms"`
	// EstSeconds is the estimate the pack started with.
	EstSeconds int64 `json:"est_seconds"`
	// EventsWait is true until the VACUUM has committed: new events are
	// held in memory meanwhile.
	EventsWait bool `json:"events_wait"`
}

// PackLast is how the last pack in this daemon's run ended.
type PackLast struct {
	AtMs        int64  `json:"at_ms"`
	OK          bool   `json:"ok"`
	Why         string `json:"why,omitempty"`
	BeforeBytes int64  `json:"before_bytes"`
	AfterBytes  int64  `json:"after_bytes,omitempty"`
	TookMs      int64  `json:"took_ms"`
	// HoldMs is how long new events waited.
	HoldMs int64 `json:"hold_ms,omitempty"`
}

// packState is the running pack, the last one, and the cached estimate.
type packState struct {
	mu   sync.Mutex
	run  *packRun
	last *PackLast
	est  *store.PackEstimate
	// estAt is when est was read; estRunning is set while a read is in
	// flight; estSeed changes with every read so a stale sample is not
	// repeated.
	estAt      time.Time
	estRunning bool
	estSeed    uint64
}

// packRun is a pack in progress.
type packRun struct {
	started    time.Time
	estSeconds int64
	phase      string
	progress   float64
	// expected is the packed size the copy phase is measured against: used
	// less the estimated saving, until the copy has finished and its real
	// size is known (tmpPeak).
	expected int64
	tmpPeak  int64
	walStart int64
	walEnd   int64
	ioBase   uint64
	ioOK     bool
	eventsOK bool
}

// packOfferMin is the estimated saving below which the status strip does not
// offer a pack: the bar compression's own repack uses (zstdRepackMin). A
// variable for tests.
var packOfferMin int64 = 256 << 20

// The readings behind a running pack's progress; variables for tests.
var (
	tempBytes  = sqliteTempBytes
	wroteBytes = selfWritten
)

// packHeld, when set, runs once the recorder is held, before the VACUUM:
// tests use it to send events at that moment.
var packHeld func()

// ErrPackRunning is returned when a pack is asked for while one runs.
var ErrPackRunning = errors.New("the database is already being packed")

// ErrPackRoom is returned when the disk has no room for the copy a pack
// makes.
var ErrPackRoom = errors.New("not enough free disk to pack the database")

// packEstimateStale makes the next report read a fresh sample.
func (d *Daemon) packEstimateStale() {
	d.pack.mu.Lock()
	d.pack.estAt = time.Time{}
	d.pack.mu.Unlock()
}

// packRate is the rate the next estimate uses, and whether it was measured
// on this machine.
func (d *Daemon) packRate(ctx context.Context) (float64, bool) {
	v, _ := d.store.GetMeta(ctx, metaPackRate)
	if r, err := strconv.ParseFloat(v, 64); err == nil && r > 0 {
		return r, true
	}
	return packRateDefault, false
}

// packSeconds is how long a pack of used bytes takes at rate, rounded up.
func packSeconds(used int64, rate float64) int64 {
	if used <= 0 || rate <= 0 {
		return 0
	}
	return int64(math.Ceil(float64(used) / rate))
}

// packReport answers GET /v1/storage/pack.
func (d *Daemon) packReport(ctx context.Context) PackReport {
	r := PackReport{Compression: d.compressionReport(ctx)}
	if d.store == nil {
		return r
	}
	if p, err := d.store.Pages(ctx); err == nil {
		r.Pack.DBBytes = p.Bytes()
	}
	d.pack.mu.Lock()
	run, last := d.pack.run, d.pack.last
	if run != nil {
		r.Pack.Running = &PackProgress{
			Phase: run.phase, Progress: run.progress, StartedMs: run.started.UnixMilli(),
			ElapsedMs: time.Since(run.started).Milliseconds(), EstSeconds: run.estSeconds,
			EventsWait: !run.eventsOK,
		}
	}
	if last != nil {
		l := *last
		r.Pack.Last = &l
	}
	est, fresh := d.pack.est, time.Since(d.pack.estAt) < packEstimateMaxAge
	if run == nil && !fresh && !d.pack.estRunning {
		d.pack.estRunning = true
		d.pack.estSeed++
		seed := d.pack.estSeed
		d.goBg(func() { d.readPackEstimate(seed) })
	}
	r.Pack.Estimating = d.pack.estRunning
	d.pack.mu.Unlock()
	if run != nil || est == nil {
		return r
	}
	rate, measured := d.packRate(ctx)
	secs := packSeconds(est.UsedBytes(), rate)
	r.Pack.Offer = &PackOffer{
		UsedBytes: est.UsedBytes(), FreeBytesEst: est.FreeBytesEst, SampledPages: est.Sampled,
		EstSeconds: secs, HoldSecondsEst: int64(math.Ceil(float64(secs) * packHoldShare)), RateMeasured: measured,
		Worth: est.FreeBytesEst >= packOfferMin && (!r.Compression.On || !r.Compression.Pending) && !r.Compression.Restoring,
	}
	return r
}

// readPackEstimate samples the file in the background; the report that
// started it answers with the previous sample, or none.
func (d *Daemon) readPackEstimate(seed uint64) {
	ctx := d.ctxOrBackground()
	e, err := d.store.EstimatePack(ctx, store.PackSample, seed)
	d.pack.mu.Lock()
	defer d.pack.mu.Unlock()
	d.pack.estRunning = false
	if err != nil {
		d.log.Warn("pack estimate", "component", "daemon", "err", err)
		d.pack.estAt = time.Now() // tried; not again for packEstimateMaxAge
		return
	}
	d.pack.est, d.pack.estAt = &e, time.Now()
}

// startPack starts a pack the user asked for and returns at once; the
// pack's progress is in packReport. It refuses while one runs, while
// migration 0073's move runs, and without the disk room the idle VACUUM
// needs (vacuumRoom).
func (d *Daemon) startPack(ctx context.Context) (PackReport, error) {
	if d.store == nil {
		return PackReport{}, errors.New("no database")
	}
	if d.moving() {
		return PackReport{}, errors.New("the database is still being upgraded; try again when it has finished")
	}
	p, err := d.store.Pages(ctx)
	if err != nil {
		return PackReport{}, err
	}
	used := p.Bytes() - p.FreeBytes()
	needData, needTemp := vacuumRoom(used)
	freeData, errData := freeSpace(d.opt.DataDir)
	freeTemp, errTemp := freeSpace(os.TempDir())
	if errData != nil || errTemp != nil || freeData < needData || freeTemp < needTemp {
		return PackReport{}, fmt.Errorf("%w: it needs %s for a moment, and %s is free", ErrPackRoom,
			Bytes(uint64(needData)), Bytes(uint64(max(min(freeData, freeTemp), 0))))
	}
	rate, _ := d.packRate(ctx)
	d.pack.mu.Lock()
	if d.pack.run != nil {
		d.pack.mu.Unlock()
		return PackReport{}, ErrPackRunning
	}
	expected := used
	if d.pack.est != nil {
		expected = max(d.pack.est.UsedBytes()-d.pack.est.FreeBytesEst+d.pack.est.FreePages*d.pack.est.PageSize, used/4)
	}
	run := &packRun{started: time.Now(), estSeconds: packSeconds(used, rate), phase: packWaiting, expected: expected}
	d.pack.run = run
	d.pack.mu.Unlock()
	// Tracked, so a daemon stopping waits for the VACUUM to roll back before
	// it closes the database.
	d.goBg(func() { d.runPack(d.ctxOrBackground(), run, p) })
	return d.packReport(ctx), nil
}

// runPack is the pack itself.
func (d *Daemon) runPack(ctx context.Context, run *packRun, before store.PageCounts) {
	stop := make(chan struct{})
	sampled := make(chan struct{})
	go func() {
		defer close(sampled)
		t := time.NewTicker(packSampleEvery)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				d.samplePack(run)
			}
		}
	}()
	end := func(l PackLast) {
		close(stop)
		<-sampled
		l.AtMs = time.Now().UnixMilli()
		l.BeforeBytes = before.Bytes()
		l.TookMs = time.Since(run.started).Milliseconds()
		d.pack.mu.Lock()
		d.pack.run, d.pack.last, d.pack.estAt = nil, &l, time.Time{}
		d.pack.mu.Unlock()
	}

	d.dbMu.Lock()
	defer d.dbMu.Unlock()
	release := func() {}
	if d.rec != nil {
		release = d.rec.Exclusive()
	}
	held := time.Now()
	if packHeld != nil {
		packHeld()
	}
	// The log starts empty where it can, so its growth is the second
	// phase's progress; a reader in the way leaves it as it is, and the
	// growth is measured from there.
	_, _ = d.store.CheckpointTruncateWithin(ctx, packTruncateWait)
	wal := config.DBPath(d.opt.DataDir) + "-wal"
	d.pack.mu.Lock()
	run.walStart = fileSize(wal)
	run.phase = packCopying
	d.pack.mu.Unlock()

	vctx, cancel := context.WithTimeout(ctx, vacuumTimeout)
	err := d.store.Pack(vctx)
	// A writer outside the recorder (a setting saved, a background job) may
	// hold the lock past the VACUUM's busy_timeout; that is a moment, not a
	// reason to give up.
	for try := 0; try < packBusyTries && store.IsBusy(err) && vctx.Err() == nil; try++ {
		if !sleepCtx(vctx, time.Second) {
			break
		}
		err = d.store.Pack(vctx)
	}
	cancel()
	hold := time.Since(held)
	release()
	if err != nil {
		why := "it failed: " + err.Error()
		switch {
		case ctx.Err() != nil:
			why = "Caprock was stopping"
		case errors.Is(vctx.Err(), context.DeadlineExceeded):
			why = fmt.Sprintf("it ran past %d minutes", int(vacuumTimeout/time.Minute))
		}
		d.actions.add("stopped packing the database after " + hold.Round(time.Second).String() + " because " + why + "; nothing changed")
		d.log.Info("database pack stopped", "component", "daemon", "why", why, "took", hold, "err", err)
		end(PackLast{Why: why, HoldMs: hold.Milliseconds()})
		return
	}

	d.pack.mu.Lock()
	run.eventsOK = true
	run.walEnd = max(fileSize(wal)-run.walStart, 0)
	run.ioBase, run.ioOK = wroteBytes()
	run.phase = packFinishing
	d.pack.mu.Unlock()
	// PASSIVE never holds a writer up; the TRUNCATE after it may wait for a
	// reader with the write lock held, so it gets a fraction of a second.
	_, _, _ = d.store.CheckpointPassive(ctx)
	_, _ = d.store.CheckpointTruncateWithin(ctx, packTruncateWait)

	after, _ := d.store.Pages(ctx)
	took := time.Since(run.started)
	used := before.Bytes() - before.FreeBytes()
	if took > 0 && used > 0 {
		if err := d.store.SetMeta(ctx, metaPackRate, strconv.FormatFloat(float64(used)/took.Seconds(), 'f', 0, 64)); err != nil {
			d.log.Warn("pack rate not kept", "component", "daemon", "err", err)
		}
	}
	// What compression has saved is packed now: its own VACUUM would only
	// repeat this one.
	if saved, err := d.store.PayloadZstdSaved(ctx); err == nil {
		if err := d.store.SetMeta(ctx, store.MetaPayloadZstdRepacked, strconv.FormatInt(saved, 10)); err != nil {
			d.log.Warn("pack not recorded for compression", "component", "daemon", "err", err)
		}
	}
	d.storage.mu.Lock()
	d.storage.tried = time.Time{}
	d.storage.mu.Unlock()
	freed := before.Bytes() - after.Bytes()
	d.actions.add(fmt.Sprintf("packed the database when asked: %s to %s (%s freed) in %s; new events waited %s",
		Bytes(uint64(before.Bytes())), Bytes(uint64(after.Bytes())), Bytes(uint64(max(freed, 0))),
		took.Round(time.Second), hold.Round(time.Second)))
	d.log.Info("database packed", "component", "daemon", "before", before.Bytes(), "after", after.Bytes(),
		"took", took, "hold", hold)
	end(PackLast{OK: true, AfterBytes: after.Bytes(), HoldMs: hold.Milliseconds()})
}

// samplePack reads the running pack's progress: see PackProgress.
func (d *Daemon) samplePack(run *packRun) {
	wal := fileSize(config.DBPath(d.opt.DataDir) + "-wal")
	tmp, tmpOK := tempBytes()
	written, ioOK := wroteBytes()
	d.pack.mu.Lock()
	defer d.pack.mu.Unlock()
	switch run.phase {
	case packCopying:
		grown := wal - run.walStart
		if grown > 1<<20 {
			run.phase = packWriting
		} else {
			if tmpOK {
				run.tmpPeak = max(run.tmpPeak, tmp)
				run.progress = min(float64(run.tmpPeak)/float64(max(run.expected, 1)), 0.99) / 3
			} else {
				run.progress = -1
			}
			return
		}
		fallthrough
	case packWriting:
		size := run.tmpPeak
		if size <= 0 {
			size = run.expected
		}
		run.progress = (1 + min(float64(max(wal-run.walStart, 0))/float64(max(size, 1)), 0.99)) / 3
	case packFinishing:
		if run.ioOK && ioOK && run.walEnd > 0 {
			run.progress = (2 + min(float64(written-run.ioBase)/float64(run.walEnd), 0.99)) / 3
		} else {
			run.progress = -1
		}
	}
}

// packRunning reports whether a user-started pack is under way, including
// the fold of the log after it: checkpointWAL keeps out of its way.
func (d *Daemon) packRunning() bool {
	d.pack.mu.Lock()
	defer d.pack.mu.Unlock()
	return d.pack.run != nil
}

// fileSize is the size of path, 0 when it is absent.
func fileSize(path string) int64 {
	st, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return st.Size()
}

// selfWritten is the bytes this process has written to storage, where the
// OS says.
func selfWritten() (uint64, bool) {
	_, w, err := procstat.SelfDiskIO()
	return w, err == nil
}

// startPackAPI is startPack for POST /v1/storage/pack, with the status each
// refusal answers with.
func (d *Daemon) startPackAPI(ctx context.Context) (any, int, error) {
	r, err := d.startPack(ctx)
	switch {
	case err == nil:
		return r, 0, nil
	case errors.Is(err, ErrPackRunning):
		return nil, http.StatusConflict, err
	case errors.Is(err, ErrPackRoom):
		return nil, http.StatusInsufficientStorage, err
	default:
		return nil, http.StatusConflict, err
	}
}
