package procstat

import (
	"bufio"
	"encoding/binary"
	"strconv"
	"strings"

	"github.com/shirou/gopsutil/v4/process"
)

// The machine's memory as a whole: how much is in use, how much swap, and
// how hard the OS says it is pressed (03-contracts.md § System memory). Read
// on each resource sample while a dashboard is open, so every source here is
// one call or one small file: two sysctls and host_statistics64 on macOS,
// /proc/meminfo and /proc/pressure/memory on Linux, GlobalMemoryStatusEx on
// Windows. No process is started to read it.

// Pressure levels, as the OS reports them. "" is a machine whose OS keeps no
// such signal (Windows) or would not give it.
const (
	PressureNormal   = "normal"
	PressureWarn     = "warn"
	PressureCritical = "critical"
)

// SysMem is the machine's memory at one moment.
type SysMem struct {
	// Total is the physical memory. Used is what Activity Monitor calls
	// Memory Used on macOS (app memory, wired and compressed), Total minus
	// MemAvailable on Linux, and Total minus available physical memory on
	// Windows: in each case, what the OS could not hand out without taking
	// it from someone.
	Total uint64
	Used  uint64
	// SwapTotal and SwapUsed are the swap space and the part in use;
	// HasSwap is false where they were not read (Windows).
	SwapTotal uint64
	SwapUsed  uint64
	HasSwap   bool
	// Pressure is the OS's own verdict (PressureNormal, PressureWarn,
	// PressureCritical), "" where it keeps none.
	Pressure string
}

// SystemMemory reads the machine's memory.
func SystemMemory() (SysMem, error) { return sysMemory() }

// ProcMemory is one process's own memory, as the resource meter counts it
// (ownMemory: the physical footprint on macOS, RssAnon+RssShmem on Linux,
// private bytes on Windows).
func ProcMemory(pid int32) (uint64, error) { return ownMemory(&process.Process{Pid: pid}) }

// darwinPressure maps kern.memorystatus_vm_pressure_level (1 normal, 2 warn,
// 4 critical; sys/kern_memorystatus.h) to a level.
func darwinPressure(level uint32) string {
	switch level {
	case 1:
		return PressureNormal
	case 2:
		return PressureWarn
	case 4:
		return PressureCritical
	}
	return ""
}

// vmStatistics64 is Darwin's struct vm_statistics64 (mach/vm_statistics.h),
// what host_statistics64(HOST_VM_INFO64) fills in and `vm_stat` prints.
type vmStatistics64 struct {
	FreeCount           uint32
	ActiveCount         uint32
	InactiveCount       uint32
	WireCount           uint32
	ZeroFillCount       uint64
	Reactivations       uint64
	Pageins             uint64
	Pageouts            uint64
	Faults              uint64
	CowFaults           uint64
	Lookups             uint64
	Hits                uint64
	Purges              uint64
	PurgeableCount      uint32
	SpeculativeCount    uint32
	Decompressions      uint64
	Compressions        uint64
	Swapins             uint64
	Swapouts            uint64
	CompressorPageCount uint32
	ThrottledCount      uint32
	ExternalPageCount   uint32
	InternalPageCount   uint32
	TotalUncompressed   uint64
}

// darwinUsed is Activity Monitor's Memory Used from vm_stat's counts: app
// memory (anonymous pages less the purgeable ones), wired and compressed.
// Cached files (external pages) are not in it: the OS drops them on demand.
func darwinUsed(vm vmStatistics64, pageSize, total uint64) uint64 {
	app := uint64(vm.InternalPageCount)
	if p := uint64(vm.PurgeableCount); p < app {
		app -= p
	} else {
		app = 0
	}
	used := (app + uint64(vm.WireCount) + uint64(vm.CompressorPageCount)) * pageSize
	if total > 0 && used > total {
		used = total
	}
	return used
}

// parseSwapUsage reads sysctl vm.swapusage, a struct xsw_usage
// (sys/sysctl.h): total, available and used bytes, then the page size and
// whether it is encrypted. Every Mac is little-endian.
func parseSwapUsage(b []byte) (total, used uint64, ok bool) {
	if len(b) < 24 {
		return 0, 0, false
	}
	return binary.LittleEndian.Uint64(b[0:8]), binary.LittleEndian.Uint64(b[16:24]), true
}

// parseMeminfo reads /proc/meminfo: the total, what is available without
// swapping (MemAvailable, or free plus buffers and page cache on a kernel
// older than 3.14), and the swap.
func parseMeminfo(s string) (SysMem, bool) {
	kv := map[string]uint64{}
	sc := bufio.NewScanner(strings.NewReader(s))
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		f := strings.Fields(v)
		if len(f) == 0 {
			continue
		}
		n, err := strconv.ParseUint(f[0], 10, 64)
		if err != nil {
			continue
		}
		if len(f) > 1 && f[1] == "kB" {
			n *= 1024
		}
		kv[strings.TrimSpace(k)] = n
	}
	total, ok := kv["MemTotal"]
	if !ok || total == 0 {
		return SysMem{}, false
	}
	avail, ok := kv["MemAvailable"]
	if !ok {
		avail = kv["MemFree"] + kv["Buffers"] + kv["Cached"]
	}
	if avail > total {
		avail = total
	}
	m := SysMem{Total: total, Used: total - avail}
	if st, ok := kv["SwapTotal"]; ok {
		m.HasSwap = true
		m.SwapTotal = st
		if sf := kv["SwapFree"]; sf <= st {
			m.SwapUsed = st - sf
		}
	}
	return m, true
}

// PSI thresholds: the share of the last ten seconds in which some task
// (some) or every task (full) stalled waiting for memory. Round numbers
// chosen to separate "the kernel is reclaiming" from "work is stalling", not
// measured on any machine; Linux has no warn and critical of its own.
const (
	psiWarnSome     = 10.0
	psiCriticalFull = 10.0
)

// parsePSI reads /proc/pressure/memory: the avg10 of its "some" and "full"
// lines (Documentation/accounting/psi.rst).
func parsePSI(s string) (some, full float64, ok bool) {
	sc := bufio.NewScanner(strings.NewReader(s))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 2 {
			continue
		}
		for _, kv := range f[1:] {
			k, v, cut := strings.Cut(kv, "=")
			if !cut || k != "avg10" {
				continue
			}
			x, err := strconv.ParseFloat(v, 64)
			if err != nil {
				continue
			}
			switch f[0] {
			case "some":
				some, ok = x, true
			case "full":
				full = x
			}
		}
	}
	return some, full, ok
}

// psiPressure is a level from PSI's avg10 figures.
func psiPressure(some, full float64) string {
	switch {
	case full >= psiCriticalFull:
		return PressureCritical
	case some >= psiWarnSome:
		return PressureWarn
	}
	return PressureNormal
}

// windowsUsed is used memory from GlobalMemoryStatusEx's total and available
// physical memory.
func windowsUsed(total, avail uint64) uint64 {
	if avail > total {
		return 0
	}
	return total - avail
}
