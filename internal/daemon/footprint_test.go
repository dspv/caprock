package daemon

import (
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/procstat"
	"github.com/dspv/caprock/internal/ptyhost"
)

func codes(vs []FootprintVerdict) map[string]string {
	out := map[string]string{}
	for _, v := range vs {
		out[v.Code] = v.Level
	}
	return out
}

func cleanFootprint() *FootprintReport {
	return &FootprintReport{
		DaemonRunning: true, DataDir: "/d",
		Memory: FootprintMemory{Daemon: &ProcUsage{PID: 1, MemBytes: 300 << 20}},
		Disk:   FootprintDisk{TotalBytes: 1 << 30, DatabaseBytes: 1 << 30, WALBytes: 8 << 20},
		DiskIO: &FootprintDiskIO{LastHour: &IOWindow{ReadBytes: 10 << 20, Seconds: 3600}},
		Duplicates: FootprintDuplicates{Daemons: []CaprockProc{}, Apps: []CaprockProc{{PID: 2}},
			OtherInstallHolders: OtherInstallHolders{Exes: []ExeCount{}}},
	}
}

func TestFootprintVerdicts(t *testing.T) {
	f := cleanFootprint()
	f.finish()
	if len(f.Verdicts) != 1 || f.Verdicts[0].Code != "ok" || f.Warns() {
		t.Fatalf("a clean machine: %+v", f.Verdicts)
	}

	f = cleanFootprint()
	f.Duplicates.Daemons = []CaprockProc{{PID: 9, Exe: "/opt/homebrew/bin/caprock", MemBytes: 200 << 20}}
	f.Duplicates.Apps = []CaprockProc{{PID: 2}, {PID: 3}}
	f.Memory.Hosts = HostSummary{Count: 43, MemBytes: 350 << 20, Orphans: 12, Reapable: 11}
	f.Duplicates.OtherInstallHolders = OtherInstallHolders{Count: 11, Orphans: 11, Exes: []ExeCount{{Exe: "/opt/homebrew/bin/caprock", Count: 11}}}
	f.Disk.DatabaseBytes, f.Disk.WALBytes = 2200<<20+1<<30, 300<<20
	f.DiskIO.LastHour.ReadBytes = 1700 << 20
	f.finish()
	got := codes(f.Verdicts)
	for _, c := range []string{"duplicate_daemon", "duplicate_app", "orphans", "database_large", "wal_large", "disk_reads_high"} {
		if got[c] != "warn" {
			t.Errorf("%s: %q, want warn (all: %+v)", c, got[c], f.Verdicts)
		}
	}
	// Said but not warned: its orphans are already the orphans verdict.
	if got["other_install_holders"] != "ok" {
		t.Errorf("other_install_holders: %q", got["other_install_holders"])
	}
	if _, ok := got["ok"]; ok || !f.Warns() {
		t.Error("no all-clear beside warnings")
	}
	if f.Memory.OtherDaemonsMemBytes != 200<<20 || f.Memory.TotalMemBytes != 300<<20+200<<20+350<<20 {
		t.Errorf("totals: %+v", f.Memory)
	}
	for _, v := range f.Verdicts {
		if v.Code == "orphans" && (!strings.Contains(v.Text, "12 of 43 terminal holders") || !strings.Contains(v.Text, "1 still run")) {
			t.Errorf("orphans text: %s", v.Text)
		}
	}

	// Holders of another install that are all still in use are said, not warned.
	f = cleanFootprint()
	f.Duplicates.OtherInstallHolders = OtherInstallHolders{Count: 2, Exes: []ExeCount{{Exe: "/old/caprock", Count: 2}}}
	f.finish()
	if got := codes(f.Verdicts); got["other_install_holders"] != "ok" || got["ok"] != "ok" || f.Warns() {
		t.Errorf("in-use holders of another install: %+v", f.Verdicts)
	}

	// Offline: one daemon in the table is the one that did not answer, not a
	// duplicate; two are.
	f = cleanFootprint()
	f.DaemonRunning, f.Memory.Daemon, f.DiskIO = false, nil, nil
	f.Duplicates.Daemons = []CaprockProc{{PID: 9}}
	f.finish()
	if got := codes(f.Verdicts); got["daemon_not_running"] != "warn" || got["duplicate_daemon"] != "" {
		t.Errorf("offline, one daemon: %+v", f.Verdicts)
	}
	f.Duplicates.Daemons = append(f.Duplicates.Daemons, CaprockProc{PID: 10})
	f.finish()
	if codes(f.Verdicts)["duplicate_daemon"] != "warn" {
		t.Errorf("offline, two daemons: %+v", f.Verdicts)
	}
}

