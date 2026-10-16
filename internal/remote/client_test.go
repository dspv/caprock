package remote_test

import (
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/dspv/caprock/internal/remote"
	"github.com/dspv/caprock/internal/remote/relaysrv"
)

func (r *rig) target() remote.Target {
	return remote.Target{Relay: wsURL(r.relay), HostID: r.keys.HostID(), Key: r.keys.StaticPublic()}
}

func wsURL(s *httptest.Server) string { return "ws" + strings.TrimPrefix(s.URL, "http") }

func (r *rig) client(t *testing.T, idle time.Duration) *remote.Client {
	t.Helper()
	c, err := remote.NewClient(remote.ClientOptions{Target: r.target(), Idle: idle})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	return c
}

func get(t *testing.T, c *remote.Client, method, path string, hdr map[string]string, body string) (int, http.Header, string) {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, _ := http.NewRequestWithContext(context.Background(), method, "http://machine"+path, rd)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	res, err := c.RoundTrip(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("%s %s: body: %v", method, path, err)
	}
	return res.StatusCode, res.Header, string(b)
}

func TestAComputerReachesAnotherThroughTheRelay(t *testing.T) {
	r := newRig(t)
	c := r.client(t, 0)
	if st := c.State(); st.Status != "idle" {
		t.Fatalf("a client nobody used is %q, want idle: nothing is dialled until it is", st.Status)
	}
	status, hdr, body := get(t, c, "POST", "/v1/echo?x=1",
		map[string]string{"Content-Type": "application/json", "X-Caprock-Device": "tok", "Origin": "https://evil.example", "Cookie": "a=b"},
		`{"hi":1}`)
	if status != 200 {
		t.Fatalf("status %d", status)
	}
	if hdr.Get("Set-Cookie") != "" {
		t.Error("Set-Cookie crossed the channel")
	}
	var got map[string]string
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"method": "POST", "via": "1.1 caprock-remote", "origin": "", "device": "tok", "body": `{"hi":1}`, "query": "x=1"}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
	st := c.State()
	if st.Status != "online" || st.Name != "mini" || st.Version != "test" {
		t.Fatalf("state = %+v, want online with the machine's welcome", st)
	}
	if st.MsgsOut == 0 || st.MsgsIn == 0 || st.BytesOut == 0 || st.BytesIn == 0 {
		t.Fatalf("counters not kept: %+v", st)
	}
	if hs := r.host.State(); hs.MsgsIn == 0 || hs.MsgsOut == 0 {
		t.Fatalf("host counters not kept: %+v", hs)
	}
}

func TestLargeBodiesCrossBothWays(t *testing.T) {
	c := newRig(t).client(t, 0)
	_, _, body := get(t, c, "GET", "/v1/big", nil, "")
	if len(body) != 300<<10 {
		t.Fatalf("download: got %d bytes", len(body))
	}
	up := strings.Repeat("u", 200<<10)
	_, _, body = get(t, c, "POST", "/v1/echo", nil, up)
	var got map[string]string
	_ = json.Unmarshal([]byte(body), &got)
	if got["body"] != up {
		t.Fatalf("upload: the machine got %d bytes", len(got["body"]))
	}
}

