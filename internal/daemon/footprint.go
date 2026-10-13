package daemon

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/procstat"
	"github.com/dspv/caprock/internal/ptyhost"
)

// The footprint: what Caprock costs this machine — memory and CPU of every
// Caprock process, the data directory on disk, the daemon's own disk I/O —
// and the duplicates and leftovers that make it cost more than it should, so
// a person can tell whether a slow machine is Caprock or not. GET
// /v1/footprint and `caprock doctor`. Contract in 03-contracts.md
// § Footprint.

// The verdict thresholds. Round numbers chosen to say "worth a look", not
// measured limits.
const (
	footprintDBWarn    = 2 << 30   // the database with its WAL and shared memory
	footprintWALWarn   = 256 << 20 // a WAL that has not been checkpointed back
	footprintReadsWarn = 500 << 20 // the daemon's disk reads in the last hour
)

// FootprintReport is GET /v1/footprint.
type FootprintReport struct {
	At int64 `json:"at"`
	// DaemonRunning is false only in `caprock doctor`'s own report, made when
	// no daemon answered: then there is no daemon line and no disk I/O.
	DaemonRunning bool                `json:"daemon_running"`
	DataDir       string              `json:"data_dir"`
	Exe           string              `json:"exe,omitempty"`
	Memory        FootprintMemory     `json:"memory"`
	Disk          FootprintDisk       `json:"disk"`
	DiskIO        *FootprintDiskIO    `json:"disk_io,omitempty"`
	Duplicates    FootprintDuplicates `json:"duplicates"`
	Verdicts      []FootprintVerdict  `json:"verdicts"`
	// Actions is what the daemon did about its own footprint without being
	// asked, oldest first: the last 50, since it started. Empty offline.
	Actions []FootprintAction `json:"actions"`
	Error   string            `json:"error,omitempty"`
}

// FootprintMemory is the memory and CPU of every Caprock process.
type FootprintMemory struct {
	Daemon  *ProcUsage  `json:"daemon,omitempty"`
	App     *ProcUsage  `json:"app,omitempty"`
	Webview *ProcGroup  `json:"webview,omitempty"`
	Hosts   HostSummary `json:"hosts"`
	// OtherDaemons is the memory of every daemon besides this one
	// (Duplicates.Daemons).
	OtherDaemonsMemBytes uint64 `json:"other_daemons_mem_bytes"`
	// Totals are all of the above.
	TotalMemBytes uint64  `json:"total_mem_bytes"`
	TotalCPUPct   float64 `json:"total_cpu_pct"`
}

// FootprintDisk is the data directory on disk, split by what it holds.
type FootprintDisk struct {
	TotalBytes int64 `json:"total_bytes"`
	// DatabaseBytes is caprock.db with its -wal and -shm; WALBytes is the
	// -wal alone.
	DatabaseBytes int64 `json:"database_bytes"`
	WALBytes      int64 `json:"wal_bytes"`
	PastesBytes   int64 `json:"pastes_bytes"`
	LogsBytes     int64 `json:"logs_bytes"`
	// BinariesBytes is the app's daemon copy (bin/) and the hook shim.
	BinariesBytes int64 `json:"binaries_bytes"`
	OtherBytes    int64 `json:"other_bytes"`
}

// FootprintDuplicates is what runs that should not.
type FootprintDuplicates struct {
	// Daemons is every other `caprock up --foreground` of this user.
	Daemons []CaprockProc `json:"daemons"`
	// Apps is every desktop app process; more than one is a duplicate.
	Apps []CaprockProc `json:"apps"`
	// OtherInstallHolders is the terminal holders running from an
	// executable outside this install.
	OtherInstallHolders OtherInstallHolders `json:"other_install_holders"`
}

// OtherInstallHolders counts holders by the executable they run from.
type OtherInstallHolders struct {
	Count int `json:"count"`
	// Orphans is how many of them no daemon will reattach to.
	Orphans int        `json:"orphans"`
	Exes    []ExeCount `json:"exes"`
}

// ExeCount is how many holders run one executable.
type ExeCount struct {
	Exe   string `json:"exe"`
	Count int    `json:"count"`
}

// FootprintVerdict is one finding. Level is "ok" or "warn".
type FootprintVerdict struct {
	Level string `json:"level"`
	Code  string `json:"code"`
	Text  string `json:"text"`
}

