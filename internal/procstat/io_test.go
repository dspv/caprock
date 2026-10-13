package procstat

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// The self I/O counters are read on every OS and only grow: writing and
// syncing a file must not make them go backwards.
func TestSelfDiskIO(t *testing.T) {
	r1, w1, err := SelfDiskIO()
	if err != nil {
		if runtime.GOOS == "linux" {
			// Some containers hide /proc/self/io (no CONFIG_TASK_IO_ACCOUNTING).
			t.Skipf("no I/O accounting here: %v", err)
		}
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "f")
	if err := os.WriteFile(p, make([]byte, 1<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	if f, err := os.Open(p); err == nil {
		_ = f.Sync()
		_ = f.Close()
	}
	r2, w2, err := SelfDiskIO()
	if err != nil {
		t.Fatal(err)
	}
	if r2 < r1 || w2 < w1 {
		t.Fatalf("counters went backwards: read %d→%d, written %d→%d", r1, r2, w1, w2)
	}
}

func TestExeOfSelf(t *testing.T) {
	exe := Exe(context.Background(), int32(os.Getpid()))
	if exe == "" || !filepath.IsAbs(exe) {
		t.Fatalf("Exe(self) = %q, want an absolute path", exe)
	}
}

func TestResponsiblePIDNeverNegative(t *testing.T) {
	if got := ResponsiblePID(int32(os.Getpid())); got < 0 {
		t.Fatalf("ResponsiblePID(self) = %d", got)
	}
	if runtime.GOOS == "darwin" && ResponsiblePID(int32(os.Getpid())) == 0 {
		t.Error("macOS should say which process is responsible for this one")
	}
}
