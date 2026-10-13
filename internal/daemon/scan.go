package daemon

import (
	"context"
	"path/filepath"
	"sort"
	"strings"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/procstat"
	"github.com/dspv/caprock/internal/ptyhost"
)

// caprockScan is every Caprock process of this user in one process table:
// the daemons other than the caller, the desktop apps, the processes drawing
// an app's window, and the terminal holders. One pass serves the resource
// meter, the footprint and `caprock doctor` with no daemon running.
type caprockScan struct {
	daemons  []CaprockProc // `caprock up --foreground`, the caller excluded
	apps     []CaprockProc
	webviews []int32
	hosts    []ptyhost.HostProc
	// hostExe is each holder's executable, "" when it cannot be read.
	hostExe map[int32]string
	// other is every other caprock process — a CLI command, a `caprock up`
	// that is detaching or stuck — for the orphan scan (orphans.go).
	other []otherCaprock
}

// otherCaprock is a caprock process that is neither a daemon, an app nor a
// holder. sub is its subcommand (argv[1]), "" when argv cannot be read.
type otherCaprock struct {
	pid   int32
	start int64
	exe   string
	sub   string
}

// CaprockProc is one Caprock process the footprint names.
type CaprockProc struct {
	PID int32  `json:"pid"`
	Exe string `json:"exe,omitempty"`
	// DataDir is the data directory a daemon was started with, from its
	// --data-dir or CAPROCK_DATA_DIR; "" when it used the default (or the
	// environment cannot be read).
	DataDir   string `json:"data_dir,omitempty"`
	MemBytes  uint64 `json:"mem_bytes"`
	StartedAt int64  `json:"started_at,omitempty"`
}

// pids is every process of the scan whose cost is measured.
func (s caprockScan) pids() []int32 {
	out := make([]int32, 0, len(s.daemons)+len(s.apps)+len(s.webviews)+len(s.hosts))
	for _, p := range s.daemons {
		out = append(out, p.PID)
	}
	for _, p := range s.apps {
		out = append(out, p.PID)
	}
	out = append(out, s.webviews...)
	for _, h := range s.hosts {
		out = append(out, h.PID)
	}
	return out
}

// webKitPrefix is the macOS WebKit helpers' process name, as the process
// table truncates it (16 bytes): com.apple.WebKit.WebContent, .GPU and
// .Networking all read "com.apple.WebKit".
const webKitPrefix = "com.apple.webkit"

// scanCaprock reads the table once for Caprock's own processes. self is the
// calling process, never counted as one of them. Must be called with m.mu
// held (or on a meter nothing else uses).
func (m *resourceMeter) scanCaprock(ctx context.Context, tab *procstat.Table, self int32) caprockScan {
	s := caprockScan{hostExe: map[int32]string{}}
	appPIDs := map[int32]bool{}
	var webkit []int32
	for pid, p := range tab.Procs {
		if pid == self || !sameUser(p) {
			continue
		}
		n := strings.ToLower(p.Name)
		if strings.HasPrefix(n, webKitPrefix) {
			webkit = append(webkit, pid)
			continue
		}
		if !strings.HasPrefix(n, "caprock") || strings.HasPrefix(n, "caprock-hook") {
			continue
		}
		k := pidKey{pid, p.StartMs}
		if isAppName(n) {
			appPIDs[pid] = true
			s.apps = append(s.apps, CaprockProc{PID: pid, Exe: m.exeOf(ctx, k), StartedAt: p.StartMs})
			continue
		}
		argv := m.argvOf(ctx, k)
		switch {
		case len(argv) >= 2 && argv[1] == ptyhost.Arg:
			h := ptyhost.HostProc{PID: pid, StartMs: p.StartMs, Env: m.envOf(ctx, k)}
			for _, c := range tab.Children[pid] {
				cp := tab.Procs[c]
				h.Children = append(h.Children, ptyhost.ChildProc{PID: c, Name: cp.Name, Busy: len(tab.Children[c]) > 0})
			}
			s.hosts = append(s.hosts, h)
			s.hostExe[pid] = m.exeOf(ctx, k)
		case isDaemonArgv(argv):
			s.daemons = append(s.daemons, CaprockProc{
				PID: pid, Exe: m.exeOf(ctx, k), StartedAt: p.StartMs,
				DataDir: daemonDataDir(argv, m.envOf(ctx, k)),
			})
		default:
			o := otherCaprock{pid: pid, start: p.StartMs, exe: m.exeOf(ctx, k)}
			if len(argv) >= 2 {
				o.sub = argv[1]
			}
			s.other = append(s.other, o)
		}
	}
	// The app's window: on macOS the WebKit helpers it is responsible for
	// (launchd's children), elsewhere the app's own descendants.
	if len(appPIDs) > 0 {
		seen := map[int32]bool{}
		for _, pid := range webkit {
			k := pidKey{pid, tab.Procs[pid].StartMs}
			r, ok := m.resp[k]
			if !ok {
				r = procstat.ResponsiblePID(pid)
				m.resp[k] = r
			}
			if appPIDs[r] && !seen[pid] {
				seen[pid] = true
				s.webviews = append(s.webviews, pid)
			}
		}
		for app := range appPIDs {
			for _, pid := range tab.Tree(app)[1:] {
				if seen[pid] || strings.HasPrefix(strings.ToLower(tab.Procs[pid].Name), "caprock") {
					continue
				}
				seen[pid] = true
				s.webviews = append(s.webviews, pid)
			}
		}
	}
	sort.Slice(s.hosts, func(i, j int) bool { return s.hosts[i].PID < s.hosts[j].PID })
	sort.Slice(s.apps, func(i, j int) bool { return s.apps[i].PID < s.apps[j].PID })
	sort.Slice(s.daemons, func(i, j int) bool { return s.daemons[i].PID < s.daemons[j].PID })
	sort.Slice(s.webviews, func(i, j int) bool { return s.webviews[i] < s.webviews[j] })
	sort.Slice(s.other, func(i, j int) bool { return s.other[i].pid < s.other[j].pid })
	return s
}

