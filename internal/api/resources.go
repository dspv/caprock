package api

import (
	"errors"
	"net/http"
)

// handleResources answers GET /v1/resources: what each live session's
// process tree and Caprock itself cost the machine (03-contracts.md
// § Resources). Asking also keeps the meter sampling for a while, so a
// client without the live socket still gets fresh figures.
func (s *Server) handleResources(w http.ResponseWriter, r *http.Request) {
	if s.d.Resources == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("resource meter not available"))
		return
	}
	writeJSON(w, http.StatusOK, s.d.Resources(r.Context()))
}

// handleFootprint answers GET /v1/footprint: what Caprock itself costs this
// machine — memory, CPU, disk and the daemon's disk I/O — and the duplicate
// and orphaned processes that make it cost more (03-contracts.md
// § Footprint).
func (s *Server) handleFootprint(w http.ResponseWriter, r *http.Request) {
	if s.d.Footprint == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("footprint not available"))
		return
	}
	writeJSON(w, http.StatusOK, s.d.Footprint(r.Context()))
}

// handleReapOrphans stops the orphaned pty-hosts nothing runs in. Not on a
// paired device's list: it signals processes on this machine.
func (s *Server) handleReapOrphans(w http.ResponseWriter, r *http.Request) {
	if s.d.ReapOrphans == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("resource meter not available"))
		return
	}
	v, err := s.d.ReapOrphans(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// LiveClients is how many /v1/live sockets are open: whether anyone is
// looking, for work that is only worth doing while someone is.
func (s *Server) LiveClients() int {
	s.ws.mu.Lock()
	defer s.ws.mu.Unlock()
	return len(s.ws.conns)
}
