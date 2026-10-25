package daemon

import (
	"context"
	"os"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/keepawake"
	"github.com/dspv/caprock/internal/narrate"
	"github.com/dspv/caprock/internal/procstat"
	"github.com/dspv/caprock/internal/store"
)

// The machine's memory (03-contracts.md § System memory): how full it is,
// how much of it the agents and Caprock hold, and — on the user's click —
// ending the idle agents Caprock started. A user's Mac froze with agents
// holding all its memory (2026-10-22) while the status bar said only what
// the agent in front used.
//
// The machine-wide figures ride on each resource sample (resources.go): one
// host_statistics64 and two sysctls on macOS, two small /proc files on
// Linux, one GlobalMemoryStatusEx on Windows, and only while a dashboard is
// open. What the popover lists — each agent's state, the other apps by name
// — is read only when GET /v1/system/memory asks.

const (
	// memTightPct is how full memory is before the bar turns amber where
	// the OS's own pressure does not already say so: a round number chosen
	// to leave room for one more agent on a 16 GB machine, not measured.
	memTightPct = 85
	// A swap that grew by swapGrowBytes within swapGrowWindow is a machine
	// paging out as it goes: critical whatever the pressure says. Chosen,
	// not measured: a quarter of a gigabyte in half a minute is well above
	// the trickle an idle Mac swaps.
	swapGrowWindow = 30 * time.Second
	swapGrowBytes  = 256 << 20
	// memIdleQuiet is how long an agent Caprock started must have drawn
	// nothing and written no event before the popover calls it idle rather
	// than working: a turn that runs draws every second (endidle.go).
	memIdleQuiet = 2 * time.Minute
	// memEndQuiet is how long it must have been idle before Free up memory
	// offers to end it (owner, 2026-10-25: two minutes is a person reading
	// the answer, not an agent left behind). Chosen, not measured.
	memEndQuiet = 15 * time.Minute
	// memTopApps is how many other apps the popover names.
	memTopApps = 3
	// memTestPressureEnv fakes the OS's pressure level (normal, warn,
	// critical) for screenshots and browser checks. A test hook: never set
	// by Caprock, documented in 03-contracts.md § System memory.
	memTestPressureEnv = "CAPROCK_TEST_MEMORY_PRESSURE"
)

// A heavy agent: one process too big, or growing steadily for hours. Long
// sessions of an agent's CLI grow in memory (on the owner's Mac one Claude
// Code process had a 2.7 GB footprint, 2 GB of it compressed, with a
// resident set of 0.6 GB; 2026-10-22), and restarting it with the
// conversation kept frees it. The figures are chosen, not measured: 3 GiB
// or a fifth of the machine is more than one agent should hold, and a
// gigabyte gained over two hours without falling back is a leak's shape,
// not a turn's.
const (
	heavyMinBytes = 3 << 30
	heavyShare    = 5 // one fifth of the machine's memory
	// growEvery is how often a session's largest process is written down,
	// growKeep how long the readings are kept, growSpan how long they must
	// cover, growBytes how much it must have gained, and growDip how far
	// (1/growDip of the previous reading) it may fall back between two
	// readings and still be growing steadily.
	growEvery = 10 * time.Minute
	growKeep  = 4 * time.Hour
	growSpan  = 2 * time.Hour
	growBytes = 1 << 30
	growDip   = 20
)

// Heavy agent kinds.
const (
	HeavyBig     = "big"
	HeavyGrowing = "growing"
)

type growPoint struct {
	at    time.Time
	bytes uint64
}

// heavyLimit is the size one agent process is flagged at on a machine with
// total bytes of memory: 3 GiB, or a fifth of the machine if that is more.
func heavyLimit(total uint64) uint64 {
	return max(uint64(heavyMinBytes), total/heavyShare)
}

// growingSteadily is whether readings, oldest first, cover growSpan, gained
// growBytes and never fell back by more than 1/growDip between two of them.
// The meter samples only while a window is open, so the readings may have
// gaps; their times, not their count, say how long they cover.
func growingSteadily(pts []growPoint) bool {
	if len(pts) < 3 || pts[len(pts)-1].at.Sub(pts[0].at) < growSpan {
		return false
	}
	first, last := pts[0].bytes, pts[len(pts)-1].bytes
	if last < first || last-first < growBytes {
		return false
	}
	for i := 1; i < len(pts); i++ {
		if prev := pts[i-1].bytes; pts[i].bytes+prev/growDip < prev {
			return false
		}
	}
	return true
}

