package daemon

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/procstat"
	"github.com/dspv/caprock/internal/store"
)

func TestMemoryLevel(t *testing.T) {
	const gib = 1 << 30
	for _, tc := range []struct {
		name     string
		pressure string
		used     uint64
		growing  bool
		want     string
	}{
		{"half full", procstat.PressureNormal, 8 * gib, false, MemNormal},
		{"no pressure signal, half full", "", 8 * gib, false, MemNormal},
		{"the OS warns", procstat.PressureWarn, 8 * gib, false, MemTight},
		{"87% full without a warning", procstat.PressureNormal, 14 * gib, false, MemTight},
		{"81% full", "", 13 * gib, false, MemNormal},
		{"the OS says critical", procstat.PressureCritical, 8 * gib, false, MemCritical},
		{"swap growing", procstat.PressureNormal, 8 * gib, true, MemCritical},
		{"swap growing over a warning", procstat.PressureWarn, 15 * gib, true, MemCritical},
	} {
		if got := memoryLevel(tc.pressure, tc.used, 16*gib, tc.growing); got != tc.want {
			t.Errorf("%s: %s, want %s", tc.name, got, tc.want)
		}
	}
	if got := memoryLevel("", 1, 0, false); got != MemNormal {
		t.Errorf("no total: %s", got)
	}
}

func TestSwapGrowing(t *testing.T) {
	t0 := time.Unix(1_800_000_000, 0)
	var marks []swapMark
	var growing bool
	step := func(sec int, used uint64) bool {
		marks, growing = swapGrowing(marks, t0.Add(time.Duration(sec)*time.Second), used)
		return growing
	}
	if step(0, 4<<30) {
		t.Fatal("one reading is not growth")
	}
	if step(5, 4<<30+100<<20) {
		t.Fatal("100 MB in 5 s is under the line")
	}
	if !step(10, 4<<30+300<<20) {
		t.Fatal("300 MB in 10 s is growth")
	}
	// Steady again: the readings that saw it grow age out of the window.
	step(20, 4<<30+300<<20)
	step(41, 4<<30+300<<20)
	if step(45, 4<<30+300<<20) {
		t.Fatal("a swap that stopped growing still reads growing")
	}
	if len(marks) > int(swapGrowWindow/(5*time.Second))+1 {
		t.Fatalf("kept %d readings", len(marks))
	}
	// Shrinking is not growth.
	if step(50, 1<<30) {
		t.Fatal("a shrinking swap reads growing")
	}
}

func TestAppNameOf(t *testing.T) {
	for _, tc := range []struct{ exe, name, want string }{
		{"/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/140/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)", "Google Chrome He", "Google Chrome"},
		{"/Applications/Slack.app/Contents/MacOS/Slack", "Slack", "Slack"},
		{"/usr/bin/python3", "python3", "python3"},
		{`C:\Program Files\Docker\Docker\Docker Desktop.exe`, "Docker Desktop.exe", "Docker Desktop"},
		{"", "firefox", "firefox"},
		{"/Users/me/.local/share/claude/versions/2.1.292", "claude", "claude"},
		{"", "", "unknown"},
	} {
		if got := appNameOf(tc.exe, tc.name); got != tc.want {
			t.Errorf("%q: %q, want %q", tc.exe, got, tc.want)
		}
	}
}

func TestMemLabel(t *testing.T) {
	for goos, want := range map[string]string{"darwin": "Mac", "linux": "Linux", "windows": "Windows", "freebsd": "Memory"} {
		if got := memLabel(goos); got != want {
			t.Errorf("%s: %s, want %s", goos, got, want)
		}
	}
}

// Agents are counted once per process tree: a session /clear renamed is
// listed under both ids with one process.
func TestAgentTreesCountAProcessOnce(t *testing.T) {
	d := &Daemon{}
	r := &ResourceReport{Sessions: []SessionResources{
		{SessionID: "a", PID: 10, MemBytes: 1 << 30},
		{SessionID: "a-after-clear", PID: 10, MemBytes: 1 << 30},
		{SessionID: "b", PID: 20, MemBytes: 2 << 30},
	}}
	got := d.agentTrees(r)
	if len(got) != 2 || got[0].SessionID != "a" || got[1].SessionID != "b" {
		t.Fatalf("%+v", got)
	}
}

