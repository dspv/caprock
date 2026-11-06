package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// zstdDaemon is an idle daemon over a new database holding n tool results a
// month old and one from now, with Compress tool output set to on.
func zstdDaemon(t *testing.T, on bool, n int) *Daemon {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(context.Background(), filepath.Join(dir, "caprock.db"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ctx := context.Background()
	old := time.Now().AddDate(0, -1, 0)
	for i := 0; i <= n; i++ {
		ts := old.Add(time.Duration(i) * time.Second)
		if i == n {
			ts = time.Now()
		}
		p, _ := json.Marshal(map[string]any{"tool_use_id": fmt.Sprint(i), "tool_response": map[string]any{"stdout": strings.Repeat(fmt.Sprintf("ok %d\n", i), 300)}})
		if err := st.WithTx(ctx, func(q store.Querier) error {
			if err := store.UpsertSession(ctx, q, "s", store.SessionPatch{StartedAt: 1, LastEventAt: 1}); err != nil {
				return err
			}
			_, err := store.InsertEvent(ctx, q, &event.Event{Ts: ts, SessionID: "s", Source: event.SourceHook, Kind: event.KindToolPost,
				Tool: "Bash", Key: fmt.Sprint("post:", i), Payload: p})
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	d := &Daemon{log: quietLog(), store: st, actions: newActionLog(), opt: Options{DataDir: dir}}
	d.opt.Config.CompressToolOutput = &on
	d.activity.Store(time.Now().Add(-time.Hour).UnixMilli())
	return d
}

func blobs(t *testing.T, d *Daemon) int {
	t.Helper()
	var n int
	if err := d.store.DB().QueryRow(`SELECT COUNT(*) FROM events WHERE typeof(payload) = 'blob'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// On: the idle pass compresses every tool result older than a day, says so
// in the footprint, and leaves the one from now plain. Off: the next idle pass
// restores them all.
func TestIdleJobCompressesAndRestores(t *testing.T) {
	withFreeSpace(t, 1<<50)
	d := zstdDaemon(t, true, 1200)
	ctx := context.Background()
	var cs compactState
	d.compactDB(ctx, &cs)
	if got := blobs(t, d); got != 1200 {
		t.Fatalf("%d of 1200 old rows compressed", got)
	}
	if !hasAction(d, "compressed 1,200 older tool calls") && !hasAction(d, "compressed 1200 older tool calls") {
		t.Errorf("actions %+v", d.actions.all())
	}
	r := d.compressionReport(ctx)
	if !r.On || r.ThroughMs == 0 || r.Restoring {
		t.Errorf("report %+v", r)
	}

	off := false
	d.opt.Config.CompressToolOutput = &off
	d.compactDB(ctx, &cs)
	if got := blobs(t, d); got != 0 {
		t.Fatalf("%d rows still compressed after turning it off", got)
	}
	if !hasAction(d, "none is compressed now") {
		t.Errorf("actions %+v", d.actions.all())
	}
	if r := d.compressionReport(ctx); r.On || r.Restoring || r.ThroughMs != 0 {
		t.Errorf("report after restoring %+v", r)
	}
}

// Restoring needs the disk the rows will take again; without it nothing is
// touched and the footprint says so once.
func TestRestoreWaitsForDiskRoom(t *testing.T) {
	withFreeSpace(t, 1<<50)
	d := zstdDaemon(t, true, 600)
	ctx := context.Background()
	var cs compactState
	d.compactDB(ctx, &cs)
	before := blobs(t, d)
	off := false
	d.opt.Config.CompressToolOutput = &off
	withFreeSpace(t, 1024)
	d.compactDB(ctx, &cs)
	d.compactDB(ctx, &cs)
	if got := blobs(t, d); got != before || before == 0 {
		t.Fatalf("restored without room: %d of %d", got, before)
	}
	n := 0
	for _, a := range d.actions.all() {
		if strings.HasPrefix(a.What, "did not restore the compressed tool output") {
			n++
		}
	}
	if n != 1 {
		t.Errorf("the missing room was said %d times: %+v", n, d.actions.all())
	}
	if r := d.compressionReport(ctx); !r.Restoring {
		t.Errorf("report %+v: want restoring", r)
	}
}

// Off by default, and nothing runs while the daemon is not quiet.
func TestCompressionWaitsForTheSettingAndForQuiet(t *testing.T) {
	withFreeSpace(t, 1<<50)
	d := zstdDaemon(t, false, 50)
	d.opt.Config.CompressToolOutput = nil
	ctx := context.Background()
	var cs compactState
	d.compactDB(ctx, &cs)
	if got := blobs(t, d); got != 0 {
		t.Fatalf("compressed %d rows with the setting never touched", got)
	}
	on := true
	d.opt.Config.CompressToolOutput = &on
	d.activity.Store(time.Now().UnixMilli())
	d.zstdPayloads(ctx, &cs)
	if got := blobs(t, d); got != 0 {
		t.Fatalf("compressed %d rows while not quiet", got)
	}
}

// A finished pass that saved enough runs one VACUUM, and not a second one
// for the same saving.
func TestRepackRunsOnceAfterAPass(t *testing.T) {
	withFreeSpace(t, 1<<50)
	old := zstdRepackMin
	zstdRepackMin = 1
	t.Cleanup(func() { zstdRepackMin = old })
	d := zstdDaemon(t, true, 300)
	ctx := context.Background()
	var cs compactState
	d.compactDB(ctx, &cs)
	if v, _ := d.store.GetMeta(ctx, store.MetaPayloadZstdRepacked); v == "" || v == "0" {
		t.Fatalf("no repack recorded: %q; actions %+v", v, d.actions.all())
	}
	n := len(d.actions.all())
	cs.repackTried = time.Time{}
	d.compactDB(ctx, &cs)
	for _, a := range d.actions.all()[n:] {
		if strings.HasPrefix(a.What, "compacted the database") {
			t.Errorf("a second VACUUM for the same saving: %s", a.What)
		}
	}
}

func TestZstdPacing(t *testing.T) {
	if zstdPause(time.Millisecond) != compactPause || zstdPause(200*time.Millisecond) != 400*time.Millisecond {
		t.Error("the rest after a step is not max(compactPause, twice the step)")
	}
	if s := zstdAction(true, 2, 1<<20, false); !strings.Contains(s, "compressed 2 older tool calls") || !strings.Contains(s, "continues") {
		t.Errorf("action %q", s)
	}
}

func hasAction(d *Daemon, prefix string) bool {
	for _, a := range d.actions.all() {
		if strings.Contains(a.What, prefix) {
			return true
		}
	}
	return false
}
