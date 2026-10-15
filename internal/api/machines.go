package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httputil"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/dspv/caprock/internal/peers"
	"github.com/dspv/caprock/internal/remote"
)

// Other computers (ADR-067), the controller's side: the computers this
// machine reaches, and a proxy that carries the dashboard's requests and
// sockets to one of them.
//
// The dashboard and the app only ever talk to their own daemon; this daemon
// holds the channel and the token, and the request arrives on the other
// computer as the device it paired as there, with the role its owner gave it.
//
// Everything here is loopback-only, enforced in the handlers, and on no
// device allowlist (lanauth.go), so access is not transitive: a phone paired
// with this machine never reaches the other computer through it.

// Machines is internal/peers' Manager, as the API uses it.
type Machines interface {
	List() []peers.Status
	Get(id string) (peers.Status, error)
	Check(ctx context.Context, id string) (peers.Status, error)
	Pair(ctx context.Context, link string) (peers.Status, error)
	Rename(id, name string) error
	// Leave asks computer id to drop this machine's token there (DELETE
	// /v1/pair/me), best effort.
	Leave(ctx context.Context, id string) error
	Forget(id string) error
	Do(id string, req *http.Request) (*http.Response, error)
	OpenWS(ctx context.Context, id, path string, protocols []string) (MachineSocket, error)
}

// MachineSocket is a WebSocket on another computer's API (remote.WSConn).
type MachineSocket interface {
	Read(ctx context.Context) (websocket.MessageType, []byte, error)
	Write(ctx context.Context, typ websocket.MessageType, msg []byte) error
	Close(code websocket.StatusCode, reason string) error
	Subprotocol() string
}

// machinesLocal refuses anything but this machine's own clients. True when
// the request may go on.
func (s *Server) machinesLocal(w http.ResponseWriter, r *http.Request) bool {
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errors.New("other computers are reached from the machine Caprock runs on"))
		return false
	}
	if s.d.Machines == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("this build cannot reach other computers"))
		return false
	}
	return true
}

// machineCheckWait bounds GET /v1/machines?check=1: each computer is asked
// at once, and one that does not answer in time is listed as it stood.
const machineCheckWait = 12 * time.Second

// handleMachines lists the computers this machine reaches. ?check=1 asks
// each one first (GET /v1/pair/me through its channel), so the list says
// online, pending, revoked or why not.
func (s *Server) handleMachines(w http.ResponseWriter, r *http.Request) {
	if !s.machinesLocal(w, r) {
		return
	}
	if r.URL.Query().Get("check") == "1" {
		ctx, cancel := context.WithTimeout(r.Context(), machineCheckWait)
		var wg sync.WaitGroup
		for _, m := range s.d.Machines.List() {
			wg.Add(1)
			go func(id string) {
				defer wg.Done()
				_, _ = s.d.Machines.Check(ctx, id)
			}(m.ID)
		}
		wg.Wait()
		cancel()
	}
	list := s.d.Machines.List()
	if list == nil {
		list = []peers.Status{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"machines": list})
}

// machinePairWait bounds one pairing: the relay, the handshake, the code.
const machinePairWait = 60 * time.Second

