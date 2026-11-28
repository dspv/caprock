package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/dspv/caprock/internal/peers"
	"github.com/dspv/caprock/internal/serverscript"
)

// New server (ADR-109, .ai/26-server.md P1): Settings → Computers → Add a
// computer → New server → I'll create it myself, and `caprock machines
// server-script`. POST /v1/machines/server-script makes a join key with the
// server lifetime (60 minutes) and answers the setup script with that key
// inside; how the key stands is GET /v1/machines/join-key, as for any key.
// Loopback only, in the handler, and on no device's allowlist: a computer or
// phone paired here could otherwise mint a key that adds controllers.

// ServerScriptRequest is the route's body.
type ServerScriptRequest struct {
	// SSHKey: the user gave the provider an SSH key, or runs the script over
	// SSH. SSH then stays on, keys only; without it SSH is stopped.
	SSHKey bool `json:"ssh_key"`
}

// ServerScript is the route's answer: the key's state (never the key on its
// own: it is inside Script, and this answer is the only one that holds it).
type ServerScript struct {
	peers.JoinState
	Script string `json:"script"`
	// Version is the Caprock release the script installs, and Signed says
	// the script checks its minisign signature as well as its SHA-256.
	Version string `json:"version"`
	Signed  bool   `json:"signed"`
}

// ServerScripts makes setup scripts: the daemon's side.
type ServerScripts interface {
	NewServerScript(ctx context.Context, req ServerScriptRequest) (ServerScript, error)
	// NewServerSSH is I already have a server: the script with SSH kept on
	// (keys only), saved to a 0600 file until its key is spent, withdrawn
	// or expired, and the ssh command for this computer's terminal.
	NewServerSSH(ctx context.Context, t serverscript.SSHTarget) (ServerSSH, error)
}

// ServerSSH is POST /v1/machines/server-ssh's answer. The script itself is
// not in it: it is in the file the command reads.
type ServerSSH struct {
	peers.JoinState
	// Command is typed into a terminal tab here and not run: the user's own
	// ssh, which asks for its password or key in that terminal.
	Command string `json:"command"`
	// OS is this computer's, whose shell Command is spelled for.
	OS      string `json:"os"`
	Version string `json:"version"`
	Signed  bool   `json:"signed"`
	// Home is the folder the terminal tab opens in.
	Home string `json:"home,omitempty"`
}

// Errors a script maker tells apart.
var (
	// ErrNoRelease: the release to install could not be read (GitHub
	// unreachable, or no checksums for it).
	ErrNoRelease = errors.New("could not read the release to install")
)

// serverScriptWait bounds reading the release's checksums.
const serverScriptWait = 30 * time.Second

func (s *Server) handleServerScript(w http.ResponseWriter, r *http.Request) {
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errors.New("computers are linked from the machine Caprock runs on"))
		return
	}
	if s.d.Servers == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("this build cannot make a server's setup script"))
		return
	}
	var req ServerScriptRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		s.failCode(w, http.StatusBadRequest, errors.New(`send {"ssh_key": true|false}`))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), serverScriptWait)
	defer cancel()
	out, err := s.d.Servers.NewServerScript(ctx, req)
	if err != nil {
		code := http.StatusConflict
		if errors.Is(err, ErrNoRelease) {
			code = http.StatusBadGateway
		}
		s.failCode(w, code, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, out)
}

// handleServerSSH is POST /v1/machines/server-ssh {address, user, port?}: I
// already have a server. Loopback only and on no device's allowlist, as the
// script's route.
func (s *Server) handleServerSSH(w http.ResponseWriter, r *http.Request) {
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errors.New("computers are linked from the machine Caprock runs on"))
		return
	}
	if s.d.Servers == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("this build cannot set up a server"))
		return
	}
	var t serverscript.SSHTarget
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&t); err != nil {
		s.failCode(w, http.StatusBadRequest, errors.New(`send {"address": "<IP or host>", "user": "root", "port"?: 22}`))
		return
	}
	if err := t.Check(); err != nil {
		s.failCode(w, http.StatusBadRequest, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), serverScriptWait)
	defer cancel()
	out, err := s.d.Servers.NewServerSSH(ctx, t)
	if err != nil {
		code := http.StatusConflict
		if errors.Is(err, ErrNoRelease) {
			code = http.StatusBadGateway
		}
		s.failCode(w, code, err)
		return
	}
	out.Home = homeRoot()
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, out)
}
