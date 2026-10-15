package remote

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// The client side of the channel, in Go: this daemon reaching another
// machine's daemon through a relay (ADR-067), as a phone does (ADR-058). It is
// ui/src/remote/transport.ts again — one WebSocket to the relay, one Noise NK
// session inside it, many streams inside that — so the machine at the other
// end runs exactly the Host it runs for phones and needs nothing new: a
// request from here is replayed onto its loopback as a paired device, with
// that device's token and role.
//
// A Client connects on demand. The first request or socket dials; the channel
// stays up while a stream is open (a terminal can be open for hours) and
// closes after Idle with none, so a computer added and never looked at costs
// the relay nothing.

// Errors a caller tells apart. Each is wrapped with the detail.
var (
	// ErrMachineOffline means the relay holds no live connection from the
	// machine: asleep, off the internet, Caprock not running, or access from
	// anywhere switched off there.
	ErrMachineOffline = errors.New("the computer is offline")
	// ErrRelayUnreachable means the relay itself could not be reached, or
	// the connection to it dropped.
	ErrRelayUnreachable = errors.New("could not reach the relay")
	// ErrRefused means the machine hung up on the handshake: its key is not
	// the one the pairing link pinned (it was reset, or it is another
	// machine).
	ErrRefused = errors.New("the computer refused the connection")
	// ErrClientClosed is a Client after Close.
	ErrClientClosed = errors.New("the connection to this computer was closed")
)

// Client timings. Variables so tests can shorten them.
var (
	// ClientAttempt bounds one attempt, from dialling the relay to the
	// machine's handshake reply. The phone's ATTEMPT_MS.
	ClientAttempt = 10 * time.Second
	// ClientIdle is how long a channel with no open stream stays up.
	ClientIdle = 90 * time.Second
	// clientPing is how often an open channel pings the relay…
	clientPing = 25 * time.Second
	// …and clientSilent how long it may hear nothing before it is dropped.
	clientSilent = 60 * time.Second
	// clientBackoff is the first wait after a failed attempt; it doubles to
	// clientBackoffMax. Within it, a new request is answered with the last
	// failure at once rather than dialling again.
	clientBackoff    = time.Second
	clientBackoffMax = 30 * time.Second
)

// streamQueue bounds the frames waiting for one stream's reader. A reader
// that falls this far behind loses its stream rather than stalling every
// other stream on the channel, which share one read loop.
const streamQueue = 512

// Target is the machine a Client reaches: what a pairing link carries, less
// the code.
type Target struct {
	Relay  string // wss://… the relay the machine waits at
	HostID string // its Ed25519 public key, base64url (HostID)
	Key    string // its X25519 static key, base64url, pinned by the handshake
}

// PairInfo is a parsed pairing link.
type PairInfo struct {
	Target
	Code string // the six-digit code, when the link carries one
	Name string // what the machine calls itself, when it says
}

// ParsePairLink reads what PairLink writes: the phone's page with the relay,
// host id, key, code and name after "#/pair?". It also takes the part after
// the "?" alone, so a link pasted from a terminal that wrapped it, or typed
// from `caprock pair`, works. Everything is checked: a relay that is not
// wss:// (ws:// only to this machine), an id that is not a key, a key that is
// not 32 bytes.
func ParsePairLink(raw string) (*PairInfo, error) {
	s := strings.TrimSpace(raw)
	s = strings.Trim(s, "<>\"'")
	if i := strings.Index(s, "#/pair?"); i >= 0 {
		s = s[i+len("#/pair?"):]
	} else if i := strings.Index(s, "?"); i >= 0 {
		s = s[i+1:]
	}
	q, err := url.ParseQuery(s)
	if err != nil {
		return nil, errors.New("that is not a pairing link")
	}
	p := &PairInfo{
		Target: Target{Relay: q.Get("r"), HostID: q.Get("h"), Key: q.Get("k")},
		Code:   strings.TrimSpace(q.Get("c")),
		Name:   q.Get("n"),
	}
	if p.Relay == "" || p.HostID == "" || p.Key == "" {
		return nil, errors.New("that is not a pairing link: it needs the relay, the computer's id and its key")
	}
	if err := p.check(); err != nil {
		return nil, err
	}
	for _, r := range p.Code {
		if r < '0' || r > '9' {
			return nil, errors.New("the code in that link is not a number")
		}
	}
	return p, nil
}

