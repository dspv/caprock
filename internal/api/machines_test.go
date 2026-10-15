package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/dspv/caprock/internal/peers"
	"github.com/dspv/caprock/internal/remote"
)

// fakeMachines is one computer, "mini", whose API is far: an http.Handler
// standing in for the other daemon behind the channel.
type fakeMachines struct {
	mu       sync.Mutex
	far      http.Handler
	status   string // the Status the list says
	checked  int
	revoked  bool // what a Check finds
	doErr    error
	left     bool
	forgot   bool
	renamed  string
	sockErr  error
	sock     *pipeSocket
	protos   []string
	sockPath string
}

func (f *fakeMachines) st() peers.Status {
	return peers.Status{ID: "mini", Name: "Mac mini", Relay: "wss://relay.example", Status: f.status}
}
func (f *fakeMachines) List() []peers.Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.forgot {
		return nil
	}
	return []peers.Status{f.st()}
}
func (f *fakeMachines) Get(id string) (peers.Status, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if id != "mini" || f.forgot {
		return peers.Status{}, peers.ErrUnknown
	}
	return f.st(), nil
}
func (f *fakeMachines) Check(_ context.Context, id string) (peers.Status, error) {
	f.mu.Lock()
	f.checked++
	if f.revoked {
		f.status = peers.StatusRevoked
	} else {
		f.status = "online"
	}
	f.mu.Unlock()
	return f.Get(id)
}
func (f *fakeMachines) Pair(_ context.Context, link string) (peers.Status, error) {
	if !strings.Contains(link, "c=") {
		return peers.Status{}, peers.ErrNoCode
	}
	return f.st(), nil
}
func (f *fakeMachines) Rename(id, name string) error {
	if id != "mini" {
		return peers.ErrUnknown
	}
	f.renamed = name
	return nil
}
func (f *fakeMachines) Leave(context.Context, string) error { f.left = true; return nil }
func (f *fakeMachines) Forget(string) error                 { f.forgot = true; return nil }
func (f *fakeMachines) Do(id string, req *http.Request) (*http.Response, error) {
	if f.doErr != nil {
		return nil, f.doErr
	}
	w := httptest.NewRecorder()
	f.far.ServeHTTP(w, req)
	return w.Result(), nil
}
func (f *fakeMachines) OpenWS(_ context.Context, id, path string, protocols []string) (MachineSocket, error) {
	f.protos, f.sockPath = protocols, path
	if f.sockErr != nil {
		return nil, f.sockErr
	}
	return f.sock, nil
}

// pipeSocket is the far end of a bridged socket: what the test sends from
// "there", and what arrived from "here".
type pipeSocket struct {
	proto    string
	in       chan []byte // to the local caller
	out      chan []byte // from the local caller
	closeIn  chan websocket.CloseError
	closedBy chan websocket.StatusCode
}

func newPipe(proto string) *pipeSocket {
	return &pipeSocket{proto: proto, in: make(chan []byte, 4), out: make(chan []byte, 4), closeIn: make(chan websocket.CloseError, 1), closedBy: make(chan websocket.StatusCode, 1)}
}
func (p *pipeSocket) Read(ctx context.Context) (websocket.MessageType, []byte, error) {
	select {
	case b := <-p.in:
		return websocket.MessageBinary, b, nil
	case ce := <-p.closeIn:
		return 0, nil, ce
	case <-ctx.Done():
		return 0, nil, ctx.Err()
	}
}
func (p *pipeSocket) Write(_ context.Context, _ websocket.MessageType, msg []byte) error {
	p.out <- msg
	return nil
}
func (p *pipeSocket) Close(code websocket.StatusCode, _ string) error {
	select {
	case p.closedBy <- code:
	default:
	}
	return nil
}
func (p *pipeSocket) Subprotocol() string { return p.proto }

func machinesServer(t *testing.T, fm *fakeMachines) *Server {
	t.Helper()
	return New(Deps{Machines: fm})
}

