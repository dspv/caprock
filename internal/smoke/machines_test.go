//go:build smoke

package smoke

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/dspv/caprock/internal/peers"
	"github.com/dspv/caprock/internal/remote"
	"github.com/dspv/caprock/internal/remote/relaysrv"
)

// ADR-067, Phase 1's first step end to end: one computer reaches another's
// sessions through a relay, with nothing changed on the other computer.
//
// The target is the real binary in its own home and data directory, with
// access from anywhere on at a relay that runs in this test on loopback
// (relaysrv — never the hosted one). The controller is this test's own
// internal/peers, in a second data directory: what PR2 wires into the daemon.
// It pairs with a code the target showed, starts the fake claude there,
// types into its terminal and reads the echo; survives the relay restarting;
// and finds out when the target revokes it.
func TestAComputerWorksOnAnotherThroughTheRelay(t *testing.T) {
	root := t.TempDir()
	if r, err := filepath.EvalSymlinks(root); err == nil {
		root = r // macOS: /var is /private/var, and spawns are checked against the real home
	}
	bin := filepath.Join(root, "bin")
	home := filepath.Join(root, "home")
	data := filepath.Join(root, "data")
	proj := filepath.Join(home, "proj")
	mine := filepath.Join(root, "controller")
	for _, d := range []string{bin, home, data, proj, mine} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	exe := ""
	if runtime.GOOS == "windows" {
		exe = ".exe"
	}
	caprock := filepath.Join(bin, "caprock"+exe)
	goBuild(t, caprock, "./cmd/caprock")
	goBuild(t, filepath.Join(bin, "claude"+exe), "./testdata/fakeclaude")
	t.Cleanup(func() {
		killHolders(t, data)
		if runtime.GOOS == "windows" {
			time.Sleep(2 * time.Second)
		}
	})

	relay := startRelay(t, "127.0.0.1:0")
	relayURL := "ws://" + relay.addr

	port := freePort(t)
	base := "http://127.0.0.1:" + strconv.Itoa(port)
	env := append(daemonEnv(bin, home, data), "CAPROCK_SECRET_STORE=file")
	target := startBinary(t, caprock, env, port, data, "target")

	// On the target, by its owner: access from anywhere on at this relay,
	// and a code that pairs a controller.
	post(t, base+"/v1/pair/remote", `{"on":true,"relay":"`+relayURL+`"}`)
	waitRemoteOnline(t, base, target)
	var code struct {
		Code   string `json:"code"`
		Remote struct {
			Link string `json:"link"`
		} `json:"remote"`
	}
	if err := json.Unmarshal(post(t, base+"/v1/pair/code", `{"role":"controller"}`), &code); err != nil || code.Remote.Link == "" {
		t.Fatalf("no pairing link: %v %+v", err, code)
	}

	// On the controller: paste the link.
	m, err := peers.Open(peers.Options{Dir: mine, Name: "MacBook"})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	st, err := m.Pair(ctx, code.Remote.Link)
	if err != nil {
		t.Fatalf("pair: %v\ntarget log:\n%s", err, target.log())
	}
	if st.Role != "controller" || st.Status != "online" || st.Version == "" {
		t.Fatalf("paired as %+v", st)
	}
	if runtime.GOOS != "windows" {
		if fi, err := os.Stat(filepath.Join(mine, peers.File)); err != nil || fi.Mode().Perm() != 0o600 {
			t.Fatalf("%s: %v %v", peers.File, fi, err)
		}
	}
	var devices struct {
		Devices []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
			Role string `json:"role"`
			Via  string `json:"via"`
		} `json:"devices"`
	}
	getJSONAt(t, base+"/v1/pair/state", &devices)
	if len(devices.Devices) != 1 || devices.Devices[0].Name != "MacBook" || devices.Devices[0].Role != "controller" || devices.Devices[0].Via != "relay" {
		t.Fatalf("the target lists %+v", devices.Devices)
	}

	// Start the fake claude there, through the target's own daemon.
	var spawned struct {
		SessionID string `json:"session_id"`
	}
	if code := doJSON(t, m, st.ID, "POST", "/v1/agents", `{"cwd":`+strconv.Quote(proj)+`}`, &spawned); code != 200 || spawned.SessionID == "" {
		t.Fatalf("spawn through the relay: %d %+v\ntarget log:\n%s", code, spawned, target.log())
	}
	id := spawned.SessionID
	var list json.RawMessage
	if code := doJSON(t, m, st.ID, "GET", "/v1/sessions", "", &list); code != 200 || !strings.Contains(string(list), id) {
		t.Fatalf("sessions through the relay: %d, without %s: %.300s", code, id, list)
	}

	term := remoteTerm(t, m, st.ID, id)
	term.waitFor(t, "fake-claude ready")
	term.send(t, "over-the-relay\r")
	term.waitFor(t, "you-said:over-the-relay")

	// The relay restarts: the open terminal drops, the session on the target
	// does not, and the terminal reopens on a new channel.
	relay.stop()
	term.waitClosed(t)
	if s := getSession(t, base, id); s.Status == "ended" {
		t.Fatalf("the session ended when the relay did")
	}
	if got, _ := m.Get(st.ID); got.Status == "online" {
		t.Fatalf("still online with the relay down: %+v", got)
	}
	relay = startRelay(t, relay.addr)
	waitRemoteOnline(t, base, target)
	deadline := time.Now().Add(30 * time.Second)
	var term2 *channelTerm
	for term2 == nil {
		if time.Now().After(deadline) {
			t.Fatal("the terminal never reopened after the relay came back")
		}
		term2 = tryRemoteTerm(m, st.ID, id)
		if term2 == nil {
			time.Sleep(300 * time.Millisecond)
		}
	}
	term2.send(t, "again\r")
	term2.waitFor(t, "you-said:again")

	// Revoked on the target: the next keystroke closes the terminal with
	// 1008, and the controller says it was removed.
	req, _ := http.NewRequest(http.MethodDelete, base+"/v1/pair/devices/"+devices.Devices[0].ID, nil)
	req.Header.Set("Content-Type", "application/json") // the forgery guard (csrf.go)
	res, err := http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("revoke: %v %v", res, err)
	}
	_ = res.Body.Close()
	term2.sendQuiet("x")
	select {
	case code := <-term2.closed:
		if code != websocket.StatusPolicyViolation {
			t.Fatalf("after revoke the terminal closed with %d, want 1008", code)
		}
	case <-time.After(30 * time.Second):
		t.Fatalf("after revoke the terminal through the relay stayed open\ntarget log:\n%s", target.log())
	}
	if got, _ := m.Check(ctx, st.ID); got.Status != peers.StatusRevoked {
		t.Fatalf("after revoke: %+v", got)
	}
	// Not transitive, and nothing more: a request now is refused there.
	if code := doJSON(t, m, st.ID, "GET", "/v1/sessions", "", nil); code != http.StatusUnauthorized {
		t.Fatalf("a revoked computer read sessions: %d", code)
	}
	relay.stop()
	// The session was the target's to start and is the target's to stop.
	post(t, base+"/v1/agents/"+id+"/signal", `{"action":"kill"}`)
	target.stop(t, true)
}

