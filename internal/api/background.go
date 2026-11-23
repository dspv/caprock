package api

import (
	"context"
	"sync"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// backgroundCache keeps each session's background work (store.BackgroundWork)
// by its main thread's newest event: only a main-thread event — a launch, a
// notification, a restart — can change it, and a lead whose subagents log a
// call a second would otherwise read it again on every one of them.
type backgroundCache struct {
	mu sync.Mutex
	m  map[string]backgroundEntry
}

type backgroundEntry struct {
	mainID int64
	tasks  []store.BackgroundTask
}

// backgroundCacheMax bounds the map; past it, it starts again empty.
const backgroundCacheMax = 512

// backgroundFor is the session's background work, read again only when its
// main thread's newest event is not the one it was read at. Nil for a
// session that is not a live Claude Code one with hooks: nothing else
// records a background launch.
func (s *Server) backgroundFor(ctx context.Context, sess store.Session, mainLast *event.Event) ([]store.BackgroundTask, error) {
	if sess.Status == store.StatusEnded || !sess.HasHooks || (sess.Agent != "" && sess.Agent != "claude") || mainLast == nil {
		return nil, nil
	}
	c := &s.background
	c.mu.Lock()
	if e, ok := c.m[sess.SessionID]; ok && e.mainID == mainLast.ID {
		c.mu.Unlock()
		return e.tasks, nil
	}
	c.mu.Unlock()
	tasks, err := store.BackgroundWork(ctx, s.d.Store.DB(), sess.SessionID, s.d.Now().UnixMilli())
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	if c.m == nil || len(c.m) >= backgroundCacheMax {
		c.m = map[string]backgroundEntry{}
	}
	c.m[sess.SessionID] = backgroundEntry{mainID: mainLast.ID, tasks: tasks}
	c.mu.Unlock()
	return tasks, nil
}

// newestMain is the newest main-thread event in events (oldest first), or
// nil with none.
func newestMain(events []event.Event) *event.Event {
	for i := len(events) - 1; i >= 0; i-- {
		if !events[i].Subagent() {
			return &events[i]
		}
	}
	return nil
}

// backgroundCounts splits tasks by kind, and counts the working subagents
// together with the background agents the subagent rule missed (one quiet
// past the live window while it waits on work of its own).
func backgroundCounts(live []string, tasks []store.BackgroundTask) (agents, shells, monitors int) {
	seen := make(map[string]bool, len(live))
	for _, id := range live {
		seen[id] = true
	}
	agents = len(live)
	for _, t := range tasks {
		switch t.Kind {
		case store.BackgroundAgent:
			if !seen[t.ID] {
				agents++
			}
		case store.BackgroundShell:
			shells++
		case store.BackgroundMonitor:
			monitors++
		}
	}
	return agents, shells, monitors
}