// heavyOf records a session's largest process and says whether it is heavy.
// Must be called with m.mu held.
func (m *resourceMeter) heavyOf(id string, maxProc, total uint64, now time.Time) string {
	pts := m.growth[id]
	if len(pts) == 0 || now.Sub(pts[len(pts)-1].at) >= growEvery {
		pts = append(pts, growPoint{at: now, bytes: maxProc})
		for len(pts) > 0 && now.Sub(pts[0].at) > growKeep {
			pts = pts[1:]
		}
		m.growth[id] = pts
	}
	switch {
	case maxProc >= heavyLimit(total):
		return HeavyBig
	case growingSteadily(pts):
		return HeavyGrowing
	}
	return ""
}

// Memory levels: the bar's green, amber and red.
const (
	MemNormal   = "normal"
	MemTight    = "tight"
	MemCritical = "critical"
)

// MachineMemory is the machine's memory in a resource sample: totals only,
// so it can ride the live socket every paired device also reads.
type MachineMemory struct {
	// Label names the machine on the bar: "Mac", "Linux", "Windows", or
	// "Memory" elsewhere.
	Label string `json:"label"`
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
	// SwapTotal and SwapUsed are omitted where swap is not read (Windows).
	SwapTotal   uint64 `json:"swap_total,omitempty"`
	SwapUsed    uint64 `json:"swap_used,omitempty"`
	SwapGrowing bool   `json:"swap_growing,omitempty"`
	// Pressure is the OS's verdict, normal|warn|critical; absent where it
	// keeps none.
	Pressure string `json:"pressure,omitempty"`
	// Level is the bar's: normal, tight or critical (memoryLevel).
	Level string `json:"level"`
	// Agents is the agents' process trees together, Caprock the daemon, the
	// app, its web view and the terminal holders, and Other the rest of Used.
	Agents     uint64 `json:"agents"`
	AgentCount int    `json:"agent_count"`
	Caprock    uint64 `json:"caprock"`
	Other      uint64 `json:"other"`
	// Simulated is set while the test hook fakes the pressure.
	Simulated bool `json:"simulated,omitempty"`
}

// memoryLevel is the bar's level: critical when the OS says so or swap is
// growing, tight when it warns or memory is memTightPct full.
func memoryLevel(pressure string, used, total uint64, swapGrowing bool) string {
	switch {
	case pressure == procstat.PressureCritical || swapGrowing:
		return MemCritical
	case pressure == procstat.PressureWarn:
		return MemTight
	case total > 0 && used*100 >= total*memTightPct:
		return MemTight
	}
	return MemNormal
}

// memLabel is what the bar calls this machine.
func memLabel(goos string) string {
	switch goos {
	case "darwin":
		return "Mac"
	case "linux":
		return "Linux"
	case "windows":
		return "Windows"
	}
	return "Memory"
}

type swapMark struct {
	at   time.Time
	used uint64
}

// swapGrowing records one swap reading and says whether swap grew by
// swapGrowBytes within swapGrowWindow. marks are the readings kept.
func swapGrowing(marks []swapMark, now time.Time, used uint64) ([]swapMark, bool) {
	keep := marks[:0]
	for _, m := range marks {
		if now.Sub(m.at) <= swapGrowWindow {
			keep = append(keep, m)
		}
	}
	growing := false
	for _, m := range keep {
		if used > m.used && used-m.used >= swapGrowBytes {
			growing = true
			break
		}
	}
	return append(keep, swapMark{at: now, used: used}), growing
}

