package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"
)

// RemoteControl is the daemon's side of access from anywhere (ADR-058).
type RemoteControl interface {
	// RemoteState is what the pairing panel shows. code is the outstanding
	// pairing code, "" for none; when there is one the state's link carries
	// it, so the QR pairs in one scan.
	RemoteState(code string) RemoteState
	// SetRemote turns it on or off, and on, optionally changes the relay and
	// the phone's page. Remembered across restarts.
	SetRemote(on bool, relay, app string) error
}

// RemoteState is GET /v1/pair's "remote".
type RemoteState struct {
	Enabled bool   `json:"enabled"`
	Status  string `json:"status"` // off, connecting, online, offline
	Error   string `json:"error,omitempty"`
	Phones  int    `json:"phones"`
	Relay   string `json:"relay"`
	App     string `json:"app"`
	HostID  string `json:"host_id,omitempty"`
	// Link is the pairing link the QR draws: the phone's page with the relay,
	// this machine's id and key, and the code when one is live.
	Link string `json:"link,omitempty"`
}

// handleSetRemote turns access from anywhere on or off. Loopback-only, like
// every other decision about who gets in: a phone that was let in must not be
// able to widen the door it came through.
func (s *Server) handleSetRemote(w http.ResponseWriter, r *http.Request) {
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errors.New("access from anywhere is switched on from the machine Caprock runs on"))
		return
	}
	if s.d.Remote == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("this build cannot be reached through a relay"))
		return
	}
	var req struct {
		On    bool   `json:"on"`
		Relay string `json:"relay"`
		App   string `json:"app"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req)
	}
	if err := s.d.Remote.SetRemote(req.On, req.Relay, req.App); err != nil {
		s.failCode(w, http.StatusBadRequest, err)
		return
	}
	code := ""
	if ps, _ := s.lanState(); ps != nil {
		if live, _ := ps.CodeActive(); live {
			code = ps.Code()
		}
	}
	writeJSON(w, http.StatusOK, s.d.Remote.RemoteState(code))
}

// handlePairSendLink sends the phone's page address (remote.app, e.g.
// https://m.caprock.dev/) to the owner's Telegram chat: "Send the link to my
// phone" beside a paired device. The address is the daemon's own, never the
// request's, and carries no code, key or token — a paired phone reconnects
// with the token it keeps, and an unpaired one is told so. Loopback-only, and
// the destination is the one the owner set up (ADR-047): nothing new leaves
// the machine.
func (s *Server) handlePairSendLink(w http.ResponseWriter, r *http.Request) {
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errors.New("the link is sent from the machine Caprock runs on"))
		return
	}
	if s.d.Remote == nil || s.d.PhoneLink == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("this build cannot send the phone's link"))
		return
	}
	if !s.d.PhoneLink.PhoneLinkReady() {
		s.failCode(w, http.StatusConflict, errors.New("no Telegram bot is set up: Settings → Telegram"))
		return
	}
	app := s.d.Remote.RemoteState("").App
	if app == "" {
		s.failCode(w, http.StatusConflict, errors.New("no phone page is set"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	if err := s.d.PhoneLink.SendPhoneLink(ctx, app); err != nil {
		s.failCode(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"sent": "telegram", "link": app})
}
