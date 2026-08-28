package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type fakeAgents struct {
	mu       sync.Mutex
	avail    bool
	inputs   []string
	sigs     []string
	writes   []string    // /term: bytes written to the PTY
	sizes    [][2]int    // /term: {cols, rows} each resize asked for
	snapshot []byte      // /term: snapshot returned on connect (nil ⇒ Term reports not-found)
	termCh   chan []byte // /term: output stream (nil ⇒ Term reports not-found)
}

// wrote and sized read the recorded calls under the lock: the socket handler
// reads on its own goroutine, so a test asserting on these races without it.
func (f *fakeAgents) wrote() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.writes...)
}

func (f *fakeAgents) sized() [][2]int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][2]int(nil), f.sizes...)
}

func (f *fakeAgents) Available() bool { return f.avail }
func (f *fakeAgents) Spawn(_ context.Context, req any) (string, string, error) {
	m := req.(map[string]any)
	return "new-session", m["cwd"].(string), nil
}
func (f *fakeAgents) Input(_ string, d []byte) error {
	f.inputs = append(f.inputs, string(d))
	return nil
}
func (f *fakeAgents) Write(_ string, d []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes = append(f.writes, string(d))
	return nil
}

func (f *fakeAgents) Resize(_ string, cols, rows int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sizes = append(f.sizes, [2]int{cols, rows})
	return nil
}
func (f *fakeAgents) Signal(_ string, a string) error { f.sigs = append(f.sigs, a); return nil }
func (f *fakeAgents) Term(string) ([]byte, <-chan []byte, func(), bool) {
	if f.termCh == nil {
		return nil, nil, nil, false
	}
	return f.snapshot, f.termCh, func() {}, true
}

func TestAgentsEndpoints(t *testing.T) {
	e := newEnv(t)
	fa := &fakeAgents{avail: true}
	// Re-create the server with agents wired.
	e.srv.Config.Handler = New(Deps{Store: e.st, Bus: nil, Table: nil, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, Agents: fa})
	do := func(method, path, body string) *http.Response {
		req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		// The dashboard posts application/json; the origin guard requires it.
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, req)
		return rr.Result()
	}
	if r := do("POST", "/v1/agents", `{"cwd":"/tmp/x","model":"claude-opus-5"}`); r.StatusCode != 200 {
		t.Fatalf("spawn: %d", r.StatusCode)
	}
	if r := do("POST", "/v1/agents/new-session/input", `{"data":"hi\n"}`); r.StatusCode != 204 || len(fa.inputs) != 1 || fa.inputs[0] != "hi\n" {
		t.Fatalf("input: %d %v", r.StatusCode, fa.inputs)
	}
	if r := do("POST", "/v1/agents/new-session/signal", `{"action":"kill"}`); r.StatusCode != 204 || len(fa.sigs) != 1 || fa.sigs[0] != "kill" {
		t.Fatalf("signal: %d %v", r.StatusCode, fa.sigs)
	}
	if r := do("POST", "/v1/agents/x/signal", `{"action":"bogus"}`); r.StatusCode != 400 {
		t.Fatalf("bad action: %d", r.StatusCode)
	}
	// Unavailable → 501.
	fa.avail = false
	if r := do("POST", "/v1/agents", `{"cwd":"/x"}`); r.StatusCode != http.StatusNotImplemented {
		t.Fatalf("unavailable spawn: %d", r.StatusCode)
	}
}

// The terminal WS (/v1/agents/{id}/term) must send the snapshot on connect and
// then stream subsequent output frames. This covers the serveTerm handler
// framing, which had no test (the manager-layer streaming is covered by the
// agents smoke test).
func TestTerminalWebSocketSnapshotAndStream(t *testing.T) {
	e := newEnv(t)
	fa := &fakeAgents{avail: true, snapshot: []byte("SNAP"), termCh: make(chan []byte, 4)}
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok",
		Now: func() time.Time { return e.now }, Agents: fa})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(e.srv.URL, "http") + "/v1/agents/s1/term"
	c, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"http://localhost:5173"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()

	// First frame is the snapshot.
	_, snap, err := c.Read(ctx)
	if err != nil || string(snap) != "SNAP" {
		t.Fatalf("snapshot: %v %q", err, snap)
	}
	// A subsequent output chunk is streamed to the client.
	fa.termCh <- []byte("more-output")
	_, chunk, err := c.Read(ctx)
	if err != nil || string(chunk) != "more-output" {
		t.Fatalf("stream: %v %q", err, chunk)
	}
}

