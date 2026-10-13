// Package relaysrv is a relay a phone and a daemon meet at (ADR-058).
//
// It is the reference for the hosted one (relay/ at the repository root, a
// Cloudflare Worker) and runs as `caprock relay serve` for anyone who would
// rather the bytes crossed a machine of their own. It splices; it does not
// read. What passes through is Noise ciphertext between a phone and a daemon
// that share no secret with it, so the only trust it is given is to forward
// promptly and to let a machine register only with its own key.
package relaysrv

import (
	"context"
	"crypto/rand"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/dspv/caprock/internal/remote"
)

// Limits. Generous for one person's phones and the occasional tablet, and
// small enough that one machine id cannot hold the relay's memory hostage.
const (
	MaxPhonesPerHost = 32
	proofTimeout     = 10 * time.Second
	writeTimeout     = 15 * time.Second
)

// Server is an http.Handler serving /v1/host/<id>, /v1/c/<id> and /healthz.
type Server struct {
	Log *slog.Logger

	mu    sync.Mutex
	hosts map[string]*host
}

// New makes an empty relay.
func New(log *slog.Logger) *Server {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Server{Log: log, hosts: map[string]*host{}}
}

type host struct {
	id   string
	conn *websocket.Conn
	wmu  sync.Mutex // one writer at a time on conn

	mu     sync.Mutex
	phones map[uint32]*websocket.Conn
	next   uint32
}

func (h *host) write(ctx context.Context, b []byte) error {
	h.wmu.Lock()
	defer h.wmu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return h.conn.Write(ctx, websocket.MessageBinary, b)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/healthz":
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok\n"))
	case strings.HasPrefix(r.URL.Path, "/v1/host/"):
		s.serveHost(w, r, strings.TrimPrefix(r.URL.Path, "/v1/host/"))
	case strings.HasPrefix(r.URL.Path, "/v1/c/"):
		s.servePhone(w, r, strings.TrimPrefix(r.URL.Path, "/v1/c/"))
	default:
		http.NotFound(w, r)
	}
}

// accept takes the WebSocket. Any origin: a phone's page is served from
// wherever its owner chose, and nothing here is worth a cross-site request —
// every byte is encrypted end to end.
func accept(w http.ResponseWriter, r *http.Request) (*websocket.Conn, error) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return nil, err
	}
	c.SetReadLimit(remote.MaxRelayMessage)
	return c, nil
}

func (s *Server) serveHost(w http.ResponseWriter, r *http.Request, id string) {
	if _, err := remote.ParseHostID(id); err != nil {
		http.Error(w, "not a host id", http.StatusBadRequest)
		return
	}
	c, err := accept(w, r)
	if err != nil {
		return
	}
	ctx := r.Context()

	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		c.Close(websocket.StatusInternalError, "")
		return
	}
	pctx, cancel := context.WithTimeout(ctx, proofTimeout)
	err = c.Write(pctx, websocket.MessageBinary, remote.Frame(remote.FrameChallenge, 0, nonce))
	var msg []byte
	if err == nil {
		_, msg, err = c.Read(pctx)
	}
	cancel()
	if err != nil {
		c.Close(websocket.StatusPolicyViolation, "no proof")
		return
	}
	kind, _, sig, err := remote.ParseFrame(msg)
	if err != nil || kind != remote.FrameProof || !remote.VerifyProof(id, nonce, sig) {
		c.Close(websocket.StatusPolicyViolation, "bad proof")
		return
	}

	h := &host{id: id, conn: c, phones: map[uint32]*websocket.Conn{}}
	s.mu.Lock()
	old := s.hosts[id]
	s.hosts[id] = h
	s.mu.Unlock()
	if old != nil {
		old.conn.Close(remote.CloseReplaced, "the machine connected again")
	}
	if err := h.write(ctx, remote.Frame(remote.FrameReady, 0, nil)); err != nil {
		s.dropHost(h)
		return
	}
	s.Log.Info("machine connected", "component", "relay", "host", short(id))
	defer s.dropHost(h)

	for {
		typ, msg, err := c.Read(ctx)
		if err != nil {
			return
		}
		if typ == websocket.MessageText {
			if string(msg) == "ping" {
				h.wmu.Lock()
				_ = c.Write(ctx, websocket.MessageText, []byte("pong"))
				h.wmu.Unlock()
			}
			continue
		}
		kind, conn, data, err := remote.ParseFrame(msg)
		if err != nil {
			continue
		}
		h.mu.Lock()
		p := h.phones[conn]
		if kind == remote.FrameClose {
			delete(h.phones, conn)
		}
		h.mu.Unlock()
		if p == nil {
			continue
		}
		switch kind {
		case remote.FrameData:
			wctx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := p.Write(wctx, websocket.MessageBinary, data)
			cancel()
			if err != nil {
				p.Close(websocket.StatusGoingAway, "")
			}
		case remote.FrameClose:
			p.Close(websocket.StatusNormalClosure, "")
		}
	}
}

// dropHost forgets h if it is still the registered connection for its id,
// and hangs up its phones: with the machine gone there is nobody to talk to.
func (s *Server) dropHost(h *host) {
	s.mu.Lock()
	if s.hosts[h.id] == h {
		delete(s.hosts, h.id)
	}
	s.mu.Unlock()
	h.conn.Close(websocket.StatusGoingAway, "")
	h.mu.Lock()
	phones := h.phones
	h.phones = map[uint32]*websocket.Conn{}
	h.mu.Unlock()
	for _, p := range phones {
		p.Close(remote.CloseOffline, "the machine disconnected")
	}
	s.Log.Info("machine disconnected", "component", "relay", "host", short(h.id))
}

func (s *Server) servePhone(w http.ResponseWriter, r *http.Request, id string) {
	if _, err := remote.ParseHostID(id); err != nil {
		http.Error(w, "not a host id", http.StatusBadRequest)
		return
	}
	c, err := accept(w, r)
	if err != nil {
		return
	}
	ctx := r.Context()
	s.mu.Lock()
	h := s.hosts[id]
	s.mu.Unlock()
	if h == nil {
		c.Close(remote.CloseOffline, "the machine is not connected")
		return
	}
	h.mu.Lock()
	if len(h.phones) >= MaxPhonesPerHost {
		h.mu.Unlock()
		c.Close(websocket.StatusTryAgainLater, "too many connections to this machine")
		return
	}
	h.next++
	conn := h.next
	h.phones[conn] = c
	h.mu.Unlock()

	hangUp := func() {
		h.mu.Lock()
		_, mine := h.phones[conn]
		delete(h.phones, conn)
		h.mu.Unlock()
		if mine {
			_ = h.write(context.Background(), remote.Frame(remote.FrameClose, conn, nil))
		}
	}
	defer hangUp()
	if err := h.write(ctx, remote.Frame(remote.FrameOpen, conn, nil)); err != nil {
		c.Close(remote.CloseOffline, "the machine is not connected")
		return
	}
	for {
		typ, msg, err := c.Read(ctx)
		if err != nil {
			return
		}
		if typ == websocket.MessageText {
			if string(msg) == "ping" {
				_ = c.Write(ctx, websocket.MessageText, []byte("pong"))
			}
			continue
		}
		if err := h.write(ctx, remote.Frame(remote.FrameData, conn, msg)); err != nil {
			c.Close(remote.CloseOffline, "the machine is not connected")
			return
		}
	}
}

// short is enough of a host id to tell machines apart in a log without
// writing out the whole key.
func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}
