package procstat

import (
	"context"
	"runtime"

	"github.com/shirou/gopsutil/v4/mem"
)

// MachineStat is the machine as a whole: how many cores, how busy, how much
// memory and how much of it is free to take (ADR-067, the install hook's
// "this machine is loaded and that one is not").
type MachineStat struct {
	// CPUs is the logical cores the OS reports.
	CPUs int
	// Load1 is the one-minute load average; HasLoad is false where the OS
	// keeps none (Windows).
	Load1   float64
	HasLoad bool
	// MemTotal is the physical memory; MemAvailable what can be taken
	// without swapping, as the OS judges it (macOS: free and inactive pages;
	// Linux: MemAvailable; Windows: available physical memory).
	MemTotal     uint64
	MemAvailable uint64
}

// Machine reads the machine-wide figures. A figure the OS would not give is
// left zero; the error is the first one met.
func Machine(ctx context.Context) (MachineStat, error) {
	st := MachineStat{CPUs: runtime.NumCPU()}
	var first error
	if vm, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		st.MemTotal, st.MemAvailable = vm.Total, vm.Available
	} else {
		first = err
	}
	if l, ok, err := load1(ctx); err == nil {
		st.Load1, st.HasLoad = l, ok
	} else if first == nil {
		first = err
	}
	return st, first
}
