package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/dspv/caprock/internal/bus"
)

// wsHub bridges the in-process bus to WebSocket clients on /v1/live.
type wsHub struct {
	bus *bus.Bus
	log *slog.Logger

	mu    sync.Mutex
	conns map[*websocket.Conn]context.CancelFunc
	// lanHost is the one private address this daemon answers on, or "". It
	// changes when LAN access is switched on from the dashboard, and every
	// handshake reads it, so it is guarded by mu with the connections.
	lanHost string
}

func newWSHub(b *bus.Bus, log *slog.Logger, lanHost string) *wsHub {
	return &wsHub{bus: b, log: log, conns: map[*websocket.Conn]context.CancelFunc{}, lanHost: lanHost}
}

// helloFrame is the first frame every client receives.
type helloFrame struct {
	ServerTime int64 `json:"server_time"`
}

func (h *wsHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Same-origin only: the dashboard is served by this daemon. Vite dev on
	// :5173 proxies /v1 so the origin is still localhost. A LAN listener adds
	// exactly one more origin — the address it was told to bind.
	origins := []string{"localhost:*", "127.0.0.1:*", "[::1]:*"}
	h.mu.Lock()
	lanHost := h.lanHost
	h.mu.Unlock()
	if lanHost != "" {
		origins = append(origins, lanHost+":*")
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: origins,
		// A device token arrives as a subprotocol, because a browser's
		// WebSocket constructor cannot set headers and this is the only field
		// it can carry. The token is echoed back as the negotiated protocol,
		// which is what the API requires of a server that accepts one.
		Subprotocols: subprotocolsFor(r),
	})
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	h.mu.Lock()
	h.conns[c] = cancel
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.conns, c)
		h.mu.Unlock()
		cancel()
		_ = c.CloseNow()
	}()
	c.SetReadLimit(64 << 10)
	sub := h.bus.Subscribe(1024)
	defer sub.Unsubscribe()

	if err := writeFrame(ctx, c, bus.Frame{Type: "hello", Data: helloFrame{ServerTime: time.Now().UnixMilli()}}); err != nil {
		return
	}
	// Drain client messages (we ignore them) so pings/close frames are processed.
	go func() {
		for {
			if _, _, err := c.Read(ctx); err != nil {
				cancel()
				return
			}
		}
	}()
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case f, ok := <-sub.C:
			if !ok {
				return
			}
			if err := writeFrame(ctx, c, f); err != nil {
				return
			}
		case <-ping.C:
			pctx, pcancel := context.WithTimeout(ctx, 5*time.Second)
			err := c.Ping(pctx)
			pcancel()
			if err != nil {
				return
			}
		}
	}
}

func writeFrame(ctx context.Context, c *websocket.Conn, f bus.Frame) error {
	b, err := f.Marshal()
	if err != nil {
		return err
	}
	wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return c.Write(wctx, websocket.MessageText, b)
}

// Close terminates all live connections.
func (h *wsHub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c, cancel := range h.conns {
		cancel()
		_ = c.Close(websocket.StatusGoingAway, "daemon shutting down")
	}
}

// serveTerm bridges an owned session's PTY to a bidirectional WebSocket for
// xterm.js: binary frames both ways, snapshot on connect, closes when the
// process exits. Returns 501 when the session is not owned / spawning is off.
func (h *wsHub) serveTerm(s *Server) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.d.Agents == nil || !s.d.Agents.Available() {
			http.Error(w, "spawning unavailable", http.StatusNotImplemented)
			return
		}
		id := r.PathValue("id")
		snapshot, sub, cancel, ok := s.d.Agents.Term(id)
		if !ok {
			http.Error(w, "session is not owned by caprock", http.StatusConflict)
			return
		}
		defer cancel()
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"localhost:*", "127.0.0.1:*", "[::1]:*"}})
		if err != nil {
			return
		}
		ctx, cctx := context.WithCancel(r.Context())
		defer cctx()
		defer func() { _ = c.CloseNow() }()
		c.SetReadLimit(1 << 20)
		if len(snapshot) > 0 {
			wctx, wc := context.WithTimeout(ctx, 5*time.Second)
			_ = c.Write(wctx, websocket.MessageBinary, snapshot)
			wc()
		}
		// Reader: typed input → PTY, and control messages → the PTY's size.
		//
		// Two frame types, because the socket has to carry two different
		// things and everything arriving on it used to be treated as
		// keystrokes. Binary is input, byte for byte. Text is a control
		// message — today only `{"resize":{"cols":N,"rows":N}}`.
		//
		// Without this the PTY kept whatever size it was born with, 120x40 by
		// default, for its whole life. Claude Code draws its menus to the
		// terminal's size, so on any window that was not exactly 120x40 the
		// interface was laid out for a screen the user did not have — arrow
		// keys moved a selection that was off-screen, which is what "only
		// Enter works" looks like from the outside.
		go func() {
			for {
				typ, data, err := c.Read(ctx)
				if err != nil {
					cctx()
					return
				}
				switch typ {
				case websocket.MessageBinary:
					_ = s.d.Agents.Write(id, data)
				case websocket.MessageText:
					// A control message, or — from a client that predates
					// this — typed input. Anything that is not valid control
					// JSON is written through, so an older dashboard against
					// a newer daemon keeps working rather than going mute.
					var msg struct {
						Resize *struct {
							Cols int `json:"cols"`
							Rows int `json:"rows"`
						} `json:"resize"`
					}
					if err := json.Unmarshal(data, &msg); err == nil && msg.Resize != nil {
						if msg.Resize.Cols > 0 && msg.Resize.Rows > 0 {
							_ = s.d.Agents.Resize(id, msg.Resize.Cols, msg.Resize.Rows)
						}
						continue
					}
					_ = s.d.Agents.Write(id, data)
				}
			}
		}()
		for {
			select {
			case <-ctx.Done():
				return
			case chunk, ok := <-sub:
				if !ok {
					_ = c.Close(websocket.StatusNormalClosure, "session ended")
					return
				}
				wctx, wc := context.WithTimeout(ctx, 5*time.Second)
				err := c.Write(wctx, websocket.MessageBinary, chunk)
				wc()
				if err != nil {
					return
				}
			}
		}
	}
}

// subprotocolsFor lists the protocols this handshake may negotiate.
//
// The browser sends `caprock.device.<token>` when it has one. Echoing it back
// completes the handshake; the token itself was already checked by the gate in
// ServeHTTP, which runs before this handler and refuses an unpaired device.
func subprotocolsFor(r *http.Request) []string {
	for _, p := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
		if p = strings.TrimSpace(p); strings.HasPrefix(p, "caprock.device.") {
			return []string{p}
		}
	}
	return nil
}

// setLANHost updates the origin the handshake admits, when LAN access is
// switched on or off while the daemon runs.
func (h *wsHub) setLANHost(host string) {
	h.mu.Lock()
	h.lanHost = host
	h.mu.Unlock()
}