// machineMemory reads the machine's memory and splits it, for one sample.
// Must be called with m.mu held.
func (d *Daemon) machineMemory(r *ResourceReport, now time.Time) *MachineMemory {
	sm, err := procstat.SystemMemory()
	if err != nil || sm.Total == 0 {
		return nil
	}
	mm := &MachineMemory{Label: memLabel(runtime.GOOS), Total: sm.Total, Used: sm.Used, Pressure: sm.Pressure}
	if sm.HasSwap {
		mm.SwapTotal, mm.SwapUsed = sm.SwapTotal, sm.SwapUsed
		d.res.swap, mm.SwapGrowing = swapGrowing(d.res.swap, now, sm.SwapUsed)
	}
	if v := os.Getenv(memTestPressureEnv); v != "" {
		switch v {
		case procstat.PressureNormal, procstat.PressureWarn, procstat.PressureCritical:
			mm.Pressure, mm.Simulated = v, true
		}
	}
	mm.Level = memoryLevel(mm.Pressure, mm.Used, mm.Total, mm.SwapGrowing)
	for _, s := range d.agentTrees(r) {
		mm.Agents += s.MemBytes
		mm.AgentCount++
	}
	c := r.Caprock
	mm.Caprock = c.Daemon.MemBytes + c.Hosts.MemBytes
	if c.App != nil {
		mm.Caprock += c.App.MemBytes
	}
	if c.Webview != nil {
		mm.Caprock += c.Webview.MemBytes
	}
	if held := mm.Agents + mm.Caprock; held < mm.Used {
		mm.Other = mm.Used - held
	}
	return mm
}

// agentTrees is the sample's sessions that are agents — not shells — each
// process tree once: a session renamed by /clear is listed under both ids
// with one process.
func (d *Daemon) agentTrees(r *ResourceReport) []SessionResources {
	out := make([]SessionResources, 0, len(r.Sessions))
	seen := map[int32]bool{}
	for _, s := range r.Sessions {
		if seen[s.PID] || (d.mgr != nil && d.mgr.IsShell(s.SessionID)) {
			continue
		}
		seen[s.PID] = true
		out = append(out, s)
	}
	return out
}

// MemoryAgent is one agent in GET /v1/system/memory.
type MemoryAgent struct {
	SessionID string `json:"session_id"`
	PID       int32  `json:"pid"`
	MemBytes  uint64 `json:"mem_bytes"`
	Procs     int    `json:"procs"`
	// Owned is a session Caprock started; only those are ever ended.
	Owned bool `json:"owned"`
	// State is working, waiting (on the user: a prompt, a question, a
	// queued message, a pause) or idle.
	State string `json:"state"`
	// IdleSince is when an idle agent last did anything, unix ms.
	IdleSince int64 `json:"idle_since,omitempty"`
	// Endable is an idle agent Caprock started that the button ends.
	Endable bool `json:"endable"`
	// WhyNot says, for an agent Caprock started that is not endable, why
	// Free up memory leaves it running (whyNot*); "" when endable or not
	// started by Caprock.
	WhyNot string `json:"why_not,omitempty"`
	// MaxProcBytes is its largest process; Heavy is "big" or "growing"
	// when that process is flagged (heavyOf), "" otherwise.
	MaxProcBytes uint64 `json:"max_proc_bytes"`
	Heavy        string `json:"heavy,omitempty"`
	// Restartable is an agent Caprock started that Restart it fresh may
	// end and continue now: not mid-turn and waiting on no prompt.
	Restartable bool `json:"restartable"`
}

// MemoryApp is one other app: its processes together, helpers under the app.
type MemoryApp struct {
	Name     string `json:"name"`
	MemBytes uint64 `json:"mem_bytes"`
	Procs    int    `json:"procs"`
	// VM is an app running a virtual machine (isVMHost): its size is the
	// guest's memory, most of which may be compressed or in swap.
	VM bool `json:"vm,omitempty"`
}

// IdleEndOffer is what the button ends and about how much it frees.
type IdleEndOffer struct {
	Count      int      `json:"count"`
	MemBytes   uint64   `json:"mem_bytes"`
	SessionIDs []string `json:"session_ids"`
}

// MemoryReport is GET /v1/system/memory.
type MemoryReport struct {
	At     int64         `json:"at"`
	Memory MachineMemory `json:"memory"`
	Agents []MemoryAgent `json:"agents"`
	// Apps are the other apps using the most, by name; absent for a paired
	// device, which reads totals only.
	Apps    []MemoryApp  `json:"apps,omitempty"`
	IdleEnd IdleEndOffer `json:"idle_end"`
	Error   string       `json:"error,omitempty"`
}

