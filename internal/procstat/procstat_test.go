package procstat

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"testing"
	"time"
)

func TestTree(t *testing.T) {
	tab := &Table{Procs: map[int32]Proc{
		1: {PID: 1}, 10: {PID: 10, PPID: 1}, 11: {PID: 11, PPID: 10}, 12: {PID: 12, PPID: 11}, 20: {PID: 20, PPID: 1},
	}, Children: map[int32][]int32{1: {10, 20}, 10: {11}, 11: {12}}}
	got := tab.Tree(10)
	if len(got) != 3 || got[0] != 10 || got[1] != 11 || got[2] != 12 {
		t.Errorf("Tree(10) = %v, want [10 11 12]", got)
	}
	if tab.Tree(99) != nil {
		t.Error("a pid not in the table has no tree")
	}
}

func TestSamplerRates(t *testing.T) {
	clock := time.Unix(1000, 0)
	cpu := map[int32]float64{1: 10, 2: 5}
	s := &Sampler{prev: map[int32]mark{}, now: func() time.Time { return clock },
		read: func(pid int32) (float64, uint64, error) {
			c, ok := cpu[pid]
			if !ok {
				return 0, 0, errors.New("gone")
			}
			return c, uint64(pid) << 20, nil
		}}
	tab := &Table{Procs: map[int32]Proc{1: {PID: 1, StartMs: 7}, 2: {PID: 2, StartMs: 8}}}
	first := s.Sample(tab, []int32{1, 2, 3})
	if first[1].Warm || first[1].CPUPct != 0 || len(first) != 2 {
		t.Fatalf("first sample = %+v; want two cold readings", first)
	}
	clock = clock.Add(2 * time.Second)
	cpu[1], cpu[2] = 13, 5.5                // 3 s of CPU in 2 s: one and a half cores
	tab.Procs[2] = Proc{PID: 2, StartMs: 9} // pid 2 is a new process now
	second := s.Sample(tab, []int32{1, 2})
	if !second[1].Warm || second[1].CPUPct != 150 {
		t.Errorf("pid 1 = %+v, want 150%% warm", second[1])
	}
	if second[2].Warm {
		t.Errorf("a reused pid must start cold: %+v", second[2])
	}
	if second[1].MemBytes != 1<<20 {
		t.Errorf("rss = %d", second[1].MemBytes)
	}
}

func TestLabel(t *testing.T) {
	for _, c := range []struct {
		name string
		argv []string
		want string
	}{
		{"node", []string{"node", "/repo/node_modules/.bin/vite", "--port", "5173"}, "node vite"},
		{"node", []string{"/usr/local/bin/node", "--max-old-space-size=4096", "server.js"}, "node server.js"},
		{"2.1.290", []string{"/Users/u/.local/bin/claude", "--session-id", "x"}, "claude"},
		{"python3.12", []string{"/usr/bin/python3.12", "-m", "pytest"}, "python3.12 pytest"},
		{"zsh", []string{"-zsh"}, "-zsh"},
		{"go", []string{`C:\Go\bin\go.exe`, "test", "./..."}, "go"},
		{"something", nil, "something"},
		{"zsh", []string{"/bin/zsh", "-c", "source /x/snap.sh && eval 'go test'"}, "zsh"},
	} {
		if got := Label(c.name, c.argv); got != c.want {
			t.Errorf("Label(%q, %q) = %q, want %q", c.name, c.argv, got, c.want)
		}
	}
	long := Label("x", []string{"averyveryveryveryveryveryveryveryverylongprogramname"})
	if r := []rune(long); len(r) != 40 || r[39] != '…' {
		t.Errorf("long label not clipped: %q", long)
	}
}

// The real table and a real child, on whichever OS runs the tests: the
// child is found under this process, and its figures read.
func TestReadFindsAChild(t *testing.T) {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("ping", "-n", "30", "127.0.0.1")
	} else {
		cmd = exec.Command("sleep", "30")
	}
	if err := cmd.Start(); err != nil {
		t.Skipf("no child to start: %v", err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	self := int32(os.Getpid())
	child := int32(cmd.Process.Pid)
	var tab *Table
	deadline := time.Now().Add(5 * time.Second)
	for {
		var err error
		tab, err = Read(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := tab.Procs[child]; ok || time.Now().After(deadline) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if p, ok := tab.Procs[child]; !ok || p.PPID != self {
		t.Fatalf("child %d not found under %d: %+v", child, self, p)
	}
	found := false
	for _, pid := range tab.Tree(self) {
		found = found || pid == child
	}
	if !found {
		t.Errorf("the child is not in this process's tree")
	}
	u := NewSampler().Sample(tab, []int32{self})
	if u[self].MemBytes == 0 {
		t.Errorf("no resident size read for this process: %+v", u[self])
	}
	if len(Cmdline(context.Background(), child)) == 0 {
		t.Errorf("no command line read for the child")
	}
}

// The machine-wide figures the other computer reads (ADR-067): real on each
// OS the matrix runs, a load average everywhere but Windows.
func TestMachine(t *testing.T) {
	st, err := Machine(context.Background())
	if err != nil {
		t.Fatalf("Machine: %v", err)
	}
	if st.CPUs < 1 || st.MemTotal == 0 || st.MemAvailable == 0 || st.MemAvailable > st.MemTotal {
		t.Errorf("Machine() = %+v: want cores, and available memory within the total", st)
	}
	if st.HasLoad == (runtime.GOOS == "windows") {
		t.Errorf("HasLoad = %v on %s", st.HasLoad, runtime.GOOS)
	}
	if st.Load1 < 0 {
		t.Errorf("Load1 = %v", st.Load1)
	}
}
