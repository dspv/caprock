package daemon

import (
	"context"
	"errors"
	"math"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/procstat"
	"github.com/dspv/caprock/internal/ptyhost"
	"github.com/dspv/caprock/internal/store"
)

// The resource meter: what each live session's process tree costs the
// machine, and what Caprock itself costs. Contract in 03-contracts.md
// § Resources.
//
// It samples only while somebody is looking — a /v1/live client connected,
// or GET /v1/resources asked within the last resourceViewerGrace — so a
// daemon nobody watches reads no process table at all.
const (
	resourceEvery       = 5 * time.Second
	resourceViewerGrace = 15 * time.Second
	// A session is "hot" when its whole tree has stayed over either limit
	// for hotAfter, and stops being hot once it has stayed under both for
	// hotClearAfter (so a build that dips for one sample does not flicker).
	// One full core is the CPU limit: an agent waiting on the model uses a
	// few percent, and a tree over a core for a minute is running something
	// — a build, tests, a dev server, a runaway loop. 2 GiB of memory is the
	// memory limit for the same reason; both are round numbers chosen to
	// separate "working" from "the machine will feel this", not measured
	// thresholds.
	hotCPUPct     = 100.0
	hotMemBytes   = 2 << 30
	hotAfter      = time.Minute
	hotClearAfter = 15 * time.Second
	// reapEvery is how often the daemon stops orphaned pty-hosts on its own;
	// the first sweep waits reapFirst after start. A sweep is one process
	// table read when there is nothing to stop.
	reapFirst = 5 * time.Minute
	reapEvery = 10 * time.Minute
	// topProcs is how many of a tree's busiest processes are named.
	topProcs = 3
)

// ProcUsage is one process's figures.
type ProcUsage struct {
	PID      int32   `json:"pid"`
	Name     string  `json:"name"`
	CPUPct   float64 `json:"cpu_pct"`
	MemBytes uint64  `json:"mem_bytes"`
}

// SessionResources is one live session's process tree.
type SessionResources struct {
	SessionID string `json:"session_id"`
	PID       int32  `json:"pid"`
	// CPUPct is summed over the tree: 250 is two and a half cores.
	CPUPct   float64 `json:"cpu_pct"`
	MemBytes uint64  `json:"mem_bytes"`
	Procs    int     `json:"procs"`
	// Warm is false on a tree's first sample, before there is a CPU rate.
	Warm bool        `json:"warm"`
	Top  []ProcUsage `json:"top"`
	Hot  bool        `json:"hot"`
	// OverSince is when the tree last went over a limit (unix ms), 0 while
	// it is under both; Hot follows hotAfter later.
	OverSince int64 `json:"over_since,omitempty"`
	// MaxProcBytes is the tree's largest process's own memory — on macOS
	// its physical footprint, compressed pages included.
	MaxProcBytes uint64 `json:"max_proc_bytes"`
	// Heavy flags an agent whose one process is too big ("big") or has grown
	// steadily for hours ("growing"); "" otherwise (sysmem.go, heavyOf).
	Heavy string `json:"heavy,omitempty"`
}

// HostSummary is the pty-hosts on this machine, counted.
type HostSummary struct {
	Count    int     `json:"count"`
	MemBytes uint64  `json:"mem_bytes"`
	CPUPct   float64 `json:"cpu_pct"`
	// Orphans are holders no daemon will attach to again; Reapable is the
	// part of them a reap stops (dead, or an idle shell). The rest run an
	// agent or a command and are left alone.
	Orphans  int `json:"orphans"`
	Reapable int `json:"reapable"`
}

// HostResources is the pty-hosts on this machine, with the verdict on each.
type HostResources struct {
	HostSummary
	List []ptyhost.Verdict `json:"list"`
}

// ProcGroup is several processes counted as one: the app's web view.
type ProcGroup struct {
	Count    int         `json:"count"`
	CPUPct   float64     `json:"cpu_pct"`
	MemBytes uint64      `json:"mem_bytes"`
	Procs    []ProcUsage `json:"procs"`
}

