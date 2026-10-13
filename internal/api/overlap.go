package api

import (
	"net/http"

	"github.com/dspv/caprock/internal/store"
)

// OverlapPeer is another live session working in the same checkout, named
// the way its card names it, with the files both edited in the window.
type OverlapPeer struct {
	SessionID  string   `json:"session_id"`
	Name       string   `json:"name"`
	NameSource string   `json:"name_source,omitempty"`
	StartedAt  int64    `json:"started_at"`
	Files      []string `json:"files"`
}

// SessionOverlap is one session's neighbours in its checkout.
type SessionOverlap struct {
	Checkout string        `json:"checkout"`
	With     []OverlapPeer `json:"with"`
}

// Overlap answers GET /v1/overlap.
type Overlap struct {
	WindowMinutes int                       `json:"window_minutes"`
	Sessions      map[string]SessionOverlap `json:"sessions"`
}

// handleOverlap lists the live sessions that share a checkout with another
// (the same clone or the same linked worktree, not two worktrees of one
// repository), and the files both edited in the last half hour
// (store.Overlaps). Read only: Caprock moves nothing.
func (s *Server) handleOverlap(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	db := s.d.Store.DB()
	live, err := store.ListSessionsMatching(ctx, db, true, "", 0)
	if err != nil {
		s.fail(w, err)
		return
	}
	got, err := store.Overlaps(ctx, db, live, s.d.Now().UnixMilli()-store.OverlapWindowMs)
	if err != nil {
		s.fail(w, err)
		return
	}
	byID := make(map[string]store.Session, len(live))
	for _, sess := range live {
		byID[sess.SessionID] = sess
	}
	type named struct{ text, source string }
	names := map[string]named{}
	nameOf := func(id string) named {
		if n, ok := names[id]; ok {
			return n
		}
		text, source := describe(ctx, db, byID[id])
		names[id] = named{text, source}
		return names[id]
	}
	out := Overlap{WindowMinutes: store.OverlapWindowMs / 60_000, Sessions: make(map[string]SessionOverlap, len(got))}
	for id, o := range got {
		so := SessionOverlap{Checkout: o.Checkout, With: make([]OverlapPeer, 0, len(o.With))}
		for _, p := range o.With {
			n := nameOf(p.SessionID)
			so.With = append(so.With, OverlapPeer{SessionID: p.SessionID, Name: n.text, NameSource: n.source, StartedAt: p.StartedAt, Files: p.Files})
		}
		out.Sessions[id] = so
	}
	writeJSON(w, http.StatusOK, out)
}
