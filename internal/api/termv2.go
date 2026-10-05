package api

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/dspv/caprock/internal/termbuf"
)

// Terminal protocol v2 (.ai/21-app.md § Terminal protocol v2; the contract is
// in .ai/03-contracts.md). Version 1 replays a snapshot on every connect and
// carries no positions, so a reconnect repaints the screen and a keystroke
// sent into a dying socket is either lost or, on retry, typed twice. Here
// every output byte has an offset and every input frame a sequence number.
const (
	// TermV2Protocol is the subprotocol a client asks for v2 with.
	TermV2Protocol = "caprock.term.v2"
	// termPingEvery is how often each side says it is alive.
	termPingEvery = 10 * time.Second
	// termDeadAfter is the silence after which a socket is taken for dead.
	termDeadAfter = 25 * time.Second
	// termAckEvery is the longest an applied input waits for its ack.
	termAckEvery = 100 * time.Millisecond
	// termWriteTimeout bounds one write to a slow client. Past it the socket
	// is closed and the client resumes from its offset.
	termWriteTimeout = 10 * time.Second
)

// TermStream is an owned session's terminal as protocol v2 sees it.
type TermStream interface {
	// Ring is the session's output with offsets.
	Ring() *termbuf.Ring
	// Done is closed when the process exits.
	Done() <-chan struct{}
	// Exited reports the exit code once Done is closed.
	Exited() (int, bool)
	// InputSeq types data unless the client's seq was applied already, and
	// returns the client's last applied sequence (seq 0: only ask).
	InputSeq(client string, seq uint64, data []byte) (uint64, error)
}

// termV2Source is an AgentController that can serve protocol v2.
type termV2Source interface {
	TermV2(sessionID string) (TermStream, bool)
}

var termClientID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// wantsTermV2 reports whether the handshake asks for protocol v2.
func wantsTermV2(r *http.Request) bool {
	for _, p := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
		if strings.TrimSpace(p) == TermV2Protocol {
			return true
		}
	}
	return false
}

type termHello struct {
	V      int    `json:"v"`
	Offset uint64 `json:"offset"`
	Reset  bool   `json:"reset"`
	Ack    uint64 `json:"ack"`
}

// termControl is a text frame from the client.
type termControl struct {
	Resize *struct {
		Cols int `json:"cols"`
		Rows int `json:"rows"`
	} `json:"resize"`
	Ping *int64 `json:"ping"`
	Pong *int64 `json:"pong"`
}

// outputFrame is a binary frame: the 8-byte big-endian offset of its first
// byte, then the bytes.
func outputFrame(offset uint64, data []byte) []byte {
	b := make([]byte, 8, 8+len(data))
	binary.BigEndian.PutUint64(b, offset)
	return append(b, data...)
}

