package daemon

import (
	"log/slog"
	"os"
	"runtime/debug"
)

// SoftMemoryLimit is the daemon's soft limit on the memory the Go runtime
// holds (runtime/debug.SetMemoryLimit), unless GOMEMLIMIT says otherwise.
//
// Under a heavy synthetic load the daemon's live Go heap stayed about 20 MB
// and the runtime mapped at most 86 MB in all (10-infrastructure.md §
// Profiling the daemon, 2026-10-22). That load never came near this limit,
// so it changed nothing there. It is a ceiling for what does come near it: a
// spike of allocation (a backfill, a large import, an all-time history over a
// big database) raises the collector's goal to twice what is live, and the
// pages it grew into go back to the OS only gradually. Near the limit the
// collector runs sooner and the scavenger returns memory promptly instead, so
// a spike costs CPU rather than growing the footprint of a process that runs
// all day beside the agents it watches. A live heap above the limit is not
// an error: the runtime caps the collector at about half of the CPU and lets
// the heap grow, so the limit cannot wedge the daemon.
//
// It covers Go's memory only. SQLite allocates outside the Go heap (its page
// caches and sorters, bounded per connection by cache_size in
// internal/store), and the limit neither sees nor bounds that.
const SoftMemoryLimit = 256 << 20

// applyMemoryLimit sets SoftMemoryLimit unless GOMEMLIMIT is set, in which
// case the runtime already applied that one. It returns the limit in force.
func applyMemoryLimit(log *slog.Logger) int64 {
	if os.Getenv("GOMEMLIMIT") != "" {
		return debug.SetMemoryLimit(-1)
	}
	debug.SetMemoryLimit(SoftMemoryLimit)
	if log != nil {
		log.Debug("soft memory limit set", "component", "daemon", "bytes", SoftMemoryLimit)
	}
	return SoftMemoryLimit
}
