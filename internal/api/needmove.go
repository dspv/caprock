package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/narrate"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// moveKeep is how long a move is remembered at most. It only ever applies
// to the Stop it was made at, so an old one is dead weight, not a risk.
const moveKeep = 48 * time.Hour

// needMoves holds the owner's "needs me?" and "not needed" corrections, one
// per session, in memory (.ai/03-contracts.md § Needs you and Done). Each
// names the Stop it was made at, so the session's next turn reads afresh
// without anything being cleared; a daemon restart forgets them, and the
// turn reads as the guess said. Nothing durable is worth a table: the
// correction is about one turn that is usually minutes old.
type needMoves struct {
	mu sync.Mutex
	m  map[string]narrate.Move
}

func (n *needMoves) get(id string) (narrate.Move, bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	m, ok := n.m[id]
	return m, ok
}

func (n *needMoves) set(id string, m narrate.Move, now time.Time) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.m == nil {
		n.m = map[string]narrate.Move{}
	}
	for k, v := range n.m {
		if now.Sub(v.StopAt) > moveKeep {
			delete(n.m, k)
		}
	}
	n.m[id] = m
}

// handleNeedMove is PUT /v1/sessions/{id}/needs {"needs": true|false}: the
// owner says a turn Caprock guessed was Done needs them after all, or that
// one it guessed asks something does not. It applies to the turn that ended
// last and holds until the next one; 409 while no turn has ended.
func (s *Server) handleNeedMove(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		Needs *bool `json:"needs"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&body); err != nil || body.Needs == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `body is {"needs": true|false}`})
		return
	}
	ctx := r.Context()
	q := s.d.Store.DB()
	sess, err := store.GetSession(ctx, q, id)
	if err != nil {
		s.failCode(w, http.StatusNotFound, errors.New("no such session"))
		return
	}
	last, err := store.LastEventsFiltered(ctx, q, id, 1, store.EventFilter{MainOnly: true})
	if err != nil {
		s.fail(w, err)
		return
	}
	if len(last) == 0 || last[0].Kind != event.KindAgentStop {
		s.failCode(w, http.StatusConflict, errors.New("the session's turn has not ended"))
		return
	}
	s.moves.set(id, narrate.Move{StopAt: last[0].Ts, Needs: *body.Needs}, s.d.Now())
	if s.d.Bus != nil {
		st, _ := store.GetStats(ctx, q, id)
		s.d.Bus.Publish(bus.Frame{Type: bus.FrameSession, Data: rollup.SessionFrame{Session: sess, Stats: st}})
	}
	writeJSON(w, http.StatusOK, map[string]any{"session_id": id, "needs": *body.Needs})
}