func TestManyRequestsShareOneChannel(t *testing.T) {
	c := newRig(t).client(t, 0)
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req, _ := http.NewRequest("GET", "http://machine/v1/echo", nil)
			res, err := c.RoundTrip(req)
			if err != nil {
				errs <- err
				return
			}
			_, _ = io.Copy(io.Discard, res.Body)
			_ = res.Body.Close()
			if res.StatusCode != 200 {
				errs <- errors.New(res.Status)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	if c.Serial() != 1 {
		t.Fatalf("%d channels opened for concurrent requests, want 1", c.Serial())
	}
}

// A caller giving up on an answer still arriving costs only that request.
func TestACancelledRequestLeavesTheChannelUp(t *testing.T) {
	r := newRig(t)
	c := r.client(t, 0)
	for round := 0; round < 3; round++ {
		ctx, cancel := context.WithCancel(context.Background())
		req, _ := http.NewRequestWithContext(ctx, "GET", "http://machine/v1/slow", nil)
		res, err := c.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, 1024)
		if _, err := res.Body.Read(buf); err != nil {
			t.Fatal(err)
		}
		cancel()
		if _, err := io.ReadAll(res.Body); err == nil {
			t.Fatal("a cancelled body read to the end")
		}
		_ = res.Body.Close()
		if status, _, _ := get(t, c, "GET", "/v1/echo", nil, ""); status != 200 {
			t.Fatalf("round %d: %d after a cancel", round, status)
		}
	}
	if c.Serial() != 1 || r.host.State().Status != "online" {
		t.Fatalf("cancels cost the channel: serial %d, host %+v", c.Serial(), r.host.State())
	}
}

func TestAWebSocketIsCarriedForAComputer(t *testing.T) {
	c := newRig(t).client(t, 0)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, err := c.OpenWS(ctx, "/v1/ws", []string{"caprock.device.tok"})
	if err != nil {
		t.Fatal(err)
	}
	if ws.Subprotocol() != "caprock.device.tok" {
		t.Fatalf("subprotocol %q", ws.Subprotocol())
	}
	big := strings.Repeat("y", 150<<10)
	if err := ws.Write(ctx, websocket.MessageText, []byte(big)); err != nil {
		t.Fatal(err)
	}
	typ, msg, err := ws.Read(ctx)
	if err != nil || typ != websocket.MessageText || string(msg) != "1.1 caprock-remote:"+big {
		t.Fatalf("echo: %v %v %d bytes", err, typ, len(msg))
	}
	if err := ws.Write(ctx, websocket.MessageBinary, []byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	if typ, msg, err = ws.Read(ctx); err != nil || typ != websocket.MessageBinary || !strings.HasSuffix(string(msg), "\x01\x02\x03") {
		t.Fatalf("binary echo: %v %v %q", err, typ, msg)
	}
	if err := ws.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatal(err)
	}
	if st := c.State(); st.Streams != 0 {
		t.Fatalf("%d streams open after close", st.Streams)
	}
}

// A socket the computer closes reaches the other end with its code, even
// when keystrokes keep arriving as it closes. A write that failed on the
// closing socket used to drop the stream without a word, and the reader that
// held the 1008 then said nothing either: the terminal stayed open after a
// revoke (TestAComputerWorksOnAnotherThroughTheRelay, macOS CI).
func TestASocketClosedWhileTypingSaysWhy(t *testing.T) {
	c := newRig(t).client(t, 0)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, err := c.OpenWS(ctx, "/v1/ws-revoke", nil)
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	typed := make(chan struct{})
	go func() {
		defer close(typed)
		// A burst of keystrokes as the socket closes: enough to land writes
		// on the closing socket, fewer than the host's queue holds. An
		// unbounded loop outran the host on one or two CPUs and was hung up
		// as a flood, which is that guard working, not this bug.
		for i := 0; i < 128; i++ {
			select {
			case <-stop:
				return
			default:
			}
			if ws.Write(ctx, websocket.MessageBinary, []byte("x")) != nil {
				return
			}
		}
	}()
	_, _, err = ws.Read(ctx)
	close(stop)
	<-typed
	if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("the socket ended with %v, want 1008", err)
	}
}

func TestARefusedSocketSaysWhy(t *testing.T) {
	c := newRig(t).client(t, 0)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := c.OpenWS(ctx, "/v1/ws-deny", nil)
	if websocket.CloseStatus(err) != 4401 {
		t.Fatalf("err = %v, want close 4401 (not paired)", err)
	}
}

