package daemon

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/procstat"
	"github.com/dspv/caprock/internal/ptyhost"
	"github.com/dspv/caprock/internal/store"
)

// orphanFixture is one process table with every case the classifier must
// tell apart, the meter's caches filled the way a scan would fill them.
type orphanFixture struct {
	m   *resourceMeter
	in  orphanInput
	now time.Time
}

func newOrphanFixture() orphanFixture {
	now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	ms := func(d time.Duration) int64 { return now.Add(-d).UnixMilli() }
	me := int64(os.Getuid())
	type row struct {
		pid, ppid int32
		name      string
		start     int64
		otherUser bool
		tty       bool
		argv      []string
		env       []string
		exe       string
	}
	old := ms(3 * time.Hour)
	rows := []row{
		{pid: 1, name: "launchd", start: ms(240 * time.Hour)},
		{pid: 100, ppid: 1, name: "caprock", start: old, argv: []string{"caprock", "up", "--foreground"}}, // this daemon
		{pid: 50, ppid: 1, name: "zsh", start: old, tty: true},                                            // a terminal the user is in
		// Caprock's own.
		{pid: 200, ppid: 1, name: "caprock", start: old},             // another daemon, data dir gone
		{pid: 210, ppid: 1, name: "caprock", start: old},             // `caprock up` left behind
		{pid: 211, ppid: 50, name: "caprock", start: old, tty: true}, // `caprock status` in the user's terminal
		{pid: 212, ppid: 1, name: "caprock", start: ms(time.Minute)}, // `caprock up` detaching right now
		{pid: 400, ppid: 1, name: "caprock-pty-host", start: old},    // a registered holder: a live session of ours
		{pid: 401, ppid: 400, name: "claude", start: old, tty: true}, // its claude
		{pid: 402, ppid: 1, name: "caprock-pty-host", start: old},    // unreachable, claude still runs in it
		{pid: 403, ppid: 402, name: "claude", start: old, tty: true}, // that claude: the holder is listed, not it
		{pid: 404, ppid: 1, name: "caprock-pty-host", start: old},    // dead: nothing runs in it
		// claude.
		{pid: 500, ppid: 1, name: "claude", start: old},                                                        // parent gone, no terminal
		{pid: 501, ppid: 1, name: "claude", start: old, tty: true},                                             // parent gone, but a terminal
		{pid: 502, ppid: 1, name: "claude", start: old},                                                        // a live session of ours (claude -p, nohup)
		{pid: 503, ppid: 600, name: "claude", start: old},                                                      // parent alive, its session ended
		{pid: 504, ppid: 600, name: "claude", start: ms(10 * time.Minute)},                                     // pid reused: started after the ended session
		{pid: 505, ppid: 1, name: "Claude", start: old, exe: "/Applications/Claude.app/Contents/MacOS/Claude"}, // the desktop app
		{pid: 506, ppid: 1, name: "claude", start: ms(30 * time.Second)},                                       // too young to judge
		{pid: 507, ppid: 1, name: "claude", start: old, otherUser: true},                                       // another user's
		{pid: 508, ppid: 1, name: "2.1.296", start: old, argv: []string{"/Users/u/.local/bin/claude", "-p"}},   // the native binary by version
		{pid: 509, ppid: 1, name: "node", start: old, argv: []string{"node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"}},
		// codex.
		{pid: 510, ppid: 1, name: "codex", start: old, argv: []string{"/Users/u/.local/bin/codex", "--no-daemon"}}, // parent gone
		{pid: 511, ppid: 1, name: "codex", start: old, argv: []string{"codex", "app-server", "daemon", "pid-update-loop"},
			exe: "/Users/u/.codex/packages/app-server-daemon/releases/0.163.0/bin/codex"}, // the Codex app's managed daemon
		{pid: 512, ppid: 1, name: "node", start: old, argv: []string{"node", "/usr/lib/node_modules/@openai/codex/bin/codex.js"}},
		{pid: 513, ppid: 600, name: "codex.exe", start: old},           // parent alive, its session ended (Windows spelling)
		{pid: 600, ppid: 1, name: "Hermes", start: ms(48 * time.Hour)}, // whatever started 503, still running
		// A holder of an old Homebrew install this Caprock still lists, and
		// the live session in it.
		{pid: 405, ppid: 1, name: "caprock", start: ms(12 * 24 * time.Hour), argv: []string{"/opt/homebrew/bin/caprock", "pty-host"}},
		{pid: 406, ppid: 405, name: "claude", start: ms(12 * 24 * time.Hour), tty: true, argv: []string{"claude", "--api-key", "sk-ant-secret", "--session-id", "af28"}},
		// MCP servers and what Claude Code started.
		{pid: 700, ppid: 1, name: "node", start: old, argv: []string{"node", "/x/@modelcontextprotocol/server-github/dist/index.js"}},
		{pid: 701, ppid: 1, name: "node", start: old, argv: []string{"node", "vite"}, env: []string{"CLAUDECODE=1"}},
		{pid: 702, ppid: 1, name: "node", start: old, argv: []string{"node", "vite"}},                           // nothing says Claude
		{pid: 703, ppid: 500, name: "node", start: old, argv: []string{"npx", "mcp-server-fetch"}},              // parent (the orphan claude) alive
		{pid: 704, ppid: 9999, name: "python3", start: old, argv: []string{"python3", "-m", "mcp_server_time"}}, // parent pid not running (Windows)
		{pid: 705, ppid: 800, name: "uvx", start: ms(4 * time.Hour), argv: []string{"uvx", "fastmcp", "run"}},   // parent pid reused by a younger process
		{pid: 706, ppid: 1, name: "node", start: old, tty: true, argv: []string{"node", "mcp-server"}},          // a terminal
		{pid: 707, ppid: 502, name: "node", start: old, argv: []string{"node", "mcp-server"}},                   // the live session's MCP server
		{pid: 708, ppid: 1, name: "github-mcp-server", start: old, argv: []string{"/opt/bin/github-mcp-server", "stdio"}},
		{pid: 709, ppid: 1, name: "node", start: old, argv: []string{"node", "xmcpy.js"}, env: []string{"CLAUDECODE=0"}}, // "mcp" inside a word; CLAUDECODE off
		{pid: 800, ppid: 1, name: "bash", start: ms(time.Hour)},
		{pid: 900, ppid: 1, name: "Python", start: old, argv: []string{"/opt/homebrew/bin/python3", "server.py"}}, // a user's own server
		// A framework Python (its executable is inside Python.app) running an MCP server: not an app.
		{pid: 901, ppid: 1, name: "Python", start: old, exe: "/opt/homebrew/Cellar/python@3.14/3.14.6/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python",
			argv: []string{"/opt/homebrew/Cellar/python@3.14/3.14.6/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python", "-m", "mcp_server_git"}},
	}
	procs := map[int32]procstat.Proc{}
	children := map[int32][]int32{}
	m := newResourceMeter()
	for _, r := range rows {
		uid := me
		if r.otherUser {
			uid = me + 1
		}
		p := procstat.Proc{PID: r.pid, PPID: r.ppid, Name: r.name, UID: uid, StartMs: r.start}
		procs[r.pid] = p
		children[r.ppid] = append(children[r.ppid], r.pid)
		k := pidKey{r.pid, r.start}
		m.tty[k] = r.tty
		argv := r.argv
		if argv == nil {
			argv = []string{r.name}
		}
		m.argv[k] = argv
		m.env[k] = r.env
		exe := r.exe
		if exe == "" {
			exe = "/bin/" + r.name
		}
		m.exe[k] = exe
	}
	tab := &procstat.Table{Procs: procs, Children: children}
	scan := caprockScan{
		daemons: []CaprockProc{{PID: 200, Exe: "/Users/u/.claude/jobs/j/tmp/caprock", DataDir: "/gone/caprock", StartedAt: old}},
		hosts: []ptyhost.HostProc{
			{PID: 400, StartMs: old, Children: []ptyhost.ChildProc{{PID: 401, Name: "claude"}}},
			{PID: 402, StartMs: old, Env: []string{ptyhost.RegistryEnv + "=/gone/stand/ptyhost"}, Children: []ptyhost.ChildProc{{PID: 403, Name: "claude"}}},
			{PID: 404, StartMs: old},
			{PID: 405, StartMs: ms(12 * 24 * time.Hour), Children: []ptyhost.ChildProc{{PID: 406, Name: "claude"}}},
		},
		hostExe: map[int32]string{400: "/app/caprock-pty-host", 402: "/opt/homebrew/bin/caprock", 404: "/app/caprock-pty-host", 405: "/gone/homebrew/bin/caprock"},
		other: []otherCaprock{
			{pid: 210, start: old, exe: "/x/caprock", sub: "up"},
			{pid: 211, start: old, exe: "/x/caprock", sub: "status"},
			{pid: 212, start: ms(time.Minute), exe: "/x/caprock", sub: "up"},
		},
	}
	in := orphanInput{
		tab: tab, scan: scan, now: now,
		holders: []ptyhost.Verdict{
			{PID: 400, State: "registered", Ours: true},
			{PID: 402, State: "unreachable-busy", Abandoned: true, Child: "claude"},
			{PID: 404, State: "dead", Reap: true},
			{PID: 405, State: "registered", Ours: true, Child: "claude"},
		},
		skip:        map[int32]bool{100: true},
		live:        liveTrees(tab, map[string]int32{"s-live": 502, "s-homebrew": 406}),
		installDirs: []string{"/app"},
		ended: map[int32]store.EndedPID{
			503: {SessionID: "s-ended", PID: 503, StartedAt: ms(2*time.Hour + 50*time.Minute), LastEventAt: ms(2 * time.Hour)},
			513: {SessionID: "s-codex", PID: 513, StartedAt: ms(2*time.Hour + 50*time.Minute), LastEventAt: ms(90 * time.Minute)},
			504: {SessionID: "s-old", PID: 504, StartedAt: ms(5 * time.Hour), LastEventAt: ms(4 * time.Hour)},
		},
		exists: func(dir string) bool { return !strings.HasPrefix(dir, "/gone") },
	}
	return orphanFixture{m: m, in: in, now: now}
}

