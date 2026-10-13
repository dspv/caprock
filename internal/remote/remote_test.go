package remote_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/dspv/caprock/internal/remote"
	"github.com/dspv/caprock/internal/remote/relaysrv"
)

// A stand-in for the daemon's API: echoes what it was asked, and a WebSocket
// that echoes messages back.
func fakeDaemon(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/echo", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "never=passed")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"method": r.Method,
			"via":    r.Header.Get("Via"),
			"origin": r.Header.Get("Origin"),
			"device": r.Header.Get("X-Caprock-Device"),
			"body":   string(body),
			"query":  r.URL.RawQuery,
		})
	})
	mux.HandleFunc("/v1/big", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", 300<<10)))
	})
	mux.HandleFunc("/v1/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"caprock.device.tok"}})
		if err != nil {
			return
		}
		c.SetReadLimit(1 << 22)
		defer func() { _ = c.CloseNow() }()
		for {
			typ, msg, err := c.Read(r.Context())
			if err != nil {
				return
			}
			if err := c.Write(r.Context(), typ, append([]byte(r.Header.Get("Via")+":"), msg...)); err != nil {
				return
			}
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

type rig struct {
	relay *httptest.Server
	keys  *remote.Keys
	host  *remote.Host
}

func newRig(t *testing.T) *rig {
	t.Helper()
	daemon := fakeDaemon(t)
	relay := httptest.NewServer(relaysrv.New(nil))
	t.Cleanup(relay.Close)
	set, err := remote.Load(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	keys, err := set.Keys()
	if err != nil {
		t.Fatal(err)
	}
	h := remote.NewHost(remote.Options{
		Relay: "ws" + strings.TrimPrefix(relay.URL, "http"), Keys: keys,
		Local: daemon.URL, Version: "test", Name: "mini",
	})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go h.Run(ctx)
	deadline := time.Now().Add(5 * time.Second)
	for h.State().Status != "online" {
		if time.Now().After(deadline) {
			t.Fatalf("host never came online: %+v", h.State())
		}
		time.Sleep(10 * time.Millisecond)
	}
	return &rig{relay: relay, keys: keys, host: h}
}

// phone is a test phone: a relay connection and a Noise session.
type phone struct {
	t    *testing.T
	c    *websocket.Conn
	sess *remote.Session
	hi   remote.Welcome
}

func (r *rig) dial(t *testing.T) *phone {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(r.relay.URL, "http")+"/v1/c/"+r.keys.HostID(), nil)
	if err != nil {
		t.Fatal(err)
	}
	c.SetReadLimit(remote.MaxRelayMessage)
	t.Cleanup(func() { _ = c.CloseNow() })
	hello, _ := json.Marshal(remote.Hello{V: 1})
	init, msg1, err := remote.Initiate(r.keys.Static.PublicKey().Bytes(), hello, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Write(ctx, websocket.MessageBinary, msg1); err != nil {
		t.Fatal(err)
	}
	_, msg2, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	payload, sess, err := init.Finish(msg2)
	if err != nil {
		t.Fatal(err)
	}
	p := &phone{t: t, c: c, sess: sess}
	if err := json.Unmarshal(payload, &p.hi); err != nil {
		t.Fatal(err)
	}
	return p
}

func (p *phone) send(kind byte, id uint32, body []byte) {
	p.t.Helper()
	ct, err := p.sess.Encrypt(remote.Frame(kind, id, body))
	if err != nil {
		p.t.Fatal(err)
	}
	if err := p.c.Write(context.Background(), websocket.MessageBinary, ct); err != nil {
		p.t.Fatal(err)
	}
}

func (p *phone) recv() (byte, uint32, []byte) {
	p.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, ct, err := p.c.Read(ctx)
	if err != nil {
		p.t.Fatal(err)
	}
	pt, err := p.sess.Decrypt(ct)
	if err != nil {
		p.t.Fatal(err)
	}
	kind, id, body, err := remote.ParseFrame(pt)
	if err != nil {
		p.t.Fatal(err)
	}
	return kind, id, body
}

// request runs one HTTP request over the channel and returns status, headers
// and body.
func (p *phone) request(id uint32, method, path string, hdr map[string]string, body string) (int, map[string]string, string) {
	p.t.Helper()
	head, _ := json.Marshal(map[string]any{"m": method, "p": path, "h": hdr})
	p.send(remote.KindReq, id, head)
	if body != "" {
		p.send(remote.KindReqBody, id, []byte(body))
	}
	p.send(remote.KindReqEnd, id, nil)
	var res struct {
		S int               `json:"s"`
		H map[string]string `json:"h"`
	}
	var out strings.Builder
	for {
		kind, got, b := p.recv()
		if got != id {
			p.t.Fatalf("frame for stream %d while waiting on %d", got, id)
		}
		switch kind {
		case remote.KindRes:
			_ = json.Unmarshal(b, &res)
		case remote.KindResBody:
			out.Write(b)
		case remote.KindResEnd:
			return res.S, res.H, out.String()
		}
	}
}

func TestAPhoneReachesTheDaemonThroughTheRelay(t *testing.T) {
	r := newRig(t)
	p := r.dial(t)
	if p.hi.Name != "mini" || p.hi.V != remote.ProtocolVersion {
		t.Fatalf("welcome = %+v", p.hi)
	}
	status, hdr, body := p.request(1, "POST", "/v1/echo?x=1",
		map[string]string{"Content-Type": "application/json", "X-Caprock-Device": "tok", "Origin": "https://evil.example", "Cookie": "a=b"},
		`{"hi":1}`)
	if status != 200 {
		t.Fatalf("status %d", status)
	}
	if _, ok := hdr["Set-Cookie"]; ok {
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
}

func TestALargeResponseArrivesWhole(t *testing.T) {
	p := newRig(t).dial(t)
	_, _, body := p.request(3, "GET", "/v1/big", nil, "")
	if len(body) != 300<<10 {
		t.Fatalf("got %d bytes", len(body))
	}
}

func TestAWebSocketIsCarried(t *testing.T) {
	p := newRig(t).dial(t)
	open, _ := json.Marshal(map[string]any{"p": "/v1/ws", "proto": []string{"caprock.device.tok"}})
	p.send(remote.KindWSOpen, 5, open)
	kind, _, b := p.recv()
	if kind != remote.KindWSOpened || !strings.Contains(string(b), "caprock.device.tok") {
		t.Fatalf("open: %x %s", kind, b)
	}
	// A message larger than one frame, sent in parts.
	big := strings.Repeat("y", 150<<10)
	p.send(remote.KindWSPart, 5, []byte(big[:50<<10]))
	p.send(remote.KindWSPart, 5, []byte(big[50<<10:100<<10]))
	p.send(remote.KindWSText, 5, []byte(big[100<<10:]))
	var got strings.Builder
	for {
		kind, _, b := p.recv()
		got.Write(b)
		if kind == remote.KindWSText {
			break
		}
		if kind != remote.KindWSPart {
			t.Fatalf("unexpected frame %x", kind)
		}
	}
	if got.String() != "1.1 caprock-remote:"+big {
		t.Fatalf("echo mismatch: %d bytes", got.Len())
	}
}

func TestAPathThatCouldLeaveLoopbackIsRefused(t *testing.T) {
	p := newRig(t).dial(t)
	for i, path := range []string{"//evil.example/x", "http://evil.example/", "/v1/echo\r\nX: y"} {
		status, _, _ := p.request(uint32(10+i), "GET", path, nil, "")
		if status != http.StatusBadRequest {
			t.Errorf("%q: status %d, want 400", path, status)
		}
	}
}

func TestAPhoneWithTheWrongKeyGetsNothing(t *testing.T) {
	r := newRig(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(r.relay.URL, "http")+"/v1/c/"+r.keys.HostID(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	other := make([]byte, 32)
	_, _ = rand.Read(other)
	hello, _ := json.Marshal(remote.Hello{V: 1})
	_, msg1, err := remote.Initiate(other, hello, nil)
	if err != nil {
		t.Skip("random bytes were not a valid point") // vanishingly rare
	}
	_ = c.Write(ctx, websocket.MessageBinary, msg1)
	_, _, err = c.Read(ctx)
	if err == nil {
		t.Fatal("the daemon answered a phone that does not know its key")
	}
}

func TestATamperedMessageDropsThePhone(t *testing.T) {
	p := newRig(t).dial(t)
	ct, _ := p.sess.Encrypt(remote.Frame(remote.KindReqEnd, 1, nil))
	ct[len(ct)-1] ^= 1
	_ = p.c.Write(context.Background(), websocket.MessageBinary, ct)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, _, err := p.c.Read(ctx); err == nil {
		t.Fatal("still connected after a tampered message")
	}
}

func TestAnOfflineMachineIsSaidSo(t *testing.T) {
	relay := httptest.NewServer(relaysrv.New(nil))
	defer relay.Close()
	pub, _, _ := ed25519.GenerateKey(nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(relay.URL, "http")+"/v1/c/"+remote.HostID(pub), nil)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = c.Read(ctx)
	if websocket.CloseStatus(err) != remote.CloseOffline {
		t.Fatalf("close = %v, want %d", err, remote.CloseOffline)
	}
}

func TestOnlyTheKeyHolderMayRegisterAMachine(t *testing.T) {
	relay := httptest.NewServer(relaysrv.New(nil))
	defer relay.Close()
	pub, _, _ := ed25519.GenerateKey(nil)
	_, wrong, _ := ed25519.GenerateKey(nil)
	id := remote.HostID(pub)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(relay.URL, "http")+"/v1/host/"+id, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, msg, _ := c.Read(ctx)
	_, _, nonce, _ := remote.ParseFrame(msg)
	_ = c.Write(ctx, websocket.MessageBinary, remote.Frame(remote.FrameProof, 0, ed25519.Sign(wrong, remote.ProofMessage(id, nonce))))
	_, _, err = c.Read(ctx)
	var ce websocket.CloseError
	if !errors.As(err, &ce) || ce.Code != websocket.StatusPolicyViolation {
		t.Fatalf("a forged proof was accepted: %v", err)
	}
}

func TestKeysSurviveAndResetMakesNewOnes(t *testing.T) {
	dir := t.TempDir()
	a, _ := remote.Load(dir)
	b, _ := remote.Load(dir)
	ka, _ := a.Keys()
	kb, _ := b.Keys()
	if ka.HostID() != kb.HostID() || ka.StaticPublic() != kb.StaticPublic() {
		t.Fatal("keys changed between loads")
	}
	if err := remote.Reset(dir); err != nil {
		t.Fatal(err)
	}
	c, _ := remote.Load(dir)
	kc, _ := c.Keys()
	if kc.HostID() == ka.HostID() {
		t.Fatal("reset kept the old id")
	}
}

func TestRelayAndAppAddressesMustBeEncryptedOffThisMachine(t *testing.T) {
	for raw, ok := range map[string]bool{
		"wss://relay.example": true, "ws://127.0.0.1:9": true, "ws://relay.example": false, "https://relay.example": false,
	} {
		if (remote.CheckRelayURL(raw) == nil) != ok {
			t.Errorf("relay %q accepted=%v", raw, !ok)
		}
	}
	for raw, ok := range map[string]bool{
		"https://m.example": true, "http://localhost:5173": true, "http://m.example": false,
	} {
		if (remote.CheckAppURL(raw) == nil) != ok {
			t.Errorf("app %q accepted=%v", raw, !ok)
		}
	}
}
