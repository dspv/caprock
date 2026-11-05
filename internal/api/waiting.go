package api

import (
	"context"

	"github.com/dspv/caprock/internal/narrate"
	"github.com/dspv/caprock/internal/store"
)

// WaitingSession is a session the Home screen shows under Needs you.
type WaitingSession struct {
	ID      string
	Project string
	// Title is what the card calls it: the agent's title, else the first
	// prompt that says something.
	Title string
	// Reason is narrate's Need.Reason (permission, question, plan, error,
	// asks).
	Reason string
}

// waitingMax bounds the live sessions read: Needs you is a handful.
const waitingMax = 200

// WaitingSessions lists the live sessions waiting on their owner, newest
// first: the ones the Home screen's Needs you shows, read the same way
// (summarize's activity, health waiting-on-you). For the Morning summary
// (ADR-091), which says how many wait and on what.
func (s *Server) WaitingSessions(ctx context.Context) ([]WaitingSession, error) {
	list, err := store.ListSessionsQuery(ctx, s.d.Store.DB(), store.SessionQuery{Active: true}, waitingMax)
	if err != nil {
		return nil, err
	}
	var out []WaitingSession
	for _, sess := range list {
		if sess.Status == "ended" {
			continue
		}
		sum, _, err := s.summarize(ctx, sess)
		if err != nil {
			return nil, err
		}
		act := sum.Activity
		if act.Health != narrate.HealthWaiting {
			continue
		}
		w := WaitingSession{ID: sess.SessionID, Project: sess.Project, Title: sum.Description}
		if act.Need != nil {
			w.Reason = act.Need.Reason
		}
		out = append(out, w)
	}
	return out, nil
}
