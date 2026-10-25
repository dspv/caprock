package api

import (
	"net/http"

	"github.com/coder/websocket"

	"github.com/dspv/caprock/internal/agents"
)

// exitReporter is the optional half of AgentController that remembers how
// an owned session's program ended (agents.ExitReport): its code, how long
// it ran, and the last lines it printed.
type exitReporter interface {
	Exit(sessionID string) (agents.ExitReport, bool)
}

// exitOf is how a session's program last ended; ok is false when nothing
// was recorded. It is recorded before the session's Done closes, so a
// socket that saw it end finds it here.
func (s *Server) exitOf(id string) (agents.ExitReport, bool) {
	er, ok := s.d.Agents.(exitReporter)
	if !ok {
		return agents.ExitReport{}, false
	}
	return er.Exit(id)
}

// handleAgentExit is GET /v1/agents/{id}/exit: how an owned session's
// program ended, for the tab of one that exited at once. 409 while it is
// still running, 404 when no exit was recorded (it was never Caprock's, or
// it ended before this was kept). Contract: .ai/03-contracts.md.
func (s *Server) handleAgentExit(w http.ResponseWriter, r *http.Request) {
	if !s.requireAgents(w) {
		return
	}
	id := r.PathValue("id")
	// A report is forgotten when its id starts again, so one that is there
	// is this process's, even in the moment before the manager lets go of
	// it — when the pane, told of the exit, asks.
	rep, ok := s.exitOf(id)
	if !ok && s.d.Agents.Holds(id) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "the session is still running"})
		return
	}
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no exit is recorded for this session"})
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

// serveEarlyExit answers a v2 terminal socket for a session whose program
// exited at once, before any terminal reached it, or that Caprock ended to
// free memory: the exit frame, with early or freed, then a normal close.
// Before, the socket was refused (409) and the tab read "Connecting to the
// session… Can't connect · next try in 5 s" over a process that was long
// gone. It reports whether it answered.
func (h *wsHub) serveEarlyExit(s *Server, w http.ResponseWriter, r *http.Request, id string) bool {
	rep, ok := s.exitOf(id)
	if !ok || (!rep.Early && !rep.Freed) {
		return false
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.origins(), Subprotocols: []string{TermV2Protocol}})
	if err != nil {
		return true
	}
	defer h.held(r, c)()
	defer func() { _ = c.CloseNow() }()
	t := &termConn{c: c, ctx: r.Context()}
	exit := map[string]int{"code": rep.Code}
	if rep.Early {
		exit["early"] = 1
	} else {
		exit["freed"] = 1
	}
	_ = t.text(map[string]map[string]int{"exit": exit})
	_ = c.Close(websocket.StatusNormalClosure, "session ended")
	return true
}