func TestOrphansAreListedConservatively(t *testing.T) {
	f := newOrphanFixture()
	list := f.m.orphans(context.Background(), f.in)
	got := map[int32]Orphan{}
	for _, o := range list {
		got[o.PID] = o
	}
	want := map[int32]string{
		200: OrphanDaemon, 402: OrphanHolder, 404: OrphanHolder, 210: OrphanCaprockOther,
		405: OrphanOldHolder,
		500: OrphanClaude, 503: OrphanClaude, 508: OrphanClaude, 509: OrphanClaude,
		510: OrphanCodex, 512: OrphanCodex, 513: OrphanCodex,
		700: OrphanMCP, 704: OrphanMCP, 705: OrphanMCP, 708: OrphanMCP, 901: OrphanMCP,
		701: OrphanClaudeChild,
	}
	for pid, kind := range want {
		o, ok := got[pid]
		if !ok {
			t.Errorf("pid %d (%s) is not listed", pid, kind)
			continue
		}
		if o.Kind != kind {
			t.Errorf("pid %d: kind %s, want %s", pid, o.Kind, kind)
		}
		if o.Why == "" || o.StartedAt == 0 || o.Label == "" {
			t.Errorf("pid %d: listed without a reason, a start or a label: %+v", pid, o)
		}
	}
	for pid := range got {
		if _, ok := want[pid]; !ok {
			t.Errorf("pid %d is listed and must not be: %+v", pid, got[pid])
		}
	}
	// The live session's claude and its MCP server, the registered holder
	// and its claude: never.
	for _, pid := range []int32{502, 707, 400, 401} {
		if _, ok := got[pid]; ok {
			t.Errorf("pid %d belongs to a live session and is listed", pid)
		}
	}

	if o := got[200]; !o.DataDirGone || o.DataDir != "/gone/caprock" || !strings.Contains(o.Why, "gone") {
		t.Errorf("the other daemon: %+v", o)
	}
	if o := got[402]; o.Auto || !o.DataDirGone || !strings.Contains(o.Why, "claude still runs") {
		t.Errorf("the busy holder is never stopped on its own and says why: %+v", o)
	}
	if o := got[404]; !o.Auto {
		t.Errorf("the dead holder is the sweep's: %+v", o)
	}
	if o := got[503]; !strings.Contains(o.Why, "session ended") || !strings.Contains(o.Why, "2h ago") {
		t.Errorf("the ended session's claude says when it was last heard from: %q", o.Why)
	}
	if o := got[210]; o.Label != "caprock up" {
		t.Errorf("label: %q, want the binary and its subcommand only", o.Label)
	}
	if o := got[700]; o.Label != "node index.js" || o.Cmd != "node /x/@modelcontextprotocol/server-github/dist/index.js" {
		t.Errorf("label %q, cmd %q", o.Label, o.Cmd)
	}
	// The Codex app's own daemon is a service, not a leftover.
	if _, ok := got[511]; ok {
		t.Errorf("codex app-server is listed: %+v", got[511])
	}
	if o := got[513]; !strings.Contains(o.Why, "A codex whose session ended") || !strings.Contains(o.Why, "1h ago") {
		t.Errorf("the ended codex: %q", o.Why)
	}
	// The old install's holder: said with where it runs from and that a
	// live session is in it; never the sweep's.
	if o := got[405]; o.Auto || !strings.Contains(o.Why, "another Caprock install (/gone/homebrew/bin/caprock)") ||
		!strings.Contains(o.Why, "12d ago") || !strings.Contains(o.Why, "program file is gone") || !strings.Contains(o.Why, "as a live session") ||
		o.Cmd != "caprock pty-host" {
		t.Errorf("the old install's holder: %+v", o)
	}
	// Its live session's claude is never listed itself.
	if _, ok := got[406]; ok {
		t.Errorf("the live claude in the old holder is listed")
	}
	// Caprock's first, then by kind and pid.
	if list[0].Kind != OrphanDaemon || list[len(list)-1].Kind != OrphanClaudeChild {
		t.Errorf("order: first %s, last %s", list[0].Kind, list[len(list)-1].Kind)
	}

	r := newOrphanReport(list, f.now)
	if r.Count != len(want) || r.ByKind[OrphanClaude] != 4 || r.ByKind[OrphanCodex] != 3 || r.ByKind[OrphanMCP] != 5 || !r.Scanned {
		t.Errorf("report: %+v", r)
	}

	// With no daemon to compare installs with, no holder is judged by its
	// executable.
	f.in.installDirs = nil
	for _, o := range f.m.orphans(context.Background(), f.in) {
		if o.Kind == OrphanOldHolder {
			t.Errorf("an old install's holder listed with nothing to compare with: %+v", o)
		}
	}
}