func TestIORing(t *testing.T) {
	t0 := time.Unix(1_000_000, 0)
	r := newIORing(t0)
	if rep := r.report(); rep.Samples != 0 || rep.LastMinute != nil || rep.SinceStart != nil {
		t.Fatalf("empty ring: %+v", rep)
	}
	r.add(ioSample{at: t0, read: 100, written: 10})
	if rep := r.report(); rep.LastMinute != nil || rep.SinceStart == nil || rep.SinceStart.ReadBytes != 100 {
		t.Fatalf("one reading: %+v", rep)
	}
	// 90 minutes of readings: every minute reads 1 MB more and writes 1 KB.
	for i := 1; i <= 90; i++ {
		r.add(ioSample{at: t0.Add(time.Duration(i) * time.Minute), read: 100 + uint64(i)<<20, written: 10 + uint64(i)<<10})
	}
	rep := r.report()
	if rep.Samples != ioRingLen {
		t.Fatalf("kept %d readings, want %d", rep.Samples, ioRingLen)
	}
	if rep.LastMinute.ReadBytes != 1<<20 || rep.LastMinute.WriteBytes != 1<<10 || rep.LastMinute.Seconds != 60 {
		t.Errorf("last minute: %+v", rep.LastMinute)
	}
	if rep.LastHour.ReadBytes != 60<<20 || rep.LastHour.Seconds != 3600 {
		t.Errorf("last hour: %+v", rep.LastHour)
	}
	if rep.SinceStart.ReadBytes != 100+90<<20 || rep.SinceStart.Seconds != 90*60 {
		t.Errorf("since start: %+v", rep.SinceStart)
	}
	r.fail(errors.New("no counters"))
	if r.report().Error != "no counters" {
		t.Error("a failed reading is reported")
	}
	r.add(ioSample{at: t0.Add(91 * time.Minute)})
	if rep := r.report(); rep.Error != "" || rep.LastMinute.ReadBytes != 0 {
		t.Errorf("counters going backwards read as zero, and a good reading clears the error: %+v", rep)
	}
}