func (t Target) check() error {
	if err := CheckRelayURL(t.Relay); err != nil {
		return err
	}
	if _, err := ParseHostID(t.HostID); err != nil {
		return fmt.Errorf("the computer's id: %w", err)
	}
	if _, err := t.staticKey(); err != nil {
		return err
	}
	return nil
}

func (t Target) staticKey() ([]byte, error) {
	k, err := base64.RawURLEncoding.DecodeString(t.Key)
	if err != nil || len(k) != 32 {
		return nil, errors.New("the computer's key is not a key")
	}
	return k, nil
}

// ClientOptions configure a Client.
type ClientOptions struct {
	Target
	Log *slog.Logger
	// HTTPClient dials the relay; nil is the default client.
	HTTPClient *http.Client
	// Idle overrides ClientIdle; zero keeps it.
	Idle time.Duration
}

// ClientState is where the channel to one machine stands.
type ClientState struct {
	// Status is "idle" (not connected, nothing wrong), "connecting",
	// "online", "offline" (the machine or the relay cannot be reached),
	// "refused" (the handshake was refused: the key does not match) or
	// "closed".
	Status string    `json:"status"`
	Error  string    `json:"error,omitempty"`
	Since  time.Time `json:"since"`
	// Version and Name are what the machine said in its last Welcome.
	Version string `json:"version,omitempty"`
	Name    string `json:"name,omitempty"`
	// Streams is how many requests and sockets are open on the channel.
	Streams int `json:"streams"`
	// Counters since the Client was made: relay messages and their bytes,
	// each way, so what a computer costs the relay is measured (OQ-14).
	MsgsOut  uint64 `json:"msgs_out"`
	MsgsIn   uint64 `json:"msgs_in"`
	BytesOut uint64 `json:"bytes_out"`
	BytesIn  uint64 `json:"bytes_in"`
}

// Client is a channel, opened on demand, to one machine.
type Client struct {
	opt  ClientOptions
	log  *slog.Logger
	key  []byte
	idle time.Duration

	msgsOut, msgsIn, bytesOut, bytesIn atomic.Uint64

	mu      sync.Mutex
	conn    *clientConn
	dialing chan struct{}
	state   ClientState
	lastErr error
	nextTry time.Time
	backoff time.Duration
	serial  uint64
	closed  bool
}

// NewClient makes a client for t; nothing is dialled until it is used.
func NewClient(opt ClientOptions) (*Client, error) {
	if err := opt.check(); err != nil {
		return nil, err
	}
	key, _ := opt.staticKey()
	if opt.Log == nil {
		opt.Log = slog.New(slog.DiscardHandler)
	}
	idle := opt.Idle
	if idle <= 0 {
		idle = ClientIdle
	}
	return &Client{opt: opt, log: opt.Log, key: key, idle: idle, state: ClientState{Status: "idle", Since: time.Now()}}, nil
}

// State reports the channel's state.
func (c *Client) State() ClientState {
	c.mu.Lock()
	st := c.state
	if c.conn != nil {
		st.Streams = c.conn.count()
	}
	c.mu.Unlock()
	st.MsgsOut, st.MsgsIn = c.msgsOut.Load(), c.msgsIn.Load()
	st.BytesOut, st.BytesIn = c.bytesOut.Load(), c.bytesIn.Load()
	return st
}

// Serial counts the channel's openings: two answers with different serials
// came on separate connections.
func (c *Client) Serial() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.serial
}