// The sample's split, with the pressure faked by the test hook: critical,
// and the agents' and Caprock's shares taken out of what is used.
func TestMachineMemoryWithTheTestHook(t *testing.T) {
	t.Setenv(memTestPressureEnv, "critical")
	d := &Daemon{res: newResourceMeter()}
	r := &ResourceReport{
		Sessions: []SessionResources{{SessionID: "a", PID: 10, MemBytes: 100 << 20}, {SessionID: "b", PID: 11, MemBytes: 50 << 20}},
		Caprock:  CaprockResources{Daemon: ProcUsage{MemBytes: 30 << 20}, App: &ProcUsage{MemBytes: 20 << 20}},
	}
	m := d.machineMemory(r, time.Now())
	if m == nil {
		t.Fatal("no memory read")
	}
	if m.Level != MemCritical || m.Pressure != "critical" || !m.Simulated {
		t.Fatalf("hook not applied: %+v", m)
	}
	if m.Agents != 150<<20 || m.AgentCount != 2 || m.Caprock != 50<<20 {
		t.Fatalf("split: %+v", m)
	}
	if m.Other != m.Used-m.Agents-m.Caprock {
		t.Fatalf("other %d, want used less agents and Caprock", m.Other)
	}
	t.Setenv(memTestPressureEnv, "bogus")
	if m := d.machineMemory(r, time.Now()); m.Simulated {
		t.Fatal("an unknown value faked the pressure")
	}
}

// Free up memory's idle agents: an agent Caprock started, idle for 15
// minutes with nothing under it but its own helpers, is offered and ended.
// Never ended: one that works, waits on a prompt, idled under 15 minutes,
// runs something in the background (a dev server), is the tab in front, is
// a worker, or was started in another terminal — the last even when named.
// Each is judged again when the click comes.
func TestEndIdleNowEndsOnlyIdleOwnedAgents(t *testing.T) {
	s := newIdleStand(t)
	ctx := context.Background()
	idleFor := func(id string, at time.Duration) {
		s.add(t, id, agents.AgentClaude)
		s.event(t, id, event.KindAgentStop, at)
	}
	idleFor("idle", time.Minute)
	idleFor("mcponly", time.Minute) // its MCP servers are helpers: backgroundWork says ""
	idleFor("recent", 20*time.Minute)
	idleFor("devserver", time.Minute)
	s.bg["devserver"] = "npm"
	idleFor("front", time.Minute)
	idleFor("late", time.Minute)
	s.add(t, "busy", agents.AgentClaude)
	s.event(t, "busy", event.KindToolPre, 29*time.Minute)
	s.add(t, "asking", agents.AgentClaude)
	set(s.f.fakeSessions, s.f.prompt, "asking", true)
	s.event(t, "asking", event.KindPermissionPrompt, time.Minute)
	idleFor("fresh", 29*time.Minute+30*time.Second)
	idleFor("worker", time.Minute)
	s.e.worker = func(id string) bool { return id == "worker" }
	// Started in another terminal: a row in the database, nothing in the manager.
	if err := store.UpsertSession(ctx, s.d.store.DB(), "theirs", store.SessionPatch{Cwd: t.TempDir(), Agent: agents.AgentClaude}); err != nil {
		t.Fatal(err)
	}
	s.event(t, "theirs", event.KindAgentStop, time.Minute)
	s.now = s.t0.Add(30 * time.Minute)

	for id, want := range map[string]struct {
		owned   bool
		state   string
		endable bool
		whyNot  string
	}{
		"idle":      {true, agentIdle, true, ""},
		"mcponly":   {true, agentIdle, true, ""},
		"late":      {true, agentIdle, true, ""},
		"recent":    {true, agentIdle, false, whyNotRecent},
		"devserver": {true, agentIdle, false, whyNotBackground + "npm"},
		"front":     {true, agentIdle, false, whyNotFront},
		"busy":      {true, agentWorking, false, agentWorking},
		"asking":    {true, agentWaiting, false, agentWaiting},
		"fresh":     {true, agentWorking, false, agentWorking},
		"worker":    {true, agentIdle, false, whyNotWorker},
		"theirs":    {false, agentIdle, false, ""},
	} {
		st := s.e.memState(ctx, id, s.now, "front", nil)
		if st.owned != want.owned || st.state != want.state || st.endable != want.endable || st.whyNot != want.whyNot {
			t.Errorf("%s: owned %v state %s endable %v why_not %q, want %+v", id, st.owned, st.state, st.endable, st.whyNot, want)
		}
	}
	if st := s.e.memState(ctx, "idle", s.now, "", nil); st.since.UnixMilli() != s.t0.Add(time.Minute).UnixMilli() {
		t.Errorf("idle since %v, want its Stop", st.since)
	}
	// Without a tab in front, that one is offered like any other.
	if st := s.e.memState(ctx, "front", s.now, "", nil); !st.endable {
		t.Errorf("front with no front tab named: %+v", st)
	}

	// Between the list and the click, "late" started a dev server.
	s.f.mu.Lock()
	s.bg["late"] = "node server.js"
	s.f.mu.Unlock()
	res := s.e.endIdleNow(ctx, []string{"idle", "mcponly", "late", "recent", "devserver", "front", "busy", "asking", "fresh", "worker", "theirs", "idle", "nobody"}, "front")
	if !slices.Equal(res.Ended, []string{"idle", "mcponly"}) {
		t.Fatalf("ended %v, want [idle mcponly]", res.Ended)
	}
	s.wantEnded(t, "idle", "mcponly")
	why := map[string]string{}
	for _, k := range res.Skipped {
		why[k.SessionID] = k.Why
	}
	for id, want := range map[string]string{
		"theirs":    "not started by Caprock",
		"nobody":    "not started by Caprock",
		"busy":      agentWorking,
		"asking":    agentWaiting,
		"recent":    "idle under 15 min",
		"devserver": "running in the background: npm",
		"late":      "running in the background: node server.js",
		"front":     "the tab in front",
		"worker":    "the orchestrator or one of its workers",
	} {
		if why[id] != want {
			t.Errorf("%s skipped with %q, want %q", id, why[id], want)
		}
	}
	// Asked again before it is gone: not a second End.
	if res := s.e.endIdleNow(ctx, []string{"idle"}, ""); len(res.Ended) != 0 {
		t.Fatalf("ended twice: %+v", res)
	}
	s.wantEnded(t, "idle", "mcponly")
}

