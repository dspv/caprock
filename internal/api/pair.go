package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"net"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/lan"
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
	// Tunnelled says the address reaches other networks (Tailscale) rather
	// than only this one. The distinction is the whole difference between
	// "works from the sofa" and "works from anywhere", and a screen that does
	// not draw it sends someone to try their tablet on mobile data and
	// conclude the feature is broken.
	Tunnelled bool `json:"tunnelled,omitempty"`
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
	ps, lanURL := s.lanState()
	st := pairState{Enabled: ps != nil, URL: lanURL, Devices: []pairing.Public{}}
	if host := hostOf(lanURL); host != "" {
		st.Tunnelled = lan.Tunnelled(net.ParseIP(host))
	}
	if ps != nil {
		if live, left := ps.CodeActive(); live {
			st.Code = ps.Code()
			st.ExpiresInSec = int(left / time.Second)
		}
		st.Devices = ps.Devices()
	} else {
		// Off, but the guest list is kept on disk. "Off · 1 phone paired" is
		// the honest answer; "Off" alone hid a phone that will be let back in
		// the moment network access is turned on.
		st.Devices = s.devicesOnDisk()
	}
	writeJSON(w, http.StatusOK, st)
}

// handlePairNewCode issues a code for the owner to read out or scan.
func (s *Server) handlePairNewCode(w http.ResponseWriter, r *http.Request) {
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errors.New("pairing is managed from the machine Caprock runs on"))
		return
	}
	ps, lanURL := s.lanState()
	if ps == nil {
		s.failCode(w, http.StatusConflict, errors.New("network access is off — turn it on from Settings"))
		return
	}
	code, err := ps.NewCode()
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"code":           code,
		"expires_in_sec": int(pairing.CodeTTL / time.Second),
		"url":            lanURL,
	})
}

// handlePairClearCode withdraws the outstanding code. The screen's Cancel
// calls it: a code hidden from the owner but still valid on the daemon would be
// an invitation nobody can see. Answers 200 when there was nothing to withdraw
// or network access is off — either way, no code works afterwards.
func (s *Server) handlePairClearCode(w http.ResponseWriter, r *http.Request) {
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errors.New("pairing is managed from the machine Caprock runs on"))
		return
	}
	if ps, _ := s.lanState(); ps != nil {
		ps.ClearCode()
	}
	writeJSON(w, http.StatusOK, map[string]bool{"cleared": true})
}

// handlePairRedeem is the one thing a device may do before it is trusted:
// exchange a code for a token.
func (s *Server) handlePairRedeem(w http.ResponseWriter, r *http.Request) {
	ps, _ := s.lanState()
	if ps == nil {
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
	dev, err := ps.Redeem(strings.TrimSpace(req.Code), name)
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
	ps, _ := s.lanState()
	id := r.PathValue("id")
	if ps == nil && s.d.DataDir != "" {
		// Off, with a guest list on disk: removing a phone must not require
		// first opening the door to it.
		s.revokeOnDisk(w, id)
		return
	}
	if ps == nil {
		s.failCode(w, http.StatusConflict, errors.New("this daemon is not listening on the network"))
		return
	}
	if id == "all" {
		n := ps.RevokeAll()
		s.saveDevices()
		writeJSON(w, http.StatusOK, map[string]int{"revoked": n})
		return
	}
	if !ps.Revoke(id) {
		s.failCode(w, http.StatusNotFound, errors.New("no such device"))
		return
	}
	s.saveDevices()
	writeJSON(w, http.StatusOK, map[string]int{"revoked": 1})
}

// devicesOnDisk is the saved guest list without tokens, for a daemon that is
// not listening. Empty, never nil, when there is none or it cannot be read.
func (s *Server) devicesOnDisk() []pairing.Public {
	out := []pairing.Public{}
	if s.d.DataDir == "" {
		return out
	}
	saved, err := config.ReadDevices(s.d.DataDir)
	if err != nil {
		return out
	}
	tmp := pairing.New()
	tmp.Load(saved)
	return append(out, tmp.Devices()...)
}

// revokeOnDisk removes one device, or all, from the saved guest list while
// network access is off.
func (s *Server) revokeOnDisk(w http.ResponseWriter, id string) {
	saved, err := config.ReadDevices(s.d.DataDir)
	if err != nil {
		s.fail(w, err)
		return
	}
	tmp := pairing.New()
	tmp.Load(saved)
	n := 0
	if id == "all" {
		n = tmp.RevokeAll()
	} else if tmp.Revoke(id) {
		n = 1
	}
	if n == 0 && id != "all" {
		s.failCode(w, http.StatusNotFound, errors.New("no such device"))
		return
	}
	if err := config.WriteDevices(s.d.DataDir, tmp.Snapshot()); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"revoked": n})
}

