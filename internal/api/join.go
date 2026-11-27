package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/peers"
	"github.com/dspv/caprock/internal/remote"
)

// Join keys (ADR-108): one paste links a new computer to the one the user
// works on.
//
//   - On the computer where the user works: POST /v1/machines/join-key makes
//     a key, single use, good for 15 minutes, and answers it once; GET says
//     how it stands (waiting, joining, joined with which computer, expired)
//     and never repeats it; DELETE withdraws it.
//   - On the new computer: POST /v1/join {key} is `caprock join <key>` and
//     the key pasted in Settings → Computers there.
//
// Every route is loopback only and on no device's allowlist (lanauth.go): a
// computer or phone paired here can neither mint a key — which would let it
// add controllers — nor make this machine join another.

// JoinControl is the daemon's side of join keys.
type JoinControl interface {
	NewJoinKey() (peers.NewJoinKey, error)
	JoinKeyState() peers.JoinState
	WithdrawJoinKey()
	Join(ctx context.Context, key string) (JoinResult, error)
}

// JoinResult is POST /v1/join's answer.
type JoinResult struct {
	peers.Joined
	// Name is this computer's own name, as the other one now lists it.
	Name string `json:"name"`
	// TurnedOnRemote says the join switched access from anywhere on here
	// (it was off), and Relay is the relay this computer waits at.
	TurnedOnRemote bool   `json:"turned_on_remote"`
	Relay          string `json:"relay"`
}

// joinLocal refuses anything but this machine's own clients.
func (s *Server) joinLocal(w http.ResponseWriter, r *http.Request) bool {
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errors.New("computers are linked from the machine Caprock runs on"))
		return false
	}
	if s.d.Join == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("this build cannot link computers with a key"))
		return false
	}
	return true
}

// handleNewJoinKey makes a join key. The key is in this answer and nowhere
// else: not in the log, an event, or a later GET.
func (s *Server) handleNewJoinKey(w http.ResponseWriter, r *http.Request) {
	if !s.joinLocal(w, r) {
		return
	}
	k, err := s.d.Join.NewJoinKey()
	if err != nil {
		s.failCode(w, http.StatusConflict, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, k)
}

func (s *Server) handleJoinKeyState(w http.ResponseWriter, r *http.Request) {
	if !s.joinLocal(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, s.d.Join.JoinKeyState())
}

func (s *Server) handleWithdrawJoinKey(w http.ResponseWriter, r *http.Request) {
	if !s.joinLocal(w, r) {
		return
	}
	s.d.Join.WithdrawJoinKey()
	writeJSON(w, http.StatusOK, map[string]bool{"withdrawn": true})
}

// joinWait bounds one join: access from anywhere coming up here, the
// rendezvous, and the other computer pairing back through the relay.
const joinWait = 2 * time.Minute

// handleJoin uses a join key on this computer.
func (s *Server) handleJoin(w http.ResponseWriter, r *http.Request) {
	if !s.joinLocal(w, r) {
		return
	}
	var req struct {
		Key string `json:"key"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil || strings.TrimSpace(req.Key) == "" {
		s.failCode(w, http.StatusBadRequest, errors.New(`send {"key": "<the key the other computer shows>"}`))
		return
	}
	if _, err := remote.ParseJoinKey(req.Key); err != nil {
		s.failCode(w, http.StatusBadRequest, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), joinWait)
	defer cancel()
	res, err := s.d.Join.Join(ctx, req.Key)
	if err != nil {
		code := http.StatusBadGateway
		switch {
		case errors.Is(err, peers.ErrJoinGone):
			code = http.StatusNotFound
		case errors.Is(err, peers.ErrJoinRefused):
			code = http.StatusForbidden
		case errors.Is(err, context.DeadlineExceeded):
			code = http.StatusGatewayTimeout
		}
		s.failCode(w, code, err)
		return
	}
	s.devicesChanged()
	writeJSON(w, http.StatusOK, res)
}