// Close hangs up and refuses further use.
func (c *Client) Close() {
	c.mu.Lock()
	c.closed = true
	cc := c.conn
	c.conn = nil
	c.setLocked("closed", "")
	c.mu.Unlock()
	if cc != nil {
		cc.shut(ErrClientClosed)
	}
}

// Retry forgets the backoff after a failure: the next request dials at once.
func (c *Client) Retry() {
	c.mu.Lock()
	c.nextTry = time.Time{}
	c.mu.Unlock()
}

func (c *Client) setLocked(status, errText string) {
	if c.state.Status != status {
		c.state.Since = time.Now()
	}
	c.state.Status, c.state.Error = status, errText
}

// ensure returns the open channel, dialling one when there is none. One dial
// at a time: callers arriving meanwhile wait for it.
func (c *Client) ensure(ctx context.Context) (*clientConn, error) {
	for {
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return nil, ErrClientClosed
		}
		if cc := c.conn; cc != nil && cc.ctx.Err() == nil {
			c.mu.Unlock()
			return cc, nil
		}
		if ch := c.dialing; ch != nil {
			c.mu.Unlock()
			select {
			case <-ch:
				// Whatever the attempt got, look again: a failure has set
				// nextTry, which answers this caller at once.
				c.mu.Lock()
				cc, err := c.conn, c.lastErr
				c.mu.Unlock()
				if cc == nil && err != nil {
					return nil, err
				}
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		if err := c.lastErr; err != nil && time.Now().Before(c.nextTry) {
			c.mu.Unlock()
			return nil, err
		}
		ch := make(chan struct{})
		c.dialing = ch
		c.setLocked("connecting", c.state.Error)
		c.mu.Unlock()

		// The attempt is not the first caller's: a request cancelled
		// part-way must not cost the others the channel.
		cc, err := c.dial()

		c.mu.Lock()
		c.dialing = nil
		close(ch)
		if err != nil {
			c.lastErr = err
			if c.backoff == 0 {
				c.backoff = clientBackoff
			} else if c.backoff < clientBackoffMax {
				c.backoff = min(c.backoff*2, clientBackoffMax)
			}
			c.nextTry = time.Now().Add(c.backoff)
			status := "offline"
			if errors.Is(err, ErrRefused) {
				status = "refused"
			}
			c.setLocked(status, err.Error())
			c.mu.Unlock()
			c.log.Info("could not reach a computer", "component", "remote", "host", short(c.opt.HostID), "err", err)
			return nil, err
		}
		if c.closed {
			c.mu.Unlock()
			cc.shut(ErrClientClosed)
			return nil, ErrClientClosed
		}
		c.serial++
		c.conn = cc
		c.lastErr, c.backoff, c.nextTry = nil, 0, time.Time{}
		c.state.Version, c.state.Name = cc.welcome.Version, cc.welcome.Name
		c.setLocked("online", "")
		c.mu.Unlock()
		go cc.run()
		return cc, nil
	}
}

func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// dial runs one attempt: the relay, the handshake, the Welcome.
func (c *Client) dial() (*clientConn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), ClientAttempt)
	defer cancel()
	u := strings.TrimRight(c.opt.Relay, "/") + "/v1/c/" + c.opt.HostID
	ws, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPClient: c.opt.HTTPClient})
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrRelayUnreachable, err)
	}
	ws.SetReadLimit(MaxRelayMessage)
	fail := func(err error) (*clientConn, error) {
		_ = ws.CloseNow()
		return nil, err
	}
	hello, _ := json.Marshal(Hello{V: ProtocolVersion})
	init, msg1, err := Initiate(c.key, hello, nil)
	if err != nil {
		return fail(err)
	}
	if err := ws.Write(ctx, websocket.MessageBinary, msg1); err != nil {
		return fail(readErr(err, false))
	}
	c.count(true, len(msg1))
	for {
		typ, msg, err := ws.Read(ctx)
		if err != nil {
			return fail(readErr(err, true))
		}
		c.count(false, len(msg))
		if typ == websocket.MessageText {
			continue // "pong"
		}
		// A message that does not finish the handshake is not trusted and
		// not a verdict either: the relay may hand over a frame meant for
		// whoever held this connection number before (ADR-058, amended
		// 2026-10-14). Try it on a copy, so the real reply still can.
		try := init.clone()
		payload, sess, err := try.Finish(msg)
		if err != nil {
			continue
		}
		var w Welcome
		if err := json.Unmarshal(payload, &w); err != nil || w.V < 1 {
			return fail(errors.New("the computer's welcome is not one this Caprock reads"))
		}
		cctx, stop := context.WithCancel(context.Background())
		cc := &clientConn{
			c: c, ws: ws, sess: sess, welcome: w, ctx: cctx, stop: stop,
			streams: map[uint32]*cstream{}, nextID: 1, lastActive: time.Now(),
		}
		cc.heard.Store(time.Now().UnixNano())
		return cc, nil
	}
}

