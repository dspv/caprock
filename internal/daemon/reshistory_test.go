package daemon

import (
	"encoding/json"
	"fmt"
	"runtime"
	"testing"
)

// The history's cost (03-contracts.md § Resources, history): what a full
// hour holds, one record per meter sample, and the full hour read on a
// popover's first open. Ten sessions is more than the owner runs at once.
func BenchmarkResourceHistory(b *testing.B) {
	ss := make([]SessionResources, 10)
	for i := range ss {
		ss[i] = SessionResources{SessionID: fmt.Sprintf("0b9c3f2e-7d41-4c1a-9e55-%012d", i), CPUPct: 12.5, MemBytes: 400 << 20, Warm: true}
	}
	full := func() *resourceHistory {
		h := new(resourceHistory)
		for i := 0; i < resourceHistoryCap; i++ {
			h.record(histReport(int64(i)*5000, ss...))
		}
		return h
	}
	b.Run("held", func(b *testing.B) {
		var held uint64
		for i := 0; i < b.N; i++ {
			var m0, m1 runtime.MemStats
			runtime.GC()
			runtime.ReadMemStats(&m0)
			h := full()
			runtime.GC()
			runtime.ReadMemStats(&m1)
			held = m1.HeapAlloc - m0.HeapAlloc
			runtime.KeepAlive(h)
		}
		b.ReportMetric(float64(held), "heap-bytes")
	})
	b.Run("record", func(b *testing.B) {
		h := full()
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			h.record(histReport(int64(i)*5000, ss...))
		}
	})
	b.Run("since-full-hour", func(b *testing.B) {
		h := full()
		var js []byte
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			js, _ = json.Marshal(h.since(0))
		}
		b.ReportMetric(float64(len(js)), "json-bytes")
	})
}

func histReport(at int64, sessions ...SessionResources) *ResourceReport {
	return &ResourceReport{At: at, Sessions: sessions, Caprock: CaprockResources{
		Daemon:  ProcUsage{CPUPct: 1, MemBytes: 100 << 20},
		App:     &ProcUsage{CPUPct: 0.5, MemBytes: 10 << 20},
		Webview: &ProcGroup{CPUPct: 2, MemBytes: 300 << 20},
		Hosts:   HostResources{HostSummary: HostSummary{CPUPct: 0.25, MemBytes: 20 << 20}},
	}}
}

// The ring holds an hour at the meter's interval and never more, oldest
// dropped first; ids of sessions that left the ring are let go.
func TestResourceHistoryIsBounded(t *testing.T) {
	if resourceHistoryCap != 720 {
		t.Fatalf("cap %d, want an hour at 5 s", resourceHistoryCap)
	}
	var h resourceHistory
	total := resourceHistoryCap*2 + 7
	for i := 0; i < total; i++ {
		h.record(histReport(int64(i+1)*5000, SessionResources{SessionID: fmt.Sprintf("s%d", i), CPUPct: float64(i), MemBytes: uint64(i) << 10, Warm: true}))
	}
	got := h.since(0)
	if len(got.At) != resourceHistoryCap {
		t.Fatalf("kept %d samples, want %d", len(got.At), resourceHistoryCap)
	}
	if first, want := got.At[0], int64(total-resourceHistoryCap+1)*5000; first != want {
		t.Errorf("oldest kept at %d, want %d", first, want)
	}
	if last := got.At[len(got.At)-1]; last != int64(total)*5000 {
		t.Errorf("newest at %d", last)
	}
	if len(got.Sessions) != resourceHistoryCap {
		t.Errorf("%d session series, want one per kept sample", len(got.Sessions))
	}
	// After the wraps renumbered the ids, each series is still its own session's.
	for _, k := range []int{total - 1, total - resourceHistoryCap} {
		se := got.Sessions[fmt.Sprintf("s%d", k)]
		j := k - (total - resourceHistoryCap)
		if se == nil || se.Mem[j] == nil || *se.Mem[j] != uint64(k)<<10 || *se.CPU[j] != float64(k) {
			t.Errorf("s%d at %d: %+v", k, j, se)
		}
	}
	if len(h.ids) > resourceHistoryCap+7 {
		t.Errorf("interned %d ids: ended sessions are never let go", len(h.ids))
	}
	if part := h.since(got.At[len(got.At)-3]); len(part.At) != 2 {
		t.Errorf("since the third-newest: %d samples, want 2", len(part.At))
	}
	if h.record(&ResourceReport{At: 1, Error: "no table"}); len(h.since(0).At) != resourceHistoryCap || h.since(0).At[0] == 1 {
		t.Error("a failed sample was kept")
	}
}

// Series line up with `at`: a session absent from a sample is null there,
// a cold CPU is null, Caprock is daemon + holders + app + web view, and all
// is the sessions summed.
func TestResourceHistorySeries(t *testing.T) {
	var h resourceHistory
	h.record(histReport(1000, SessionResources{SessionID: "a", CPUPct: 50, MemBytes: 1 << 20, Warm: false}))
	h.record(histReport(6000,
		SessionResources{SessionID: "a", CPUPct: 12.34, MemBytes: 2 << 20, Warm: true},
		SessionResources{SessionID: "b", CPUPct: 100, MemBytes: 3 << 20, Warm: true}))
	b, err := json.Marshal(h.since(0))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"interval_s":5,"capacity":720,"at":[1000,6000],` +
		`"caprock":{"cpu":[3.8,3.8],"mem":[450887680,450887680]},` +
		`"all":{"cpu":[0,112.3],"mem":[1048576,5242880]},` +
		`"sessions":{"a":{"cpu":[null,12.3],"mem":[1048576,2097152]},"b":{"cpu":[null,100],"mem":[null,3145728]}}}`
	if string(b) != want {
		t.Errorf("history:\n got %s\nwant %s", b, want)
	}
}
