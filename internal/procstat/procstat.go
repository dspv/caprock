// Package procstat reads the machine's process table and what each process
// costs — CPU and resident memory — on macOS, Linux and Windows.
//
// It only reads. Nothing here signals, opens or writes to another process;
// rule 7 forbids signalling a process Caprock did not start (the doctor's
// confirmed stop, ADR-059, lives in internal/daemon), and reading the
// figures a process manager shows is not that.
//
// The table comes from one call where the OS has one (sysctl kern.proc.all on
// macOS) and from gopsutil elsewhere; per-process CPU time and resident size
// come from gopsutil on every OS. CPU is a percentage of one core between two
// samples, so a process tree using three cores reads 300%.
package procstat

import (
	"context"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/process"
)

// Proc is one row of the process table.
type Proc struct {
	PID  int32
	PPID int32
	// Name is the OS's short name for the process (macOS truncates it to 16
	// bytes); Label is better for showing a person.
	Name string
	// UID is the owner's user id, -1 where the table does not say (Windows).
	UID int64
	// StartMs is when the process started, unix ms, 0 when unknown. A pid
	// with a different start is a different process.
	StartMs int64
	// tty is whether the process has a controlling terminal, where the table
	// says (macOS); HasTTY reads it elsewhere.
	tty bool
}

// StartMs is when pid started, unix ms, as the table reports it; false when
// there is no such process. A pid whose start differs from the one a caller
// judged is another process: the check to make before every signal.
func StartMs(ctx context.Context, pid int32) (int64, bool) {
	ms, err := (&process.Process{Pid: pid}).CreateTimeWithContext(ctx)
	if err != nil {
		return 0, false
	}
	return ms, true
}

// Table is the process table at one moment, with each parent's children.
type Table struct {
	Procs    map[int32]Proc
	Children map[int32][]int32
}

// Read takes the process table.
func Read(ctx context.Context) (*Table, error) {
	procs, err := readProcs(ctx)
	if err != nil {
		return nil, err
	}
	t := &Table{Procs: procs, Children: make(map[int32][]int32, len(procs))}
	for pid, p := range procs {
		if p.PPID != pid {
			t.Children[p.PPID] = append(t.Children[p.PPID], pid)
		}
	}
	for _, c := range t.Children {
		sort.Slice(c, func(i, j int) bool { return c[i] < c[j] })
	}
	return t, nil
}

// Tree is pid and every process below it, pid first. A pid not in the table
// gives nil.
func (t *Table) Tree(pid int32) []int32 {
	if _, ok := t.Procs[pid]; !ok {
		return nil
	}
	out := []int32{pid}
	seen := map[int32]bool{pid: true}
	for i := 0; i < len(out); i++ {
		for _, c := range t.Children[out[i]] {
			if !seen[c] {
				seen[c] = true
				out = append(out, c)
			}
		}
	}
	return out
}

// Usage is one process's cost.
type Usage struct {
	// CPUPct is percent of one core since the previous sample of the same
	// process; Warm is false on the first sample, when there is nothing to
	// compare with and CPUPct is 0.
	CPUPct float64
	Warm   bool
	// MemBytes is the process's own memory (ownMemory), not its RSS.
	MemBytes uint64
}

type mark struct {
	start  int64
	cpuSec float64
	at     time.Time
}

// Sampler turns cumulative CPU time into a rate. It is not safe for
// concurrent use.
type Sampler struct {
	prev map[int32]mark
	now  func() time.Time
	// read is the per-process reading, replaced in tests.
	read func(pid int32) (cpuSec float64, mem uint64, err error)
}

// NewSampler returns a sampler reading real processes.
func NewSampler() *Sampler {
	return &Sampler{prev: map[int32]mark{}, now: time.Now, read: readUsage}
}