// CaprockResources is Caprock's own cost.
type CaprockResources struct {
	Daemon ProcUsage `json:"daemon"`
	// App is the desktop app's own process, when it is running.
	App *ProcUsage `json:"app,omitempty"`
	// Webview is the processes that draw the app's window: on macOS the
	// WebKit helpers (WebContent, GPU, Networking) macOS holds the app
	// responsible for — launchd's children, not the app's — and elsewhere
	// the app's own child processes (WebView2, WebKitGTK). Absent when the
	// app is not running or none is found.
	Webview *ProcGroup    `json:"webview,omitempty"`
	Hosts   HostResources `json:"hosts"`
}

// ResourceThresholds are the "hot" limits, so a client can say what they are.
type ResourceThresholds struct {
	CPUPct      float64 `json:"cpu_pct"`
	MemBytes    uint64  `json:"mem_bytes"`
	AfterS      int     `json:"after_s"`
	IntervalSec int     `json:"interval_s"`
}

// MachineResources is the machine-wide part of GET /v1/resources.
type MachineResources struct {
	CPUs int `json:"cpus"`
	// Load1 is the one-minute load average; nil where the OS keeps none
	// (Windows).
	Load1        *float64 `json:"load1,omitempty"`
	MemTotal     uint64   `json:"mem_total"`
	MemAvailable uint64   `json:"mem_available"`
}

// machineResources reads the machine-wide figures; nil when none came back.
func machineResources(ctx context.Context) *MachineResources {
	st, _ := procstat.Machine(ctx)
	if st.MemTotal == 0 && !st.HasLoad {
		return nil
	}
	m := &MachineResources{CPUs: st.CPUs, MemTotal: st.MemTotal, MemAvailable: st.MemAvailable}
	if st.HasLoad {
		l := math.Round(st.Load1*100) / 100
		m.Load1 = &l
	}
	return m
}

// ResourceReport is GET /v1/resources and the data of a "resources" frame.
type ResourceReport struct {
	At         int64              `json:"at"`
	Sessions   []SessionResources `json:"sessions"`
	Caprock    CaprockResources   `json:"caprock"`
	Thresholds ResourceThresholds `json:"thresholds"`
	// Machine is the machine as a whole (ADR-067): what another computer
	// reads through /v1/m/{id}/v1/resources to say which one has room.
	// Absent when the OS gave none of it.
	Machine *MachineResources `json:"machine,omitempty"`
	// Memory is the machine's memory and who holds it, totals only
	// (sysmem.go; 03-contracts.md § System memory). Absent when the OS
	// gave none of it.
	Memory *MachineMemory `json:"memory,omitempty"`
	Error  string         `json:"error,omitempty"`

	// What the footprint needs beyond the contract's figures (footprint.go).
	scan   caprockScan
	others []CaprockProc // the other daemons, with their memory
	apps   []CaprockProc // every app process, with its memory
}

type pidKey struct {
	pid   int32
	start int64
}

type overState struct {
	since time.Time // first sample over a limit in this run
	under time.Time // first sample under both since then; zero while over
	hot   bool
}

type resourceMeter struct {
	mu      sync.Mutex // one sample at a time; guards everything below
	sampler *procstat.Sampler
	argv    map[pidKey][]string
	env     map[pidKey][]string
	exe     map[pidKey]string
	resp    map[pidKey]int32 // macOS: the process responsible for a WebKit helper
	tty     map[pidKey]bool  // whether a process has a controlling terminal
	over    map[string]*overState
	last    *ResourceReport
	asked   time.Time // last GET /v1/resources
	// orphSampler measures the orphan list (orphans.go); orphLast is the
	// last orphan scan, whose counts the footprint answers with between
	// scans.
	orphSampler *procstat.Sampler
	orphLast    OrphanReport
	// hist is the last hour of samples (reshistory.go).
	hist resourceHistory
	// swap is the last swapGrowWindow of swap readings (sysmem.go).
	swap []swapMark
	// growth is each session's largest process over the last hours, one
	// reading per growEvery (sysmem.go).
	growth map[string][]growPoint
}