// The list, a pasted link, a rename and Forget, from this machine only.
func TestMachinesRoutes(t *testing.T) {
	fm := &fakeMachines{status: "idle"}
	s := machinesServer(t, fm)
	w := serve(s, local("GET", "/v1/machines?check=1", ""))
	var list struct {
		Machines []peers.Status `json:"machines"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil || w.Code != 200 || len(list.Machines) != 1 || list.Machines[0].Status != "online" || fm.checked != 1 {
		t.Fatalf("list: %d %s (checked %d)", w.Code, w.Body, fm.checked)
	}
	if strings.Contains(w.Body.String(), "token") {
		t.Fatalf("the list carries a token: %s", w.Body)
	}
	if w := serve(s, local("POST", "/v1/machines", `{"link":"https://m.caprock.dev/#/pair?r=x&h=y&k=z"}`)); w.Code != 400 {
		t.Fatalf("a link without a code: %d %s", w.Code, w.Body)
	}
	if w := serve(s, local("POST", "/v1/machines", `{}`)); w.Code != 400 {
		t.Fatalf("no link: %d", w.Code)
	}
	if w := serve(s, local("POST", "/v1/machines", `{"link":"r=x&h=y&k=z&c=123456"}`)); w.Code != 200 {
		t.Fatalf("pair: %d %s", w.Code, w.Body)
	}
	if w := serve(s, local("PATCH", "/v1/machines/mini", `{"name":"Mini"}`)); w.Code != 200 || fm.renamed != "Mini" {
		t.Fatalf("rename: %d %s", w.Code, w.Body)
	}
	if w := serve(s, local("PATCH", "/v1/machines/nope", `{"name":"x"}`)); w.Code != 404 {
		t.Fatalf("rename an unknown one: %d", w.Code)
	}
	w = serve(s, local("DELETE", "/v1/machines/mini", ""))
	if w.Code != 200 || !fm.left || !fm.forgot || !strings.Contains(w.Body.String(), `"released":true`) {
		t.Fatalf("forget: %d %s left=%v forgot=%v", w.Code, w.Body, fm.left, fm.forgot)
	}
	if w := serve(s, local("DELETE", "/v1/machines/mini", "")); w.Code != 404 {
		t.Fatalf("forget twice: %d", w.Code)
	}
}

// Off this machine — a relayed request, a phone — nothing here answers, and
// a build without computers says so.
func TestMachinesAreThisMachinesOnly(t *testing.T) {
	fm := &fakeMachines{status: "online", far: http.NotFoundHandler()}
	s := machinesServer(t, fm)
	for _, path := range []string{"/v1/machines", "/v1/m/mini/v1/sessions"} {
		r := local("GET", path, "")
		r.Header.Set("X-Forwarded-For", "203.0.113.9") // a tunnel on this machine
		if w := serve(s, r); w.Code != 401 && w.Code != 403 {
			t.Errorf("%s through a tunnel: %d", path, w.Code)
		}
	}
	if w := serve(New(Deps{}), local("GET", "/v1/machines", "")); w.Code != 501 {
		t.Errorf("without computers: %d", w.Code)
	}
}

// The proxy carries the path and query to the other computer and streams its
// answer back; an unknown computer is 404, an offline one 503 with why, and
// one that removed this machine says revoked.
func TestMachineProxyHTTP(t *testing.T) {
	var got string
	fm := &fakeMachines{status: "online", far: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Method + " " + r.URL.Path + "?" + r.URL.RawQuery
		if r.Header.Get("Cookie") != "" {
			t.Errorf("a cookie reached the other computer")
		}
		b, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"echo":%q}`, b)
	})}
	s := machinesServer(t, fm)
	r := local("POST", "/v1/m/mini/v1/agents?x=1", `{"cwd":"/c/Users/ada"}`)
	r.Header.Set("Cookie", "a=b")
	w := serve(s, r)
	if w.Code != 200 || got != "POST /v1/agents?x=1" || !strings.Contains(w.Body.String(), `/c/Users/ada`) {
		t.Fatalf("proxied: %d %s, the other computer saw %q", w.Code, w.Body, got)
	}
	if w := serve(s, local("GET", "/v1/m/nope/v1/sessions", "")); w.Code != 404 {
		t.Fatalf("unknown computer: %d", w.Code)
	}
	if w := serve(s, local("GET", "/v1/m/mini/etc/passwd", "")); w.Code != 404 {
		t.Fatalf("outside the API: %d", w.Code)
	}

	fm.doErr = fmt.Errorf("dial: %w", remote.ErrMachineOffline)
	w = serve(s, local("GET", "/v1/m/mini/v1/sessions", ""))
	if w.Code != 503 || !strings.Contains(w.Body.String(), `"status":"offline"`) {
		t.Fatalf("offline: %d %s", w.Code, w.Body)
	}
	fm.doErr = nil

	// The other computer answers 401: asked once, it says this machine was
	// removed there, and the proxy says so.
	fm.far = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(401) })
	fm.revoked = true
	w = serve(s, local("GET", "/v1/m/mini/v1/sessions", ""))
	if w.Code != 403 || !strings.Contains(w.Body.String(), `"status":"revoked"`) {
		t.Fatalf("revoked: %d %s", w.Code, w.Body)
	}
	// Still revoked: answered without forwarding, after asking again.
	before := fm.checked
	w = serve(s, local("GET", "/v1/m/mini/v1/sessions", ""))
	if w.Code != 403 || fm.checked != before+1 {
		t.Fatalf("still revoked: %d, checks %d→%d", w.Code, before, fm.checked)
	}
	// Allowed back on the other computer: it comes back by itself.
	fm.revoked = false
	fm.far = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`[]`)) })
	if w := serve(s, local("GET", "/v1/m/mini/v1/sessions", "")); w.Code != 200 {
		t.Fatalf("after coming back: %d %s", w.Code, w.Body)
	}
}