// saveDevices writes the guest list to disk.
//
// Best-effort on purpose: the device is already paired or already revoked in
// memory, and failing the request afterwards would tell the user the opposite
// of what happened. A failure costs a re-pair after the next restart, and is
// logged rather than shown.
func (s *Server) saveDevices() {
	ps, _ := s.lanState()
	if ps == nil || s.d.DataDir == "" {
		return
	}
	if err := config.WriteDevices(s.d.DataDir, ps.Snapshot()); err != nil {
		s.d.Log.Warn("could not save the paired devices", "component", "api", "err", err)
	}
}

// handleSetLAN turns network access on or off from the dashboard.
//
// Loopback-only, like everything else an owner does here: switching this on is
// the decision that lets other devices in, and a device that was let in must
// not be able to make it.
//
// It exists because the alternative was "restart the daemon with --lan", which
// requires a terminal on the machine — and the person who wants this is
// usually holding the tablet, not sitting at the machine. `caprock up --lan`
// still does the same thing at startup.
func (s *Server) handleSetLAN(w http.ResponseWriter, r *http.Request) {
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errors.New("network access is switched on from the machine Caprock runs on"))
		return
	}
	if s.d.LAN == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("this build cannot change network access while running — start it with `caprock up --lan`"))
		return
	}
	var req struct {
		On bool `json:"on"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req)
	}
	if !req.On {
		if err := s.d.LAN.DisableLAN(); err != nil {
			s.fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	url, err := s.d.LAN.EnableLAN()
	if err != nil {
		s.failCode(w, http.StatusConflict, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "url": url})
}

// pairMe is what a dashboard needs to know about the device it runs on.
type pairMe struct {
	// Role is "owner" on the machine itself, else the device's role.
	Role string `json:"role"`
	ID   string `json:"id,omitempty"`
	Name string `json:"name,omitempty"`
}

// handlePairMe tells a dashboard which controls to draw (ADR-034). The daemon
// enforces the role either way; this only keeps a viewer's screen free of
// buttons that would answer 403.
func (s *Server) handlePairMe(w http.ResponseWriter, r *http.Request) {
	dev := deviceFrom(r)
	if dev == nil {
		writeJSON(w, http.StatusOK, pairMe{Role: "owner"})
		return
	}
	writeJSON(w, http.StatusOK, pairMe{Role: dev.Role, ID: dev.ID, Name: dev.Name})
}

// handlePairSetRole makes one paired device a controller, or a viewer again
// (ADR-034). Loopback-only, like every other decision about who may do what:
// a controller must not be able to promote another device, or itself.
//
// Taking control away takes effect on the device's next request and on its
// next keystroke into a terminal already open (serveTerm asks again per frame).
func (s *Server) handlePairSetRole(w http.ResponseWriter, r *http.Request) {
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errors.New("pairing is managed from the machine Caprock runs on"))
		return
	}
	var req struct {
		Role string `json:"role"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil || !pairing.ValidRole(req.Role) {
		s.failCode(w, http.StatusBadRequest, errors.New(`send {"role": "viewer"|"controller"}`))
		return
	}
	id := r.PathValue("id")
	ps, _ := s.lanState()
	if ps == nil {
		if s.d.DataDir == "" {
			s.failCode(w, http.StatusConflict, errors.New("this daemon is not listening on the network"))
			return
		}
		// Off, with a guest list on disk: the role is set there, and holds
		// when network access is turned on again.
		s.setRoleOnDisk(w, id, req.Role)
		return
	}
	if !ps.SetRole(id, req.Role) {
		s.failCode(w, http.StatusNotFound, errors.New("no such device"))
		return
	}
	s.saveDevices()
	s.d.Log.Info("paired device role changed", "component", "api", "device", id, "role", req.Role)
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "role": req.Role})
}

// setRoleOnDisk is handlePairSetRole for a daemon that is not listening.
func (s *Server) setRoleOnDisk(w http.ResponseWriter, id, role string) {
	saved, err := config.ReadDevices(s.d.DataDir)
	if err != nil {
		s.fail(w, err)
		return
	}
	tmp := pairing.New()
	tmp.Load(saved)
	if !tmp.SetRole(id, role) {
		s.failCode(w, http.StatusNotFound, errors.New("no such device"))
		return
	}
	if err := config.WriteDevices(s.d.DataDir, tmp.Snapshot()); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "role": role})
}