func newResourceMeter() *resourceMeter {
	return &resourceMeter{
		sampler: procstat.NewSampler(),
		argv:    map[pidKey][]string{}, env: map[pidKey][]string{},
		exe: map[pidKey]string{}, resp: map[pidKey]int32{}, tty: map[pidKey]bool{},
		over:        map[string]*overState{},
		growth:      map[string][]growPoint{},
		orphSampler: procstat.NewSampler(),
	}
}

// resourceLoop samples while a dashboard is open and sweeps orphaned
// pty-hosts once in a while whether or not one is.
func (d *Daemon) resourceLoop(ctx context.Context) {
	t := time.NewTicker(resourceEvery)
	defer t.Stop()
	reap := time.NewTimer(reapFirst)
	defer reap.Stop()
	push := time.NewTicker(livePushEvery)
	defer push.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-push.C:
			d.pushLive(ctx)
		case <-reap.C:
			if res, err := d.reapOrphans(ctx, false); err != nil {
				d.log.Warn("orphaned pty-host sweep", "component", "resources", "err", err)
			} else if len(res.Reaped) > 0 {
				d.log.Info("stopped orphaned pty-hosts", "component", "resources", "count", len(res.Reaped))
			}
			// The orphan count the status strip warns with; the list is
			// taken only when someone opens the doctor.
			d.scanOrphans(ctx)
			reap.Reset(reapEvery)
		case <-t.C:
			if !d.someoneLooking() {
				continue
			}
			r := d.sampleResources(ctx)
			d.bus.Publish(bus.Frame{Type: bus.FrameResources, Data: r})
		}
	}
}

func (d *Daemon) someoneLooking() bool {
	if d.api != nil && d.api.LiveClients() > 0 {
		return true
	}
	d.res.mu.Lock()
	defer d.res.mu.Unlock()
	return time.Since(d.res.asked) < resourceViewerGrace
}

// resources answers GET /v1/resources: the last sample when it is fresh,
// otherwise a new one.
func (d *Daemon) resources(ctx context.Context) *ResourceReport {
	d.res.mu.Lock()
	d.res.asked = time.Now()
	last := d.res.last
	d.res.mu.Unlock()
	if last != nil && time.Since(time.UnixMilli(last.At)) < resourceEvery {
		return last
	}
	return d.sampleResources(ctx)
}

// sessionPIDs is every live session with a process to measure: the store's
// (hook-observed and owned) and the manager's own (shells have no row).
func (d *Daemon) sessionPIDs(ctx context.Context) map[string]int32 {
	out := map[string]int32{}
	if live, err := store.LivePIDs(ctx, d.store.DB()); err == nil {
		for _, l := range live {
			out[l.SessionID] = int32(l.PID)
		}
	}
	if d.mgr != nil {
		for _, a := range d.mgr.List() {
			if _, exited := a.Exited(); !exited && a.PID() > 0 {
				out[a.SessionID] = int32(a.PID())
			}
		}
	}
	return out
}

