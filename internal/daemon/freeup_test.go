package daemon

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/procstat"
)

// procRow is one process of a hand-built table: what the meter's caches
// would hold for it after a scan.
type procRow struct {
	pid, ppid int32
	name      string
	start     int64
	argv      []string
	env       []string
}

func tableOf(m *resourceMeter, rows []procRow) *procstat.Table {
	me := int64(os.Getuid())
	t := &procstat.Table{Procs: map[int32]procstat.Proc{}, Children: map[int32][]int32{}}
	for _, r := range rows {
		t.Procs[r.pid] = procstat.Proc{PID: r.pid, PPID: r.ppid, Name: r.name, UID: me, StartMs: r.start}
		t.Children[r.ppid] = append(t.Children[r.ppid], r.pid)
		if m != nil {
			k := pidKey{r.pid, r.start}
			argv := r.argv
			if argv == nil {
				argv = []string{r.name}
			}
			m.argv[k] = argv
			m.env[k] = r.env
		}
	}
	return t
}

// A test copy of Caprock is held — not offered by Free up memory — while
// the agent that started it runs, and offered once it is gone (2026-10-25:
// Clean up offered two preview daemons of agents still using them).
func TestDaemonHoldFollowsTheAgentThatStartedIt(t *testing.T) {
	now := time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	old := now.Add(-time.Hour).UnixMilli()
	const live, ended = "e49da112-4f2d-4f3a-914a-bc601bc57640", "0f3a9c1e-1111-4222-8333-944455556666"
	scratch := func(id string) string {
		return "/private/tmp/claude-501/-Users-u-dev-caprock/" + id + "/scratchpad/prev/data"
	}
	rows := []procRow{
		{pid: 1, name: "launchd", start: old - 1e7},
		{pid: 10, ppid: 1, name: "claude", start: old - 1e6, argv: []string{"/Users/u/.local/bin/claude", "--session-id", live}},
		{pid: 11, ppid: 10, name: "zsh", start: old},
		// Started from the agent's Bash tool and still its child.
		{pid: 20, ppid: 11, name: "caprock", start: old},
		// Started in a terminal the user still has open.
		{pid: 30, ppid: 1, name: "zsh", start: old - 1e6},
		{pid: 21, ppid: 30, name: "caprock", start: old},
		// Detached (parent reaped), its environment naming a running claude.
		{pid: 22, ppid: 1, name: "caprock", start: old, env: []string{"CLAUDE_PID=10"}},
		// Detached, env -i: only its data folder says whose it is.
		{pid: 23, ppid: 1, name: "caprock", start: old},
		{pid: 24, ppid: 1, name: "caprock", start: old},
		// Detached, its claude gone: CLAUDE_PID names nothing now.
		{pid: 25, ppid: 1, name: "caprock", start: old, env: []string{"CLAUDE_PID=4444", "CLAUDE_CODE_SESSION_ID=" + ended}},
		// In a worktree of a repository a live session works in.
		{pid: 26, ppid: 1, name: "caprock", start: old},
		// In a worktree already removed.
		{pid: 27, ppid: 1, name: "caprock", start: old},
	}
	m := newResourceMeter()
	tab := tableOf(m, rows)
	in := orphanInput{
		tab: tab, now: now,
		liveSessions: map[string]bool{},
		liveCwds:     []string{"/Users/u/dev/caprock"},
		exists:       func(dir string) bool { return !strings.Contains(dir, "gone-wt") },
	}
	ctx := context.Background()
	for _, tc := range []struct {
		pid   int32
		paths []string
		want  string
	}{
		{20, nil, holdAgentRunning},
		{21, nil, holdStarterRunning},
		{22, nil, holdAgentRunning},
		{23, []string{scratch(live), "/Users/u/dev/caprock/.claude/worktrees/agent-1/bin/caprock"}, holdAgentRunning}, // its claude's argv names the session
		{24, []string{scratch(ended), "/tmp/caprock"}, ""},
		{25, []string{"/tmp/prev"}, ""},
		{26, []string{"/var/folders/x/T/data", "/Users/u/dev/caprock/.claude/worktrees/agent-2/caprock"}, holdRepoAgent},
		{27, []string{"/Users/u/dev/caprock/.claude/worktrees/gone-wt/caprock"}, ""},
	} {
		if got := m.daemonHold(ctx, in, tab.Procs[tc.pid], tc.paths...); got != tc.want {
			t.Errorf("pid %d: hold %q, want %q", tc.pid, got, tc.want)
		}
	}
	// The session itself live, with no claude naming it: still held.
	in.liveSessions = map[string]bool{ended: true}
	if got := m.daemonHold(ctx, in, tab.Procs[24], scratch(ended)); got != holdAgentRunning {
		t.Errorf("a live scratchpad session: %q", got)
	}
	// No live session in the repository: a worktree copy is offered.
	in.liveCwds = []string{"/Users/u/dev/other"}
	if got := m.daemonHold(ctx, in, tab.Procs[26], "/Users/u/dev/caprock/.claude/worktrees/agent-2/caprock"); got != "" {
		t.Errorf("a worktree copy with no agent in its repository: %q", got)
	}
}

