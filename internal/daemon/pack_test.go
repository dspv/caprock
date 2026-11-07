package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// packDaemon is zstdDaemon with a recorder, its tool output compressed and
// the space incremental vacuum gives back already given back: what is left
// is what only a pack frees.
func packDaemon(t *testing.T) *Daemon {
	t.Helper()
	withFreeSpace(t, 1<<50)
	d := zstdDaemon(t, true, 1500)
	d.rec = rollup.New(d.store, embeddedTable(t), bus.New(), quietLog())
	d.rec.OnWrite = d.writes.want
	drainSteps(t, d)
	return d
}

// waitPack polls the report until the pack has ended.
func waitPack(t *testing.T, d *Daemon) PackReport {
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for {
		r := d.packReport(context.Background())
		if r.Pack.Running == nil {
			return r
		}
		if time.Now().After(deadline) {
			t.Fatalf("the pack never ended: %+v", r.Pack.Running)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Events that arrive while the pack holds the database wait in memory and
// are all written when it lets go: none fails, none is lost, and the pack is
// not interrupted by them the way the idle VACUUM is.
func TestPackNowHoldsEventsAndLosesNone(t *testing.T) {
	d := packDaemon(t)
	ctx := context.Background()
	const n = 20
	var wg sync.WaitGroup
	var stored, failed atomic.Int64
	var heldEnded atomic.Bool
	packHeld = func() {
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				// The hook handler's own bound: far shorter than the wait
				// is allowed to be, and still nothing fails.
				rctx, cancel := context.WithTimeout(ctx, 30*time.Second)
				defer cancel()
				p, _ := json.Marshal(map[string]any{"tool_use_id": fmt.Sprint("live", i)})
				_, err := d.rec.Record(rctx, &event.Event{Ts: time.Now(), SessionID: "live", Source: event.SourceHook,
					Kind: event.KindToolPost, Tool: "Bash", Key: fmt.Sprint("live:", i), Payload: p}, rollup.SessionInfo{})
				if err != nil {
					failed.Add(1)
					return
				}
				if !heldEnded.Load() {
					t.Error("an event was written while the pack held the database")
				}
				stored.Add(1)
			}()
		}
		// Let every writer reach the recorder and wait there.
		time.Sleep(300 * time.Millisecond)
		if stored.Load() != 0 || failed.Load() != 0 {
			t.Errorf("writes finished during the hold: %d stored, %d failed", stored.Load(), failed.Load())
		}
		heldEnded.Store(true)
	}
	t.Cleanup(func() { packHeld = nil })
	if _, err := d.startPack(ctx); err != nil {
		t.Fatal(err)
	}
	r := waitPack(t, d)
	wg.Wait()
	if failed.Load() != 0 || stored.Load() != n {
		t.Fatalf("%d stored, %d failed of %d", stored.Load(), failed.Load(), n)
	}
	var rows int
	if err := d.store.DB().QueryRow(`SELECT COUNT(*) FROM events e JOIN sessions s ON s.sid = e.sid WHERE s.session_id = 'live'`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != n {
		t.Fatalf("%d of %d events in the database", rows, n)
	}
	if r.Pack.Last == nil || !r.Pack.Last.OK || r.Pack.Last.HoldMs < 300 || r.Pack.Last.AfterBytes <= 0 {
		t.Fatalf("last %+v", r.Pack.Last)
	}
	if v, _ := d.store.GetMeta(ctx, metaPackRate); v == "" {
		t.Error("the pack's rate was not kept for the next estimate")
	}
	if m, _ := d.store.AutoVacuum(ctx); m != store.AutoVacuumIncremental {
		t.Errorf("auto_vacuum %d after a pack", m)
	}
	if !hasAction(d, "packed the database when asked") {
		t.Errorf("actions %+v", d.actions.all())
	}
	// The compression's own repack would only repeat it.
	saved, _ := d.store.PayloadZstdSaved(ctx)
	if v, _ := d.store.GetMeta(ctx, store.MetaPayloadZstdRepacked); v != fmt.Sprint(saved) {
		t.Errorf("repacked %q, saved %d", v, saved)
	}
}

// A second pack while one runs, and a pack without the disk room, are
// refused with their own status; nothing starts.
func TestPackRefusals(t *testing.T) {
	d := packDaemon(t)
	ctx := context.Background()
	d.pack.run = &packRun{started: time.Now(), phase: packCopying}
	if _, code, err := d.startPackAPI(ctx); !errors.Is(err, ErrPackRunning) || code != http.StatusConflict {
		t.Fatalf("while running: %d %v", code, err)
	}
	d.pack.run = nil
	withFreeSpace(t, 1024)
	_, code, err := d.startPackAPI(ctx)
	if !errors.Is(err, ErrPackRoom) || code != http.StatusInsufficientStorage || !strings.Contains(err.Error(), "free") {
		t.Fatalf("without room: %d %v", code, err)
	}
	if d.pack.run != nil {
		t.Fatal("a refused pack left a run behind")
	}
}

// Before a pack the report offers one, with what it would free (a sampled
// estimate) and how long it would take at the default rate, then at the
// rate the last pack on this machine ran at.
func TestPackOfferEstimate(t *testing.T) {
	d := packDaemon(t)
	ctx := context.Background()
	// Leave pages half empty: delete every other row's payload.
	if _, err := d.store.DB().Exec(`UPDATE events SET payload = '{}' WHERE id % 2 = 0`); err != nil {
		t.Fatal(err)
	}
	r := d.packReport(ctx)
	if !r.Pack.Estimating && r.Pack.Offer == nil {
		t.Fatalf("no estimate started: %+v", r.Pack)
	}
	deadline := time.Now().Add(10 * time.Second)
	for r.Pack.Offer == nil {
		if time.Now().After(deadline) {
			t.Fatal("no offer")
		}
		time.Sleep(10 * time.Millisecond)
		r = d.packReport(ctx)
	}
	o := r.Pack.Offer
	if o.FreeBytesEst <= 0 || o.SampledPages != store.PackSample || o.UsedBytes <= 0 {
		t.Fatalf("offer %+v", o)
	}
	if o.EstSeconds != packSeconds(o.UsedBytes, packRateDefault) || o.RateMeasured || o.HoldSecondsEst > o.EstSeconds {
		t.Fatalf("offer times %+v", o)
	}
	if o.Worth {
		t.Fatalf("worth packing below packOfferMin: %+v", o)
	}
	old := packOfferMin
	packOfferMin = 1
	t.Cleanup(func() { packOfferMin = old })
	if r := d.packReport(ctx); !r.Pack.Offer.Worth {
		t.Fatalf("not worth it above the bar: %+v", r.Pack.Offer)
	}
	// Mid-pass, compression comes first.
	_ = d.store.SetMeta(ctx, store.MetaPayloadZstdCursor, "1")
	if r := d.packReport(ctx); r.Pack.Offer.Worth || !r.Compression.Pending {
		t.Fatalf("offered mid-pass: %+v %+v", r.Pack.Offer, r.Compression)
	}
	_ = d.store.SetMeta(ctx, metaPackRate, fmt.Sprint(1<<20))
	if r := d.packReport(ctx); !r.Pack.Offer.RateMeasured || r.Pack.Offer.EstSeconds != packSeconds(r.Pack.Offer.UsedBytes, 1<<20) {
		t.Fatalf("measured rate not used: %+v", r.Pack.Offer)
	}
}

func TestPackSeconds(t *testing.T) {
	if got := packSeconds(2001<<20, packRateDefault); got != 84 {
		t.Fatalf("2,001 MiB at the default rate: %d s", got)
	}
	if packSeconds(0, 1) != 0 || packSeconds(1, 0) != 0 {
		t.Fatal("no time for nothing")
	}
}

// Progress comes from bytes, a third per phase: the temporary copy against
// the expected size, the log against the copy, the bytes written while
// folding against the log. Where the OS gives no reading it says -1.
func TestPackProgressFromBytes(t *testing.T) {
	dir := t.TempDir()
	d := &Daemon{opt: Options{DataDir: dir}}
	wal := config.DBPath(dir) + "-wal"
	setWAL := func(n int64) {
		if err := os.WriteFile(wal, make([]byte, n), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	var tmp int64
	var tmpOK = true
	var wrote uint64
	var wroteOK = true
	oldT, oldW := tempBytes, wroteBytes
	tempBytes = func() (int64, bool) { return tmp, tmpOK }
	wroteBytes = func() (uint64, bool) { return wrote, wroteOK }
	t.Cleanup(func() { tempBytes, wroteBytes = oldT, oldW })

	run := &packRun{phase: packCopying, expected: 1000}
	setWAL(0)
	tmp = 500
	d.samplePack(run)
	if run.phase != packCopying || !near(run.progress, 0.5/3) {
		t.Fatalf("copying half: %s %.3f", run.phase, run.progress)
	}
	tmp = 800 // the copy came out smaller than expected
	d.samplePack(run)
	tmp = 0
	setWAL(2 << 20)
	run.tmpPeak = 4 << 20
	d.samplePack(run)
	if run.phase != packWriting || !near(run.progress, (1+0.5)/3) {
		t.Fatalf("writing half: %s %.3f", run.phase, run.progress)
	}
	run.phase, run.walEnd, run.ioBase, run.ioOK = packFinishing, 1000, 100, true
	wrote = 350
	d.samplePack(run)
	if !near(run.progress, (2+0.25)/3) {
		t.Fatalf("finishing a quarter: %.3f", run.progress)
	}
	wroteOK = false
	d.samplePack(run)
	if run.progress != -1 {
		t.Fatalf("no reading: %.3f", run.progress)
	}
	tmpOK = false
	run2 := &packRun{phase: packCopying, expected: 1000}
	setWAL(0)
	d.samplePack(run2)
	if run2.progress != -1 {
		t.Fatalf("no temp reading: %.3f", run2.progress)
	}
}

func near(a, b float64) bool { return a-b < 0.01 && b-a < 0.01 }
