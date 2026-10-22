package daemon

import (
	"math"
	"runtime/debug"
	"testing"
)

func TestApplyMemoryLimit(t *testing.T) {
	was := debug.SetMemoryLimit(-1)
	t.Cleanup(func() { debug.SetMemoryLimit(was) })

	t.Setenv("GOMEMLIMIT", "")
	debug.SetMemoryLimit(math.MaxInt64)
	if got := applyMemoryLimit(nil); got != SoftMemoryLimit {
		t.Errorf("applied %d, want %d", got, SoftMemoryLimit)
	}
	if got := debug.SetMemoryLimit(-1); got != SoftMemoryLimit {
		t.Errorf("runtime limit %d, want %d", got, SoftMemoryLimit)
	}

	// The user's own GOMEMLIMIT wins: the runtime read it at start, and the
	// daemon leaves it alone.
	t.Setenv("GOMEMLIMIT", "1GiB")
	debug.SetMemoryLimit(1 << 30)
	if got := applyMemoryLimit(nil); got != 1<<30 {
		t.Errorf("with GOMEMLIMIT set: %d, want the user's 1 GiB", got)
	}
}