func TestOrphanReportSumsMemory(t *testing.T) {
	r := newOrphanReport([]Orphan{{PID: 2, Kind: OrphanClaude, MemBytes: 300 << 20}, {PID: 3, Kind: OrphanMCP, MemBytes: 110 << 20}}, time.Now())
	if r.MemBytes != 410<<20 || r.Count != 2 {
		t.Errorf("report: %+v", r)
	}
}

func TestCmdLineHidesSecretsAndCuts(t *testing.T) {
	for _, c := range []struct {
		argv []string
		want string
	}{
		{[]string{"/Users/u/.local/bin/claude", "--api-key", "sk-ant-1", "--session-id", "af28"}, "claude --api-key [hidden] --session-id af28"},
		{[]string{"node", "server.js", "--token=abc", "GITHUB_TOKEN=ghp_x", "--port", "8080"}, "node server.js --token=[hidden] GITHUB_TOKEN=[hidden] --port 8080"},
		{[]string{"uvx", "mcp-proxy", "https://user:pa55@example.com/sse"}, "uvx mcp-proxy https://[hidden]@example.com/sse"},
		{[]string{"claude", "-p", "fix the\nbug now"}, `claude -p "fix the bug now"`},
		{[]string{`C:\Users\u\AppData\Roaming\npm\codex.exe`, "exec"}, "codex.exe exec"},
		{nil, ""},
	} {
		if got := cmdLine(c.argv); got != c.want {
			t.Errorf("cmdLine(%q) = %q, want %q", c.argv, got, c.want)
		}
	}
	long := cmdLine([]string{"node", strings.Repeat("ア", 300)})
	if n := len([]rune(long)); n != cmdMax || !strings.HasSuffix(long, "…") {
		t.Errorf("a long line: %d runes, %q", n, long[len(long)-10:])
	}
}

