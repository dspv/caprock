package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/pairing"
)

// The pairing endpoints.
//
// Two audiences, and the split between them is the point:
//
//   - the **owner**, at the machine, on loopback: issues a code, sees which
//     devices are paired, revokes one or all of them;
//   - the **device**, on the network, holding nothing: exchanges a code for a
//     token, once.
//
// Everything an owner does is loopback-only, enforced here rather than left to
// the gate. A paired tablet is a device the owner let in to read figures; it is
// not a second control room, and it must not be able to pair a third device or
// revoke the laptop that admitted it.

type pairRequest struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

type pairResponse struct {
	Token string `json:"token"`
	ID    string `json:"id"`
	Name  string `json:"name"`
}

type pairState struct {
	// Enabled is whether this daemon is listening on the network at all.
	Enabled bool `json:"enabled"`
	// URL is what to type into the other device, empty when disabled.
	URL string `json:"url,omitempty"`
	// Code is the outstanding pairing code, shown only to the owner.
	Code string `json:"code,omitempty"`
	// ExpiresInSec counts the code down. Zero when there is none.
	ExpiresInSec int              `json:"expires_in_sec,omitempty"`
	Devices      []pairing.Public `json:"devices"`
}

// handlePairState reports what the owner needs to see: whether the network
// listener is up, at what address, any code still live, and every paired
// device.
func (s *Server) handlePairState(w http.ResponseWriter, r *http.Request) {
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errors.New("pairing is managed from the machine Caprock runs on"))
		return
	}
	st := pairState{Enabled: s.d.Pairing != nil, URL: s.d.LANURL, Devices: []pairing.Public{}}
	if s.d.Pairing != nil {
		if live, left := s.d.Pairing.CodeActive(); live {
			st.Code = s.d.Pairing.Code()
			st.ExpiresInSec = int(left / time.Second)
		}
		st.Devices = s.d.Pairing.Devices()
	}
	writeJSON(w, http.StatusOK, st)
}

// handlePairNewCode issues a code for the owner to read out or scan.
func (s *Server) handlePairNewCode(w http.ResponseWriter, r *http.Request) {
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errors.New("pairing is managed from the machine Caprock runs on"))
		return
	}
	if s.d.Pairing == nil {
		s.failCode(w, http.StatusConflict, errors.New("this daemon is not listening on the network — restart it with `caprock up --lan`"))
		return
	}
	code, err := s.d.Pairing.NewCode()
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"code":           code,
		"expires_in_sec": int(pairing.CodeTTL / time.Second),
		"url":            s.d.LANURL,
	})
}

// handlePairRedeem is the one thing a device may do before it is trusted:
// exchange a code for a token.
func (s *Server) handlePairRedeem(w http.ResponseWriter, r *http.Request) {
	if s.d.Pairing == nil {
		s.failCode(w, http.StatusConflict, errors.New("this daemon is not listening on the network"))
		return
	}
	var req pairRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		s.failCode(w, http.StatusBadRequest, errors.New("send a JSON body with a code"))
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		// The device list is only useful if a row says which thing it is, and
		// a person pairing a tablet will not name it unprompted.
		name = "a device"
	}
	dev, err := s.d.Pairing.Redeem(strings.TrimSpace(req.Code), name)
	if err != nil {
		// Same answer for wrong, expired, exhausted and never-issued. Each
		// distinction tells someone guessing how close they are.
		s.failCode(w, http.StatusUnauthorized, errors.New("that code does not work — ask for a new one on the machine Caprock runs on"))
		return
	}
	s.saveDevices()
	writeJSON(w, http.StatusOK, pairResponse{Token: dev.Token, ID: dev.ID, Name: dev.Name})
}

// handlePairRevoke removes one device, or all of them.
func (s *Server) handlePairRevoke(w http.ResponseWriter, r *http.Request) {
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errors.New("pairing is managed from the machine Caprock runs on"))
		return
	}
	if s.d.Pairing == nil {
		s.failCode(w, http.StatusConflict, errors.New("this daemon is not listening on the network"))
		return
	}
	id := r.PathValue("id")
	if id == "all" {
		n := s.d.Pairing.RevokeAll()
		s.saveDevices()
		writeJSON(w, http.StatusOK, map[string]int{"revoked": n})
		return
	}
	if !s.d.Pairing.Revoke(id) {
		s.failCode(w, http.StatusNotFound, errors.New("no such device"))
		return
	}
	s.saveDevices()
	writeJSON(w, http.StatusOK, map[string]int{"revoked": 1})
}

// saveDevices writes the guest list to disk.
//
// Best-effort on purpose: the device is already paired or already revoked in
// memory, and failing the request afterwards would tell the user the opposite
// of what happened. A failure costs a re-pair after the next restart, and is
// logged rather than shown.
func (s *Server) saveDevices() {
	if s.d.Pairing == nil || s.d.DataDir == "" {
		return
	}
	if err := config.WriteDevices(s.d.DataDir, s.d.Pairing.Snapshot()); err != nil {
		s.d.Log.Warn("could not save the paired devices", "component", "api", "err", err)
	}
}