// The socket carries two things: keystrokes and the terminal's size.
//
// Everything arriving on it used to be written to the PTY as input, and
// `Resize` was declared on the interface and called by nothing — so a PTY kept
// whatever size it was born with (120x40 by default) for its whole life. Claude
// Code lays its menus out to the terminal size, so on any other window the
// interface was drawn for a screen the user did not have: arrow keys moved a
// selection that was off screen, which is exactly what "only Enter works" looks
// like from the outside.
func TestTerminalWebSocketResizesThePTY(t *testing.T) {
	e := newEnv(t)
	fa := &fakeAgents{avail: true, snapshot: []byte("SNAP"), termCh: make(chan []byte, 4)}
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok",
		Now: func() time.Time { return e.now }, Agents: fa})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(e.srv.URL, "http") + "/v1/agents/s1/term"
	c, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"http://localhost:5173"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	if _, _, err := c.Read(ctx); err != nil { // drain the snapshot
		t.Fatal(err)
	}

	// A control message resizes and is never written to the PTY as input —
	// otherwise the user's session fills with JSON.
	if err := c.Write(ctx, websocket.MessageText, []byte(`{"resize":{"cols":143,"rows":38}}`)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(fa.sized()) == 1 })
	if got := fa.sized()[0]; got != [2]int{143, 38} {
		t.Errorf("resize = %v, want {143 38}", got)
	}
	if w := fa.wrote(); len(w) != 0 {
		t.Errorf("a control message reached the PTY as input: %q", w)
	}

	// Binary frames are keystrokes, byte for byte — an arrow key is three
	// bytes and must arrive as three bytes.
	if err := c.Write(ctx, websocket.MessageBinary, []byte("\x1b[A")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(fa.wrote()) == 1 })
	if got := fa.wrote()[0]; got != "\x1b[A" {
		t.Errorf("input = %q, want the arrow-key bytes verbatim", got)
	}

	// Text that is not a control message is still input: an older dashboard
	// against a newer daemon must keep typing rather than go mute.
	if err := c.Write(ctx, websocket.MessageText, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(fa.wrote()) == 2 })
	if got := fa.wrote()[1]; got != "hello" {
		t.Errorf("legacy text input = %q, want %q", got, "hello")
	}

	// A nonsense size is ignored rather than passed to the kernel.
	if err := c.Write(ctx, websocket.MessageText, []byte(`{"resize":{"cols":0,"rows":0}}`)); err != nil {
		t.Fatal(err)
	}
	if err := c.Write(ctx, websocket.MessageBinary, []byte("x")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(fa.wrote()) == 3 })
	if n := len(fa.sized()); n != 1 {
		t.Errorf("resizes = %d, want the zero size ignored", n)
	}
}

// waitFor polls a condition the socket goroutine satisfies, so the test does
// not race the handler's own goroutine.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timed out waiting for the socket handler")
}