func TestClaudeCandidatesSkipTerminalsAndApps(t *testing.T) {
	f := newOrphanFixture()
	got := f.m.agentCandidates(context.Background(), f.in.tab, f.in.skip)
	want := []int32{500, 502, 503, 504, 506, 508, 509, 510, 512, 513}
	if len(got) != len(want) {
		t.Fatalf("candidates %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("candidates %v, want %v", got, want)
		}
	}
}

func TestStrayVerdict(t *testing.T) {
	f := cleanFootprint()
	f.Orphans = &OrphanReport{Count: 3, ByKind: map[string]int{OrphanClaude: 1, OrphanMCP: 2}}
	f.finish()
	var v FootprintVerdict
	for _, x := range f.Verdicts {
		if x.Code == "stray_processes" {
			v = x
		}
	}
	if v.Level != "warn" || !strings.Contains(v.Text, "3 processes look abandoned: 1 claude, 2 MCP servers") || !strings.Contains(v.Text, "never stops them on its own") {
		t.Errorf("verdict: %+v", v)
	}

	// Caprock's own orphans have their own warnings; a server Claude left is
	// said, not warned.
	f = cleanFootprint()
	f.Orphans = &OrphanReport{Count: 2, ByKind: map[string]int{OrphanHolder: 1, OrphanClaudeChild: 1}}
	f.finish()
	if f.Warns() {
		t.Errorf("warned: %+v", f.Verdicts)
	}
	if c := codes(f.Verdicts); c["stray_processes"] != "ok" {
		t.Errorf("codes: %v", c)
	}
}

