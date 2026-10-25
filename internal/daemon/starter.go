package daemon

import (
	"context"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/dspv/caprock/internal/procstat"
	"github.com/dspv/caprock/internal/store"
)

// Whether what started another Caprock daemon still runs (03-contracts.md
// § Footprint, `hold`). On 2026-10-25 Clean up offered two "Test copies of
// Caprock" (626 MB) that were preview daemons of agents still running and
// using them. A test copy is offered by Free up memory only once the agent
// that started it is gone; until then it is held, with why, and Stop on its
// row stays the expert's way.
//
// What is looked at, in order — the first that says "still running" holds:
//
//   - The parent chain. A daemon whose parent still runs was started by it:
//     an agent's Bash tool (run_in_background) or a terminal.
//   - Its environment. Claude Code puts CLAUDE_PID and
//     CLAUDE_CODE_SESSION_ID in every command it runs; a daemon started
//     from one keeps them, unless the agent cleared its environment.
//   - Its paths. An agent's scratchpad is named after its session
//     (…/<session id>/scratchpad/…): that session live, or a claude whose
//     command line names it, holds. A daemon or data folder inside a
//     `.claude/worktrees/<name>` checkout that still exists is held while
//     any live session works in that repository: which agent made the
//     worktree is not written anywhere Caprock reads.
//
// Conservative on purpose: a daemon none of these can place is not held,
// and is offered only if the doctor would tick it anyway (a test copy).

const (
	holdAgentRunning   = "its agent is still running"
	holdStarterRunning = "what started it is still running"
	holdRepoAgent      = "an agent in its repository is still running"
)

var (
	// scratchSession is an agent scratchpad's session: the folder above it.
	scratchSession = regexp.MustCompile(`(?i)[/\\]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[/\\]scratchpad(?:[/\\]|$)`)
	// worktreeOf is a `.claude/worktrees/<name>` checkout: the repository
	// it belongs to, and the checkout.
	worktreeOf = regexp.MustCompile(`^(.*?)[/\\]\.claude[/\\]worktrees[/\\][^/\\]+`)
)

// daemonHold is why Free up memory leaves another Caprock daemon alone, ""
// when what started it is gone (or cannot be told). paths are its data
// directory and executable.
func (m *resourceMeter) daemonHold(ctx context.Context, in orphanInput, p procstat.Proc, paths ...string) string {
	if in.tab == nil {
		return ""
	}
	// The parent chain: still there, so its starter is.
	if !reaped(in.tab, p) {
		q := p
		for n := 0; n < 64 && !reaped(in.tab, q); n++ {
			par := in.tab.Procs[q.PPID]
			argv := m.argvOf(ctx, pidKey{par.PID, par.StartMs})
			if claudeLike(par.Name, argv) || codexLike(par.Name, argv, "") {
				return holdAgentRunning
			}
			q = par
		}
		return holdStarterRunning
	}
	// The environment an agent's command passed on.
	env := m.envOf(ctx, pidKey{p.PID, p.StartMs})
	if v := envValue(env, "CLAUDE_PID"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 1 {
			if c, ok := in.tab.Procs[int32(n)]; ok && (c.StartMs == 0 || p.StartMs == 0 || c.StartMs <= p.StartMs) {
				return holdAgentRunning
			}
		}
	}
	if id := envValue(env, "CLAUDE_CODE_SESSION_ID"); id != "" && m.sessionRuns(ctx, in, id) {
		return holdAgentRunning
	}
	// The paths: a scratchpad names its session; a worktree its repository.
	for _, path := range paths {
		if mm := scratchSession.FindStringSubmatch(path); mm != nil {
			if m.sessionRuns(ctx, in, mm[1]) {
				return holdAgentRunning
			}
			// That session has ended: this path says no more.
			continue
		}
		if mm := worktreeOf.FindStringSubmatch(path); mm != nil {
			if in.exists != nil && !in.exists(mm[0]) {
				continue
			}
			repo := filepath.ToSlash(mm[1])
			for _, cwd := range in.liveCwds {
				c := filepath.ToSlash(cwd)
				if c == repo || strings.HasPrefix(c, repo+"/") {
					return holdRepoAgent
				}
			}
		}
	}
	return ""
}

// sessionRuns reports a live session by id, or a running agent whose
// command line names it (a session /clear moved on from keeps its process).
func (m *resourceMeter) sessionRuns(ctx context.Context, in orphanInput, id string) bool {
	if in.liveSessions[id] {
		return true
	}
	for pid, p := range in.tab.Procs {
		if pid <= 1 || !sameUser(p) || !maybeAgent(p.Name) {
			continue
		}
		for _, a := range m.argvOf(ctx, pidKey{pid, p.StartMs}) {
			if strings.Contains(a, id) {
				return true
			}
		}
	}
	return false
}

// envValue is KEY's value in env, "" when unset.
func envValue(env []string, key string) string {
	for _, kv := range env {
		if v, ok := strings.CutPrefix(kv, key+"="); ok {
			return v
		}
	}
	return ""
}

// liveSessionsOf is the live sessions' ids and their folders.
func (d *Daemon) liveSessionsOf(ctx context.Context, pids map[string]int32) (map[string]bool, []string) {
	ids := make(map[string]bool, len(pids))
	var cwds []string
	for id := range pids {
		ids[id] = true
		if d.store == nil {
			continue
		}
		if s, err := store.GetSession(ctx, d.store.DB(), id); err == nil && s.Cwd != "" {
			cwds = append(cwds, s.Cwd)
		}
	}
	return ids, cwds
}
