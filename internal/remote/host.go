package remote

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// viaHeader marks every request the channel replays onto loopback. Its
// presence is what makes the daemon's gate treat the request as coming off
// the network (api.forwarded), so a phone gets exactly a paired device's
// rights — never the owner's.
const viaHeader = "1.1 caprock-remote"

// State is where the connection to the relay stands, for the pairing panel.
type State struct {
	// Status is "off", "connecting", "online" or "offline".
	Status string `json:"status"`
	// Error says why the last attempt failed, when it did.
	Error string `json:"error,omitempty"`
	// Phones is how many phones are connected through the relay now.
	Phones int `json:"phones"`
	// Since is when Status last changed.
	Since time.Time `json:"since"`
}

// Options configure a Host.
type Options struct {
	Relay string // wss://… the relay to wait at
	Keys  *Keys
	// Local is this daemon's loopback base URL, http://127.0.0.1:<port>.
	Local   string
	Version string
	Name    string // what the phone calls this machine
	Log     *slog.Logger
	// Client is the HTTP client requests are replayed with. nil means one
	// with no timeout (a long-poll or a large download is the caller's to
	// cancel) and no proxy: loopback is never proxied.
	Client *http.Client
}

// Host keeps this machine connected to a relay and serves the phones that
// reach it there.
type Host struct {
	opt Options
	log *slog.Logger

	mu    sync.Mutex
	state State
}

// NewHost makes a host; Run connects it.
func NewHost(opt Options) *Host {
	if opt.Log == nil {
		opt.Log = slog.New(slog.DiscardHandler)
	}
	if opt.Client == nil {
		opt.Client = &http.Client{Transport: &http.Transport{Proxy: nil, DisableCompression: true}}
	}
	return &Host{opt: opt, log: opt.Log, state: State{Status: "connecting", Since: time.Now()}}
}

// State reports the connection's state.
func (h *Host) State() State {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.state
}

func (h *Host) setState(status, errText string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.state.Status != status {
		h.state.Since = time.Now()
	}
	h.state.Status, h.state.Error = status, errText
}

func (h *Host) addPhones(n int) {
	h.mu.Lock()
	h.state.Phones += n
	h.mu.Unlock()
}

// Run stays connected until ctx ends, reconnecting with backoff: a laptop
// sleeps, Wi-Fi drops, the relay restarts, and none of those should need
// anyone to touch the machine.
func (h *Host) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		start := time.Now()
		err := h.session(ctx)
		if ctx.Err() != nil {
			break
		}
		msg := "the relay closed the connection"
		if err != nil {
			msg = err.Error()
		}
		h.setState("offline", msg)
		h.log.Warn("relay connection lost", "component", "remote", "err", msg)
		if time.Since(start) > time.Minute {
			backoff = time.Second // it was up a while; this is a new outage
		}
		select {
		case <-ctx.Done():
		case <-time.After(backoff):
		}
		if backoff < time.Minute {
			backoff *= 2
		}
	}
	h.setState("off", "")
}

// relayConn is one connection to the relay, shared by every phone on it.
type relayConn struct {
	c *websocket.Conn
	// ctx is the connection's own: it ends when the connection does.
	ctx context.Context
	wmu sync.Mutex
}

// send writes one frame for a phone. ctx is that phone's: once it has ended
// the frame is not sent, but it never bounds the write itself. The WebSocket
// library closes the whole connection when a write's context ends part-way,
// and the connection is every phone's: a phone hanging up mid-answer (a
// reload, a page put away) took the machine off the relay for all of them,
// and the next phone to arrive was handed the old one's bytes (2026-10-14).
func (r *relayConn) send(ctx context.Context, kind byte, conn uint32, data []byte) error {
	r.wmu.Lock()
	defer r.wmu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	wctx, cancel := context.WithTimeout(r.ctx, 30*time.Second)
	defer cancel()
	return r.c.Write(wctx, websocket.MessageBinary, Frame(kind, conn, data))
}

