package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// sessionNameMaxRunes bounds a name the user types: one line, about what a
// wide tab shows and then some.
const sessionNameMaxRunes = 120

// handleRenameSession is PUT /v1/sessions/{id}/name {name}: the user's own
// name for a session, from its tab or its sidebar row. An empty name clears
// it. The new name goes out as a session frame, so every window holding the
// session (the app, a browser tab, the phone) shows it without a refetch.
func (s *Server) handleRenameSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		Name *string `json:"name"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&body); err != nil || body.Name == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `body is {"name": "..."}; "" clears it`})
		return
	}
	name := sessionName(*body.Name)
	ctx := r.Context()
	q := s.d.Store.DB()
	ok, err := store.SetName(ctx, q, id, name)
	if err != nil {
		s.fail(w, err)
		return
	}
	if !ok {
		s.failCode(w, http.StatusNotFound, errors.New("no such session"))
		return
	}
	sess, err := store.GetSession(ctx, q, id)
	if err != nil {
		s.fail(w, err)
		return
	}
	if s.d.Bus != nil {
		st, _ := store.GetStats(ctx, q, id)
		s.d.Bus.Publish(bus.Frame{Type: bus.FrameSession, Data: rollup.SessionFrame{Session: sess, Stats: st}})
	}
	writeJSON(w, http.StatusOK, map[string]string{"session_id": id, "name": sess.Name})
}

// sessionName is a typed name made one line: whitespace collapsed, clipped on
// a rune boundary.
func sessionName(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) > sessionNameMaxRunes {
		s = strings.TrimSpace(string([]rune(s)[:sessionNameMaxRunes]))
	}
	return s
}