// The scan finds the other daemons, the apps, the app's window and the
// holders in a made-up process table, without reading a real process: the
// meter's caches stand in for argv, environment, executable and the macOS
// responsible process.
func TestScanCaprockFindsDuplicates(t *testing.T) {
	const self = 100
	procs := map[int32]procstat.Proc{
		self: {PID: self, Name: "caprock", UID: -1},
		200:  {PID: 200, Name: "caprock", UID: -1},                     // another daemon, own data dir
		201:  {PID: 201, Name: "caprock", UID: -1},                     // `caprock up` detaching: not a daemon
		202:  {PID: 202, Name: "caprock", UID: int64(os.Getuid()) + 1}, // another user's daemon
		300:  {PID: 300, Name: "caprock-app", UID: -1},
		301:  {PID: 301, Name: "caprock-app", UID: -1},
		310:  {PID: 310, Name: "com.apple.WebKit", UID: -1}, // the app's WebContent
		311:  {PID: 311, Name: "com.apple.WebKit", UID: -1}, // Safari's
		320:  {PID: 320, PPID: 300, Name: "msedgewebview2", UID: -1},
		400:  {PID: 400, Name: "caprock-pty-host", UID: -1},
		401:  {PID: 401, Name: "caprock", UID: -1},
		402:  {PID: 402, PPID: 401, Name: "zsh", UID: -1},
		500:  {PID: 500, Name: "caprock-hook", UID: -1},
	}
	tab := &procstat.Table{Procs: procs, Children: map[int32][]int32{300: {320}, 401: {402}}}
	m := newResourceMeter()
	k := func(pid int32) pidKey { return pidKey{pid, procs[pid].StartMs} }
	m.argv[k(200)] = []string{"/opt/homebrew/bin/caprock", "up", "--foreground", "--data-dir", "/tmp/stand"}
	m.argv[k(201)] = []string{"caprock", "up"}
	m.argv[k(202)] = []string{"caprock", "up", "--foreground"}
	m.argv[k(400)] = []string{"/app/caprock-pty-host", "pty-host"}
	m.argv[k(401)] = []string{"/opt/homebrew/bin/caprock", "pty-host"}
	for _, pid := range []int32{200, 201, 400, 401} {
		m.env[k(pid)] = []string{"HOME=/h"}
	}
	m.exe[k(200)] = "/opt/homebrew/Cellar/caprock/1/bin/caprock"
	m.exe[k(300)], m.exe[k(301)] = "/Applications/Caprock.app/Contents/MacOS/caprock-app", "/Users/u/old/Caprock.app/Contents/MacOS/caprock-app"
	m.exe[k(400)] = "/app/caprock-pty-host"
	m.exe[k(401)] = "/opt/homebrew/Cellar/caprock/1/bin/caprock"
	m.resp[k(310)], m.resp[k(311)] = 300, 999

	s := m.scanCaprock(t.Context(), tab, self)
	if len(s.daemons) != 1 || s.daemons[0].PID != 200 || s.daemons[0].DataDir != filepath.Clean("/tmp/stand") || s.daemons[0].Exe == "" {
		t.Errorf("daemons: %+v", s.daemons)
	}
	if len(s.apps) != 2 {
		t.Errorf("apps: %+v", s.apps)
	}
	if len(s.webviews) != 2 || s.webviews[0] != 310 || s.webviews[1] != 320 {
		t.Errorf("web view: %v, want the app's WebKit helper and the app's child", s.webviews)
	}
	if len(s.hosts) != 2 || s.hosts[0].PID != 400 || len(s.hosts[1].Children) != 1 {
		t.Errorf("hosts: %+v", s.hosts)
	}

	verdicts := []ptyhost.Verdict{{PID: 400, State: "registered"}, {PID: 401, State: "unreachable-idle", Reap: true}}
	o := otherInstallHolders(s, verdicts, installDirs("/app/caprock", "", ""))
	if o.Count != 1 || o.Orphans != 1 || len(o.Exes) != 1 || o.Exes[0].Exe != "/opt/homebrew/Cellar/caprock/1/bin/caprock" {
		t.Errorf("other install holders: %+v", o)
	}
}

func TestDaemonArgvAndDataDir(t *testing.T) {
	for _, c := range []struct {
		argv []string
		want bool
	}{
		{[]string{"caprock", "up", "--foreground", "--no-open"}, true},
		{[]string{"caprock", "up", "--foreground=true"}, true},
		{[]string{"caprock", "up"}, false},
		{[]string{"caprock", "pty-host"}, false},
		{[]string{"caprock"}, false},
	} {
		if isDaemonArgv(c.argv) != c.want {
			t.Errorf("isDaemonArgv(%v) = %v", c.argv, !c.want)
		}
	}
	if got := daemonDataDir([]string{"caprock", "up", "--data-dir=/a/b/"}, nil); got != filepath.Clean("/a/b") {
		t.Errorf("--data-dir=: %q", got)
	}
	if got := daemonDataDir([]string{"caprock", "up"}, []string{"CAPROCK_DATA_DIR=/e"}); got != filepath.Clean("/e") {
		t.Errorf("env: %q", got)
	}
	if got := daemonDataDir([]string{"caprock", "up"}, nil); got != "" {
		t.Errorf("default: %q", got)
	}
}