// readErr says what a failed read or write on the relay connection means.
// reached is whether the relay took the connection and the handshake went
// out: a clean close then is the machine hanging up on it.
func readErr(err error, reached bool) error {
	switch st := websocket.CloseStatus(err); {
	case st == CloseOffline:
		return fmt.Errorf("%w (the relay has no connection from it)", ErrMachineOffline)
	case reached && st == websocket.StatusNormalClosure:
		return fmt.Errorf("%w: its key is not the one in the pairing link", ErrRefused)
	case errors.Is(err, context.DeadlineExceeded):
		return fmt.Errorf("%w: it did not answer", ErrMachineOffline)
	}
	return fmt.Errorf("%w: %w", ErrRelayUnreachable, err)
}

func (c *Client) count(out bool, n int) {
	if out {
		c.msgsOut.Add(1)
		c.bytesOut.Add(uint64(n))
		return
	}
	c.msgsIn.Add(1)
	c.bytesIn.Add(uint64(n))
}

// dropped is called once by a channel that ended.
func (c *Client) dropped(cc *clientConn, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn != cc {
		return
	}
	c.conn = nil
	switch {
	case c.closed:
	case err == nil:
		c.setLocked("idle", "")
	default:
		c.setLocked("offline", err.Error())
	}
}

// clientConn is one open channel.
type clientConn struct {
	c       *Client
	ws      *websocket.Conn
	sess    *Session
	welcome Welcome
	ctx     context.Context
	stop    context.CancelFunc
	heard   atomic.Int64

	smu sync.Mutex // orders encrypt-and-write, so nonces reach the wire in order

	mu         sync.Mutex
	streams    map[uint32]*cstream
	nextID     uint32
	lastActive time.Time
	err        error
	once       sync.Once
}

// cstream is one stream's inbox.
type cstream struct {
	in   chan cframe
	done chan struct{} // closed when the stream is dropped
	err  error         // why, set before done closes
	once sync.Once
}

type cframe struct {
	kind byte
	body []byte
}

func (s *cstream) drop(err error) {
	s.once.Do(func() {
		s.err = err
		close(s.done)
	})
}

func (cc *clientConn) count() int {
	cc.mu.Lock()
	defer cc.mu.Unlock()
	return len(cc.streams)
}

func (cc *clientConn) register() (uint32, *cstream, error) {
	cc.mu.Lock()
	defer cc.mu.Unlock()
	if cc.err != nil {
		return 0, nil, cc.err
	}
	if len(cc.streams) >= maxStreams {
		return 0, nil, errors.New("too many open requests to this computer")
	}
	// Odd ids, as the phone's: a later protocol may let the machine open
	// streams with even ones.
	id := cc.nextID
	cc.nextID += 2
	s := &cstream{in: make(chan cframe, streamQueue), done: make(chan struct{})}
	cc.streams[id] = s
	cc.lastActive = time.Now()
	return id, s, nil
}