// A shell is never an agent the button ends.
func TestEndIdleNowNeverEndsAShell(t *testing.T) {
	s := newIdleStand(t)
	s.add(t, "sh", agents.KindShell)
	s.now = s.t0.Add(time.Hour)
	if res := s.e.endIdleNow(context.Background(), []string{"sh"}, ""); len(res.Ended) != 0 {
		t.Fatalf("ended a shell: %+v", res)
	}
	s.wantEnded(t)
}

// What GET /v1/system/memory adds over the sample: the other apps, every
// process of this user read once.
func BenchmarkOtherApps(b *testing.B) {
	d := &Daemon{res: newResourceMeter()}
	r := &ResourceReport{}
	ctx := context.Background()
	for b.Loop() {
		_, _ = d.otherApps(ctx, r)
	}
}

// The owner's popover, 2026-10-22: colima's virtual machine listed at
// 8.2 GB under "Other apps and the system" at 7.6 GB. used counts RAM, the
// VM's footprint its whole guest, most of it in swap; the group now takes
// what its members hold when that is more, and the VM is marked as one.
func TestOtherIsNeverSmallerThanItsApps(t *testing.T) {
	const gb = 1 << 30
	gib := func(f float64) uint64 { return uint64(f * gb) }
	mm := MachineMemory{Total: 16 * gb, Used: gib(14.0), Agents: gib(5.9), Caprock: gib(0.5)}
	mm.Other = mm.Used - mm.Agents - mm.Caprock
	if mm.Other != gib(14.0)-gib(5.9)-gib(0.5) || mm.Other > gib(7.61) || mm.Other < gib(7.59) {
		t.Fatalf("fixture: other %d", mm.Other)
	}
	groups := map[string]*MemoryApp{
		"colima":        {Name: "colima", MemBytes: gib(8.2), Procs: 4, VM: isVMHost("com.apple.Virtua")},
		"Google Chrome": {Name: "Google Chrome", MemBytes: gib(1.1), Procs: 30},
		"Slack":         {Name: "Slack", MemBytes: gib(0.4), Procs: 5},
		"Finder":        {Name: "Finder", MemBytes: gib(0.1), Procs: 1},
	}
	top, sum := rankApps(groups)
	if len(top) != memTopApps || top[0].Name != "colima" || !top[0].VM || top[1].VM {
		t.Fatalf("top: %+v", top)
	}
	if want := gib(8.2) + gib(1.1) + gib(0.4) + gib(0.1); sum != want {
		t.Fatalf("sum %d, want %d: every app read, not only the listed ones", sum, want)
	}
	mm.Other = settleOther(mm.Other, sum)
	for _, a := range top {
		if a.MemBytes > mm.Other {
			t.Fatalf("%s at %d is bigger than its group at %d", a.Name, a.MemBytes, mm.Other)
		}
	}
	if mm.Other != sum {
		t.Fatalf("other %d, want the apps' %d", mm.Other, sum)
	}
	// Where the apps hold less than the rest of used — the system's own
	// memory, other users' processes — the rest stands.
	if got := settleOther(gib(7.6), gib(2)); got != gib(7.6) {
		t.Fatalf("a smaller app sum replaced the remainder: %d", got)
	}
}