// footprint answers GET /v1/footprint.
func (d *Daemon) footprint(ctx context.Context) *FootprintReport {
	rep := d.resources(ctx)
	exe, _ := os.Executable()
	f := &FootprintReport{At: time.Now().UnixMilli(), DaemonRunning: true, DataDir: d.opt.DataDir, Exe: exe, Error: rep.Error}
	f.Memory.Daemon = &rep.Caprock.Daemon
	f.Memory.App = rep.Caprock.App
	f.Memory.Webview = rep.Caprock.Webview
	f.Memory.Hosts = rep.Caprock.Hosts.HostSummary
	f.Duplicates.Daemons = rep.others
	f.Duplicates.Apps = rep.apps
	f.Duplicates.OtherInstallHolders = otherInstallHolders(rep.scan, rep.Caprock.Hosts.List, installDirs(exe, d.opt.HolderExe, d.opt.DataDir))
	f.Disk = diskSplit(dataDirSizes(d.opt.DataDir))
	f.DiskIO = d.io.report()
	f.Actions = d.actions.all()
	f.finish()
	return f
}

// OfflineFootprint is what `caprock doctor` can say without the daemon's
// own report: the Caprock processes in the process table (daemons, apps,
// holders and what each costs) and the data directory's size; no disk I/O,
// and no CPU — one sample has no rate. running is the pid of a daemon that
// answers for dataDir but predates GET /v1/footprint, 0 when none answers.
// The calling process is excluded from every list.
func OfflineFootprint(ctx context.Context, dataDir string, running int32) *FootprintReport {
	exe, _ := os.Executable()
	f := &FootprintReport{At: time.Now().UnixMilli(), DataDir: dataDir, Exe: exe, DaemonRunning: running > 0, Actions: []FootprintAction{}}
	f.Disk = diskSplit(dataDirSizes(dataDir))
	m := newResourceMeter()
	tab, err := procstat.Read(ctx)
	if err != nil {
		f.Error = err.Error()
		f.Duplicates = FootprintDuplicates{Daemons: []CaprockProc{}, Apps: []CaprockProc{}, OtherInstallHolders: OtherInstallHolders{Exes: []ExeCount{}}}
		f.finish()
		return f
	}
	scan := m.scanCaprock(ctx, tab, int32(os.Getpid()))
	pids := scan.pids()
	if running > 0 {
		pids = append(pids, running)
		if e := procstat.Exe(ctx, running); e != "" {
			f.Exe = e
		}
	}
	use := m.sampler.Sample(tab, pids)
	c := m.caprockFrom(ctx, tab, scan, use, ptyhost.Dir(dataDir), time.Now())
	f.Memory.App, f.Memory.Webview, f.Memory.Hosts = c.App, c.Webview, c.Hosts.HostSummary
	if running > 0 {
		u := usageOf(running, "caprock", use)
		f.Memory.Daemon = &u
	}
	others := scan.daemons[:0:0]
	for _, p := range scan.daemons {
		if p.PID != running {
			others = append(others, p)
		}
	}
	f.Duplicates.Daemons = withMemory(others, use)
	f.Duplicates.Apps = withMemory(scan.apps, use)
	// "This install" is the running daemon's when there is one, else the
	// binary doctor was run from.
	f.Duplicates.OtherInstallHolders = otherInstallHolders(scan, c.Hosts.List, installDirs(f.Exe, "", dataDir))
	f.finish()
	return f
}

// finish adds up the totals and reaches the verdicts.
func (f *FootprintReport) finish() {
	f.Memory.OtherDaemonsMemBytes = 0
	for _, p := range f.Duplicates.Daemons {
		f.Memory.OtherDaemonsMemBytes += p.MemBytes
	}
	f.Memory.total()
	f.Verdicts = footprintVerdicts(f)
}

func (m *FootprintMemory) total() {
	var mem uint64
	var cpu float64
	if m.Daemon != nil {
		mem, cpu = mem+m.Daemon.MemBytes, cpu+m.Daemon.CPUPct
	}
	if m.App != nil {
		mem, cpu = mem+m.App.MemBytes, cpu+m.App.CPUPct
	}
	if m.Webview != nil {
		mem, cpu = mem+m.Webview.MemBytes, cpu+m.Webview.CPUPct
	}
	mem, cpu = mem+m.Hosts.MemBytes, cpu+m.Hosts.CPUPct
	mem += m.OtherDaemonsMemBytes
	m.TotalMemBytes, m.TotalCPUPct = mem, cpu
}

