package daemon

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/store"
)

// compactDaemon is a daemon over a database made the way every version before
// 2026-10-13 made one (auto_vacuum NONE), idle for an hour.
func compactDaemon(t *testing.T) *Daemon {
	t.Helper()
	dir := t.TempDir()
	path := config.DBPath(dir)
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE legacy(x)`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	st, err := store.Open(context.Background(), path, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	d := &Daemon{log: quietLog(), store: st, actions: newActionLog(), opt: Options{DataDir: dir}}
	d.activity.Store(time.Now().Add(-time.Hour).UnixMilli())
	return d
}

func withFreeSpace(t *testing.T, free int64) {
	t.Helper()
	old := freeSpace
	freeSpace = func(string) (int64, error) { return free, nil }
	t.Cleanup(func() { freeSpace = old })
}

func lastAction(d *Daemon) string {
	a := d.actions.all()
	if len(a) == 0 {
		return ""
	}
	return a[len(a)-1].What
}

// Without the room for a second copy the VACUUM is not started, and the
// footprint says so once.
func TestVacuumWaitsForDiskRoom(t *testing.T) {
	d := compactDaemon(t)
	withFreeSpace(t, 1024)
	ctx := context.Background()
	var cs compactState
	d.compactDB(ctx, &cs)
	if m, _ := d.store.AutoVacuum(ctx); m != 0 {
		t.Fatalf("vacuumed without room: auto_vacuum %d", m)
	}
	if !strings.HasPrefix(lastAction(d), "did not compact the database") {
		t.Fatalf("actions %+v", d.actions.all())
	}
	n := len(d.actions.all())
	cs.vacuumTried = time.Time{}
	d.compactDB(ctx, &cs)
	if len(d.actions.all()) != n {
		t.Fatal("the missing room was reported twice")
	}
}

// The room is twice the used size and a tenth, the measured peak (a temporary
// copy plus the write-ahead log) with a margin.
func TestVacuumRoom(t *testing.T) {
	data, temp := vacuumRoom(1000)
	if data != 2200 || temp != 1100 {
		t.Fatalf("room %d %d", data, temp)
	}
}

// With room, the compaction finishes, then one VACUUM switches the database
// to incremental, then free pages go back to the disk in steps.
func TestCompactDBRunsTheThreeSteps(t *testing.T) {
	d := compactDaemon(t)
	withFreeSpace(t, 1<<50)
	ctx := context.Background()
	var cs compactState
	d.compactDB(ctx, &cs)
	if done, _ := d.store.PayloadCompactFinished(ctx); !done {
		t.Fatal("compaction not finished")
	}
	if m, _ := d.store.AutoVacuum(ctx); m != store.AutoVacuumIncremental {
		t.Fatalf("auto_vacuum %d after the VACUUM", m)
	}
	if !strings.HasPrefix(lastAction(d), "compacted the database:") {
		t.Fatalf("actions %+v", d.actions.all())
	}
	// Free some pages: over incrementalMin.
	db := d.store.DB()
	if _, err := db.Exec(`CREATE TABLE filler(b TEXT)`); err != nil {
		t.Fatal(err)
	}
	big := strings.Repeat("z", 64<<10)
	for i := 0; i < 200; i++ { // 12.5 MiB
		if _, err := db.Exec(`INSERT INTO filler VALUES(?)`, big); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`DELETE FROM filler`); err != nil {
		t.Fatal(err)
	}
	d.compactDB(ctx, &cs)
	if p, _ := d.store.Pages(ctx); p.Free != 0 {
		t.Fatalf("freelist %d pages left", p.Free)
	}
	if !strings.HasPrefix(lastAction(d), "gave ") {
		t.Fatalf("actions %+v", d.actions.all())
	}
}

// Nothing runs while something is being recorded, or was asked to be written,
// within idleFor.
func TestCompactDBWaitsForQuiet(t *testing.T) {
	d := compactDaemon(t)
	withFreeSpace(t, 1<<50)
	d.writes.want()
	if d.quiet(time.Now()) {
		t.Fatal("quiet right after a write")
	}
	ctx := context.Background()
	var cs compactState
	d.compactDB(ctx, &cs)
	if done, _ := d.store.PayloadCompactFinished(ctx); done {
		t.Fatal("compacted while not idle")
	}
	if len(d.actions.all()) != 0 {
		t.Fatalf("actions %+v", d.actions.all())
	}
}

// A write interrupts the guarded VACUUM's context at once, and a request that
// may write counts as one; a GET does not.
func TestWriteGate(t *testing.T) {
	var g writeGate
	ctx, release := g.guard(context.Background())
	g.want()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("want did not interrupt")
	}
	release()
	g.want() // no guard: nothing to cancel, must not panic

	d := &Daemon{}
	h := d.markWrites(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/v1/status", nil))
	if d.writes.last.Load() != 0 {
		t.Fatal("a GET counted as a write")
	}
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/v1/hook", nil))
	if d.writes.last.Load() == 0 {
		t.Fatal("a POST did not count")
	}
}

func TestCompactAction(t *testing.T) {
	got := compactAction(3, 5<<20, false)
	if !strings.Contains(got, "3 older events") || !strings.Contains(got, "continues the next time") {
		t.Fatal(got)
	}
	if got := compactAction(1, 0, true); !strings.Contains(got, "every older event is done") {
		t.Fatal(got)
	}
}