// The scan carries the hold on the daemon it lists.
func TestOrphanScanHoldsATestCopyWhoseAgentRuns(t *testing.T) {
	f := newOrphanFixture()
	f.in.scan.daemons = []CaprockProc{{PID: 200, Exe: "/Users/u/.claude/jobs/j/tmp/caprock", DataDir: "/gone/caprock"}}
	f.m.env[pidKey{200, f.in.tab.Procs[200].StartMs}] = []string{"CLAUDE_PID=600"}
	var got Orphan
	for _, o := range f.m.orphans(context.Background(), f.in) {
		if o.PID == 200 {
			got = o
		}
	}
	if got.Kind != OrphanDaemon || got.Hold != holdAgentRunning {
		t.Fatalf("daemon 200: %+v, want held", got)
	}
}

// What runs under an idle agent: its MCP servers (and what they start), the
// keep-awake caffeinate and the agent re-executed below its launcher are
// its own; a dev server, a watcher or a background shell is work.
func TestBackgroundWork(t *testing.T) {
	rows := []procRow{
		{pid: 10, ppid: 1, name: "claude"},
		{pid: 11, ppid: 10, name: "caprock", argv: []string{"/Applications/Caprock.app/caprock", "mcp"}},
		{pid: 12, ppid: 10, name: "node", argv: []string{"npx", "-y", "@modelcontextprotocol/server-github"}},
		{pid: 13, ppid: 12, name: "node", argv: []string{"node", "/x/server-github/dist/index.js"}},
		{pid: 14, ppid: 10, name: "caffeinate", argv: []string{"caffeinate", "-i", "-t", "300"}},

		// The npm Codex: node launches the native codex, which runs an MCP server.
		{pid: 20, ppid: 1, name: "node", argv: []string{"node", "/usr/lib/node_modules/@openai/codex/bin/codex.js"}},
		{pid: 21, ppid: 20, name: "codex", argv: []string{"/usr/lib/node_modules/@openai/codex/vendor/codex"}},
		{pid: 22, ppid: 21, name: "uvx", argv: []string{"uvx", "fastmcp", "run"}},

		// A dev server left by run_in_background.
		{pid: 30, ppid: 1, name: "claude"},
		{pid: 31, ppid: 30, name: "caprock", argv: []string{"caprock", "mcp"}},
		{pid: 32, ppid: 30, name: "zsh", argv: []string{"/bin/zsh", "-c", "npm run dev"}},
		{pid: 33, ppid: 32, name: "node", argv: []string{"node", "vite"}},

		// A dev server two levels under the re-executed agent.
		{pid: 40, ppid: 1, name: "node", argv: []string{"node", "/usr/lib/node_modules/@openai/codex/bin/codex.js"}},
		{pid: 41, ppid: 40, name: "codex"},
		{pid: 42, ppid: 41, name: "python3", argv: []string{"python3", "-m", "http.server"}},

		{pid: 50, ppid: 1, name: "claude"},
	}
	tab := tableOf(nil, rows)
	argv := map[int32][]string{}
	for _, r := range rows {
		argv[r.pid] = r.argv
	}
	read := func(pid int32) []string { return argv[pid] }
	for root, want := range map[int32]string{
		10: "",
		20: "",
		30: "zsh",
		40: "python3 http.server",
		50: "",
		99: "", // not running
	} {
		if got := backgroundWork(tab, root, read); got != want {
			t.Errorf("under %d: %q, want %q", root, got, want)
		}
	}
}