// A socket is bridged message by message; the device subprotocol is never
// offered from here nor echoed back, the protocol the other computer chose
// is, and its close code reaches the local caller.
func TestMachineProxySocket(t *testing.T) {
	fm := &fakeMachines{status: "online", far: http.NotFoundHandler(), sock: newPipe("caprock.term.v2")}
	s := machinesServer(t, fm)
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/v1/m/mini/v1/agents/s1/term?since=4"
	c, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{
		HTTPHeader:   http.Header{"Origin": {srv.URL}},
		Subprotocols: []string{"caprock.term.v2", "caprock.device.sneaky"},
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = c.CloseNow() }()
	if c.Subprotocol() != "caprock.term.v2" {
		t.Fatalf("subprotocol %q", c.Subprotocol())
	}
	if fm.sockPath != "/v1/agents/s1/term?since=4" || len(fm.protos) != 1 || fm.protos[0] != "caprock.term.v2" {
		t.Fatalf("opened %q with %v", fm.sockPath, fm.protos)
	}
	if err := c.Write(ctx, websocket.MessageBinary, []byte("ls\r")); err != nil {
		t.Fatal(err)
	}
	select {
	case b := <-fm.sock.out:
		if string(b) != "ls\r" {
			t.Fatalf("there got %q", b)
		}
	case <-ctx.Done():
		t.Fatal("nothing reached the other computer")
	}
	fm.sock.in <- []byte("you-said:ls")
	if _, b, err := c.Read(ctx); err != nil || string(b) != "you-said:ls" {
		t.Fatalf("here got %q %v", b, err)
	}
	fm.sock.closeIn <- websocket.CloseError{Code: websocket.StatusPolicyViolation, Reason: "removed"}
	if _, _, err := c.Read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("close: %v, want 1008", err)
	}
}

// A socket the other computer refuses is answered as the status it was.
func TestMachineProxySocketRefused(t *testing.T) {
	fm := &fakeMachines{status: "online", far: http.NotFoundHandler(), sockErr: websocket.CloseError{Code: 4403, Reason: "no"}}
	s := machinesServer(t, fm)
	r := local("GET", "/v1/m/mini/v1/agents/s1/term", "")
	r.Header.Set("Upgrade", "websocket")
	r.Header.Set("Connection", "Upgrade")
	if w := serve(s, r); w.Code != 403 {
		t.Fatalf("refused socket: %d %s", w.Code, w.Body)
	}
	fm.sockErr = remote.ErrMachineOffline
	if w := serve(s, r); w.Code != 503 {
		t.Fatalf("offline socket: %d %s", w.Code, w.Body)
	}
}