// installDirs is where this install's executables live: the daemon's
// directory, the holder's, and on Windows the holder copies under the data
// directory (03-contracts.md § Terminal holders).
func installDirs(exe, holderExe, dataDir string) []string {
	var out []string
	for _, p := range []string{exe, holderExe} {
		if p == "" {
			continue
		}
		out = append(out, filepath.Dir(p))
		if r, err := filepath.EvalSymlinks(p); err == nil {
			out = append(out, filepath.Dir(r))
		}
	}
	if dataDir != "" {
		out = append(out, filepath.Join(ptyhost.Dir(dataDir), "bin"))
	}
	return out
}

func sameDir(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// otherInstallHolders counts the holders whose executable is outside dirs.
// A holder whose executable cannot be read is not counted.
func otherInstallHolders(s caprockScan, verdicts []ptyhost.Verdict, dirs []string) OtherInstallHolders {
	out := OtherInstallHolders{Exes: []ExeCount{}}
	orphan := map[int32]bool{}
	for _, v := range verdicts {
		orphan[v.PID] = v.Orphan()
	}
	counts := map[string]int{}
	for _, h := range s.hosts {
		exe := s.hostExe[h.PID]
		if exe == "" {
			continue
		}
		mine := false
		for _, d := range dirs {
			if sameDir(filepath.Dir(exe), d) {
				mine = true
				break
			}
		}
		if mine {
			continue
		}
		out.Count++
		if orphan[h.PID] {
			out.Orphans++
		}
		counts[exe]++
	}
	for exe, n := range counts {
		out.Exes = append(out.Exes, ExeCount{Exe: exe, Count: n})
	}
	sort.Slice(out.Exes, func(i, j int) bool {
		if out.Exes[i].Count != out.Exes[j].Count {
			return out.Exes[i].Count > out.Exes[j].Count
		}
		return out.Exes[i].Exe < out.Exes[j].Exe
	})
	return out
}

// diskSplit sorts the data directory's top-level entries into the
// footprint's groups.
func diskSplit(files []FileSize, total int64) FootprintDisk {
	d := FootprintDisk{TotalBytes: total}
	for _, f := range files {
		n := strings.ToLower(f.Name)
		switch {
		case n == "caprock.db" || n == "caprock.db-shm":
			d.DatabaseBytes += f.Bytes
		case n == "caprock.db-wal":
			d.DatabaseBytes += f.Bytes
			d.WALBytes += f.Bytes
		case f.Dir && n == "paste":
			d.PastesBytes += f.Bytes
		case !f.Dir && (strings.HasSuffix(n, ".log") || strings.Contains(n, ".log.")):
			d.LogsBytes += f.Bytes
		case (f.Dir && n == "bin") || n == "caprock-hook" || n == "caprock-hook.exe":
			d.BinariesBytes += f.Bytes
		default:
			d.OtherBytes += f.Bytes
		}
	}
	return d
}

// footprintVerdicts is the findings, warnings first; one "ok" when there is
// nothing to warn about. Informational lines are "ok".
func footprintVerdicts(f *FootprintReport) []FootprintVerdict {
	var warn, info []FootprintVerdict
	w := func(code, format string, a ...any) {
		warn = append(warn, FootprintVerdict{Level: "warn", Code: code, Text: fmt.Sprintf(format, a...)})
	}
	if !f.DaemonRunning {
		w("daemon_not_running", "No Caprock daemon answers for %s. Start it with `caprock up` or the desktop app.", f.DataDir)
	}
	// With no daemon answering, one daemon in the table is not a duplicate:
	// it is the one that did not answer, or one for another data directory.
	others := f.Duplicates.Daemons
	if allowed := map[bool]int{true: 0, false: 1}[f.DaemonRunning]; len(others) > allowed {
		var parts []string
		for _, p := range others {
			parts = append(parts, describeProc(p))
		}
		w("duplicate_daemon", "%s running beside this one (%s), using %s. Caprock does not stop a daemon it did not start; stop the ones you do not use.",
			plural(len(others), "other Caprock daemon"), strings.Join(parts, "; "), Bytes(f.Memory.OtherDaemonsMemBytes))
	}
	if n := len(f.Duplicates.Apps); n > 1 {
		var parts []string
		for _, p := range f.Duplicates.Apps {
			parts = append(parts, describeProc(p))
		}
		w("duplicate_app", "%d copies of the desktop app are running (%s). Quit all but one.", n, strings.Join(parts, "; "))
	}
	if h := f.Memory.Hosts; h.Orphans > 0 {
		kept := h.Orphans - h.Reapable
		text := fmt.Sprintf("%d of %s are orphans no Caprock will reattach to (all of them together use %s).", h.Orphans, plural(h.Count, "terminal holder"), Bytes(h.MemBytes))
		if h.Reapable > 0 {
			text += fmt.Sprintf(" %d hold only an idle shell or nothing: the daemon stops them on its own within %d minutes (the Stop button in Settings does it now).", h.Reapable, int(reapEvery/time.Minute))
		}
		if kept > 0 {
			text += fmt.Sprintf(" %d still run an agent or a command and are left alone.", kept)
		}
		w("orphans", "%s", text)
	}
	if o := f.Duplicates.OtherInstallHolders; o.Count > 0 {
		var parts []string
		for _, e := range o.Exes {
			parts = append(parts, fmt.Sprintf("%d from %s", e.Count, e.Exe))
		}
		// Said, never warned: the orphans among them are the orphans
		// verdict's, and the rest are sessions that outlived an upgrade.
		text := fmt.Sprintf("%s from another Caprock install or an older version (%s).", plural(o.Count, "terminal holder")+map[bool]string{true: " runs", false: " run"}[o.Count == 1], strings.Join(parts, ", "))
		if o.Orphans > 0 {
			text += fmt.Sprintf(" %d of them are orphans (above).", o.Orphans)
		} else {
			text += " All are still in use — usually sessions started before an upgrade."
		}
		info = append(info, FootprintVerdict{Level: "ok", Code: "other_install_holders", Text: text})
	}
	if f.Disk.DatabaseBytes > footprintDBWarn {
		w("database_large", "The database is %s (over %s). Settings shows what fills it, and a retention period there deletes old events.", Bytes(uint64(f.Disk.DatabaseBytes)), Bytes(footprintDBWarn))
	}
	if f.Disk.WALBytes > footprintWALWarn {
		w("wal_large", "The database's write-ahead log is %s (over %s): it has not been folded back into the database. The daemon checkpoints it on its own within %d minutes.", Bytes(uint64(f.Disk.WALBytes)), Bytes(footprintWALWarn), int(walCheckpointEvery/time.Minute))
	}
	if io := f.DiskIO; io != nil && io.LastHour != nil && io.LastHour.ReadBytes > footprintReadsWarn {
		w("disk_reads_high", "The daemon read %s from disk in the last %s (over %s).", Bytes(io.LastHour.ReadBytes), minutes(io.LastHour.Seconds), Bytes(footprintReadsWarn))
	}
	if len(warn) == 0 {
		warn = []FootprintVerdict{{Level: "ok", Code: "ok", Text: "Nothing here looks wrong: one daemon, no orphaned terminals, and the data directory within bounds."}}
	}
	return append(warn, info...)
}

// Warns reports whether any verdict is a warning.
func (f *FootprintReport) Warns() bool {
	for _, v := range f.Verdicts {
		if v.Level == "warn" {
			return true
		}
	}
	return false
}

func describeProc(p CaprockProc) string {
	s := fmt.Sprintf("pid %d", p.PID)
	if p.Exe != "" {
		s += " " + p.Exe
	}
	if p.DataDir != "" {
		s += ", data " + p.DataDir
	}
	return s
}

func minutes(sec int64) string {
	m := (sec + 30) / 60
	if m == 1 {
		return "minute"
	}
	return fmt.Sprintf("%d minutes", m)
}

// Bytes is a byte count for a person: 1.2 GB, 340 MB, 12 KB (powers of
// 1024, named the way the OS's own tools name them).
func Bytes(n uint64) string {
	const k = 1024
	switch {
	case n >= k*k*k:
		return fmt.Sprintf("%.1f GB", float64(n)/(k*k*k))
	case n >= k*k:
		return fmt.Sprintf("%.0f MB", float64(n)/(k*k))
	case n >= k:
		return fmt.Sprintf("%.0f KB", float64(n)/k)
	}
	return fmt.Sprintf("%d B", n)
}