func (h *Host) session(ctx context.Context) error {
	h.setState("connecting", "")
	dctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	id := h.opt.Keys.HostID()
	c, _, err := websocket.Dial(dctx, strings.TrimRight(h.opt.Relay, "/")+"/v1/host/"+id, nil)
	if err != nil {
		return fmt.Errorf("could not reach the relay: %w", err)
	}
	c.SetReadLimit(MaxRelayMessage)
	defer func() { _ = c.CloseNow() }()

	_, msg, err := c.Read(dctx)
	if err != nil {
		return fmt.Errorf("the relay did not challenge: %w", err)
	}
	kind, _, nonce, err := ParseFrame(msg)
	if err != nil || kind != FrameChallenge || len(nonce) != 32 {
		return errors.New("the relay sent something other than a challenge")
	}
	sig := ed25519.Sign(h.opt.Keys.Sign, ProofMessage(id, nonce))
	if err := c.Write(dctx, websocket.MessageBinary, Frame(FrameProof, 0, sig)); err != nil {
		return err
	}
	_, msg, err = c.Read(dctx)
	if err != nil {
		return fmt.Errorf("the relay refused this machine: %w", err)
	}
	if kind, _, _, err := ParseFrame(msg); err != nil || kind != FrameReady {
		return errors.New("the relay refused this machine")
	}
	cancel()

	h.setState("online", "")
	h.log.Info("reachable through the relay", "component", "remote", "relay", h.opt.Relay)

	sctx, stop := context.WithCancel(ctx)
	defer stop()
	rc := &relayConn{c: c, ctx: sctx}
	var heard atomic.Int64
	heard.Store(time.Now().UnixNano())
	go h.keepalive(sctx, rc, &heard, stop)

	phones := map[uint32]*phone{}
	defer func() {
		for _, p := range phones {
			p.close()
		}
		h.addPhones(-len(phones))
	}()
	for {
		typ, msg, err := c.Read(sctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		heard.Store(time.Now().UnixNano())
		if typ == websocket.MessageText {
			continue // "pong"
		}
		kind, conn, data, err := ParseFrame(msg)
		if err != nil {
			continue
		}
		switch kind {
		case FrameOpen:
			if old := phones[conn]; old != nil {
				old.close()
			} else {
				h.addPhones(1)
			}
			phones[conn] = h.newPhone(sctx, rc, conn)
		case FrameData:
			if p := phones[conn]; p != nil {
				p.receive(data)
			}
		case FrameClose:
			if p := phones[conn]; p != nil {
				p.close()
				delete(phones, conn)
				h.addPhones(-1)
			}
		}
	}
}

// keepalive pings the relay and hangs up when it stops answering: a TCP
// connection through a NAT that has forgotten it looks open for hours.
func (h *Host) keepalive(ctx context.Context, rc *relayConn, heard *atomic.Int64, stop func()) {
	t := time.NewTicker(25 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if time.Since(time.Unix(0, heard.Load())) > 75*time.Second {
			h.log.Warn("the relay stopped answering", "component", "remote")
			stop()
			return
		}
		rc.wmu.Lock()
		wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		_ = rc.c.Write(wctx, websocket.MessageText, []byte("ping"))
		cancel()
		rc.wmu.Unlock()
	}
}

// phone is one phone's channel.
type phone struct {
	h    *Host
	rc   *relayConn
	conn uint32
	ctx  context.Context
	stop context.CancelFunc

	// in is the phone's frames in order; one goroutine decrypts and
	// dispatches them so the relay's read loop never waits on a phone.
	in chan []byte

	smu  sync.Mutex // orders encrypt-and-send, so nonces reach the wire in order
	sess *Session

	mu      sync.Mutex
	streams map[uint32]*stream
}

type stream struct {
	ctx    context.Context
	cancel context.CancelFunc
	body   bytes.Buffer // a request's body, until KindReqEnd
	head   *reqHead
	ws     *websocket.Conn
	part   bytes.Buffer // a WebSocket message from the phone, until its last part
}

func (h *Host) newPhone(ctx context.Context, rc *relayConn, conn uint32) *phone {
	pctx, stop := context.WithCancel(ctx)
	p := &phone{h: h, rc: rc, conn: conn, ctx: pctx, stop: stop, in: make(chan []byte, 256), streams: map[uint32]*stream{}}
	go p.loop()
	return p
}

func (p *phone) receive(data []byte) {
	select {
	case p.in <- data:
	case <-p.ctx.Done():
	default:
		// A phone sending faster than this machine can answer is dropped
		// rather than allowed to fill memory; it reconnects.
		p.h.log.Warn("a phone sent faster than it could be served; dropping it", "component", "remote")
		p.hangUp()
	}
}

func (p *phone) close() {
	p.stop()
	p.mu.Lock()
	for id, s := range p.streams {
		s.cancel()
		if s.ws != nil {
			_ = s.ws.CloseNow()
		}
		delete(p.streams, id)
	}
	p.mu.Unlock()
}

// hangUp drops the phone and tells the relay so.
func (p *phone) hangUp() {
	p.close()
	_ = p.rc.send(context.Background(), FrameClose, p.conn, nil)
}

func (p *phone) loop() {
	for {
		var msg []byte
		select {
		case <-p.ctx.Done():
			return
		case msg = <-p.in:
		}
		if p.sess == nil {
			if err := p.handshake(msg); err != nil {
				p.h.log.Info("a phone's handshake failed", "component", "remote", "err", err)
				p.hangUp()
				return
			}
			continue
		}
		pt, err := p.sess.Decrypt(msg)
		if err != nil {
			p.h.log.Warn("a phone's message failed to decrypt; dropping it", "component", "remote")
			p.hangUp()
			return
		}
		kind, id, body, err := ParseFrame(pt)
		if err != nil {
			continue
		}
		p.dispatch(kind, id, body)
	}
}

func (p *phone) handshake(msg1 []byte) error {
	welcome, _ := json.Marshal(Welcome{V: ProtocolVersion, Version: p.h.opt.Version, Name: p.h.opt.Name})
	reply, payload, sess, err := Respond(p.h.opt.Keys.Static, msg1, welcome, nil)
	if err != nil {
		return err
	}
	var hello Hello
	if err := json.Unmarshal(payload, &hello); err != nil || hello.V < 1 {
		return errors.New("the phone's hello is not one this daemon reads")
	}
	p.sess = sess
	return p.rc.send(p.ctx, FrameData, p.conn, reply)
}

// send encrypts one frame and sends it, in order.
func (p *phone) send(kind byte, id uint32, body []byte) error {
	p.smu.Lock()
	defer p.smu.Unlock()
	ct, err := p.sess.Encrypt(Frame(kind, id, body))
	if err != nil {
		return err
	}
	return p.rc.send(p.ctx, FrameData, p.conn, ct)
}

func (p *phone) sendJSON(kind byte, id uint32, v any) error {
	b, _ := json.Marshal(v)
	return p.send(kind, id, b)
}

func (p *phone) dispatch(kind byte, id uint32, body []byte) {
	p.mu.Lock()
	s := p.streams[id]
	p.mu.Unlock()

	switch kind {
	case KindReq, KindWSOpen:
		if s != nil {
			return // a stream id is used once
		}
		p.mu.Lock()
		if len(p.streams) >= maxStreams {
			p.mu.Unlock()
			if kind == KindReq {
				_ = p.sendJSON(KindRes, id, resHead{Status: http.StatusTooManyRequests})
				_ = p.send(KindResEnd, id, nil)
			} else {
				_ = p.sendJSON(KindWSClose, id, wsClose{Code: 1013, Reason: "too many open streams"})
			}
			return
		}
		ctx, cancel := context.WithCancel(p.ctx)
		s = &stream{ctx: ctx, cancel: cancel}
		p.streams[id] = s
		p.mu.Unlock()
		if kind == KindReq {
			var head reqHead
			if err := json.Unmarshal(body, &head); err != nil || !validPath(head.Path) {
				p.finish(id)
				_ = p.sendJSON(KindRes, id, resHead{Status: http.StatusBadRequest})
				_ = p.send(KindResEnd, id, nil)
				return
			}
			s.head = &head
			return
		}
		var open wsOpen
		if err := json.Unmarshal(body, &open); err != nil || !validPath(open.Path) {
			p.finish(id)
			_ = p.sendJSON(KindWSClose, id, wsClose{Code: 1008, Reason: "bad path"})
			return
		}
		go p.openWS(ctx, id, s, open)
	case KindReqBody:
		if s == nil || s.head == nil {
			return
		}
		if s.body.Len()+len(body) > maxRequestBody {
			p.finish(id)
			_ = p.sendJSON(KindRes, id, resHead{Status: http.StatusRequestEntityTooLarge})
			_ = p.send(KindResEnd, id, nil)
			return
		}
		s.body.Write(body)
	case KindReqEnd:
		if s == nil || s.head == nil {
			return
		}
		head, reqBody := *s.head, append([]byte(nil), s.body.Bytes()...)
		s.head, s.body = nil, bytes.Buffer{}
		go p.serveHTTP(s.ctx, id, head, reqBody)
	case KindWSPart, KindWSText, KindWSBinary:
		ws := p.socket(s)
		if ws == nil {
			return
		}
		if s.part.Len()+len(body) > maxWSMessage {
			p.finish(id)
			_ = p.sendJSON(KindWSClose, id, wsClose{Code: 1009, Reason: "message too big"})
			return
		}
		s.part.Write(body)
		if kind == KindWSPart {
			return
		}
		typ := websocket.MessageText
		if kind == KindWSBinary {
			typ = websocket.MessageBinary
		}
		msg := append([]byte(nil), s.part.Bytes()...)
		s.part.Reset()
		wctx, cancel := context.WithTimeout(p.ctx, 30*time.Second)
		err := ws.Write(wctx, typ, msg)
		cancel()
		if err != nil {
			p.finish(id)
		}
	case KindWSClose:
		if ws := p.socket(s); ws != nil {
			var cl wsClose
			_ = json.Unmarshal(body, &cl)
			code := websocket.StatusNormalClosure
			if cl.Code >= 1000 && cl.Code < 5000 {
				code = websocket.StatusCode(cl.Code)
			}
			_ = ws.Close(code, cl.Reason)
		}
		p.finish(id)
	case KindCancel:
		p.finish(id)
	}
}

// socket is s's WebSocket once openWS has set it.
func (p *phone) socket(s *stream) *websocket.Conn {
	if s == nil {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return s.ws
}

// finish forgets a stream and stops whatever it was doing.
func (p *phone) finish(id uint32) {
	p.mu.Lock()
	s := p.streams[id]
	delete(p.streams, id)
	p.mu.Unlock()
	if s == nil {
		return
	}
	s.cancel()
	if ws := p.socket(s); ws != nil {
		_ = ws.CloseNow()
	}
}

// validPath admits the daemon's own paths and nothing that could make the
// replayed request leave loopback.
func validPath(p string) bool {
	return strings.HasPrefix(p, "/") && !strings.HasPrefix(p, "//") && !strings.ContainsAny(p, " \r\n\\")
}

func (p *phone) serveHTTP(ctx context.Context, id uint32, head reqHead, body []byte) {
	defer p.finish(id)
	var rd io.Reader
	if len(body) > 0 {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, head.Method, p.h.opt.Local+head.Path, rd)
	if err != nil {
		_ = p.sendJSON(KindRes, id, resHead{Status: http.StatusBadRequest})
		_ = p.send(KindResEnd, id, nil)
		return
	}
	for k, v := range head.Headers {
		if ck := http.CanonicalHeaderKey(k); requestHeaders[ck] {
			req.Header.Set(ck, v)
		}
	}
	req.Header.Set("Via", viaHeader)
	res, err := p.h.opt.Client.Do(req)
	if err != nil {
		if ctx.Err() == nil {
			_ = p.sendJSON(KindRes, id, resHead{Status: http.StatusBadGateway})
			_ = p.send(KindResEnd, id, nil)
		}
		return
	}
	defer res.Body.Close()
	hdr := map[string]string{}
	for k, vs := range res.Header {
		if !hopHeaders[k] && len(vs) > 0 {
			hdr[k] = strings.Join(vs, ", ")
		}
	}
	if err := p.sendJSON(KindRes, id, resHead{Status: res.StatusCode, Headers: hdr}); err != nil {
		return
	}
	buf := make([]byte, chunk)
	for {
		n, err := res.Body.Read(buf)
		if n > 0 {
			if p.send(KindResBody, id, buf[:n]) != nil {
				return
			}
		}
		if err != nil {
			break
		}
	}
	_ = p.send(KindResEnd, id, nil)
}

func (p *phone) openWS(ctx context.Context, id uint32, s *stream, open wsOpen) {
	u := "ws" + strings.TrimPrefix(p.h.opt.Local, "http") + open.Path
	hdr := http.Header{}
	hdr.Set("Via", viaHeader)
	c, res, err := websocket.Dial(ctx, u, &websocket.DialOptions{
		HTTPHeader:   hdr,
		Subprotocols: open.Protocols,
		HTTPClient:   p.h.opt.Client,
	})
	if err != nil {
		code := 1011
		if res != nil && res.StatusCode >= 400 {
			// 4401 for 401 and so on: the phone tells "not paired" from
			// "this machine is down" without parsing a reason string.
			code = 4000 + res.StatusCode
		}
		_ = p.sendJSON(KindWSClose, id, wsClose{Code: code, Reason: "could not open"})
		p.finish(id)
		return
	}
	c.SetReadLimit(maxWSMessage)
	p.mu.Lock()
	if p.streams[id] != s {
		p.mu.Unlock()
		_ = c.CloseNow()
		return
	}
	s.ws = c
	p.mu.Unlock()
	if err := p.sendJSON(KindWSOpened, id, wsOpened{Protocol: c.Subprotocol()}); err != nil {
		p.finish(id)
		return
	}
	for {
		typ, msg, err := c.Read(ctx)
		if err != nil {
			cl := wsClose{Code: 1006}
			if st := websocket.CloseStatus(err); st != -1 {
				cl.Code = int(st)
			}
			if ctx.Err() == nil {
				_ = p.sendJSON(KindWSClose, id, cl)
			}
			p.finish(id)
			return
		}
		last := KindWSText
		if typ == websocket.MessageBinary {
			last = KindWSBinary
		}
		for len(msg) > chunk {
			if p.send(KindWSPart, id, msg[:chunk]) != nil {
				return
			}
			msg = msg[chunk:]
		}
		if p.send(last, id, msg) != nil {
			return
		}
	}
}