// handleAddMachine pairs with the computer a pasted link names.
func (s *Server) handleAddMachine(w http.ResponseWriter, r *http.Request) {
	if !s.machinesLocal(w, r) {
		return
	}
	var req struct {
		Link string `json:"link"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil || strings.TrimSpace(req.Link) == "" {
		s.failCode(w, http.StatusBadRequest, errors.New(`send {"link": "<the link the other computer shows>"}`))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), machinePairWait)
	defer cancel()
	st, err := s.d.Machines.Pair(ctx, req.Link)
	if err != nil {
		writeJSON(w, machineErrStatus(err), map[string]string{"error": err.Error()})
		return
	}
	s.d.Log.Info("paired with another computer", "component", "api", "machine", st.ID, "name", st.Name, "status", st.Status)
	writeJSON(w, http.StatusOK, st)
}

// handlePatchMachine renames a computer here; the computer is not told.
func (s *Server) handlePatchMachine(w http.ResponseWriter, r *http.Request) {
	if !s.machinesLocal(w, r) {
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		s.failCode(w, http.StatusBadRequest, errors.New(`send {"name": "…"}`))
		return
	}
	id := r.PathValue("id")
	if err := s.d.Machines.Rename(id, req.Name); err != nil {
		writeJSON(w, machineErrStatus(err), map[string]string{"error": err.Error()})
		return
	}
	st, err := s.d.Machines.Get(id)
	if err != nil {
		writeJSON(w, machineErrStatus(err), map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// machineLeaveWait bounds Forget's courtesy call to the other computer.
const machineLeaveWait = 10 * time.Second

// handleForgetMachine deletes a computer and its token here, after asking it,
// best effort, to drop this machine too (DELETE /v1/pair/me). An offline
// computer still lists this machine until its owner removes it there; the
// token it knows is gone from here either way.
func (s *Server) handleForgetMachine(w http.ResponseWriter, r *http.Request) {
	if !s.machinesLocal(w, r) {
		return
	}
	id := r.PathValue("id")
	if _, err := s.d.Machines.Get(id); err != nil {
		writeJSON(w, machineErrStatus(err), map[string]string{"error": err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), machineLeaveWait)
	released := s.d.Machines.Leave(ctx, id) == nil
	cancel()
	if err := s.d.Machines.Forget(id); err != nil {
		writeJSON(w, machineErrStatus(err), map[string]string{"error": err.Error()})
		return
	}
	s.d.Log.Info("forgot another computer", "component", "api", "machine", id, "released", released)
	writeJSON(w, http.StatusOK, map[string]bool{"forgotten": true, "released": released})
}

// machineErrStatus is the status an error from internal/peers answers with.
func machineErrStatus(err error) int {
	switch {
	case errors.Is(err, peers.ErrUnknown):
		return http.StatusNotFound
	case errors.Is(err, peers.ErrNotAccepting):
		return http.StatusConflict
	case errors.Is(err, remote.ErrMachineOffline), errors.Is(err, remote.ErrRelayUnreachable):
		return http.StatusServiceUnavailable
	case errors.Is(err, remote.ErrRefused):
		return http.StatusBadGateway
	case errors.Is(err, context.DeadlineExceeded):
		return http.StatusGatewayTimeout
	case errors.Is(err, peers.ErrBadCode), errors.Is(err, peers.ErrNoCode), errors.Is(err, peers.ErrSelf):
		return http.StatusBadRequest
	}
	if errors.Is(err, peers.ErrBadLink) {
		return http.StatusBadRequest
	}
	return http.StatusBadGateway
}

// errRevoked is a computer whose owner removed this machine there.
var errRevoked = errors.New("that computer removed this one: pair again there to reach it")

// handleMachineProxy carries a request or a socket to computer id:
// /v1/m/{id}/v1/sessions is that computer's GET /v1/sessions, as this
// machine's paired device there. HTTP goes through a ReverseProxy standing on
// the channel; a WebSocket is bridged message by message, and the device
// subprotocol that carries this machine's token there is never echoed to the
// local caller.
func (s *Server) handleMachineProxy(w http.ResponseWriter, r *http.Request) {
	if !s.machinesLocal(w, r) {
		return
	}
	id := r.PathValue("id")
	path := "/" + r.PathValue("path")
	if !strings.HasPrefix(path, "/v1/") && path != "/healthz" {
		s.failCode(w, http.StatusNotFound, errors.New("only the other computer's API is reached through this"))
		return
	}
	st, err := s.d.Machines.Get(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such computer"})
		return
	}
	if st.Status == peers.StatusRevoked {
		// Asked again rather than believed: a computer that was wrong about
		// it comes back by itself (ADR-067).
		ctx, cancel := context.WithTimeout(r.Context(), machineLeaveWait)
		st, _ = s.d.Machines.Check(ctx, id)
		cancel()
		if st.Status == peers.StatusRevoked {
			machineFail(w, errRevoked)
			return
		}
	}
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		s.bridgeMachineSocket(w, r, id, path)
		return
	}
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Path, pr.Out.URL.RawPath = path, ""
			pr.Out.URL.RawQuery = r.URL.RawQuery
			// What identifies the caller here goes no further (peers.Do
			// strips the same; this keeps the proxy honest on its own).
			for k := range pr.Out.Header {
				if k == "Cookie" || k == "Origin" || k == "Referer" || k == "Authorization" || strings.HasPrefix(k, "Sec-") {
					pr.Out.Header.Del(k)
				}
			}
		},
		Transport: machineTransport{m: s.d.Machines, id: id},
		// Streamed as it arrives: a long answer is not held here.
		FlushInterval: -1,
		ModifyResponse: func(res *http.Response) error {
			if res.StatusCode != http.StatusUnauthorized {
				return nil
			}
			// The computer does not know this machine's token: ask it once,
			// through a channel only it can speak on, and say so plainly.
			ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), machineLeaveWait)
			defer cancel()
			if st, _ := s.d.Machines.Check(ctx, id); st.Status == peers.StatusRevoked {
				_ = res.Body.Close()
				return errRevoked
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) { machineFail(w, err) },
	}
	rp.ServeHTTP(w, r)
}

// machineFail answers a request the other computer could not take, with the
// computer's state: offline (and why), refused, revoked.
func machineFail(w http.ResponseWriter, err error) {
	status, state := machineErrStatus(err), "error"
	switch {
	case errors.Is(err, errRevoked):
		status, state = http.StatusForbidden, peers.StatusRevoked
	case errors.Is(err, remote.ErrMachineOffline), errors.Is(err, remote.ErrRelayUnreachable):
		state = "offline"
	case errors.Is(err, remote.ErrRefused):
		state = "refused"
	case errors.Is(err, peers.ErrUnknown):
		state = "unknown"
	case errors.Is(err, context.Canceled):
		return // the caller left
	}
	writeJSON(w, status, map[string]string{"error": err.Error(), "status": state})
}

// machineTransport carries one request to computer id.
type machineTransport struct {
	m  Machines
	id string
}

func (t machineTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return t.m.Do(t.id, req)
}

// bridgeMachineSocket opens the socket on the other computer first — so a
// refusal there is answered here as the status it was — then accepts the
// local one and copies messages both ways until either side closes.
func (s *Server) bridgeMachineSocket(w http.ResponseWriter, r *http.Request, id, path string) {
	var protos []string
	for _, p := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
		p = strings.TrimSpace(p)
		if p != "" && !strings.HasPrefix(p, "caprock.device.") {
			protos = append(protos, p)
		}
	}
	if r.URL.RawQuery != "" {
		path += "?" + r.URL.RawQuery
	}
	octx, ocancel := context.WithTimeout(r.Context(), 30*time.Second)
	far, err := s.d.Machines.OpenWS(octx, id, path, protos)
	ocancel()
	if err != nil {
		var ce websocket.CloseError
		if errors.As(err, &ce) && ce.Code >= 4100 && ce.Code < 4600 {
			// 4000 plus the HTTP status the other computer refused with.
			code := int(ce.Code) - 4000
			if code == http.StatusUnauthorized {
				cctx, cancel := context.WithTimeout(r.Context(), machineLeaveWait)
				st, _ := s.d.Machines.Check(cctx, id)
				cancel()
				if st.Status == peers.StatusRevoked {
					machineFail(w, errRevoked)
					return
				}
			}
			writeJSON(w, code, map[string]string{"error": "the other computer refused the socket: " + ce.Reason, "status": "refused"})
			return
		}
		machineFail(w, err)
		return
	}
	var accept []string
	if p := far.Subprotocol(); p != "" && !strings.HasPrefix(p, "caprock.device.") {
		accept = []string{p}
	}
	near, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: s.ws.origins(), Subprotocols: accept})
	if err != nil {
		_ = far.Close(websocket.StatusGoingAway, "")
		return
	}
	near.SetReadLimit(1 << 20)
	ctx, cancel := context.WithCancel(context.WithoutCancel(r.Context()))
	defer cancel()
	done := make(chan struct{}, 2)
	// Here → there.
	go func() {
		defer func() { done <- struct{}{} }()
		for {
			typ, msg, err := near.Read(ctx)
			if err != nil {
				code, reason := closeOf(err)
				if code == 0 {
					code = websocket.StatusGoingAway
				}
				_ = far.Close(code, reason)
				return
			}
			if err := far.Write(ctx, typ, msg); err != nil {
				_ = near.Close(websocket.StatusGoingAway, "the other computer's socket closed")
				return
			}
		}
	}()
	// There → here.
	go func() {
		defer func() { done <- struct{}{} }()
		for {
			typ, msg, err := far.Read(ctx)
			if err != nil {
				code, reason := closeOf(err)
				if sendable(code) {
					_ = near.Close(code, reason)
				} else {
					// A dropped channel (1006) cannot be said in a close
					// frame; the local socket drops the same way.
					_ = near.CloseNow()
				}
				return
			}
			if err := near.Write(ctx, typ, msg); err != nil {
				_ = far.Close(websocket.StatusGoingAway, "")
				return
			}
		}
	}()
	<-done
	cancel()
	<-done
	_ = near.CloseNow()
}

// closeOf is the close code and reason an error from a socket carries; 0 for
// none.
func closeOf(err error) (websocket.StatusCode, string) {
	var ce websocket.CloseError
	if errors.As(err, &ce) {
		return ce.Code, ce.Reason
	}
	if errors.Is(err, io.EOF) {
		return websocket.StatusNormalClosure, ""
	}
	return 0, ""
}

// sendable reports whether code may travel in a close frame (RFC 6455 7.4).
func sendable(code websocket.StatusCode) bool {
	switch code {
	case 0, websocket.StatusNoStatusRcvd, websocket.StatusAbnormalClosure, websocket.StatusTLSHandshake:
		return false
	}
	return code >= 1000 && code < 5000
}