func TestIsVMHost(t *testing.T) {
	for name, want := range map[string]bool{
		"com.apple.Virtua":                        true, // com.apple.Virtualization.VirtualMachine, cut to 16 bytes
		"com.apple.Virtualization.VirtualMachine": true,
		"qemu-system-aarc":                        true,
		"qemu-system-x86":                         true,
		"vfkit":                                   true,
		"krunkit":                                 true,
		"limactl":                                 false,
		"colima":                                  false,
		"Google Chrome He":                        false,
		"com.apple.WebKit":                        false,
		"":                                        false,
	} {
		if got := isVMHost(name); got != want {
			t.Errorf("isVMHost(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestHeavyLimit(t *testing.T) {
	const gib = 1 << 30
	if got := heavyLimit(8 * gib); got != 3*gib {
		t.Errorf("8 GB machine: %d, want 3 GiB", got)
	}
	if got := heavyLimit(64 * gib); got != 64*gib/5 {
		t.Errorf("64 GB machine: %d, want a fifth", got)
	}
}

func TestHeavyOf(t *testing.T) {
	const gib = 1 << 30
	m := newResourceMeter()
	t0 := time.Unix(1_800_000_000, 0)
	if got := m.heavyOf("s", 3*gib, 8*gib, t0); got != HeavyBig {
		t.Fatalf("a 3 GiB process on 8 GB: %q, want big", got)
	}
	if got := m.heavyOf("small", gib, 16*gib, t0); got != "" {
		t.Fatalf("a 1 GiB process: %q", got)
	}
	// Growing a little every 10 minutes for 2 h 10 min, one small dip: growing.
	g := newResourceMeter()
	var got string
	for i := 0; i <= 13; i++ {
		b := uint64(800<<20) + uint64(i)*(100<<20)
		if i == 7 {
			b -= 20 << 20
		}
		// A sample between two readings is not written down.
		g.heavyOf("g", b, 16*gib, t0.Add(time.Duration(i)*growEvery-time.Minute))
		got = g.heavyOf("g", b, 16*gib, t0.Add(time.Duration(i)*growEvery))
	}
	if got != HeavyGrowing {
		t.Fatalf("steady growth: %q, want growing", got)
	}
	if n := len(g.growth["g"]); n > int(growKeep/growEvery)+1 {
		t.Fatalf("kept %d readings", n)
	}
}

func TestGrowingSteadily(t *testing.T) {
	const gib = 1 << 30
	t0 := time.Unix(1_800_000_000, 0)
	pts := func(step time.Duration, bytes ...uint64) []growPoint {
		out := make([]growPoint, len(bytes))
		for i, b := range bytes {
			out[i] = growPoint{at: t0.Add(time.Duration(i) * step), bytes: b}
		}
		return out
	}
	for _, tc := range []struct {
		name string
		pts  []growPoint
		want bool
	}{
		{"a gigabyte over two hours", pts(time.Hour, gib, gib+gib/2, 2*gib+1), true},
		{"too short", pts(30*time.Minute, gib, gib+gib/2, 2*gib+1), false},
		{"too little", pts(time.Hour, gib, gib+100<<20, gib+400<<20), false},
		{"fell back halfway", pts(time.Hour, gib, 2*gib, gib/2, 3*gib), false},
		{"two readings", pts(3*time.Hour, gib, 3*gib), false},
	} {
		if got := growingSteadily(tc.pts); got != tc.want {
			t.Errorf("%s: %v, want %v", tc.name, got, tc.want)
		}
	}
}

// Restart it fresh ends only an agent Caprock started that is not mid-turn,
// waits for it to exit, and says where to continue it.
func TestRestartEnd(t *testing.T) {
	s := newIdleStand(t)
	ctx := context.Background()
	s.f.exits = true
	old := restartWait
	restartWait = 500 * time.Millisecond
	t.Cleanup(func() { restartWait = old })
	s.add(t, "heavy", agents.AgentClaude)
	s.event(t, "heavy", event.KindAgentStop, time.Minute)
	s.add(t, "busy", agents.AgentClaude)
	s.event(t, "busy", event.KindToolPre, 9*time.Minute)
	if err := store.UpsertSession(ctx, s.d.store.DB(), "theirs", store.SessionPatch{Cwd: t.TempDir(), Agent: agents.AgentClaude}); err != nil {
		t.Fatal(err)
	}
	s.now = s.t0.Add(10 * time.Minute)
	if r := s.e.restartEnd(ctx, "theirs"); r.Ended || r.Why != "not started by Caprock" {
		t.Fatalf("theirs: %+v", r)
	}
	if r := s.e.restartEnd(ctx, "busy"); r.Ended || r.Why != agentWorking {
		t.Fatalf("busy: %+v", r)
	}
	r := s.e.restartEnd(ctx, "heavy")
	if !r.Ended || r.Cwd == "" || r.Agent != agents.AgentClaude {
		t.Fatalf("heavy: %+v", r)
	}
	s.wantEnded(t, "heavy")
}
