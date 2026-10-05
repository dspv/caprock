package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/dspv/caprock/internal/bus"
)

// liveFrame is a /v1/live frame as a client reads it.
type liveFrame struct {
	Type string          `json:"type"`
	Seq  uint64          `json:"seq"`
	Data json.RawMessage `json:"data"`
}

func dialLive(t *testing.T, ctx context.Context, e *env, query string) *websocket.Conn {
	t.Helper()
	u := "ws" + strings.TrimPrefix(e.srv.URL, "http") + "/v1/live" + query
	c, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"http://localhost:5173"}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.CloseNow() })
	return c
}

func nextLive(t *testing.T, ctx context.Context, c *websocket.Conn) liveFrame {
	t.Helper()
	_, msg, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var f liveFrame
	if err := json.Unmarshal(msg, &f); err != nil {
		t.Fatalf("%v: %s", err, msg)
	}
	return f
}

// waitSubscribers waits until the socket's handler has subscribed, so frames
// published next are delivered live rather than raced.
func waitSubscribers(t *testing.T, b *bus.Bus, n int) {
	t.Helper()
	for i := 0; b.Subscribers() < n; i++ {
		if i > 500 {
			t.Fatal("socket never subscribed")
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// A client reconnecting inside the ring receives exactly the frames it missed,
// in order — a notify among them — and then the live stream.
func TestLiveResumeInsideRingSendsExactlyTheMissedFrames(t *testing.T) {
	e := newEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c := dialLive(t, ctx, e, "")
	hello := nextLive(t, ctx, c)
	if hello.Type != "hello" || hello.Seq == 0 {
		t.Fatalf("hello: %+v", hello)
	}
	e.bus.Publish(bus.Frame{Type: bus.FrameAlert, Data: "seen"})
	seen := nextLive(t, ctx, c)
	if seen.Seq != hello.Seq+1 {
		t.Fatalf("first frame: %+v after hello %d", seen, hello.Seq)
	}
	_ = c.CloseNow()
	waitSubscribers(t, e.bus, 0)

	// Offline: three frames, one of them the notification WP-09 will send.
	e.bus.Publish(bus.Frame{Type: bus.FrameEvent, Data: "m1"})
	e.bus.Publish(bus.Frame{Type: "notify", Data: map[string]string{"id": "n1", "kind": "approval"}})
	e.bus.Publish(bus.Frame{Type: bus.FrameSession, Data: "m3"})

	c2 := dialLive(t, ctx, e, fmt.Sprintf("?since=%d", seen.Seq))
	h2 := nextLive(t, ctx, c2)
	if h2.Type != "hello" || h2.Seq != seen.Seq || strings.Contains(string(h2.Data), `"reset":true`) {
		t.Fatalf("resume hello: %+v %s", h2, h2.Data)
	}
	want := []string{"event", "notify", "session"}
	for i, typ := range want {
		f := nextLive(t, ctx, c2)
		if f.Type != typ || f.Seq != seen.Seq+uint64(i)+1 {
			t.Fatalf("missed frame %d: %+v, want %s", i, f, typ)
		}
	}
	waitSubscribers(t, e.bus, 1)
	e.bus.Publish(bus.Frame{Type: bus.FrameEvent, Data: "live"})
	if f := nextLive(t, ctx, c2); f.Seq != seen.Seq+4 || string(f.Data) != `"live"` {
		t.Fatalf("live after replay (a duplicate or a gap): %+v", f)
	}
}

// A client whose since the ring no longer holds gets a reset and continues
// from the newest frame.
func TestLiveResumeOutsideRingSendsReset(t *testing.T) {
	e := newEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c := dialLive(t, ctx, e, "")
	since := nextLive(t, ctx, c).Seq
	_ = c.CloseNow()
	for i := 0; i <= bus.ReplayFrames; i++ {
		e.bus.Publish(bus.Frame{Type: bus.FrameEvent, Data: i})
	}
	newest := since + bus.ReplayFrames + 1

	c2 := dialLive(t, ctx, e, fmt.Sprintf("?since=%d", since))
	h := nextLive(t, ctx, c2)
	if h.Type != "hello" || h.Seq != newest || !strings.Contains(string(h.Data), `"reset":true`) {
		t.Fatalf("hello: %+v %s", h, h.Data)
	}
	r := nextLive(t, ctx, c2)
	if r.Type != "reset" || r.Seq != newest || string(r.Data) != fmt.Sprintf(`{"seq":%d}`, newest) {
		t.Fatalf("reset: %+v %s", r, r.Data)
	}
	waitSubscribers(t, e.bus, 1)
	e.bus.Publish(bus.Frame{Type: bus.FrameEvent, Data: "after"})
	if f := nextLive(t, ctx, c2); f.Type != "event" || f.Seq != newest+1 {
		t.Fatalf("after reset: %+v", f)
	}
}

// A client that predates replay sends no since and reads frames as before,
// each now carrying a seq; a malformed since is refused before the upgrade.
func TestLiveWithoutSinceKeepsWorkingAndBadSinceIsRefused(t *testing.T) {
	e := newEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c := dialLive(t, ctx, e, "")
	h := nextLive(t, ctx, c)
	if h.Type != "hello" || strings.Contains(string(h.Data), `"reset":true`) {
		t.Fatalf("hello: %+v %s", h, h.Data)
	}
	e.bus.Publish(bus.Frame{Type: bus.FrameEvent, Data: 1})
	if f := nextLive(t, ctx, c); f.Type != "event" || f.Seq != h.Seq+1 {
		t.Fatalf("frame: %+v", f)
	}
	resp, err := http.Get(e.srv.URL + "/v1/live?since=abc")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("since=abc: %d", resp.StatusCode)
	}
}

// A client's {"ping":t} is answered with a pong frame carrying t and the
// client's position.
func TestLivePingIsAnsweredWithPong(t *testing.T) {
	e := newEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c := dialLive(t, ctx, e, "")
	h := nextLive(t, ctx, c)
	if err := c.Write(ctx, websocket.MessageText, []byte(`{"ping":42}`)); err != nil {
		t.Fatal(err)
	}
	if f := nextLive(t, ctx, c); f.Type != "pong" || string(f.Data) != "42" || f.Seq != h.Seq {
		t.Fatalf("pong: %+v %s", f, f.Data)
	}
}

// A subscriber that overflowed its buffer is caught up from the ring: no gap,
// no duplicate.
func TestLiveFillsAGapFromTheRing(t *testing.T) {
	e := newEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c := dialLive(t, ctx, e, "")
	h := nextLive(t, ctx, c)
	waitSubscribers(t, e.bus, 1)
	// More than the socket's buffer, published while nobody reads.
	const n = 1500
	for i := 0; i < n; i++ {
		e.bus.Publish(bus.Frame{Type: bus.FrameEvent, Data: i})
	}
	for i := 1; i <= n; i++ {
		if f := nextLive(t, ctx, c); f.Seq != h.Seq+uint64(i) {
			t.Fatalf("frame %d: seq %d, want %d", i, f.Seq, h.Seq+uint64(i))
		}
	}
}