// systemMemory answers GET /v1/system/memory. paired leaves out the other
// apps' names: a phone reads how full the machine is, not what else runs.
// front is the session whose tab is in front of the asking dashboard
// (?front=), never offered.
func (d *Daemon) systemMemory(ctx context.Context, paired bool, front string) *MemoryReport {
	r := d.resources(ctx)
	rep := &MemoryReport{At: r.At, Agents: []MemoryAgent{}, IdleEnd: IdleEndOffer{SessionIDs: []string{}}}
	if r.Memory == nil {
		rep.Error = "this machine's memory could not be read"
		if r.Error != "" {
			rep.Error = r.Error
		}
		return rep
	}
	rep.Memory = *r.Memory
	now := time.Now()
	bg := d.endIdle.bgFor(ctx)
	for _, s := range d.agentTrees(r) {
		a := MemoryAgent{SessionID: s.SessionID, PID: s.PID, MemBytes: s.MemBytes, Procs: s.Procs, MaxProcBytes: s.MaxProcBytes, Heavy: s.Heavy}
		st := d.endIdle.memState(ctx, s.SessionID, now, front, bg)
		a.Owned, a.State, a.Endable, a.Restartable, a.WhyNot = st.owned, st.state, st.endable, st.restartable, st.whyNot
		if st.state == agentIdle && !st.since.IsZero() {
			a.IdleSince = st.since.UnixMilli()
		}
		if a.Endable {
			rep.IdleEnd.Count++
			rep.IdleEnd.MemBytes += a.MemBytes
			rep.IdleEnd.SessionIDs = append(rep.IdleEnd.SessionIDs, a.SessionID)
		}
		rep.Agents = append(rep.Agents, a)
	}
	sort.SliceStable(rep.Agents, func(i, j int) bool { return rep.Agents[i].MemBytes > rep.Agents[j].MemBytes })
	if !paired {
		var sum uint64
		rep.Apps, sum = d.otherApps(ctx, r)
		rep.Memory.Other = settleOther(rep.Memory.Other, sum)
	}
	return rep
}

// settleOther is the popover's "Other apps and the system": the rest of
// used, or what the other apps it read hold together if that is more.
//
// The two are counted differently. used is RAM: compressed memory at the
// size it takes in the compressor, swapped-out memory not at all. An app's
// size is its physical footprint, as Activity Monitor's Memory column
// shows it, which counts its compressed and swapped-out pages at full size.
// An app whose memory is mostly compressed or in swap — an idle virtual
// machine, whose guest RAM is one process — is far bigger by its footprint
// than its share of used: on the owner's Mac colima's VM had an 8.2 GB
// footprint with 0.5 GB of it resident and 7.6 GB of swap in use, and the
// group it was listed under read 7.6 GB (2026-10-22). A group is never
// smaller than its members, so it takes their sum when that is more; the
// popover then says why the parts add up past what is in use.
func settleOther(rest, apps uint64) uint64 {
	return max(rest, apps)
}

// otherApps is the apps outside the agents and Caprock using the most memory,
// each with its helpers: on macOS a process is counted under the one macOS
// holds responsible for it (Chrome's renderers under Chrome, a web view's
// WebKit processes under its app) and named after its outermost .app. Only
// this user's processes can be read; the rest stay in Other's remainder.
// sum is what every app read holds together, not only the ones returned.
func (d *Daemon) otherApps(ctx context.Context, r *ResourceReport) (top []MemoryApp, sum uint64) {
	d.res.mu.Lock()
	defer d.res.mu.Unlock()
	tab, err := procstat.Read(ctx)
	if err != nil {
		return nil, 0
	}
	skip := map[int32]bool{int32(os.Getpid()): true}
	for _, s := range r.Sessions {
		for _, pid := range tab.Tree(s.PID) {
			skip[pid] = true
		}
	}
	for _, pid := range r.scan.pids() {
		skip[pid] = true
	}
	groups := map[string]*MemoryApp{}
	for pid, p := range tab.Procs {
		if pid <= 1 || skip[pid] || !sameUser(p) {
			continue
		}
		mem, err := procstat.ProcMemory(pid)
		if err != nil || mem == 0 {
			continue
		}
		name := d.res.appName(ctx, tab, p)
		g := groups[name]
		if g == nil {
			g = &MemoryApp{Name: name}
			groups[name] = g
		}
		g.MemBytes += mem
		g.Procs++
		g.VM = g.VM || isVMHost(p.Name)
	}
	return rankApps(groups)
}