// testRelay is relaysrv on a loopback address, able to stop as a relay does:
// every connection dropped, the WebSockets with them.
type testRelay struct {
	addr  string
	srv   *http.Server
	mu    sync.Mutex
	conns []net.Conn
}

func startRelay(t *testing.T, addr string) *testRelay {
	t.Helper()
	var ln net.Listener
	var err error
	deadline := time.Now().Add(15 * time.Second)
	for {
		ln, err = net.Listen("tcp", addr)
		if err == nil || time.Now().After(deadline) {
			break
		}
		time.Sleep(200 * time.Millisecond) // the port is ours; the OS is letting go of it
	}
	if err != nil {
		t.Fatal(err)
	}
	r := &testRelay{addr: ln.Addr().String()}
	r.srv = &http.Server{Handler: relaysrv.New(nil), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = r.srv.Serve(&trackingListener{Listener: ln, r: r}) }()
	t.Cleanup(r.stop)
	return r
}

func (r *testRelay) stop() {
	_ = r.srv.Close()
	r.mu.Lock()
	for _, c := range r.conns {
		_ = c.Close()
	}
	r.conns = nil
	r.mu.Unlock()
}

type trackingListener struct {
	net.Listener
	r *testRelay
}

func (l *trackingListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err == nil {
		l.r.mu.Lock()
		l.r.conns = append(l.r.conns, c)
		l.r.mu.Unlock()
	}
	return c, err
}

