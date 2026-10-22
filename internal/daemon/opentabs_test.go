package daemon

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

// The phone mirrors one list, in the order it was reported: the window on
// screen whose tabs changed last. A heartbeat repeating a list does not make
// it the latest, a reorder does, and a week without a report drops a viewer.
func TestOpenTabsLatestKeepsOrderAndPicksTheLastChanged(t *testing.T) {
	now := time.UnixMilli(1_800_000_000_000)
	tabs := newOpenTabs("")
	tabs.now = func() time.Time { return now }
	if _, _, ok := tabs.latest(); ok {
		t.Fatal("no viewer has reported, yet a list is known")
	}
	must := func(viewer string, ids ...string) {
		t.Helper()
		if err := tabs.report(viewer, ids); err != nil {
			t.Fatal(err)
		}
	}
	want := func(ids ...string) {
		t.Helper()
		got, _, ok := tabs.latest()
		if !ok || !slices.Equal(got, ids) {
			t.Fatalf("latest = %v %v, want %v", got, ok, ids)
		}
	}
	must("mac", "c", "a", "b")
	want("c", "a", "b")
	now = now.Add(time.Minute)
	must("browser", "x")
	want("x")
	// The Mac's heartbeat repeats its list: the browser's change is still the last.
	now = now.Add(time.Minute)
	must("mac", "c", "a", "b")
	want("x")
	// A drag on the Mac is a change, in its new order.
	now = now.Add(time.Minute)
	must("mac", "a", "c", "b")
	want("a", "c", "b")
	// The Mac goes quiet past tabPresentFor while the browser keeps beating:
	// the one on screen wins over a later change.
	for i := 0; i < 4; i++ {
		now = now.Add(10 * time.Minute)
		must("browser", "x")
	}
	want("x")
	// A week with no report from either: nothing is known.
	now = now.Add(tabReportTTL + time.Minute)
	if got, _, ok := tabs.latest(); ok {
		t.Fatalf("expired lists still answer %v", got)
	}
}

// A file written before lists carried their change time still reads, and its
// report time stands for the change, so a heartbeat does not move it.
func TestOpenTabsReadsAFileWithoutChangeTimes(t *testing.T) {
	dir := t.TempDir()
	at := time.UnixMilli(1_800_000_000_000)
	old := `{"viewers":{"mac":{"at":1800000000000,"sessions":["b","a"]},"tab":{"at":1799999990000,"sessions":["z"]}}}`
	if err := os.WriteFile(filepath.Join(dir, openTabsFile), []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	tabs := newOpenTabs(dir)
	tabs.now = func() time.Time { return at.Add(time.Minute) }
	if got, _, ok := tabs.latest(); !ok || !slices.Equal(got, []string{"b", "a"}) {
		t.Fatalf("latest = %v %v", got, ok)
	}
	if err := tabs.report("tab", []string{"z"}); err != nil {
		t.Fatal(err)
	}
	if got, _, _ := tabs.latest(); !slices.Equal(got, []string{"b", "a"}) {
		t.Fatalf("a heartbeat took the mirror: %v", got)
	}
	if !tabs.open()["z"] || !tabs.open()["a"] {
		t.Fatal("the idle end lost a tab")
	}
}