// rankApps is the memTopApps largest apps, and what all of them hold.
func rankApps(groups map[string]*MemoryApp) ([]MemoryApp, uint64) {
	out := make([]MemoryApp, 0, len(groups))
	var sum uint64
	for _, g := range groups {
		out = append(out, *g)
		sum += g.MemBytes
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].MemBytes != out[j].MemBytes {
			return out[i].MemBytes > out[j].MemBytes
		}
		return out[i].Name < out[j].Name
	})
	if len(out) > memTopApps {
		out = out[:memTopApps]
	}
	return out, sum
}

// isVMHost is whether a process, by the process table's name, holds a
// virtual machine's guest memory: Apple's Virtualization framework's
// com.apple.Virtualization.VirtualMachine (colima, lima, Docker Desktop,
// UTM; macOS cuts the name to 16 bytes), QEMU's qemu-system-*, vfkit and
// krunkit. Read from the name alone, so no lookup is added per process.
func isVMHost(name string) bool {
	switch {
	case strings.HasPrefix(name, "com.apple.Virtua"), strings.HasPrefix(name, "qemu-system-"):
		return true
	case name == "vfkit", name == "krunkit":
		return true
	}
	return false
}

// appName is the app a process belongs to. Must be called with m.mu held.
func (m *resourceMeter) appName(ctx context.Context, tab *procstat.Table, p procstat.Proc) string {
	k := pidKey{p.PID, p.StartMs}
	root := p
	if runtime.GOOS == "darwin" {
		r, ok := m.resp[k]
		if !ok {
			r = procstat.ResponsiblePID(p.PID)
			m.resp[k] = r
		}
		if rp, ok := tab.Procs[r]; ok && r != p.PID {
			root = rp
		}
	}
	rk := pidKey{root.PID, root.StartMs}
	name := appNameOf(m.exeOf(ctx, rk), root.Name)
	if strings.IndexFunc(name, unicode.IsLetter) < 0 {
		// Claude Code's executable and its process name are both its
		// version (versions/2.1.292); argv[0] says "claude".
		if l := procstat.Label(root.Name, m.argvOf(ctx, rk)); strings.IndexFunc(l, unicode.IsLetter) >= 0 {
			return l
		}
	}
	return name
}