func TestAnOfflineComputerIsSaidSo(t *testing.T) {
	relay := httptest.NewServer(relaysrv.New(nil))
	defer relay.Close()
	pub, _, _ := ed25519.GenerateKey(nil)
	st, _ := ecdh.X25519().GenerateKey(rand.Reader)
	c, err := remote.NewClient(remote.ClientOptions{Target: remote.Target{
		Relay: wsURL(relay), HostID: remote.HostID(pub), Key: base64.RawURLEncoding.EncodeToString(st.PublicKey().Bytes()),
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	req, _ := http.NewRequest("GET", "http://machine/v1/status", nil)
	if _, err := c.RoundTrip(req); !errors.Is(err, remote.ErrMachineOffline) {
		t.Fatalf("err = %v, want offline", err)
	}
	if s := c.State(); s.Status != "offline" {
		t.Fatalf("state %+v", s)
	}
	// Within the backoff, the next request is answered at once.
	start := time.Now()
	if _, err := c.RoundTrip(req); !errors.Is(err, remote.ErrMachineOffline) || time.Since(start) > 200*time.Millisecond {
		t.Fatalf("second try: %v after %v", err, time.Since(start))
	}
}

func TestAComputerWithOtherKeysIsRefused(t *testing.T) {
	r := newRig(t)
	other, _ := ecdh.X25519().GenerateKey(rand.Reader)
	tgt := r.target()
	tgt.Key = base64.RawURLEncoding.EncodeToString(other.PublicKey().Bytes())
	c, err := remote.NewClient(remote.ClientOptions{Target: tgt})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	req, _ := http.NewRequest("GET", "http://machine/v1/echo", nil)
	if _, err := c.RoundTrip(req); !errors.Is(err, remote.ErrRefused) {
		t.Fatalf("err = %v, want refused", err)
	}
	if s := c.State(); s.Status != "refused" {
		t.Fatalf("state %+v", s)
	}
}

// A machine that answers the handshake and then sends something that does
// not decrypt loses the channel: nothing on it can be trusted.
func TestATamperedMessageDropsTheChannel(t *testing.T) {
	static, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pub, _, _ := ed25519.GenerateKey(nil)
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = c.CloseNow() }()
		c.SetReadLimit(remote.MaxRelayMessage)
		_, msg1, err := c.Read(r.Context())
		if err != nil {
			return
		}
		welcome, _ := json.Marshal(remote.Welcome{V: 1, Version: "x", Name: "fake"})
		reply, _, sess, err := remote.Respond(static, msg1, welcome, nil)
		if err != nil {
			return
		}
		_ = c.Write(r.Context(), websocket.MessageBinary, reply)
		if _, _, err := c.Read(r.Context()); err != nil { // the request's head
			return
		}
		ct, _ := sess.Encrypt(remote.Frame(remote.KindRes, 1, []byte(`{"s":200}`)))
		ct[len(ct)-1] ^= 1
		_ = c.Write(r.Context(), websocket.MessageBinary, ct)
		_, _, _ = c.Read(r.Context())
	}))
	defer fake.Close()
	c, err := remote.NewClient(remote.ClientOptions{Target: remote.Target{
		Relay: wsURL(fake), HostID: remote.HostID(pub), Key: base64.RawURLEncoding.EncodeToString(static.PublicKey().Bytes()),
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	req, _ := http.NewRequest("GET", "http://machine/v1/echo", nil)
	if _, err := c.RoundTrip(req); err == nil {
		t.Fatal("a tampered answer was taken")
	}
	deadline := time.Now().Add(5 * time.Second)
	for c.State().Status != "offline" {
		if time.Now().After(deadline) {
			t.Fatalf("state %+v after a tampered message", c.State())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// The channel opens on demand and closes after it has been idle; the next
// request opens a new one.
func TestAnIdleChannelClosesAndReopens(t *testing.T) {
	c := newRig(t).client(t, 150*time.Millisecond)
	if status, _, _ := get(t, c, "GET", "/v1/echo", nil, ""); status != 200 {
		t.Fatal(status)
	}
	deadline := time.Now().Add(5 * time.Second)
	for c.State().Status != "idle" {
		if time.Now().After(deadline) {
			t.Fatalf("still %+v after idling", c.State())
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status, _, _ := get(t, c, "GET", "/v1/echo", nil, ""); status != 200 {
		t.Fatal(status)
	}
	if c.Serial() != 2 {
		t.Fatalf("serial %d, want 2", c.Serial())
	}
}

// An open socket keeps the channel up past the idle time: a terminal can be
// open for hours with nothing typed.
func TestAnOpenSocketKeepsTheChannelUp(t *testing.T) {
	c := newRig(t).client(t, 100*time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, err := c.OpenWS(ctx, "/v1/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(400 * time.Millisecond)
	if st := c.State(); st.Status != "online" || c.Serial() != 1 {
		t.Fatalf("an open socket's channel closed: %+v", st)
	}
	if err := ws.Write(ctx, websocket.MessageText, []byte("still")); err != nil {
		t.Fatal(err)
	}
	if _, msg, err := ws.Read(ctx); err != nil || !strings.HasSuffix(string(msg), "still") {
		t.Fatalf("%v %q", err, msg)
	}
}

// The machine going away drops what was open on it; when it is back, the
// next request reaches it on a new channel.
func TestAComputerThatComesBackIsReachedAgain(t *testing.T) {
	r := newRig(t)
	c := r.client(t, 0)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, err := c.OpenWS(ctx, "/v1/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	r.stop() // the machine's daemon goes away: the relay tells its phones
	if _, _, err := ws.Read(ctx); websocket.CloseStatus(err) == -1 {
		t.Fatalf("an open socket on a machine that went away read %v", err)
	}
	// The machine comes back with the same keys.
	h := remote.NewHost(remote.Options{Relay: wsURL(r.relay), Keys: r.keys, Local: r.daemon.URL, Version: "test", Name: "mini"})
	hctx, hstop := context.WithCancel(context.Background())
	defer hstop()
	go h.Run(hctx)
	for h.State().Status != "online" {
		if ctx.Err() != nil {
			t.Fatal("host never came back")
		}
		time.Sleep(10 * time.Millisecond)
	}
	for {
		c.Retry()
		req, _ := http.NewRequestWithContext(ctx, "GET", "http://machine/v1/echo", nil)
		res, err := c.RoundTrip(req)
		if err == nil {
			_ = res.Body.Close()
			break
		}
		if ctx.Err() != nil {
			t.Fatalf("never reached again: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if c.Serial() < 2 {
		t.Fatalf("serial %d: the channel was not reopened", c.Serial())
	}
}

func TestAPairingLinkReadsBack(t *testing.T) {
	set, _ := remote.Load(t.TempDir())
	set.Relay = "wss://relay.example"
	keys, _ := set.Keys()
	link := remote.PairLink(set, keys, "123456", "Mac mini")
	for _, in := range []string{link, "  " + link + "\n", "<" + link + ">", link[strings.Index(link, "?")+1:]} {
		p, err := remote.ParsePairLink(in)
		if err != nil {
			t.Fatalf("%q: %v", in, err)
		}
		if p.Relay != "wss://relay.example" || p.HostID != keys.HostID() || p.Key != keys.StaticPublic() || p.Code != "123456" || p.Name != "Mac mini" {
			t.Fatalf("%q read as %+v", in, p)
		}
	}
	// Without a code it is still a target; the caller asks for one.
	if p, err := remote.ParsePairLink(remote.PairLink(set, keys, "", "")); err != nil || p.Code != "" {
		t.Fatalf("no code: %+v %v", p, err)
	}
	bad := []string{
		"",
		"https://m.caprock.dev/",
		strings.Replace(link, "wss%3A%2F%2Frelay.example", "ws%3A%2F%2Frelay.example", 1), // clear text off this machine
		strings.Replace(link, "h="+keys.HostID(), "h=abc", 1),
		strings.Replace(link, "k="+keys.StaticPublic(), "k=abc", 1),
		strings.Replace(link, "c=123456", "c=12a456", 1),
	}
	for _, in := range bad {
		if _, err := remote.ParsePairLink(in); err == nil {
			t.Errorf("%q was accepted", in)
		}
	}
}