func (cc *clientConn) release(id uint32) {
	cc.mu.Lock()
	if s := cc.streams[id]; s != nil {
		delete(cc.streams, id)
		s.drop(io.EOF)
	}
	cc.lastActive = time.Now()
	cc.mu.Unlock()
}

// send encrypts one frame and writes it, in order.
func (cc *clientConn) send(kind byte, id uint32, body []byte) error {
	cc.smu.Lock()
	defer cc.smu.Unlock()
	if err := cc.ctx.Err(); err != nil {
		return cc.failure()
	}
	ct, err := cc.sess.Encrypt(Frame(kind, id, body))
	if err != nil {
		return err
	}
	// Bounded by the channel's own context, never a caller's: the library
	// closes the whole connection when a write's context ends part-way,
	// which would cost every other stream (ADR-058, amended 2026-10-14).
	wctx, cancel := context.WithTimeout(cc.ctx, 30*time.Second)
	defer cancel()
	if err := cc.ws.Write(wctx, websocket.MessageBinary, ct); err != nil {
		cc.shut(fmt.Errorf("%w: %w", ErrRelayUnreachable, err))
		return cc.failure()
	}
	cc.c.count(true, len(ct))
	return nil
}

func (cc *clientConn) sendJSON(kind byte, id uint32, v any) error {
	b, _ := json.Marshal(v)
	return cc.send(kind, id, b)
}

// sendChunks sends body in frames of at most chunk, the last as last.
func (cc *clientConn) sendChunks(part, last byte, id uint32, body []byte) error {
	for len(body) > chunk {
		if err := cc.send(part, id, body[:chunk]); err != nil {
			return err
		}
		body = body[chunk:]
	}
	return cc.send(last, id, body)
}

func (cc *clientConn) failure() error {
	cc.mu.Lock()
	defer cc.mu.Unlock()
	if cc.err != nil {
		return cc.err
	}
	return fmt.Errorf("%w: the connection closed", ErrRelayUnreachable)
}

// shut ends the channel once: every stream is dropped with err and the relay
// connection is closed. err nil is an idle close. Closed at once, not with a
// close handshake: nothing reads the connection any more to complete one.
func (cc *clientConn) shut(err error) {
	cc.once.Do(func() {
		cc.mu.Lock()
		cc.err = err
		if cc.err == nil {
			cc.err = fmt.Errorf("%w: the connection closed", ErrRelayUnreachable)
		}
		streams := cc.streams
		cc.streams = map[uint32]*cstream{}
		cc.mu.Unlock()
		cc.stop()
		for _, s := range streams {
			s.drop(cc.err)
		}
		_ = cc.ws.CloseNow()
		cc.c.dropped(cc, err)
	})
}

// run reads the channel until it ends, and keeps it alive or lets it go.
func (cc *clientConn) run() {
	go cc.keepalive()
	for {
		typ, msg, err := cc.ws.Read(cc.ctx)
		if err != nil {
			if cc.ctx.Err() != nil {
				cc.shut(nil)
				return
			}
			cc.shut(readErr(err, false))
			return
		}
		cc.heard.Store(time.Now().UnixNano())
		cc.c.count(false, len(msg))
		if typ == websocket.MessageText {
			continue
		}
		pt, err := cc.sess.Decrypt(msg)
		if err != nil {
			// Altered, or not from the machine: nothing on this channel can
			// be trusted any more.
			cc.shut(errors.New("a message from the computer failed to decrypt"))
			return
		}
		kind, id, body, err := ParseFrame(pt)
		if err != nil {
			continue
		}
		cc.mu.Lock()
		s := cc.streams[id]
		cc.lastActive = time.Now()
		cc.mu.Unlock()
		if s == nil {
			continue
		}
		select {
		case s.in <- cframe{kind: kind, body: append([]byte(nil), body...)}:
		default:
			// The reader stopped reading: drop its stream, not the channel.
			cc.mu.Lock()
			delete(cc.streams, id)
			cc.mu.Unlock()
			s.drop(errors.New("the reader fell behind"))
			_ = cc.send(KindCancel, id, nil)
		}
	}
}