func (d *Daemon) sampleResources(ctx context.Context) *ResourceReport {
	d.res.mu.Lock()
	defer d.res.mu.Unlock()
	now := time.Now()
	r := &ResourceReport{
		At:       now.UnixMilli(),
		Sessions: []SessionResources{},
		Thresholds: ResourceThresholds{
			CPUPct: hotCPUPct, MemBytes: hotMemBytes,
			AfterS: int(hotAfter / time.Second), IntervalSec: int(resourceEvery / time.Second),
		},
	}
	r.Machine = machineResources(ctx)
	tab, err := procstat.Read(ctx)
	if err != nil {
		r.Error = err.Error()
		d.res.last = r
		return r
	}
	sessions := d.sessionPIDs(ctx)
	trees := make(map[string][]int32, len(sessions))
	var want []int32
	for id, pid := range sessions {
		tr := tab.Tree(pid)
		if len(tr) == 0 {
			continue
		}
		trees[id] = tr
		want = append(want, tr...)
	}
	self := int32(os.Getpid())
	want = append(want, self)
	scan := d.res.scanCaprock(ctx, tab, self)
	want = append(want, scan.pids()...)
	use := d.res.sampler.Sample(tab, want)

	for id, tr := range trees {
		s := SessionResources{SessionID: id, PID: tr[0], Warm: true}
		procs := make([]ProcUsage, 0, len(tr))
		for _, pid := range tr {
			u, ok := use[pid]
			if !ok {
				continue
			}
			s.Procs++
			s.CPUPct += u.CPUPct
			s.MemBytes += u.MemBytes
			s.Warm = s.Warm && u.Warm
			s.MaxProcBytes = max(s.MaxProcBytes, u.MemBytes)
			procs = append(procs, ProcUsage{PID: pid, CPUPct: u.CPUPct, MemBytes: u.MemBytes})
		}
		sort.Slice(procs, func(i, j int) bool {
			if procs[i].CPUPct != procs[j].CPUPct {
				return procs[i].CPUPct > procs[j].CPUPct
			}
			return procs[i].MemBytes > procs[j].MemBytes
		})
		if len(procs) > topProcs {
			procs = procs[:topProcs]
		}
		for i := range procs {
			procs[i].Name = d.res.label(ctx, tab.Procs[procs[i].PID])
		}
		s.Top = procs
		d.res.judge(&s, now)
		var total uint64
		if r.Machine != nil {
			total = r.Machine.MemTotal
		}
		if d.mgr == nil || !d.mgr.IsShell(id) {
			s.Heavy = d.res.heavyOf(id, s.MaxProcBytes, total, now)
		}
		r.Sessions = append(r.Sessions, s)
	}
	// Forget sessions that are gone, so a pid reused tomorrow starts cold.
	for id := range d.res.over {
		if _, ok := trees[id]; !ok {
			delete(d.res.over, id)
		}
	}
	for id := range d.res.growth {
		if _, ok := trees[id]; !ok {
			delete(d.res.growth, id)
		}
	}
	sort.Slice(r.Sessions, func(i, j int) bool { return r.Sessions[i].SessionID < r.Sessions[j].SessionID })

	r.Caprock = d.res.caprockFrom(ctx, tab, scan, use, ptyhost.Dir(d.opt.DataDir), now)
	r.Caprock.Daemon = usageOf(self, "caprock", use)
	r.scan = scan
	r.others = withMemory(scan.daemons, use)
	r.apps = withMemory(scan.apps, use)
	r.Memory = d.machineMemory(r, now)
	d.res.forgetGone(tab)
	d.res.last = r
	d.res.hist.record(r)
	return r
}

// resourceHistory answers GET /v1/resources/history: the samples kept since
// sinceMs. It takes no sample of its own.
func (d *Daemon) resourceHistory(sinceMs int64) *ResourceHistory {
	d.res.mu.Lock()
	defer d.res.mu.Unlock()
	return d.res.hist.since(sinceMs)
}

// forgetGone drops the caches keyed by processes that no longer exist.
func (m *resourceMeter) forgetGone(tab *procstat.Table) {
	gone := func(k pidKey) bool {
		p, ok := tab.Procs[k.pid]
		return !ok || p.StartMs != k.start
	}
	for k := range m.argv {
		if gone(k) {
			delete(m.argv, k)
		}
	}
	for k := range m.env {
		if gone(k) {
			delete(m.env, k)
		}
	}
	for k := range m.exe {
		if gone(k) {
			delete(m.exe, k)
		}
	}
	for k := range m.resp {
		if gone(k) {
			delete(m.resp, k)
		}
	}
	for k := range m.tty {
		if gone(k) {
			delete(m.tty, k)
		}
	}
}