// POST /v1/paste writes a file and hands back its path.
//
// A browser gives an image's bytes and never a path — there is no path for
// something copied out of a screenshot tool — and Claude Code reads files by
// path. So the bytes become a file here, which makes this the one endpoint
// that writes to disk on a web page's say-so. Most of what follows is about
// what it refuses.
func TestPasteWritesAFileAndRefusesTheRest(t *testing.T) {
	e := newEnv(t)
	dir := t.TempDir()
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok",
		Now: func() time.Time { return e.now }, DataDir: dir})

	post := func(mime string, data []byte) *http.Response {
		b, _ := json.Marshal(map[string]string{"type": mime, "data": base64.StdEncoding.EncodeToString(data)})
		req := httptest.NewRequest("POST", "/v1/paste", bytes.NewReader(b))
		// application/json is what the forgery guard requires, and requiring
		// it is why the bytes travel base64 inside JSON rather than as a raw
		// body: a cross-site simple request cannot set this header, and
		// `image/png` is a simple type — a raw upload would have been an
		// endpoint any web page could use to write into the data directory.
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, req)
		return rr.Result()
	}

	png := []byte("\x89PNG\r\n\x1a\nfake")
	r := post("image/png", png)
	if r.StatusCode != 200 {
		t.Fatalf("png: %d", r.StatusCode)
	}
	var got struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got.Path, dir) || !strings.HasSuffix(got.Path, ".png") {
		t.Errorf("path = %q, want a .png under %q", got.Path, dir)
	}
	if b, err := os.ReadFile(got.Path); err != nil || !bytes.Equal(b, png) {
		t.Errorf("the file on disk does not match what was sent: %v %q", err, b)
	}

	// An allow-list, so a type nobody thought about is refused by default.
	if r := post("application/x-sh", []byte("#!/bin/sh\nrm -rf /")); r.StatusCode != http.StatusUnsupportedMediaType {
		t.Errorf("a shell script was accepted: %d", r.StatusCode)
	}
	if r := post("", []byte("no type at all")); r.StatusCode != http.StatusUnsupportedMediaType {
		t.Errorf("a typeless body was accepted: %d", r.StatusCode)
	}

	// Over the cap is refused rather than truncated: half a screenshot on
	// disk is worse than none.
	if r := post("image/png", bytes.Repeat([]byte("x"), (10<<20)+1)); r.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("an oversized file was accepted: %d", r.StatusCode)
	}
	if r := post("image/png", nil); r.StatusCode != http.StatusBadRequest {
		t.Errorf("an empty file was accepted: %d", r.StatusCode)
	}
}

// The endpoint is behind the same forgery guard as every other state-changing
// route. Without it, `image/png` is a simple content type and any web page in
// the browser could write files into the user's data directory.
func TestPasteRefusesARawUpload(t *testing.T) {
	e := newEnv(t)
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok",
		Now: func() time.Time { return e.now }, DataDir: t.TempDir()})
	req := httptest.NewRequest("POST", "/v1/paste", bytes.NewReader([]byte("raw bytes")))
	req.Header.Set("Content-Type", "image/png")
	rr := httptest.NewRecorder()
	e.srv.Config.Handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Errorf("status %d, want 403 — a simple content type must not reach this", rr.Code)
	}
}

// The filename is ours entirely: nothing the caller sends reaches the
// filesystem, so there is no path to traverse and no extension to smuggle.
func TestPasteNamesTheFileItself(t *testing.T) {
	e := newEnv(t)
	dir := t.TempDir()
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok",
		Now: func() time.Time { return e.now }, DataDir: dir})

	b, _ := json.Marshal(map[string]string{
		"type": "image/png",
		"data": base64.StdEncoding.EncodeToString([]byte("data")),
		// Fields a caller might hope influence the name. The handler reads
		// neither, and this is here so that adding a `name` field later has
		// to face this test.
		"name": "../../../../etc/passwd",
		"path": "/tmp/evil.sh",
	})
	req := httptest.NewRequest("POST", "/v1/paste", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	e.srv.Config.Handler.ServeHTTP(rr, req)
	if rr.Code != 200 {
		t.Fatalf("status %d", rr.Code)
	}
	var got struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(got.Path) != filepath.Join(dir, "paste") {
		t.Errorf("path escaped the paste directory: %q", got.Path)
	}
	if strings.Contains(got.Path, "passwd") || strings.Contains(got.Path, "evil") {
		t.Errorf("a caller-supplied name reached the filesystem: %q", got.Path)
	}
}

// Without a data directory there is nowhere to write, and saying so beats
// writing somewhere arbitrary.
func TestPasteWithoutADataDir(t *testing.T) {
	e := newEnv(t)
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok",
		Now: func() time.Time { return e.now }})
	b, _ := json.Marshal(map[string]string{"type": "image/png", "data": "eA=="})
	req := httptest.NewRequest("POST", "/v1/paste", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	e.srv.Config.Handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotImplemented {
		t.Errorf("status %d, want 501", rr.Code)
	}
}