// keepalive pings the relay, drops a channel that has gone silent, and closes
// one that has been idle with no stream open.
func (cc *clientConn) keepalive() {
	tick := min(5*time.Second, cc.c.idle/4)
	if tick < 10*time.Millisecond {
		tick = 10 * time.Millisecond
	}
	t := time.NewTicker(tick)
	defer t.Stop()
	lastPing := time.Now()
	for {
		select {
		case <-cc.ctx.Done():
			return
		case <-t.C:
		}
		if time.Since(time.Unix(0, cc.heard.Load())) > clientSilent {
			cc.shut(fmt.Errorf("%w: the computer stopped answering", ErrMachineOffline))
			return
		}
		cc.mu.Lock()
		idle := len(cc.streams) == 0 && time.Since(cc.lastActive) > cc.c.idle
		cc.mu.Unlock()
		if idle {
			cc.shut(nil)
			return
		}
		if time.Since(lastPing) >= clientPing {
			lastPing = time.Now()
			cc.smu.Lock()
			wctx, cancel := context.WithTimeout(cc.ctx, 10*time.Second)
			if cc.ws.Write(wctx, websocket.MessageText, []byte("ping")) == nil {
				cc.c.count(true, 4)
			}
			cancel()
			cc.smu.Unlock()
		}
	}
}

// RoundTrip carries one HTTP request to the machine's own API and returns its
// answer, streamed: the body arrives as the machine sends it. It implements
// http.RoundTripper, so a ReverseProxy can stand on it.
//
// Only the request's path and query travel; the scheme and host are ignored.
// The machine passes on only the headers a phone may set (proto.go), so a
// caller's cookies or Origin never reach it.
func (c *Client) RoundTrip(req *http.Request) (*http.Response, error) {
	ctx := req.Context()
	var body []byte
	if req.Body != nil {
		b, err := io.ReadAll(io.LimitReader(req.Body, maxRequestBody+1))
		_ = req.Body.Close()
		if err != nil {
			return nil, err
		}
		if len(b) > maxRequestBody {
			return nil, errors.New("the request is too large to send to another computer")
		}
		body = b
	}
	cc, err := c.ensure(ctx)
	if err != nil {
		return nil, err
	}
	id, s, err := cc.register()
	if err != nil {
		return nil, err
	}
	hdr := map[string]string{}
	for k, vs := range req.Header {
		if ck := http.CanonicalHeaderKey(k); requestHeaders[ck] && len(vs) > 0 {
			hdr[ck] = strings.Join(vs, ", ")
		}
	}
	path := req.URL.EscapedPath()
	if path == "" {
		path = "/"
	}
	if req.URL.RawQuery != "" {
		path += "?" + req.URL.RawQuery
	}
	method := req.Method
	if method == "" {
		method = http.MethodGet
	}
	if err := cc.sendJSON(KindReq, id, reqHead{Method: method, Path: path, Headers: hdr}); err != nil {
		cc.release(id)
		return nil, err
	}
	for off := 0; off < len(body); off += chunk {
		if err := cc.send(KindReqBody, id, body[off:min(off+chunk, len(body))]); err != nil {
			cc.release(id)
			return nil, err
		}
	}
	if err := cc.send(KindReqEnd, id, nil); err != nil {
		cc.release(id)
		return nil, err
	}
	rb := &streamBody{cc: cc, id: id, s: s}
	stopCancel := context.AfterFunc(ctx, func() { rb.abort(ctx.Err()) })
	rb.mu.Lock()
	rb.stopWatch = stopCancel
	rb.mu.Unlock()
	for {
		select {
		case f := <-s.in:
			if f.kind != KindRes {
				continue
			}
			var head resHead
			if err := json.Unmarshal(f.body, &head); err != nil || head.Status < 100 {
				rb.abort(errors.New("the computer's answer is not one this Caprock reads"))
				return nil, errors.New("the computer's answer is not one this Caprock reads")
			}
			res := &http.Response{
				Status:        fmt.Sprintf("%d %s", head.Status, http.StatusText(head.Status)),
				StatusCode:    head.Status,
				Proto:         "HTTP/1.1",
				ProtoMajor:    1,
				ProtoMinor:    1,
				Header:        http.Header{},
				Body:          rb,
				ContentLength: -1,
				Request:       req,
			}
			for k, v := range head.Headers {
				res.Header.Set(k, v)
			}
			return res, nil
		case <-s.done:
			stopCancel()
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, s.err
		}
	}
}