func waitRemoteOnline(t *testing.T, base string, p *proc) {
	const want = "online"
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for {
		var st struct {
			Remote struct {
				Status string `json:"status"`
				Error  string `json:"error"`
			} `json:"remote"`
		}
		getJSONAt(t, base+"/v1/pair/state", &st)
		if st.Remote.Status == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("remote access is %+v, want %s\ndaemon log:\n%s", st.Remote, want, p.log())
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func getJSONAt(t *testing.T, url string, out any) {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
}

// doJSON makes one request to computer id through the relay.
func doJSON(t *testing.T, m *peers.Manager, id, method, path, body string, out any) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, _ := http.NewRequestWithContext(ctx, method, "http://machine"+path, rd)
	req.Header.Set("Content-Type", "application/json")
	res, err := m.Do(id, req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if out != nil && res.StatusCode < 300 {
		if err := json.Unmarshal(b, out); err != nil {
			t.Fatalf("%s %s: %v: %s", method, path, err, b)
		}
	}
	return res.StatusCode
}

// channelTerm is a session's terminal on another computer.
type channelTerm struct {
	ws     *remote.WSConn
	mu     sync.Mutex
	buf    strings.Builder
	closed chan websocket.StatusCode
}

func tryRemoteTerm(m *peers.Manager, mid, id string) *channelTerm {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	ws, err := m.OpenWS(ctx, mid, "/v1/agents/"+id+"/term", nil)
	if err != nil {
		return nil
	}
	tc := &channelTerm{ws: ws, closed: make(chan websocket.StatusCode, 1)}
	go func() {
		for {
			_, b, err := ws.Read(context.Background())
			if err != nil {
				var ce websocket.CloseError
				code := websocket.StatusAbnormalClosure
				if errors.As(err, &ce) {
					code = ce.Code
				}
				tc.closed <- code
				return
			}
			tc.mu.Lock()
			tc.buf.Write(b)
			tc.mu.Unlock()
		}
	}()
	return tc
}

func remoteTerm(t *testing.T, m *peers.Manager, mid, id string) *channelTerm {
	t.Helper()
	tc := tryRemoteTerm(m, mid, id)
	if tc == nil {
		t.Fatal("could not open the terminal through the relay")
	}
	return tc
}

func (tc *channelTerm) send(t *testing.T, s string) {
	t.Helper()
	if err := tc.ws.Write(context.Background(), websocket.MessageBinary, []byte(s)); err != nil {
		t.Fatalf("type through the relay: %v", err)
	}
}

func (tc *channelTerm) sendQuiet(s string) {
	_ = tc.ws.Write(context.Background(), websocket.MessageBinary, []byte(s))
}

func (tc *channelTerm) waitFor(t *testing.T, want string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		tc.mu.Lock()
		hit := strings.Contains(tc.buf.String(), want)
		tc.mu.Unlock()
		if hit {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	tc.mu.Lock()
	defer tc.mu.Unlock()
	t.Fatalf("the terminal through the relay never showed %q; it showed %q", want, tc.buf.String())
}

func (tc *channelTerm) waitClosed(t *testing.T) websocket.StatusCode {
	t.Helper()
	select {
	case code := <-tc.closed:
		return code
	case <-time.After(30 * time.Second):
		t.Fatal("the terminal through the relay stayed open")
		return 0
	}
}