// caprockFrom is Caprock's own cost from one scan and one sample: the app,
// its web view and the holders. The daemon's own line is the caller's.
func (m *resourceMeter) caprockFrom(ctx context.Context, tab *procstat.Table, scan caprockScan, use map[int32]procstat.Usage, ownRegistry string, now time.Time) CaprockResources {
	var c CaprockResources
	if len(scan.apps) > 0 {
		a := ProcUsage{PID: scan.apps[0].PID, Name: "caprock-app"}
		for _, p := range scan.apps {
			u := use[p.PID]
			a.CPUPct += u.CPUPct
			a.MemBytes += u.MemBytes
		}
		c.App = &a
	}
	if len(scan.webviews) > 0 {
		g := &ProcGroup{Procs: []ProcUsage{}}
		for _, pid := range scan.webviews {
			u, ok := use[pid]
			if !ok {
				continue
			}
			g.Count++
			g.CPUPct += u.CPUPct
			g.MemBytes += u.MemBytes
			g.Procs = append(g.Procs, ProcUsage{PID: pid, Name: m.label(ctx, tab.Procs[pid]), CPUPct: u.CPUPct, MemBytes: u.MemBytes})
		}
		sort.Slice(g.Procs, func(i, j int) bool { return g.Procs[i].MemBytes > g.Procs[j].MemBytes })
		if g.Count > 0 {
			c.Webview = g
		}
	}
	verdicts := ptyhost.Classify(scan.hosts, ownRegistry, now)
	hr := HostResources{HostSummary: HostSummary{Count: len(scan.hosts)}, List: verdicts}
	for i, h := range scan.hosts {
		u := use[h.PID]
		hr.MemBytes += u.MemBytes
		hr.CPUPct += u.CPUPct
		if verdicts[i].Orphan() {
			hr.Orphans++
		}
		if verdicts[i].Reap {
			hr.Reapable++
		}
	}
	c.Hosts = hr
	return c
}

// judge updates a session's over/under run and decides whether it is hot.
func (m *resourceMeter) judge(s *SessionResources, now time.Time) {
	over := s.Warm && (s.CPUPct >= hotCPUPct || s.MemBytes >= hotMemBytes)
	st := m.over[s.SessionID]
	switch {
	case over && st == nil:
		st = &overState{since: now}
		m.over[s.SessionID] = st
	case over:
		st.under = time.Time{}
	case st != nil && st.under.IsZero():
		st.under = now
	}
	if st != nil && !over && now.Sub(st.under) >= hotClearAfter {
		delete(m.over, s.SessionID)
		st = nil
	}
	if st == nil {
		return
	}
	if !st.hot && st.under.IsZero() && now.Sub(st.since) >= hotAfter {
		st.hot = true
	}
	s.Hot = st.hot
	s.OverSince = st.since.UnixMilli()
}

func (m *resourceMeter) label(ctx context.Context, p procstat.Proc) string {
	k := pidKey{p.PID, p.StartMs}
	argv, ok := m.argv[k]
	if !ok {
		argv = procstat.Cmdline(ctx, p.PID)
		m.argv[k] = argv
	}
	return procstat.Label(p.Name, argv)
}

func usageOf(pid int32, name string, use map[int32]procstat.Usage) ProcUsage {
	u := use[pid]
	return ProcUsage{PID: pid, Name: name, CPUPct: u.CPUPct, MemBytes: u.MemBytes}
}

func isAppName(name string) bool {
	n := strings.TrimSuffix(strings.ToLower(name), ".exe")
	return n == "caprock-app"
}

// sameUser reports whether p runs as this daemon's user, where the table
// says (not on Windows).
func sameUser(p procstat.Proc) bool {
	return p.UID < 0 || p.UID == int64(os.Getuid())
}