// streamBody is a response body arriving over the channel.
type streamBody struct {
	cc        *clientConn
	id        uint32
	s         *cstream
	stopWatch func() bool
	buf       []byte
	eof       bool
	mu        sync.Mutex
	gone      bool
}

func (b *streamBody) Read(p []byte) (int, error) {
	for len(b.buf) == 0 {
		if b.eof {
			return 0, io.EOF
		}
		select {
		case f := <-b.s.in:
			switch f.kind {
			case KindResBody:
				b.buf = f.body
			case KindResEnd:
				b.eof = true
				b.finish()
			}
		case <-b.s.done:
			// Frames already queued come first.
			select {
			case f := <-b.s.in:
				switch f.kind {
				case KindResBody:
					b.buf = f.body
				case KindResEnd:
					b.eof = true
					b.finish()
				}
				continue
			default:
			}
			if errors.Is(b.s.err, io.EOF) {
				if b.eof {
					return 0, io.EOF
				}
				// Released without its end: never a short body read as whole.
				return 0, io.ErrUnexpectedEOF
			}
			return 0, b.s.err
		}
	}
	n := copy(p, b.buf)
	b.buf = b.buf[n:]
	return n, nil
}

// finish releases a stream that ended normally.
func (b *streamBody) finish() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.gone {
		return
	}
	b.gone = true
	if b.stopWatch != nil {
		b.stopWatch()
	}
	b.cc.release(b.id)
}

// abort gives up on the stream and tells the machine so.
func (b *streamBody) abort(err error) {
	b.mu.Lock()
	if b.gone {
		b.mu.Unlock()
		return
	}
	b.gone = true
	stop := b.stopWatch
	b.mu.Unlock()
	if stop != nil {
		stop()
	}
	_ = b.cc.send(KindCancel, b.id, nil)
	b.cc.mu.Lock()
	delete(b.cc.streams, b.id)
	b.cc.lastActive = time.Now()
	b.cc.mu.Unlock()
	b.s.drop(err)
}

// Close stops reading; an answer still arriving is cancelled.
func (b *streamBody) Close() error {
	b.abort(errors.New("the response body was closed"))
	return nil
}

// WSConn is a WebSocket on the machine's API, carried over the channel.
type WSConn struct {
	cc    *clientConn
	id    uint32
	s     *cstream
	proto string

	rmu  sync.Mutex
	part bytes.Buffer

	mu     sync.Mutex
	closed bool
}

// OpenWS opens a WebSocket at path (with its query) on the machine, offering
// protocols. It returns once the machine's socket is open, or the close the
// machine answered with (4000 plus the HTTP status for a refused upgrade, so
// 4401 is "not paired"), as a websocket.CloseError.
func (c *Client) OpenWS(ctx context.Context, path string, protocols []string) (*WSConn, error) {
	if !validPath(path) {
		return nil, errors.New("not a path on the computer's API")
	}
	cc, err := c.ensure(ctx)
	if err != nil {
		return nil, err
	}
	id, s, err := cc.register()
	if err != nil {
		return nil, err
	}
	if err := cc.sendJSON(KindWSOpen, id, wsOpen{Path: path, Protocols: protocols}); err != nil {
		cc.release(id)
		return nil, err
	}
	for {
		select {
		case f := <-s.in:
			switch f.kind {
			case KindWSOpened:
				var o wsOpened
				_ = json.Unmarshal(f.body, &o)
				return &WSConn{cc: cc, id: id, s: s, proto: o.Protocol}, nil
			case KindWSClose:
				cc.release(id)
				return nil, closeFrame(f.body)
			}
		case <-s.done:
			return nil, s.err
		case <-ctx.Done():
			_ = cc.send(KindCancel, id, nil)
			cc.release(id)
			return nil, ctx.Err()
		}
	}
}

