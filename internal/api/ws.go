package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
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
	// Reset says a "reset" frame follows: the frames after the client's
	// since are gone (as the terminal's protocol v2 hello says).
	Reset bool `json:"reset"`
}

// liveControl is a text frame from a /v1/live client, as on the terminal's
// protocol v2: {"ping":t}, answered with a pong, or {"pong":t}.
type liveControl struct {
	Ping *int64 `json:"ping"`
}

// ServeHTTP serves /v1/live (.ai/03-contracts.md § Live socket, replay). Every frame
// carries a seq; a client that reconnects with ?since=<seq> gets the frames it
// missed, or a "reset" frame when the replay ring no longer holds them.
func (h *wsHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var since *uint64
	if v := r.URL.Query().Get("since"); v != "" {
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			http.Error(w, "since must be a frame seq", http.StatusBadRequest)
			return
		}
		since = &n
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: h.origins(),
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
	sub, missed, seq, resumed := h.bus.Resume(1024, since)
	defer sub.Unsubscribe()

	// The hello's seq is where the client stands: its own since when the
	// missed frames follow, else the newest frame.
	pos := seq
	if since != nil && resumed {
		pos = *since
	}
	if err := writeFrame(ctx, c, bus.Frame{Type: "hello", Seq: pos, Data: helloFrame{ServerTime: time.Now().UnixMilli(), Reset: !resumed}}); err != nil {
		return
	}
	if !resumed {
		if err := writeFrame(ctx, c, resetFrame(seq)); err != nil {
			return
		}
	}
	for _, f := range missed {
		if err := writeFrame(ctx, c, f); err != nil {
			return
		}
		pos = f.Seq
	}
	var heard atomic.Int64
	heard.Store(time.Now().UnixNano())
	pings := make(chan int64, 4)
	go readLive(ctx, c, &heard, pings, cancel)
	ping := time.NewTicker(termPingEvery)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case f, ok := <-sub.C:
			if !ok {
				return
			}
			if f.Seq <= pos {
				continue // already sent while filling a gap
			}
			frames := []bus.Frame{f}
			if f.Seq > pos+1 {
				frames = h.catchUp(pos)
			}
			for _, f := range frames {
				if err := writeFrame(ctx, c, f); err != nil {
					return
				}
				pos = f.Seq
			}
		case <-sub.Lagged():
			// This subscriber's buffer overflowed and the bus dropped frames
			// for it, maybe the newest ones, which no later frame would
			// reveal: catch up from the ring now.
			for _, f := range h.catchUp(pos) {
				if err := writeFrame(ctx, c, f); err != nil {
					return
				}
				pos = f.Seq
			}
		case t := <-pings:
			if err := writeFrame(ctx, c, bus.Frame{Type: "pong", Seq: pos, Data: t}); err != nil {
				return
			}
		case <-ping.C:
			if time.Since(time.Unix(0, heard.Load())) > termDeadAfter {
				return
			}
			if err := writeFrame(ctx, c, bus.Frame{Type: "ping", Seq: pos, Data: time.Now().UnixMilli()}); err != nil {
				return
			}
			// A client that predates the ping frame never answers it, but
			// every browser answers a protocol ping by itself.
			go func() {
				pctx, pcancel := context.WithTimeout(ctx, termDeadAfter)
				defer pcancel()
				if c.Ping(pctx) == nil {
					heard.Store(time.Now().UnixNano())
				}
			}()
		}
	}
}

// catchUp is every frame after pos from the ring, or a reset when the ring no
// longer holds them.
func (h *wsHub) catchUp(pos uint64) []bus.Frame {
	frames, newest, ok := h.bus.Since(pos)
	if !ok {
		return []bus.Frame{resetFrame(newest)}
	}
	return frames
}

// resetFrame tells a client the frames it asked for are gone: refetch, and
// continue from seq.
func resetFrame(seq uint64) bus.Frame {
	return bus.Frame{Type: "reset", Seq: seq, Data: map[string]uint64{"seq": seq}}
}

// readLive takes the client's frames: anything heard keeps the socket alive,
// and a ping is handed to the writer to answer with a pong.
func readLive(ctx context.Context, c *websocket.Conn, heard *atomic.Int64, pings chan<- int64, cancel context.CancelFunc) {
	defer cancel()
	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			return
		}
		heard.Store(time.Now().UnixNano())
		var m liveControl
		if typ != websocket.MessageText || json.Unmarshal(data, &m) != nil || m.Ping == nil {
			continue
		}
		select {
		case pings <- *m.Ping:
		default: // a flood of pings needs no answer to each
		}
	}
}

// origins are the browser origins a socket handshake admits. Same-origin
// only: the dashboard is served by this daemon. Vite dev on :5173 proxies /v1
// so the origin is still localhost. A LAN listener adds exactly one more
// origin — the address it was told to bind.
func (h *wsHub) origins() []string {
	origins := []string{"localhost:*", "127.0.0.1:*", "[::1]:*"}
	h.mu.Lock()
	lanHost := h.lanHost
	h.mu.Unlock()
	if lanHost != "" {
		origins = append(origins, lanHost+":*")
	}
	return origins
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
// A client that asks for caprock.term.v2 is served by serveTermV2; this is
// version 1, kept unchanged for clients that predate it.
func (h *wsHub) serveTerm(s *Server) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.d.Agents == nil || !s.d.Agents.Available() {
			http.Error(w, "spawning unavailable", http.StatusNotImplemented)
			return
		}
		if src, ok := s.d.Agents.(termV2Source); ok && wantsTermV2(r) {
			h.serveTermV2(s, src, w, r)
			return
		}
		id := r.PathValue("id")
		if s.refuseShellToDevice(w, r, id) {
			return
		}
		snapshot, sub, cancel, ok := s.d.Agents.Term(id)
		if !ok {
			http.Error(w, "session is not owned by caprock", http.StatusConflict)
			return
		}
		defer cancel()
		// A paired controller reaches this over the LAN address, with its
		// token as a subprotocol, as on /v1/live (ADR-034). The gate has
		// already refused every device that is not a controller.
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.origins(), Subprotocols: subprotocolsFor(r)})
		if err != nil {
			return
		}
		// Empty on the machine itself; a device's token otherwise, asked
		// about again before every frame it sends.
		var devTok string
		if deviceFrom(r) != nil {
			devTok = deviceTokenOf(r)
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
				if devTok != "" && !s.stillControls(devTok) {
					_ = c.Close(websocket.StatusPolicyViolation, "this device can no longer control sessions")
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
