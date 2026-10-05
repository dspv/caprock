package agents

import (
	"context"
	"strconv"
	"time"

	"github.com/dspv/caprock/internal/ptyhost"
	"github.com/dspv/caprock/internal/ptyman"
	"github.com/dspv/caprock/internal/store"
)

// UseHosts starts every new session inside a pty-host process (ADR-033), so it
// outlives this daemon. exe is the Caprock binary to run as `exe pty-host`.
// A session whose holder cannot be started falls back to the in-process PTY
// this manager used before, which works and ends with the daemon.
func (m *Manager) UseHosts(exe, version string) {
	if exe == "" || m.dataDir == "" {
		return
	}
	m.hosts = &ptyhost.Manager{Exe: exe, DataDir: m.dataDir, Version: version, Log: m.log, Fallback: m.pty}
	m.pty = m.hosts
}

// Keys of the ptyman.Spec.Meta a session is spawned with, which a pty-host
// keeps and hands back on reattach.
const (
	metaKind = "kind" // which coding agent: claude, codex, opencode, gemini
	metaPort = "port" // an OpenCode TUI's own server port, for linking its id
)

// Reattach picks up the sessions a previous daemon left running in their
// pty-hosts and records how the ones that ended in between finished. Returns
// the reattached sessions, so the daemon can resume watching the agents that
// need it (an OpenCode session not yet linked to its own id). Call it once,
// at startup, before the first liveness sweep.
func (m *Manager) Reattach(ctx context.Context) []*Agent {
	if m.hosts == nil {
		return nil
	}
	var out []*Agent
	attached, exits := m.hosts.Reattach()
	for _, x := range exits {
		s, err := store.GetSession(ctx, m.store.DB(), x.SessionID)
		if err != nil || !s.Owned || s.Status == store.StatusEnded {
			continue
		}
		_ = m.store.WithTx(ctx, func(q store.Querier) error { return store.SetExit(ctx, q, x.SessionID, x.Code) })
		m.log.Info("owned session ended while Caprock was stopped", "component", "agents", "session_id", x.SessionID, "code", x.Code)
	}
	for _, at := range attached {
		rec := at.Record
		worktree := ""
		s, err := store.GetSession(ctx, m.store.DB(), rec.SessionID)
		if err == nil {
			worktree = s.Worktree
		}
		// Which agent: what the spawn recorded, else the row, else Claude Code
		// (a holder from before Meta existed only ever ran claude).
		kind := rec.Meta[metaKind]
		if kind == "" && err == nil {
			kind = s.Agent
		}
		if kind == "" {
			kind = AgentClaude
		}
		port, _ := strconv.Atoi(rec.Meta[metaPort])
		a := &Agent{
			SessionID: rec.SessionID, Cwd: rec.Cwd, Worktree: worktree, Command: rec.Command, StartedAt: rec.StartedAt,
			Kind: kind, Port: port,
			sess: at.Session, ring: newRing(256 << 10), log: m.log, subs: map[chan []byte]struct{}{}, done: make(chan struct{}), onExit: m.OnExit,
		}
		m.mu.Lock()
		m.agents[rec.SessionID] = a
		m.mu.Unlock()
		// The row normally already says all of this. It does not when the
		// sweep of an older run ended it, or the database is newer than the
		// session; then the holder is the evidence and the row follows it.
		if err != nil || !s.Owned || s.Status == store.StatusEnded || s.PID != at.Session.PID() {
			_ = m.store.WithTx(ctx, func(q store.Querier) error {
				if err != nil {
					if uerr := store.UpsertSession(ctx, q, rec.SessionID, store.SessionPatch{Cwd: rec.Cwd}); uerr != nil {
						return uerr
					}
				}
				return store.MarkOwned(ctx, q, rec.SessionID, worktree, rec.Command, at.Session.PID())
			})
		}
		if kind == AgentClaude {
			m.restorePermission(ctx, rec.SessionID)
		}
		go a.pump(m.OnOutput)
		go a.wait(m)
		m.log.Info("reattached owned session", "component", "agents", "session_id", rec.SessionID, "agent", kind, "pid", at.Session.PID(), "host_version", rec.Version)
		out = append(out, a)
	}
	// A prompt stored for a session that is not running again is waiting on
	// nothing.
	keep := map[string]bool{}
	for _, a := range out {
		keep[a.SessionID] = true
	}
	_ = m.store.WithTx(ctx, func(q store.Querier) error { return store.PrunePendingPermissions(ctx, q, keep) })
	return out
}

// Survives reports whether a running owned session is held by a pty-host and
// so outlives this daemon. False for one in the in-process fallback, which
// ends when the daemon does.
func (m *Manager) Survives(sessionID string) bool {
	a, ok := m.Get(sessionID)
	if !ok {
		return false
	}
	_, hosted := a.sess.(ptyman.Detacher)
	return hosted
}

// leftoverGrace is how long a leftover process gets to exit on SIGTERM.
const leftoverGrace = 5 * time.Second

// stopLeftover ends the process of an owned session this daemon has no
// terminal for, before that conversation is continued under the same id.
//
// Such a process exists when an older Caprock — one from before pty-hosts —
// started the session and then stopped without ending it, or its pty-host
// died and the child ignored the hangup. Nobody can type into it, and left
// running it would share a transcript with the new process, each ending up
// with half the other's turns.
//
// Rule 7 allows this and only this: the row says Caprock started the session
// (owned), and the pid is the one Caprock recorded when it did. A session
// someone started in their own terminal is never touched here — the owned
// check is the whole guard, so it comes first.
func (m *Manager) stopLeftover(ctx context.Context, id string) {
	if _, held := m.Get(id); held {
		return
	}
	s, err := store.GetSession(ctx, m.store.DB(), id)
	if err != nil || !s.Owned || s.Status == store.StatusEnded || s.PID <= 1 || !store.ProcessAlive(s.PID) {
		return
	}
	m.log.Info("stopping the terminal-less process of an owned session before continuing it", "component", "agents", "session_id", id, "pid", s.PID)
	_ = ptyman.TerminatePID(s.PID)
	deadline := time.Now().Add(leftoverGrace)
	for time.Now().Before(deadline) {
		if !store.ProcessAlive(s.PID) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = ptyman.KillPID(s.PID)
}