func closeFrame(body []byte) websocket.CloseError {
	var cl wsClose
	_ = json.Unmarshal(body, &cl)
	if cl.Code == 0 {
		cl.Code = int(websocket.StatusAbnormalClosure)
	}
	return websocket.CloseError{Code: websocket.StatusCode(cl.Code), Reason: cl.Reason}
}

// Subprotocol is the protocol the machine's socket chose.
func (w *WSConn) Subprotocol() string { return w.proto }

// Read returns the next whole message. A close from the machine is a
// websocket.CloseError with its code (1008 when the role was taken away
// mid-session); the channel dropping is 1006.
func (w *WSConn) Read(ctx context.Context) (websocket.MessageType, []byte, error) {
	w.rmu.Lock()
	defer w.rmu.Unlock()
	for {
		var f cframe
		select {
		case f = <-w.s.in:
		case <-w.s.done:
			select {
			case f = <-w.s.in:
			default:
				return 0, nil, websocket.CloseError{Code: websocket.StatusAbnormalClosure, Reason: errText(w.s.err)}
			}
		case <-ctx.Done():
			return 0, nil, ctx.Err()
		}
		switch f.kind {
		case KindWSPart:
			if w.part.Len()+len(f.body) > maxWSMessage {
				_ = w.Close(websocket.StatusMessageTooBig, "message too big")
				return 0, nil, websocket.CloseError{Code: websocket.StatusMessageTooBig}
			}
			w.part.Write(f.body)
		case KindWSText, KindWSBinary:
			w.part.Write(f.body)
			msg := append([]byte(nil), w.part.Bytes()...)
			w.part.Reset()
			typ := websocket.MessageText
			if f.kind == KindWSBinary {
				typ = websocket.MessageBinary
			}
			return typ, msg, nil
		case KindWSClose:
			w.mu.Lock()
			w.closed = true
			w.mu.Unlock()
			w.cc.release(w.id)
			return 0, nil, closeFrame(f.body)
		}
	}
}

func errText(err error) string {
	if err == nil || errors.Is(err, io.EOF) {
		return ""
	}
	return err.Error()
}

// Write sends one message, in parts when it is larger than a frame.
func (w *WSConn) Write(_ context.Context, typ websocket.MessageType, msg []byte) error {
	w.mu.Lock()
	closed := w.closed
	w.mu.Unlock()
	if closed {
		return websocket.CloseError{Code: websocket.StatusNormalClosure}
	}
	last := KindWSText
	if typ == websocket.MessageBinary {
		last = KindWSBinary
	}
	return w.cc.sendChunks(KindWSPart, last, w.id, msg)
}

// Close closes the socket on the machine with code and reason.
func (w *WSConn) Close(code websocket.StatusCode, reason string) error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil
	}
	w.closed = true
	w.mu.Unlock()
	err := w.cc.sendJSON(KindWSClose, w.id, wsClose{Code: int(code), Reason: reason})
	w.cc.release(w.id)
	return err
}

// clone copies a handshake in progress, so a reply that fails to finish it
// leaves the original able to read the real one.
func (i *Initiator) clone() *Initiator {
	s := &symmetricState{ck: append([]byte(nil), i.s.ck...), h: append([]byte(nil), i.s.h...)}
	if i.s.k != nil {
		s.k = &cipherState{aead: i.s.k.aead, n: i.s.k.n}
	}
	return &Initiator{s: s, e: i.e}
}