// Sample reads every pid in t that is listed in pids. A process that has gone
// since the table was read is left out. Processes not sampled this time are
// forgotten, so a pid reused later starts fresh.
func (s *Sampler) Sample(t *Table, pids []int32) map[int32]Usage {
	now := s.now()
	out := make(map[int32]Usage, len(pids))
	next := make(map[int32]mark, len(pids))
	for _, pid := range pids {
		p, ok := t.Procs[pid]
		if !ok {
			continue
		}
		if _, done := out[pid]; done {
			continue
		}
		cpu, mem, err := s.read(pid)
		if err != nil {
			continue
		}
		u := Usage{MemBytes: mem}
		if m, ok := s.prev[pid]; ok && m.start == p.StartMs {
			if dt := now.Sub(m.at).Seconds(); dt > 0 && cpu >= m.cpuSec {
				u.CPUPct = 100 * (cpu - m.cpuSec) / dt
				u.Warm = true
			}
		}
		out[pid] = u
		next[pid] = mark{start: p.StartMs, cpuSec: cpu, at: now}
	}
	s.prev = next
	return out
}

// readUsage is a process's CPU seconds so far and its memory. Memory is what
// the OS's own process manager shows, not the resident set: the resident set
// counts file pages a process has mapped, and the daemon maps its whole
// database, so its RSS read 544 MB with a 122 MB footprint (2026-10-10). See
// ownMemory for each OS.
func readUsage(pid int32) (float64, uint64, error) {
	p := &process.Process{Pid: pid}
	ts, err := p.Times()
	if err != nil {
		return 0, 0, err
	}
	mem, err := ownMemory(p)
	if err != nil {
		return 0, 0, err
	}
	return ts.User + ts.System, mem, nil
}

// Cmdline is a process's argument vector; nil when it cannot be read (another
// user's process, or one that has exited).
func Cmdline(ctx context.Context, pid int32) []string {
	args, err := (&process.Process{Pid: pid}).CmdlineSliceWithContext(ctx)
	if err != nil {
		return nil
	}
	return args
}

// Exe is the absolute path of a process's executable as the OS reports it
// (symlinks resolved on macOS and Linux); "" when it cannot be read.
func Exe(ctx context.Context, pid int32) string {
	exe, err := (&process.Process{Pid: pid}).ExeWithContext(ctx)
	if err != nil {
		return ""
	}
	return exe
}

// Environ is a process's environment; nil when it cannot be read.
func Environ(ctx context.Context, pid int32) []string {
	env, err := (&process.Process{Pid: pid}).EnvironWithContext(ctx)
	if err != nil {
		return nil
	}
	return env
}

// IsInterpreter is whether a program name (as the process table or argv[0]
// gives it) is an interpreter or a shell that runs a script named after it.
func IsInterpreter(name string) bool {
	low := strings.ToLower(base(name))
	return interpreters[low] || strings.HasPrefix(low, "python3.")
}

// interpreters run a script named by their first argument; their label names
// the script too ("node vite"), since "node" alone says nothing.
var interpreters = map[string]bool{
	"node": true, "bun": true, "deno": true, "python": true, "python3": true, "ruby": true,
	"perl": true, "java": true, "npx": true, "uv": true, "uvx": true, "sh": true, "bash": true,
	"zsh": true, "pwsh": true, "powershell": true, "cmd": true, "php": true, "dotnet": true,
}

// Label is a short name for a process a person recognises: the program, and
// for an interpreter the script it runs. name is the fallback when argv is
// unreadable.
func Label(name string, argv []string) string {
	if len(argv) == 0 || argv[0] == "" {
		return clip(name)
	}
	exe := base(argv[0])
	low := strings.ToLower(exe)
	if interpreters[low] || strings.HasPrefix(low, "python3.") {
		for _, a := range argv[1:] {
			if a == "-c" || strings.EqualFold(a, "/c") || strings.EqualFold(a, "-command") {
				// An inline script: its text is not a name.
				return clip(exe)
			}
			if a == "" || strings.HasPrefix(a, "-") {
				continue
			}
			return clip(exe + " " + base(a))
		}
	}
	return clip(exe)
}

func base(p string) string {
	b := filepath.Base(strings.ReplaceAll(p, `\`, "/"))
	if strings.EqualFold(filepath.Ext(b), ".exe") {
		b = b[:len(b)-4]
	}
	return b
}

func clip(s string) string {
	const max = 40
	if r := []rune(s); len(r) > max {
		return string(r[:max-1]) + "…"
	}
	return s
}
