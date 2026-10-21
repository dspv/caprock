package agents

import (
	"context"

	"github.com/dspv/caprock/internal/store"
)

// A /clear in a session Caprock started keeps the process and starts a new
// session id (03-contracts.md § "/clear replaces a session"). The terminal is
// still the one Caprock spawned, filed under the spawn's id; Follow files it
// under the new id as well, so the tab that follows the conversation
// (.ai/04-ui.md § One card per conversation) attaches, types and signals
// through the new id. The spawn's id keeps answering too: the process, its
// pty-host and its exit are still recorded under it.

// Follow records that session next took over the process prev ran in. prev
// may itself be a session an earlier /clear filed here. False when Caprock
// holds no terminal for prev, or next is a session of its own (a fork runs
// in its own process and is never filed here).
func (m *Manager) Follow(next, prev string) bool {
	if next == "" || prev == "" || next == prev {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	a := m.lookupLocked(prev)
	if a == nil || a.Kind == KindShell {
		return false
	}
	if _, own := m.agents[next]; own {
		return false
	}
	if m.follows == nil {
		m.follows = map[string]string{}
	}
	m.follows[next] = a.SessionID
	a.current.Store(&next)
	m.log.Info("terminal follows the session a /clear started", "component", "agents", "session_id", next, "spawned_as", a.SessionID)
	return true
}

// lookupLocked is the agent filed under id: its own, or the one a /clear
// moved it to. m.mu is held.
func (m *Manager) lookupLocked(id string) *Agent {
	if a, ok := m.agents[id]; ok {
		return a
	}
	if to, ok := m.follows[id]; ok {
		return m.agents[to]
	}
	return nil
}

// forgetFollowsLocked drops every id filed under the spawn id and returns
// them. m.mu is held.
func (m *Manager) forgetFollowsLocked(spawn string) []string {
	var ids []string
	for id, to := range m.follows {
		if to == spawn {
			ids = append(ids, id)
			delete(m.follows, id)
		}
	}
	return ids
}

// Current is the session the process runs now: the spawn's id until a
// /clear, then the newest session a /clear started in it.
func (a *Agent) Current() string {
	if p := a.current.Load(); p != nil && *p != "" {
		return *p
	}
	return a.SessionID
}

// followCleared files a reattached session's terminal under every session a
// /clear started in its process, before this daemon started or while none
// held it. The spawn's own row stays as the /clear left it, ended; the
// newest one is brought up to date instead. Reports the newest id, "" when
// there is none.
func (m *Manager) followCleared(ctx context.Context, a *Agent, pid int) string {
	newest, err := store.ClearSuccessor(ctx, m.store.DB(), a.SessionID)
	if err != nil || newest == "" {
		return ""
	}
	chain, err := store.ClearAncestors(ctx, m.store.DB(), newest)
	if err != nil {
		return ""
	}
	// Oldest first, so the newest is filed last and is the one Current names.
	for i := len(chain) - 1; i >= 0; i-- {
		if chain[i] != a.SessionID {
			m.Follow(chain[i], a.SessionID)
		}
	}
	m.Follow(newest, a.SessionID)
	s, err := store.GetSession(ctx, m.store.DB(), newest)
	if err == nil && (!s.Owned || s.Status == store.StatusEnded || s.PID != pid) {
		_ = m.store.WithTx(ctx, func(q store.Querier) error {
			return store.MarkOwned(ctx, q, newest, a.Worktree, a.Command, pid)
		})
	}
	return newest
}
