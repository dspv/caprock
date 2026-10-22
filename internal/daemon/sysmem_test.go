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

// The button's selection: an idle agent Caprock started is offered and
// ended; one that works, one that waits on a prompt, a shell and a session
// another terminal started are never ended — the last even when named.
func TestEndIdleNowEndsOnlyIdleOwnedAgents(t *testing.T) {
	s := newIdleStand(t)
	ctx := context.Background()
	s.add(t, "idle", agents.AgentClaude)
	s.event(t, "idle", event.KindAgentStop, time.Minute)
	s.add(t, "busy", agents.AgentClaude)
	s.event(t, "busy", event.KindToolPre, 9*time.Minute)
	s.add(t, "asking", agents.AgentClaude)
	set(s.f.fakeSessions, s.f.prompt, "asking", true)
	s.event(t, "asking", event.KindPermissionPrompt, time.Minute)
	s.add(t, "fresh", agents.AgentClaude)
	s.event(t, "fresh", event.KindAgentStop, 9*time.Minute+30*time.Second)
	s.add(t, "worker", agents.AgentClaude)
	s.event(t, "worker", event.KindAgentStop, time.Minute)
	s.e.worker = func(id string) bool { return id == "worker" }
	// Started in another terminal: a row in the database, nothing in the manager.
	if err := store.UpsertSession(ctx, s.d.store.DB(), "theirs", store.SessionPatch{Cwd: t.TempDir(), Agent: agents.AgentClaude}); err != nil {
		t.Fatal(err)
	}
	s.event(t, "theirs", event.KindAgentStop, time.Minute)
	s.now = s.t0.Add(10 * time.Minute)

	for id, want := range map[string]struct {
		owned   bool
		state   string
		endable bool
	}{
		"idle":   {true, agentIdle, true},
		"busy":   {true, agentWorking, false},
		"asking": {true, agentWaiting, false},
		"fresh":  {true, agentWorking, false},
		"worker": {true, agentIdle, false},
		"theirs": {false, agentIdle, false},
	} {
		st := s.e.memState(ctx, id, s.now)
		if st.owned != want.owned || st.state != want.state || st.endable != want.endable {
			t.Errorf("%s: owned %v state %s endable %v, want %+v", id, st.owned, st.state, st.endable, want)
		}
	}
	if st := s.e.memState(ctx, "idle", s.now); st.since.UnixMilli() != s.t0.Add(time.Minute).UnixMilli() {
		t.Errorf("idle since %v, want its Stop", st.since)
	}

	res := s.e.endIdleNow(ctx, []string{"idle", "busy", "asking", "fresh", "worker", "theirs", "idle", "nobody"})
	if !slices.Equal(res.Ended, []string{"idle"}) {
		t.Fatalf("ended %v, want [idle]", res.Ended)
	}
	s.wantEnded(t, "idle")
	why := map[string]string{}
	for _, k := range res.Skipped {
		why[k.SessionID] = k.Why
	}
	if why["theirs"] != "not started by Caprock" || why["nobody"] != "not started by Caprock" {
		t.Errorf("skipped: %v", why)
	}
	if why["busy"] != agentWorking || why["asking"] != agentWaiting {
		t.Errorf("skipped: %v", why)
	}
	// Asked again before it is gone: not a second End.
	if res := s.e.endIdleNow(ctx, []string{"idle"}); len(res.Ended) != 0 {
		t.Fatalf("ended twice: %+v", res)
	}
	s.wantEnded(t, "idle")
}

// A shell is never an agent the button ends.
func TestEndIdleNowNeverEndsAShell(t *testing.T) {
	s := newIdleStand(t)
	s.add(t, "sh", agents.KindShell)
	s.now = s.t0.Add(time.Hour)
	if res := s.e.endIdleNow(context.Background(), []string{"sh"}); len(res.Ended) != 0 {
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
		_ = d.otherApps(ctx, r)
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
