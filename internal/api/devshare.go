package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/dspv/caprock/internal/devshare"
)

// A local dev server opened on a phone on the same Wi-Fi (ADR-087,
// internal/devshare). Every route is loopback-only, in the handler and by
// being on no device's allowlist: the link carries a working token, and a
// share is started on the machine whose dev server it is, never from a
// paired phone or through the relay.

// devShareList is GET /v1/devshare's answer.
type devShareList struct {
	Shares  []devshare.Share `json:"shares"`
	IdleSec int              `json:"idle_sec"`
	MaxSec  int              `json:"max_sec"`
	Max     int              `json:"max"`
}

func (s *Server) devShareGuard(w http.ResponseWriter, r *http.Request) bool {
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errors.New("a dev server is shared from the machine it runs on"))
		return false
	}
	if s.d.DevShare == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("this build cannot share a dev server"))
		return false
	}
	return true
}

func (s *Server) devShareState() devShareList {
	m := s.d.DevShare
	return devShareList{Shares: m.List(), IdleSec: int(m.Idle().Seconds()), MaxSec: int(m.MaxAge().Seconds()), Max: m.Max()}
}

func (s *Server) handleDevShares(w http.ResponseWriter, r *http.Request) {
	if !s.devShareGuard(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, s.devShareState())
}

func (s *Server) handleStartDevShare(w http.ResponseWriter, r *http.Request) {
	if !s.devShareGuard(w, r) {
		return
	}
	var req struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		s.failCode(w, http.StatusBadRequest, errors.New("expected {url}"))
		return
	}
	sh, err := s.d.DevShare.Start(req.URL)
	switch {
	case errors.Is(err, devshare.ErrNotLocal), errors.Is(err, devshare.ErrOwnPort):
		s.failCode(w, http.StatusBadRequest, err)
	case errors.Is(err, devshare.ErrTooMany):
		s.failCode(w, http.StatusConflict, err)
	case errors.Is(err, devshare.ErrNoAddress), errors.Is(err, devshare.ErrClosed):
		s.failCode(w, http.StatusServiceUnavailable, err)
	case err != nil:
		s.fail(w, err)
	default:
		writeJSON(w, http.StatusOK, sh)
	}
}

func (s *Server) handleStopDevShare(w http.ResponseWriter, r *http.Request) {
	if !s.devShareGuard(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"stopped": s.d.DevShare.Stop(r.PathValue("id"))})
}