// appNameOf names an app from its executable: the outermost .app bundle on
// macOS ("Google Chrome" for every Chrome helper), else the program without
// .exe; name, the process table's, when the executable is unknown or is
// named by a version alone.
func appNameOf(exe, name string) string {
	if exe != "" {
		for _, part := range strings.Split(strings.ReplaceAll(exe, `\`, "/"), "/") {
			if strings.HasSuffix(part, ".app") && len(part) > len(".app") {
				return strings.TrimSuffix(part, ".app")
			}
		}
		// A program named by its version (Claude Code's
		// versions/2.1.292) says nothing: the table's name does.
		if b := procBase(exe); b != "" && strings.IndexFunc(b, unicode.IsLetter) >= 0 {
			return b
		}
	}
	if b := procBase(name); b != "" {
		return b
	}
	return "unknown"
}

func procBase(p string) string {
	i := strings.LastIndexAny(p, `/\`)
	b := p[i+1:]
	if strings.EqualFold(strings.ToLower(b[max(0, len(b)-4):]), ".exe") {
		b = b[:len(b)-4]
	}
	return b
}

// Agent states in the memory popover.
const (
	agentWorking = "working"
	agentWaiting = "waiting"
	agentIdle    = "idle"
)

type memAgentState struct {
	owned       bool
	state       string
	since       time.Time
	endable     bool
	restartable bool
	// whyNot is why an agent Caprock started is not endable.
	whyNot string
}

// Why Free up memory leaves an agent Caprock started running, as
// GET /v1/system/memory's why_not and end-idle's why say it. A state
// (working, waiting) is said as itself.
const (
	whyNotWorker     = "the orchestrator or one of its workers"
	whyNotFront      = "the tab in front"
	whyNotRecent     = "idle under 15 min"
	whyNotBackground = "running in the background: "
)

// bgFor is what memState asks about an agent's process tree: one process
// table for every agent judged in one answer.
func (e *endIdle) bgFor(ctx context.Context) func(a *agents.Agent) string {
	if e.bg != nil {
		return e.bg
	}
	r := newBGReader(ctx)
	return func(a *agents.Agent) string { return r.of(int32(a.PID())) }
}

// memState is what one agent is doing, and whether Free up memory may end
// it: only an agent Caprock started (rule 7) that is not a shell, not the
// orchestrator or one of its workers, not the tab in front (front), waits
// on nobody (endidle.go's waitingOn: no prompt, question, queued message,
// live subagent or pause), is not mid-turn, has been quiet for
// memEndQuiet, and has nothing running under it but its own helpers
// (agentwork.go). bg reads that last.
func (e *endIdle) memState(ctx context.Context, id string, now time.Time, front string, bg func(a *agents.Agent) string) memAgentState {
	db := e.d.store.DB()
	var st memAgentState
	if e.sess != nil {
		if a, ok := e.sess.Get(id); ok && !e.sess.IsShell(id) {
			st.owned = true
			last, err := e.lastActive(ctx, a)
			if err != nil {
				return memAgentState{owned: true, state: agentWorking, whyNot: agentWorking}
			}
			st.since = last
			if why, err := e.waitingOn(ctx, a, now); err != nil || why != "" {
				st.state = agentWaiting
				st.whyNot = agentWaiting
				return st
			}
			st.state = turnState(ctx, db, a.Current(), now)
			if st.state == agentIdle && now.Sub(last) < memIdleQuiet {
				st.state = agentWorking
			}
			worker := e.worker != nil && e.worker(id)
			// A turn that ended asking something can be restarted: the
			// question is in the conversation it continues.
			st.restartable = st.state != agentWorking && !worker
			switch {
			case st.state != agentIdle:
				st.whyNot = st.state
			case worker:
				st.whyNot = whyNotWorker
			case front != "" && (id == front || a.Current() == front):
				st.whyNot = whyNotFront
			case now.Sub(last) < memEndQuiet:
				st.whyNot = whyNotRecent
			default:
				if bg == nil {
					bg = e.bgFor(ctx)
				}
				if w := bg(a); w != "" {
					st.whyNot = whyNotBackground + w
				}
			}
			st.endable = st.whyNot == ""
			return st
		}
	}
	// A session another terminal started: its state, never an offer.
	st.state = turnState(ctx, db, id, now)
	if s, err := store.GetSession(ctx, db, id); err == nil && s.LastEventAt > 0 {
		st.since = time.UnixMilli(s.LastEventAt)
	}
	return st
}

// turnState reads a session's events as working (mid-turn, as the
// keep-awake keeper reads it: keepawake.go's busy), waiting (Needs you: the
// turn ended asking something of the user) or idle.
func turnState(ctx context.Context, db store.Querier, id string, now time.Time) string {
	last, err := store.LastEvents(ctx, db, id, 20)
	if err != nil {
		return agentWorking
	}
	subs, _ := store.LiveSubagents(ctx, db, id, now.Add(-store.LiveSubagentWindow).UnixMilli())
	act := narrate.Summarize(last, narrate.Options{Now: now, IdleAfter: keepawake.Silence, LiveSubagents: subs})
	switch {
	case busy(act, last):
		return agentWorking
	case act.Health == narrate.HealthWaiting:
		return agentWaiting
	}
	return agentIdle
}

// EndIdleResult is POST /v1/system/memory/end-idle.
type EndIdleResult struct {
	Ended   []string      `json:"ended"`
	Skipped []EndIdleSkip `json:"skipped,omitempty"`
}

// EndIdleSkip is a session the button named that was not ended, and why.
type EndIdleSkip struct {
	SessionID string `json:"session_id"`
	Why       string `json:"why"`
}

// endIdleNow ends the named agents the user chose in Free up memory, each
// only if memState still offers it — idle for memEndQuiet, started by
// Caprock, not the tab in front (front), nothing in the background — the
// way closing an idle tab ends one: End asks first, so the transcript is
// written and Continue picks the conversation up. A confirmed user action,
// never automatic.
func (e *endIdle) endIdleNow(ctx context.Context, ids []string, front string) EndIdleResult {
	res := EndIdleResult{Ended: []string{}}
	seen := map[string]bool{}
	now := e.now()
	for _, id := range ids {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		if why := e.endOne(ctx, id, now, front); why != "" {
			res.Skipped = append(res.Skipped, EndIdleSkip{SessionID: id, Why: why})
			continue
		}
		res.Ended = append(res.Ended, id)
	}
	return res
}

// endOne ends one session if it may be, holding the queue's lock so a
// message queued meanwhile is either typed in first or not at all; "" when
// it was ended, otherwise why not.
func (e *endIdle) endOne(ctx context.Context, id string, now time.Time, front string) string {
	if e.sess == nil {
		return "not started by Caprock"
	}
	unlock := e.q.lock(id)
	defer unlock()
	// The process table read now, not the one the list was drawn from.
	st := e.memState(ctx, id, now, front, nil)
	switch {
	case !st.owned:
		return "not started by Caprock"
	case !st.endable:
		return st.whyNot
	}
	e.mu.Lock()
	if e.ending[id] {
		e.mu.Unlock()
		return "already ending"
	}
	e.ending[id] = true
	e.mu.Unlock()
	if err := e.sess.End(id); err != nil {
		e.mu.Lock()
		delete(e.ending, id)
		e.mu.Unlock()
		return err.Error()
	}
	e.d.releaseFromWindowStop(id)
	e.d.log.Info("memory: ended an idle agent the user chose", "component", "agents", "session_id", id)
	return ""
}

// RestartEnd is POST /v1/system/memory/restart: whether the session was
// ended, and the folder to continue it in; Why says why not.
type RestartEnd struct {
	Ended bool   `json:"ended"`
	Cwd   string `json:"cwd,omitempty"`
	Agent string `json:"agent,omitempty"`
	Why   string `json:"why,omitempty"`
}

// restartWait is how long a restart waits for the ended process to exit:
// End's grace before it kills, and a little more.
var restartWait = agents.ShutdownGrace + 3*time.Second

// restartEnd is the first half of Restart it fresh, the user's click on a
// heavy agent: end the process the way End does (asked first, so the
// transcript is written; killed after the grace) and wait until it has
// exited, so the dashboard can continue the conversation in a new process
// with --resume. Only an agent Caprock started (rule 7), not mid-turn and
// waiting on no prompt, and not the orchestrator or one of its workers.
func (e *endIdle) restartEnd(ctx context.Context, id string) RestartEnd {
	if e.sess == nil {
		return RestartEnd{Why: "not started by Caprock"}
	}
	unlock := e.q.lock(id)
	// Restart asks only whether it is mid-turn: no process table is read.
	st := e.memState(ctx, id, e.now(), "", func(*agents.Agent) string { return "" })
	switch {
	case !st.owned:
		unlock()
		return RestartEnd{Why: "not started by Caprock"}
	case !st.restartable:
		unlock()
		return RestartEnd{Why: st.state}
	}
	a, ok := e.sess.Get(id)
	if !ok {
		unlock()
		return RestartEnd{Why: "not running"}
	}
	res := RestartEnd{Agent: a.Kind}
	if s, err := store.GetSession(ctx, e.d.store.DB(), a.Current()); err == nil {
		res.Cwd = s.Cwd
	}
	e.mu.Lock()
	if e.ending[id] {
		e.mu.Unlock()
		unlock()
		return RestartEnd{Why: "already ending"}
	}
	e.ending[id] = true
	e.mu.Unlock()
	err := e.sess.End(id)
	unlock()
	if err != nil {
		e.mu.Lock()
		delete(e.ending, id)
		e.mu.Unlock()
		return RestartEnd{Why: err.Error()}
	}
	e.d.releaseFromWindowStop(id)
	e.d.log.Info("memory: ended a heavy agent to restart it fresh", "component", "agents", "session_id", id)
	deadline := time.Now().Add(restartWait)
	for time.Now().Before(deadline) {
		if a, ok := e.sess.Get(id); !ok {
			break
		} else if _, exited := a.Exited(); exited {
			break
		}
		select {
		case <-ctx.Done():
			return RestartEnd{Why: ctx.Err().Error()}
		case <-time.After(100 * time.Millisecond):
		}
	}
	if a, ok := e.sess.Get(id); ok {
		if _, exited := a.Exited(); !exited {
			return RestartEnd{Why: "it has not exited yet"}
		}
	}
	res.Ended = true
	return res
}
