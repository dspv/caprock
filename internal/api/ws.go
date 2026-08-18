package api

import (
	"context"
	"log/slog"
	"net/http"
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
}

func newWSHub(b *bus.Bus, log *slog.Logger) *wsHub {
	return &wsHub{bus: b, log: log, conns: map[*websocket.Conn]context.CancelFunc{}}
}

// helloFrame is the first frame every client receives.
type helloFrame struct {
	ServerTime int64 `json:"server_time"`
}

func (h *wsHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Same-origin only: the dashboard is served by this daemon. Vite dev on
		// :5173 proxies /v1 so the origin is still localhost.
		OriginPatterns: []string{"localhost:*", "127.0.0.1:*", "[::1]:*"},
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
		// Reader: typed input → PTY.
		go func() {
			for {
				typ, data, err := c.Read(ctx)
				if err != nil {
					cctx()
					return
				}
				if typ == websocket.MessageBinary || typ == websocket.MessageText {
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