func TestReapedParents(t *testing.T) {
	tab := &procstat.Table{Procs: map[int32]procstat.Proc{
		1:  {PID: 1, Name: "init", StartMs: 1},
		10: {PID: 10, PPID: 1, Name: "systemd", StartMs: 5},
		11: {PID: 11, PPID: 10, Name: "node", StartMs: 9},     // under systemd --user: a subreaper
		12: {PID: 12, PPID: 20, Name: "node", StartMs: 9},     // parent is a younger process: the pid was reused
		13: {PID: 13, PPID: 21, Name: "node", StartMs: 9},     // parent alive and older
		14: {PID: 14, PPID: 404, Name: "node", StartMs: 9},    // parent not running
		20: {PID: 20, PPID: 1, Name: "explorer", StartMs: 50}, // younger
		21: {PID: 21, PPID: 1, Name: "zsh", StartMs: 2},
	}}
	for pid, want := range map[int32]bool{11: true, 12: true, 13: false, 14: true, 21: true} {
		if got := reaped(tab, tab.Procs[pid]); got != want {
			t.Errorf("pid %d: reaped %v, want %v", pid, got, want)
		}
	}
}

// fakeProcs is a signaller over pretend processes: nothing real is ever
// signalled.
type fakeProcs struct {
	mu       sync.Mutex
	start    map[int32]int64
	stubborn map[int32]bool // ignores SIGTERM
	sent     []string
}

func (f *fakeProcs) terminate(pid int32) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, "TERM "+strconv.Itoa(int(pid)))
	if !f.stubborn[pid] {
		delete(f.start, pid)
	}
	return nil
}

func (f *fakeProcs) kill(pid int32) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, "KILL "+strconv.Itoa(int(pid)))
	delete(f.start, pid)
	return nil
}

func (f *fakeProcs) startOf(_ context.Context, pid int32) (int64, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.start[pid]
	return s, ok
}

