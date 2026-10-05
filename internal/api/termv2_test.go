// Terminal protocol v2: every output byte has an offset, every input frame a
// sequence number. These tests drive the socket with a session backed by a
// real termbuf ring, so offsets, resets and dedupe are the production ones.
package api

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/dspv/caprock/internal/termbuf"
)

// fakeTerm is a v2 session: a ring and an input table; with echo, what is
// typed comes back as output, as a terminal's line discipline does.
type fakeTerm struct {
	ring   *termbuf.Ring
	inputs *termbuf.Inputs
	echo   bool
	done   chan struct{}
	code   int

	mu    sync.Mutex
	typed []string
}

func newFakeTerm(size int) *fakeTerm {
	return &fakeTerm{ring: termbuf.NewRing(size), inputs: termbuf.NewInputs(termbuf.InputTTL), done: make(chan struct{})}
}

func (f *fakeTerm) Ring() *termbuf.Ring   { return f.ring }
func (f *fakeTerm) Done() <-chan struct{} { return f.done }
func (f *fakeTerm) Exited() (int, bool) {
	select {
	case <-f.done:
		return f.code, true
	default:
		return 0, false
	}
}

func (f *fakeTerm) InputSeq(client string, seq uint64, data []byte) (uint64, error) {
	return f.inputs.Apply(client, seq, func() error {
		f.mu.Lock()
		f.typed = append(f.typed, string(data))
		f.mu.Unlock()
		if f.echo {
			f.ring.Write(data)
		}
		return nil
	})
}

func (f *fakeTerm) typedNow() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.typed...)
}

// v2Agents is fakeAgents that can also serve protocol v2.
type v2Agents struct {
	*fakeAgents
	mu   sync.Mutex
	term TermStream
}

func (a *v2Agents) TermV2(string) (TermStream, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.term, a.term != nil
}

func (a *v2Agents) swap(t TermStream) {
	a.mu.Lock()
	a.term = t
	a.mu.Unlock()
}

func v2Server(t *testing.T, term TermStream) (*httptest.Server, *v2Agents) {
	t.Helper()
	e := newEnv(t)
	ag := &v2Agents{fakeAgents: &fakeAgents{avail: true, snapshot: []byte("V1SNAP"), termCh: make(chan []byte, 4)}, term: term}
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, Agents: ag})
	return e.srv, ag
}

// frame is one server frame, decoded.
type frame struct {
	text   map[string]json.RawMessage
	offset uint64
	data   []byte
}

