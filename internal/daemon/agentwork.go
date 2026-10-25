package daemon

import (
	"context"
	"strings"

	"github.com/dspv/caprock/internal/procstat"
)

// Background work under an idle agent (03-contracts.md § System memory,
// `why_not`; owner, 2026-10-25: "I want it fully safe and to understand
// it"). Ending an agent ends its process tree: a dev server it started with
// run_in_background, a watcher, a build it left running would stop with it.
// So Free up memory offers an idle agent only while nothing runs under it
// but the agent's own helpers — its MCP servers, the keep-awake caffeinate
// Claude Code starts on macOS, the console host Windows gives a console
// program, the hook shim — and, for a CLI that re-executes itself (the npm
// Codex's node launcher runs the native codex), the agent's own process
// below its launcher. Anything else is background work and keeps it.
//
// Conservative on purpose: a helper this list does not know reads as work,
// and the agent is left running with the reason shown, never ended.

// agentHelper reports a process an agent runs for itself: its children say
// nothing about work the user would lose.
func agentHelper(name string, argv []string) bool {
	n := strings.TrimSuffix(strings.ToLower(name), ".exe")
	switch n {
	case "caffeinate", "conhost", "caprock-hook":
		return true
	}
	line := strings.ToLower(strings.Join(argv, " "))
	if line == "" {
		line = strings.ToLower(name)
	}
	return mcpWord.MatchString(line)
}

// backgroundWork is the first process under root that is neither the
// agent's own helper nor the agent itself re-executed, by its label ("npm",
// "node server.js"); "" when there is none. argv reads a process's command
// line.
func backgroundWork(tab *procstat.Table, root int32, argv func(pid int32) []string) string {
	if tab == nil || root <= 0 {
		return ""
	}
	if _, ok := tab.Procs[root]; !ok {
		return ""
	}
	queue := []int32{root}
	seen := map[int32]bool{root: true}
	for len(queue) > 0 {
		pid := queue[0]
		queue = queue[1:]
		for _, c := range tab.Children[pid] {
			if seen[c] {
				continue
			}
			seen[c] = true
			p := tab.Procs[c]
			args := argv(c)
			switch {
			case agentHelper(p.Name, args):
				// Its own subtree is the helper's: npx under an MCP server.
				continue
			case claudeLike(p.Name, args) || codexLike(p.Name, args, ""):
				// The agent itself below its launcher: look under it.
				queue = append(queue, c)
				continue
			}
			return procstat.Label(p.Name, args)
		}
	}
	return ""
}

// bgReader is backgroundWork over one process table, read on first use, so
// GET /v1/system/memory reads the table once for every agent it judges.
type bgReader struct {
	ctx context.Context
	tab *procstat.Table
	err error
	got bool
}

func newBGReader(ctx context.Context) *bgReader { return &bgReader{ctx: ctx} }

// of is what runs in the background under the agent process pid; "" for
// none. An unreadable table reads as work: never end what cannot be seen.
func (b *bgReader) of(pid int32) string {
	if pid <= 0 {
		return ""
	}
	if !b.got {
		b.got = true
		b.tab, b.err = procstat.Read(b.ctx)
	}
	if b.err != nil {
		return "its processes could not be read"
	}
	return backgroundWork(b.tab, pid, func(p int32) []string { return procstat.Cmdline(b.ctx, p) })
}