func TestStopOnlyWhatIsListedWithItsStart(t *testing.T) {
	list := []Orphan{
		{PID: 500, StartedAt: 1000, Kind: OrphanClaude, Label: "claude"},
		{PID: 501, StartedAt: 1001, Kind: OrphanMCP, Label: "node x"},
		{PID: 502, StartedAt: 1002, Kind: OrphanMCP, Label: "node y"},
	}
	f := &fakeProcs{
		start:    map[int32]int64{500: 1000, 501: 1001, 502: 9999, 600: 1},
		stubborn: map[int32]bool{501: true},
	}
	res := stopListed(context.Background(), f, list, []OrphanTarget{
		{PID: 500, StartedAt: 1000}, // stops on SIGTERM
		{PID: 501, StartedAt: 1001}, // ignores it: reported running, nothing more sent
		{PID: 502, StartedAt: 1002}, // the pid now names another process
		{PID: 600, StartedAt: 1},    // never listed
		{PID: 500, StartedAt: 1000}, // named twice
		{PID: 501, StartedAt: 7},    // listed, but not with this start
	}, 300*time.Millisecond, false)

	if len(res.Stopped) != 1 || res.Stopped[0].PID != 500 {
		t.Errorf("stopped: %+v", res.Stopped)
	}
	if len(res.Running) != 1 || res.Running[0].PID != 501 {
		t.Errorf("running: %+v, want 501, which ignored SIGTERM", res.Running)
	}
	failed := map[int32]string{}
	for _, x := range res.Failed {
		failed[x.PID] = x.Error
	}
	if failed[502] != errChanged.Error() || failed[600] != errNotListed.Error() {
		t.Errorf("failed: %+v", res.Failed)
	}
	sent := strings.Join(f.sent, ",")
	for _, never := range []string{"502", "600"} {
		if strings.Contains(sent, never) {
			t.Errorf("signalled pid %s: %s", never, sent)
		}
	}
	if !strings.Contains(sent, "TERM 500") || strings.Contains(sent, "KILL 500") {
		t.Errorf("500 should stop on SIGTERM alone: %s", sent)
	}
	if !strings.Contains(sent, "TERM 501") || strings.Contains(sent, "KILL") {
		t.Errorf("no SIGKILL without the second click: %s", sent)
	}
	if strings.Count(sent, "TERM 500") != 1 {
		t.Errorf("500 signalled twice: %s", sent)
	}

	// The second click: force, for 501 alone.
	f.sent = nil
	res = stopListed(context.Background(), f, list, []OrphanTarget{{PID: 501, StartedAt: 1001}}, 300*time.Millisecond, true)
	if len(res.Stopped) != 1 || res.Stopped[0].PID != 501 || len(res.Running) != 0 || len(res.Failed) != 0 {
		t.Errorf("force: %+v", res)
	}
	if got := strings.Join(f.sent, ","); got != "KILL 501" {
		t.Errorf("force sent %q, want SIGKILL to 501 alone", got)
	}
}

func TestStopProcRefusesAReusedPid(t *testing.T) {
	f := &fakeProcs{start: map[int32]int64{700: 2}}
	if _, err := stopProc(context.Background(), f, 700, 1, time.Second, false); !errors.Is(err, errChanged) {
		t.Errorf("err %v, want errChanged", err)
	}
	if _, err := stopProc(context.Background(), f, 1, 2, time.Second, true); !errors.Is(err, errChanged) {
		t.Errorf("pid 1: err %v, want errChanged", err)
	}
	if len(f.sent) != 0 {
		t.Errorf("signals sent: %v", f.sent)
	}
}

// A real stop, of a process this test started itself (a copy of the test
// binary that sleeps), so the OS signalling path is exercised on every OS
// without touching anything else on the machine.
func TestStopProcStopsOwnChild(t *testing.T) {
	if os.Getenv("CAPROCK_ORPHAN_SLEEPER") == "1" {
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestStopProcStopsOwnChild$")
	cmd.Env = append(os.Environ(), "CAPROCK_ORPHAN_SLEEPER=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	defer func() { _ = cmd.Process.Kill() }()
	pid := int32(cmd.Process.Pid)
	var start int64
	for i := 0; i < 50; i++ {
		if s, ok := procstat.StartMs(context.Background(), pid); ok {
			start = s
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if start == 0 {
		t.Fatal("the child's start time cannot be read")
	}
	// The wrong start first: nothing is sent.
	if _, err := stopProc(context.Background(), osSignaller{}, pid, start+1, time.Second, false); !errors.Is(err, errChanged) {
		t.Fatalf("a wrong start: %v", err)
	}
	select {
	case <-done:
		t.Fatal("the child exited after a refused stop")
	case <-time.After(100 * time.Millisecond):
	}
	// Reaped by cmd.Wait as it exits, so its start stops matching.
	if running, err := stopProc(context.Background(), osSignaller{}, pid, start, 5*time.Second, false); err != nil || running {
		t.Fatalf("stop: %v", err)
	}
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the child still runs")
	}
}