func dialV2(ctx context.Context, t *testing.T, srv *httptest.Server, query string) *websocket.Conn {
	t.Helper()
	c, err := dialV2Err(ctx, srv, query)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func dialV2Err(ctx context.Context, srv *httptest.Server, query string) (*websocket.Conn, error) {
	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/v1/agents/s1/term" + query
	c, resp, err := websocket.Dial(ctx, u, &websocket.DialOptions{
		HTTPHeader:   http.Header{"Origin": {"http://localhost:5173"}},
		Subprotocols: []string{TermV2Protocol, "caprock.device.notatoken"},
	})
	if err != nil {
		return nil, err
	}
	if c.Subprotocol() != TermV2Protocol {
		_ = c.CloseNow()
		return nil, fmt.Errorf("negotiated %q; want %q (status %d)", c.Subprotocol(), TermV2Protocol, resp.StatusCode)
	}
	c.SetReadLimit(16 << 20)
	return c, nil
}

func readFrame(ctx context.Context, c *websocket.Conn) (frame, error) {
	typ, b, err := c.Read(ctx)
	if err != nil {
		return frame{}, err
	}
	if typ == websocket.MessageText {
		var m map[string]json.RawMessage
		if err := json.Unmarshal(b, &m); err != nil {
			return frame{}, err
		}
		return frame{text: m}, nil
	}
	if len(b) < 8 {
		return frame{}, fmt.Errorf("binary frame of %d bytes has no offset", len(b))
	}
	return frame{offset: binary.BigEndian.Uint64(b[:8]), data: b[8:]}, nil
}

func mustFrame(ctx context.Context, t *testing.T, c *websocket.Conn) frame {
	t.Helper()
	f, err := readFrame(ctx, c)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func mustHello(ctx context.Context, t *testing.T, c *websocket.Conn) termHello {
	t.Helper()
	f := mustFrame(ctx, t, c)
	var h termHello
	if f.text == nil || json.Unmarshal(f.text["hello"], &h) != nil || h.V != 2 {
		t.Fatalf("first frame is not a v2 hello: %+v", f)
	}
	return h
}

func input(seq uint32, s string) []byte {
	b := binary.BigEndian.AppendUint32(nil, seq)
	return append(b, s...)
}

func TestTermV2FreshClientGetsTheSnapshotThenOffsets(t *testing.T) {
	ft := newFakeTerm(1 << 10)
	ft.ring.Write([]byte("\x1b[?2004hhello"))
	srv, _ := v2Server(t, ft)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c := dialV2(ctx, t, srv, "")
	defer func() { _ = c.CloseNow() }()

	h := mustHello(ctx, t, c)
	if !h.Reset || h.Offset != 13 {
		t.Fatalf("hello = %+v; a fresh client gets reset at the end of the output", h)
	}
	snap := mustFrame(ctx, t, c)
	if snap.offset != 13 || !bytes.HasSuffix(snap.data, []byte("hello")) || !bytes.HasPrefix(snap.data, []byte("\x1b[?2004h")) {
		t.Fatalf("snapshot = %d %q", snap.offset, snap.data)
	}
	ft.ring.Write([]byte("more"))
	f := mustFrame(ctx, t, c)
	if f.offset != 13 || string(f.data) != "more" {
		t.Fatalf("stream = %d %q; want 13 \"more\"", f.offset, f.data)
	}
}

func TestTermV2ResumeInsideTheRingSendsExactlyTheMissingBytes(t *testing.T) {
	ft := newFakeTerm(1 << 10)
	ft.ring.Write([]byte("abcdef"))
	srv, _ := v2Server(t, ft)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c := dialV2(ctx, t, srv, "?since=2")
	defer func() { _ = c.CloseNow() }()
	h := mustHello(ctx, t, c)
	if h.Reset || h.Offset != 2 {
		t.Fatalf("hello = %+v; want offset 2 and no reset", h)
	}
	f := mustFrame(ctx, t, c)
	if f.offset != 2 || string(f.data) != "cdef" {
		t.Fatalf("resume = %d %q; want 2 \"cdef\"", f.offset, f.data)
	}
	// Up to date: nothing is sent until there is something new.
	c2 := dialV2(ctx, t, srv, "?since=6")
	defer func() { _ = c2.CloseNow() }()
	if h := mustHello(ctx, t, c2); h.Reset || h.Offset != 6 {
		t.Fatalf("hello at the end = %+v", h)
	}
	ft.ring.Write([]byte("g"))
	if f := mustFrame(ctx, t, c2); f.offset != 6 || string(f.data) != "g" {
		t.Fatalf("after an up-to-date resume = %d %q", f.offset, f.data)
	}
}

func TestTermV2ResumePastTheRingResets(t *testing.T) {
	ft := newFakeTerm(8)
	ft.ring.Write([]byte("0123456789abcdefghij")) // the ring holds offsets 12..20
	srv, _ := v2Server(t, ft)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, since := range []string{"1", "999"} { // fell out of the ring; another stream's offset
		c := dialV2(ctx, t, srv, "?since="+since)
		h := mustHello(ctx, t, c)
		if !h.Reset || h.Offset != 20 {
			t.Fatalf("since=%s: hello = %+v; want a reset at 20", since, h)
		}
		if f := mustFrame(ctx, t, c); string(f.data) != "cdefghij" {
			t.Fatalf("since=%s: snapshot = %q", since, f.data)
		}
		_ = c.CloseNow()
	}
}

func TestTermV2InputIsAppliedOnceAndAcked(t *testing.T) {
	ft := newFakeTerm(1 << 10)
	srv, _ := v2Server(t, ft)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c := dialV2(ctx, t, srv, "?client=tab-1")
	mustHello(ctx, t, c)
	mustFrame(ctx, t, c) // empty snapshot
	for _, b := range [][]byte{input(1, "a"), input(1, "a"), input(2, "b"), input(1, "a")} {
		if err := c.Write(ctx, websocket.MessageBinary, b); err != nil {
			t.Fatal(err)
		}
	}
	start := time.Now()
	for {
		f := mustFrame(ctx, t, c)
		if raw, ok := f.text["ack"]; ok && string(raw) == "2" {
			break
		}
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("ack took %v", d)
	}
	if got := ft.typedNow(); strings.Join(got, ",") != "a,b" {
		t.Fatalf("typed %q; a resent frame was typed twice", got)
	}
	_ = c.CloseNow()

	// The next connection of the same tab hears what was applied, and a
	// resend of it is dropped.
	c2 := dialV2(ctx, t, srv, "?client=tab-1&since=0")
	defer func() { _ = c2.CloseNow() }()
	if h := mustHello(ctx, t, c2); h.Ack != 2 {
		t.Fatalf("hello ack = %d; want 2", h.Ack)
	}
	_ = c2.Write(ctx, websocket.MessageBinary, input(2, "b"))
	_ = c2.Write(ctx, websocket.MessageBinary, input(3, "c"))
	waitFor(t, func() bool { return len(ft.typedNow()) == 3 })
	if got := ft.typedNow(); strings.Join(got, ",") != "a,b,c" {
		t.Fatalf("typed %q", got)
	}
}

func TestTermV2PingPongAndResize(t *testing.T) {
	ft := newFakeTerm(1 << 10)
	srv, ag := v2Server(t, ft)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c := dialV2(ctx, t, srv, "")
	defer func() { _ = c.CloseNow() }()
	mustHello(ctx, t, c)
	mustFrame(ctx, t, c)
	_ = c.Write(ctx, websocket.MessageText, []byte(`{"ping":42}`))
	if f := mustFrame(ctx, t, c); string(f.text["pong"]) != "42" {
		t.Fatalf("answer to a ping = %+v", f)
	}
	_ = c.Write(ctx, websocket.MessageText, []byte(`{"resize":{"cols":90,"rows":30}}`))
	waitFor(t, func() bool { return len(ag.sized()) == 1 })
	// v2 never types a text frame: control that is not understood is dropped.
	_ = c.Write(ctx, websocket.MessageText, []byte(`ls`))
	time.Sleep(50 * time.Millisecond)
	if len(ag.wrote()) != 0 || len(ft.typedNow()) != 0 {
		t.Fatalf("a text frame reached the PTY: %q %q", ag.wrote(), ft.typedNow())
	}
}

func TestTermV2SaysTheExitCodeBeforeClosing(t *testing.T) {
	ft := newFakeTerm(1 << 10)
	srv, _ := v2Server(t, ft)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c := dialV2(ctx, t, srv, "")
	mustHello(ctx, t, c)
	mustFrame(ctx, t, c)
	ft.ring.Write([]byte("bye"))
	ft.code = 3
	close(ft.done)
	var sawBye bool
	for {
		f, err := readFrame(ctx, c)
		if err != nil {
			t.Fatalf("closed without an exit frame: %v", err)
		}
		if string(f.data) == "bye" {
			sawBye = true
		}
		if raw, ok := f.text["exit"]; ok {
			if string(raw) != `{"code":3}` || !sawBye {
				t.Fatalf("exit = %s, last output seen %v", raw, sawBye)
			}
			break
		}
	}
	_, _, err := c.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusNormalClosure {
		t.Fatalf("close after exit = %v; want 1000", err)
	}
}

// A client that stops reading costs itself a repaint and nobody else
// anything: the output never waits for it, and another client keeps up.
func TestTermV2SlowClientNeverSlowsTheOutputOrAnotherClient(t *testing.T) {
	ft := newFakeTerm(256 << 10)
	srv, _ := v2Server(t, ft)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	slow := dialV2(ctx, t, srv, "")
	defer func() { _ = slow.CloseNow() }()
	fast := dialV2(ctx, t, srv, "")
	defer func() { _ = fast.CloseNow() }()
	fastDone := make(chan uint64, 1)
	const total = 8 << 20
	go func() {
		pos := uint64(0)
		for pos < total {
			f, err := readFrame(ctx, fast)
			if err != nil {
				return
			}
			if h, ok := f.text["hello"]; ok {
				var hh termHello
				_ = json.Unmarshal(h, &hh)
				pos = hh.Offset
				_, _ = readFrame(ctx, fast) // the empty snapshot
				continue
			}
			if f.text == nil {
				pos = f.offset + uint64(len(f.data))
			}
		}
		fastDone <- pos
	}()
	chunk := bytes.Repeat([]byte("x"), 32<<10)
	start := time.Now()
	for n := 0; n < total; n += len(chunk) {
		ft.ring.Write(chunk)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("writing the output took %v; a slow client held it up", d)
	}
	select {
	case <-fastDone:
	case <-time.After(20 * time.Second):
		t.Fatal("the reading client did not get the output while another stalled")
	}
	// The stalled one, when it reads again, gets a consistent stream: each
	// frame continues the last, or a reset says to start over.
	h := mustHello(ctx, t, slow)
	pos := h.Offset
	mustFrame(ctx, t, slow)
	for pos < total {
		f := mustFrame(ctx, t, slow)
		if raw, ok := f.text["reset"]; ok {
			var r struct{ Offset uint64 }
			_ = json.Unmarshal(raw, &r)
			snap := mustFrame(ctx, t, slow)
			pos = r.Offset
			if snap.offset != pos {
				t.Fatalf("snapshot after reset at %d, reset said %d", snap.offset, pos)
			}
			continue
		}
		if f.text != nil {
			continue
		}
		if f.offset != pos {
			t.Fatalf("gap: frame at %d, client at %d", f.offset, pos)
		}
		pos += uint64(len(f.data))
	}
}

// Version 1 is unchanged for a client that does not ask for v2, even when
// the daemon could serve it.
func TestTermV1StillServedWithoutTheSubprotocol(t *testing.T) {
	srv, ag := v2Server(t, newFakeTerm(1<<10))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/v1/agents/s1/term"
	c, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"http://localhost:5173"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	typ, b, err := c.Read(ctx)
	if err != nil || typ != websocket.MessageBinary || string(b) != "V1SNAP" {
		t.Fatalf("v1 first frame = %v %q %v", typ, b, err)
	}
	_ = c.Write(ctx, websocket.MessageBinary, []byte("raw"))
	waitFor(t, func() bool { return len(ag.wrote()) == 1 })
	if ag.wrote()[0] != "raw" {
		t.Fatalf("v1 input = %q", ag.wrote())
	}
}

func TestTermV2RefusesABadQuery(t *testing.T) {
	srv, _ := v2Server(t, newFakeTerm(1<<10))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, q := range []string{"?since=-1", "?since=x", "?client=has%20space"} {
		if c, err := dialV2Err(ctx, srv, q); err == nil {
			_ = c.CloseNow()
			t.Errorf("%s was accepted", q)
		}
	}
}

var errDropped = errors.New("dropped")