// findHosts lists every `caprock pty-host` on the machine run by this user,
// whichever Caprock started it, with what Classify needs. Must be called
// with d.res.mu held.
func (d *Daemon) findHosts(ctx context.Context, tab *procstat.Table, self int32) []ptyhost.HostProc {
	return d.res.scanCaprock(ctx, tab, self).hosts
}

// ReapResult is POST /v1/resources/reap.
type ReapResult struct {
	Reaped []ptyhost.Verdict `json:"reaped"`
	// Failed are the ones that would not stop, with why.
	Failed []ReapFailure `json:"failed,omitempty"`
	// Kept are the orphans left running: an agent or a command is still
	// running in them.
	Kept []ptyhost.Verdict `json:"kept"`
}

// ReapFailure is a holder a reap could not stop.
type ReapFailure struct {
	PID   int32  `json:"pid"`
	Error string `json:"error"`
}

// reapGrace is how long a holder gets to stop after SIGTERM before SIGKILL.
const reapGrace = 3 * time.Second

// reapOrphans stops the pty-hosts Classify marks reapable: a holder whose
// child has exited, or whose registry is gone and whose child is a shell
// running nothing. It signals only `caprock pty-host` processes of this
// user — processes a Caprock started (rule 7) — and re-checks each one's
// identity (pid and start time) immediately before every signal. The
// daemon's own sweep and the Settings button stop the same holders — every
// reapable one, whichever Caprock started it: nobody else cleans up after a
// user's Caprock, and the rule that makes a holder reapable (its program has
// exited, or it is unreachable holding only an idle shell) is what makes
// stopping it safe. Every such holder is a Caprock's own — a process some
// Caprock started — which is what lets rule 7 allow the signal. asked is the
// button; what was stopped goes into the footprint's action log either way.
func (d *Daemon) reapOrphans(ctx context.Context, asked bool) (ReapResult, error) {
	res := ReapResult{Reaped: []ptyhost.Verdict{}, Kept: []ptyhost.Verdict{}}
	d.res.mu.Lock()
	tab, err := procstat.Read(ctx)
	if err != nil {
		d.res.mu.Unlock()
		return res, err
	}
	hosts := d.findHosts(ctx, tab, int32(os.Getpid()))
	d.res.mu.Unlock()
	verdicts := ptyhost.Classify(hosts, ptyhost.Dir(d.opt.DataDir), time.Now())
	for i, v := range verdicts {
		switch {
		case v.Reap:
			if err := stopHost(ctx, hosts[i]); err != nil {
				res.Failed = append(res.Failed, ReapFailure{PID: v.PID, Error: err.Error()})
				continue
			}
			res.Reaped = append(res.Reaped, v)
			d.log.Info("stopped an orphaned pty-host", "component", "resources", "pid", v.PID, "state", v.State, "child", v.Child)
		case v.Orphan():
			res.Kept = append(res.Kept, v)
		}
	}
	if len(res.Reaped) > 0 && d.actions != nil {
		d.actions.add(reapAction(res.Reaped, asked))
	}
	return res, nil
}

// errChanged is a pid that no longer names the process that was judged.
var errChanged = errors.New("the process changed before it could be stopped")

// stopHost asks the holder to stop, then makes it. Its PTY closes with it, so
// the shell inside gets the hangup a closed terminal window sends.
func stopHost(ctx context.Context, h ptyhost.HostProc) error {
	same := func() bool {
		tab, err := procstat.Read(ctx)
		if err != nil {
			return false
		}
		p, ok := tab.Procs[h.PID]
		return ok && p.StartMs == h.StartMs && !exited(h.PID)
	}
	if !same() {
		return errChanged
	}
	if err := terminate(int(h.PID)); err != nil {
		return err
	}
	deadline := time.Now().Add(reapGrace)
	for time.Now().Before(deadline) {
		if !same() {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	if !same() {
		return nil
	}
	return kill(int(h.PID))
}
