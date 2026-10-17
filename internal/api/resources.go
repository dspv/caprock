package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
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

// handleResourceHistory answers GET /v1/resources/history[?since=<unix ms>]:
// the resource meter's samples of the last hour, as series (03-contracts.md
// § Resources). A read of what is kept; it takes no sample and does not keep
// the meter sampling.
func (s *Server) handleResourceHistory(w http.ResponseWriter, r *http.Request) {
	if s.d.ResourceHistory == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("resource history not available"))
		return
	}
	var since int64
	if v := r.URL.Query().Get("since"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 {
			s.failCode(w, http.StatusBadRequest, errors.New("since: a unix time in milliseconds"))
			return
		}
		since = n
	}
	writeJSON(w, http.StatusOK, s.d.ResourceHistory(since))
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
	q := r.URL.Query()
	writeJSON(w, http.StatusOK, s.d.Footprint(r.Context(), q.Get("orphans") == "1", q.Get("fresh") == "1"))
}

// OrphanTarget names one process from the footprint's orphan list: its pid
// and the start time the list gave, so a pid reused since is not touched.
type OrphanTarget struct {
	PID       int32 `json:"pid"`
	StartedAt int64 `json:"started_at"`
}

// maxStopTargets bounds one stop request; the list is never near it.
const maxStopTargets = 256

// handleStopOrphans stops processes the user picked from the doctor's
// orphan list, each named by pid and start time (ADR-059). The daemon
// scans again and signals only what that scan lists: SIGTERM, or SIGKILL
// with `force`, the user's second click on one that outlived SIGTERM.
// Machine only: it is on no paired device's list, so a phone can read the
// orphans but never stop one.
func (s *Server) handleStopOrphans(w http.ResponseWriter, r *http.Request) {
	if s.d.StopOrphans == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("the orphan stop is not available"))
		return
	}
	var body struct {
		Targets []OrphanTarget `json:"targets"`
		Force   bool           `json:"force"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&body); err != nil {
		s.failCode(w, http.StatusBadRequest, fmt.Errorf("parse body: %w", err))
		return
	}
	if len(body.Targets) == 0 || len(body.Targets) > maxStopTargets {
		s.failCode(w, http.StatusBadRequest, fmt.Errorf("targets: name 1 to %d processes", maxStopTargets))
		return
	}
	for _, t := range body.Targets {
		if t.PID <= 1 || t.StartedAt <= 0 {
			s.failCode(w, http.StatusBadRequest, fmt.Errorf("target %d: a pid above 1 and its started_at are required", t.PID))
			return
		}
	}
	writeJSON(w, http.StatusOK, s.d.StopOrphans(r.Context(), body.Targets, body.Force))
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
