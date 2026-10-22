package procstat

import (
	"encoding/binary"
	"testing"
	"unsafe"
)

// A Linux machine with 16 GiB, 6 GiB available and 1 GiB of 4 GiB swap used,
// as /proc/meminfo prints it (trimmed).
const meminfoFixture = `MemTotal:       16777216 kB
MemFree:         1048576 kB
MemAvailable:    6291456 kB
Buffers:          262144 kB
Cached:          4194304 kB
SwapCached:        65536 kB
Active:          8388608 kB
SwapTotal:       4194304 kB
SwapFree:        3145728 kB
HugePages_Total:       0
`

func TestParseMeminfo(t *testing.T) {
	m, ok := parseMeminfo(meminfoFixture)
	if !ok {
		t.Fatal("not parsed")
	}
	const gib = 1 << 30
	if m.Total != 16*gib || m.Used != 10*gib {
		t.Fatalf("total %d used %d, want 16 GiB and 10 GiB", m.Total, m.Used)
	}
	if !m.HasSwap || m.SwapTotal != 4*gib || m.SwapUsed != 1*gib {
		t.Fatalf("swap %+v", m)
	}
}

func TestParseMeminfoWithoutMemAvailable(t *testing.T) {
	// A kernel before 3.14: free plus buffers plus page cache.
	m, ok := parseMeminfo("MemTotal: 8388608 kB\nMemFree: 1048576 kB\nBuffers: 1048576 kB\nCached: 2097152 kB\n")
	if !ok || m.Used != 4<<30 {
		t.Fatalf("used %d ok %v, want 4 GiB", m.Used, ok)
	}
	if m.HasSwap {
		t.Fatal("no SwapTotal line, yet HasSwap")
	}
	if _, ok := parseMeminfo("garbage\n"); ok {
		t.Fatal("parsed a file with no MemTotal")
	}
}

func TestParsePSI(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want string
	}{
		{"some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n", PressureNormal},
		{"some avg10=12.50 avg60=3.00 avg300=1.00 total=99\nfull avg10=2.00 avg60=0.50 avg300=0.10 total=9\n", PressureWarn},
		{"some avg10=40.00 avg60=20.00 avg300=5.00 total=999\nfull avg10=15.25 avg60=6.00 avg300=1.00 total=99\n", PressureCritical},
		// An older kernel prints only the some line.
		{"some avg10=0.10 avg60=0.00 avg300=0.00 total=10\n", PressureNormal},
	} {
		some, full, ok := parsePSI(tc.in)
		if !ok {
			t.Fatalf("%q: not parsed", tc.in)
		}
		if got := psiPressure(some, full); got != tc.want {
			t.Errorf("%q: %s, want %s", tc.in, got, tc.want)
		}
	}
	if _, _, ok := parsePSI(""); ok {
		t.Fatal("an empty file parsed")
	}
}

func TestDarwinPressure(t *testing.T) {
	for lvl, want := range map[uint32]string{1: PressureNormal, 2: PressureWarn, 4: PressureCritical, 0: "", 3: ""} {
		if got := darwinPressure(lvl); got != want {
			t.Errorf("level %d: %q, want %q", lvl, got, want)
		}
	}
}

// vm_stat on a 16 GiB Apple silicon Mac (16 KiB pages), the counts of the
// lines Activity Monitor's Memory Used is made of.
func TestDarwinUsed(t *testing.T) {
	if got := unsafe.Sizeof(vmStatistics64{}); got != 152 {
		t.Fatalf("vm_statistics64 is %d bytes, want 152", got)
	}
	const page = 16384
	vm := vmStatistics64{
		FreeCount: 20000, ActiveCount: 300000, InactiveCount: 290000, WireCount: 120000,
		PurgeableCount: 10000, SpeculativeCount: 5000,
		CompressorPageCount: 90000, ExternalPageCount: 200000, InternalPageCount: 390000,
	}
	// (390000 - 10000 + 120000 + 90000) pages of 16 KiB.
	if got, want := darwinUsed(vm, page, 16<<30), uint64(590000)*page; got != want {
		t.Fatalf("used %d, want %d", got, want)
	}
	// Never above the total, never below zero.
	if got := darwinUsed(vmStatistics64{InternalPageCount: 1 << 30}, page, 16<<30); got != 16<<30 {
		t.Fatalf("clamped to %d", got)
	}
	if got := darwinUsed(vmStatistics64{PurgeableCount: 10, InternalPageCount: 5}, page, 16<<30); got != 0 {
		t.Fatalf("purgeable over internal gave %d", got)
	}
}

func TestParseSwapUsage(t *testing.T) {
	b := make([]byte, 32)
	binary.LittleEndian.PutUint64(b[0:], 3<<30)
	binary.LittleEndian.PutUint64(b[8:], 1<<30)
	binary.LittleEndian.PutUint64(b[16:], 2<<30)
	total, used, ok := parseSwapUsage(b)
	if !ok || total != 3<<30 || used != 2<<30 {
		t.Fatalf("total %d used %d ok %v", total, used, ok)
	}
	if _, _, ok := parseSwapUsage(b[:10]); ok {
		t.Fatal("a short buffer parsed")
	}
}

func TestWindowsUsed(t *testing.T) {
	if got := windowsUsed(16<<30, 4<<30); got != 12<<30 {
		t.Fatalf("used %d", got)
	}
	if got := windowsUsed(1, 2); got != 0 {
		t.Fatalf("available over total gave %d", got)
	}
}

func TestSystemMemoryReadsThisMachine(t *testing.T) {
	m, err := SystemMemory()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("total %.2f GiB used %.2f GiB swap %.2f/%.2f GiB pressure %q", float64(m.Total)/(1<<30), float64(m.Used)/(1<<30), float64(m.SwapUsed)/(1<<30), float64(m.SwapTotal)/(1<<30), m.Pressure)
	if m.Total == 0 || m.Used == 0 || m.Used > m.Total {
		t.Fatalf("%+v", m)
	}
}

// What each resource sample adds: one reading of the machine's memory.
func BenchmarkSystemMemory(b *testing.B) {
	for b.Loop() {
		if _, err := SystemMemory(); err != nil {
			b.Fatal(err)
		}
	}
}