func TestDiskSplit(t *testing.T) {
	d := diskSplit([]FileSize{
		{Name: "caprock.db", Bytes: 1000}, {Name: "caprock.db-wal", Bytes: 200}, {Name: "caprock.db-shm", Bytes: 30},
		{Name: "paste", Bytes: 50, Dir: true}, {Name: "caprock.log", Bytes: 7}, {Name: "service.log", Bytes: 3},
		{Name: "bin", Bytes: 400, Dir: true}, {Name: "caprock-hook", Bytes: 40}, {Name: "ptyhost", Bytes: 5, Dir: true},
		{Name: "config.json", Bytes: 1},
	}, 1736)
	want := FootprintDisk{TotalBytes: 1736, DatabaseBytes: 1230, WALBytes: 200, PastesBytes: 50, LogsBytes: 10, BinariesBytes: 440, OtherBytes: 6}
	if d != want {
		t.Errorf("got %+v\nwant %+v", d, want)
	}
}

// The daemon's own sweep used to stop only holders of its own data
// directory, which left eleven idle shells from deleted preview stands
// running on the owner's machine (2026-10-13). It now stops every reapable
// holder — the owner's case is reapable — and says so in the action log.
func TestTheSweepStopsAnotherInstallsIdleOrphans(t *testing.T) {
	root := t.TempDir()
	own := filepath.Join(root, "own", "ptyhost")
	if err := os.MkdirAll(own, 0o700); err != nil {
		t.Fatal(err)
	}
	stand := filepath.Join(root, "caprock-app.7VVE", "data", "ptyhost") // deleted
	hosts := []ptyhost.HostProc{{
		PID: 4624, StartMs: time.Now().Add(-time.Hour).UnixMilli(),
		Env:      []string{ptyhost.RegistryEnv + "=" + stand},
		Children: []ptyhost.ChildProc{{PID: 4625, Name: "zsh"}},
	}}
	v := ptyhost.Classify(hosts, own, time.Now())[0]
	if !v.Reap || v.Ours || !v.Abandoned {
		t.Fatalf("the owner's orphan: %+v", v)
	}

	l := newActionLog()
	l.now = func() time.Time { return time.UnixMilli(1_791_400_000_000) }
	l.add(reapAction([]ptyhost.Verdict{v, {State: "dead", Reap: true}}, false))
	got := l.all()
	want := "stopped 2 orphaned terminal holders (1 holding only an idle shell, 1 whose program had exited and 1 left by a Caprock whose data directory is deleted)"
	if len(got) != 1 || got[0].What != want || got[0].At != 1_791_400_000_000 {
		t.Fatalf("action: %+v\nwant %q", got, want)
	}
	if s := reapAction([]ptyhost.Verdict{{State: "unreachable-idle", Reap: true}}, true); s != "stopped 1 orphaned terminal holder (1 holding only an idle shell), asked from Settings" {
		t.Errorf("asked: %q", s)
	}
	for i := 0; i < 2*actionLogLen; i++ {
		l.add("x")
	}
	if n := len(l.all()); n != actionLogLen {
		t.Errorf("kept %d actions, want %d", n, actionLogLen)
	}
}

func TestDataDirLock(t *testing.T) {
	old := lockWait
	lockWait = 200 * time.Millisecond
	t.Cleanup(func() { lockWait = old })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	dir := t.TempDir()

	release, err := acquireDataDirLock(dir, log)
	if err != nil {
		t.Fatal(err)
	}
	_, err = acquireDataDirLock(dir, log)
	var already *AlreadyRunningError
	if !errors.As(err, &already) {
		t.Fatalf("a second lock on the same directory: %v", err)
	}
	if already.PID != os.Getpid() || !strings.Contains(err.Error(), dir) {
		t.Errorf("the refusal names the holder and the directory: %v (pid %d)", err, already.PID)
	}
	// Another directory is another daemon's business.
	other, err := acquireDataDirLock(t.TempDir(), log)
	if err != nil {
		t.Fatalf("a lock on another directory: %v", err)
	}
	other()

	release()
	release() // twice is harmless
	again, err := acquireDataDirLock(dir, log)
	if err != nil {
		t.Fatalf("the lock is free again after release: %v", err)
	}
	again()
}