func (m *resourceMeter) argvOf(ctx context.Context, k pidKey) []string {
	argv, ok := m.argv[k]
	if !ok {
		argv = procstat.Cmdline(ctx, k.pid)
		m.argv[k] = argv
	}
	return argv
}

func (m *resourceMeter) envOf(ctx context.Context, k pidKey) []string {
	env, ok := m.env[k]
	if !ok {
		env = procstat.Environ(ctx, k.pid)
		m.env[k] = env
	}
	return env
}

// exeOf is a process's executable. The OS cannot name one whose file has
// since been deleted or replaced — a Homebrew upgrade removes the old
// Cellar, an app update swaps the bundle — and those are exactly the
// leftovers worth naming, so an absolute argv[0] stands in.
func (m *resourceMeter) exeOf(ctx context.Context, k pidKey) string {
	exe, ok := m.exe[k]
	if !ok {
		exe = procstat.Exe(ctx, k.pid)
		if exe == "" {
			if argv := m.argvOf(ctx, k); len(argv) > 0 && filepath.IsAbs(argv[0]) {
				exe = argv[0]
			}
		}
		m.exe[k] = exe
	}
	return exe
}

// isDaemonArgv is whether a caprock process is a daemon: `caprock up
// --foreground`, which is what the login service runs and what `caprock up`
// detaches into. The short-lived `caprock up` that starts it is not one.
func isDaemonArgv(argv []string) bool {
	if len(argv) < 2 || argv[1] != "up" {
		return false
	}
	for _, a := range argv[2:] {
		if a == "--foreground" || a == "--foreground=true" {
			return true
		}
	}
	return false
}

// daemonDataDir is the data directory a daemon was started with: --data-dir
// on its command line, else CAPROCK_DATA_DIR in its environment; "" for the
// default.
func daemonDataDir(argv, env []string) string {
	for i, a := range argv {
		if a == "--data-dir" && i+1 < len(argv) {
			return filepath.Clean(argv[i+1])
		}
		if v, ok := strings.CutPrefix(a, "--data-dir="); ok {
			return filepath.Clean(v)
		}
	}
	for _, kv := range env {
		if v, ok := strings.CutPrefix(kv, config.EnvDataDir+"="); ok && v != "" {
			return filepath.Clean(v)
		}
	}
	return ""
}

// withMemory is a list of processes, each with its own memory.
func withMemory(list []CaprockProc, use map[int32]procstat.Usage) []CaprockProc {
	out := make([]CaprockProc, 0, len(list))
	for _, p := range list {
		p.MemBytes = use[p.PID].MemBytes
		out = append(out, p)
	}
	return out
}