// serveTermV2 is serveTerm for a client that negotiated caprock.term.v2.
func (h *wsHub) serveTermV2(s *Server, src termV2Source, w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	ts, ok := src.TermV2(id)
	if !ok {
		http.Error(w, "session is not owned by caprock", http.StatusConflict)
		return
	}
	q := r.URL.Query()
	client := q.Get("client")
	if client != "" && !termClientID.MatchString(client) {
		http.Error(w, "client must match [A-Za-z0-9_-]{1,64}", http.StatusBadRequest)
		return
	}
	var since *uint64
	if v := q.Get("since"); v != "" {
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			http.Error(w, "since must be a byte offset", http.StatusBadRequest)
			return
		}
		since = &n
	}
	// Only v2 is echoed: a device token, when sent alongside, has already
	// been checked by the gate, and a browser needs no echo of it.
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.origins(), Subprotocols: []string{TermV2Protocol}})
	if err != nil {
		return
	}
	var devTok string
	if deviceFrom(r) != nil {
		devTok = deviceTokenOf(r)
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	defer func() { _ = c.CloseNow() }()
	c.SetReadLimit(1 << 20)

	t := &termConn{c: c, ctx: ctx}
	t.heard.Store(time.Now().UnixNano())
	var ack uint64
	if client != "" {
		ack, _ = ts.InputSeq(client, 0, nil)
	}
	t.acked.Store(ack)
	t.sentAck = ack

	ring := ts.Ring()
	changed := ring.Changed()
	hello := termHello{V: 2, Ack: ack}
	var first []byte
	if since != nil {
		if data, ok := ring.Since(*since); ok {
			hello.Offset, first = *since, data
		}
	}
	if first == nil {
		snap, total := ring.SnapshotAt()
		hello.Offset, hello.Reset, first = total, true, snap
	}
	if t.text(map[string]termHello{"hello": hello}) != nil {
		return
	}
	pos := hello.Offset
	if len(first) > 0 && t.binary(outputFrame(pos, first)) != nil {
		return
	}
	if !hello.Reset {
		pos += uint64(len(first))
	}

	go t.read(s, id, client, ts, devTok, cancel)

	ping := time.NewTicker(termPingEvery)
	defer ping.Stop()
	ackTick := time.NewTicker(termAckEvery)
	defer ackTick.Stop()
	for {
		exited := false
		select {
		case <-ctx.Done():
			return
		case <-ping.C:
			if time.Since(time.Unix(0, t.heard.Load())) > termDeadAfter {
				return
			}
			if t.text(map[string]int64{"ping": time.Now().UnixMilli()}) != nil {
				return
			}
			continue
		case <-ackTick.C:
			if a := t.acked.Load(); a > t.sentAck {
				if t.text(map[string]uint64{"ack": a}) != nil {
					return
				}
				t.sentAck = a
			}
			continue
		case <-changed:
		case <-ts.Done():
			exited = true
		}
		changed = ring.Changed()
		data, ok := ring.Since(pos)
		switch {
		case !ok:
			// The client fell further behind than the ring reaches, or the
			// ring was restored under it. It costs this client a repaint and
			// nobody else anything.
			snap, total := ring.SnapshotAt()
			if t.text(map[string]map[string]uint64{"reset": {"offset": total}}) != nil || t.binary(outputFrame(total, snap)) != nil {
				return
			}
			pos = total
		case len(data) > 0:
			if t.binary(outputFrame(pos, data)) != nil {
				return
			}
			pos += uint64(len(data))
		}
		if exited {
			if a := t.acked.Load(); a > t.sentAck {
				_ = t.text(map[string]uint64{"ack": a})
			}
			code, _ := ts.Exited()
			_ = t.text(map[string]map[string]int{"exit": {"code": code}})
			_ = c.Close(websocket.StatusNormalClosure, "session ended")
			return
		}
	}
}

// termConn is one v2 socket.
type termConn struct {
	c   *websocket.Conn
	ctx context.Context
	// heard is when the client last sent anything, in Unix nanoseconds.
	heard atomic.Int64
	// acked is the client's last applied input sequence; sentAck the last
	// one told to the client (main loop only).
	acked   atomic.Uint64
	sentAck uint64
}

func (t *termConn) text(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(t.ctx, termWriteTimeout)
	defer cancel()
	return t.c.Write(ctx, websocket.MessageText, b)
}

func (t *termConn) binary(b []byte) error {
	ctx, cancel := context.WithTimeout(t.ctx, termWriteTimeout)
	defer cancel()
	return t.c.Write(ctx, websocket.MessageBinary, b)
}

// read takes the client's frames: binary is input (a 4-byte big-endian
// sequence number, then the bytes), text is control.
func (t *termConn) read(s *Server, id, client string, ts TermStream, devTok string, cancel context.CancelFunc) {
	defer cancel()
	for {
		typ, data, err := t.c.Read(t.ctx)
		if err != nil {
			return
		}
		t.heard.Store(time.Now().UnixNano())
		if devTok != "" && !s.stillControls(devTok) {
			_ = t.c.Close(websocket.StatusPolicyViolation, "this device can no longer control sessions")
			return
		}
		switch typ {
		case websocket.MessageBinary:
			if len(data) < 4 {
				continue
			}
			seq, input := uint64(binary.BigEndian.Uint32(data[:4])), data[4:]
			if client == "" {
				// Nothing to number against: typed as it comes, as in v1.
				_ = s.d.Agents.Write(id, input)
				continue
			}
			last, err := ts.InputSeq(client, seq, input)
			if err != nil {
				// Not known to be typed. Closing makes the client reconnect
				// and resend it; the sequence keeps that from doubling it.
				s.d.Log.Warn("terminal input not applied; asking the client to resend", "component", "api", "session_id", id, "err", err)
				_ = t.c.Close(websocket.StatusInternalError, "input not applied; reconnect and resend")
				return
			}
			for {
				cur := t.acked.Load()
				if last <= cur || t.acked.CompareAndSwap(cur, last) {
					break
				}
			}
		case websocket.MessageText:
			var m termControl
			if json.Unmarshal(data, &m) != nil {
				continue
			}
			if m.Resize != nil && m.Resize.Cols > 0 && m.Resize.Rows > 0 {
				_ = s.d.Agents.Resize(id, m.Resize.Cols, m.Resize.Rows)
			}
			if m.Ping != nil {
				_ = t.text(map[string]int64{"pong": *m.Ping})
			}
		}
	}
}
