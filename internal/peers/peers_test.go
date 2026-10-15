package peers_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/dspv/caprock/internal/peers"
	"github.com/dspv/caprock/internal/remote"
	"github.com/dspv/caprock/internal/remote/relaysrv"
)

// target stands in for another computer's daemon: the pairing routes and a
// gate that knows one token, behind a real Host on a real relay.
type target struct {
	mu     sync.Mutex
	code   string
	tokens map[string]string // token → role
	seen   http.Header       // the last /v1/echo request's headers
	// pending answers GET /v1/pair/me as a computer that waits for the
	// owner's Allow (ADR-067).
	pending bool
	set     *remote.Settings
	keys    *remote.Keys
	relay   *httptest.Server
}

func newTarget(t *testing.T) *target {
	t.Helper()
	tg := &target{tokens: map[string]string{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/pair", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Code, Name string }
		_ = json.NewDecoder(r.Body).Decode(&req)
		tg.mu.Lock()
		defer tg.mu.Unlock()
		if tg.code == "" || req.Code != tg.code || req.Name != "MacBook" {
			http.Error(w, `{"error":"no"}`, http.StatusUnauthorized)
			return
		}
		tg.code = ""
		tg.tokens["tok-1"] = "controller"
		_ = json.NewEncoder(w).Encode(map[string]string{"token": "tok-1", "id": "dev-1", "name": req.Name})
	})
	auth := func(r *http.Request) string {
		tok := r.Header.Get("X-Caprock-Device")
		for _, p := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
			if after, ok := strings.CutPrefix(strings.TrimSpace(p), "caprock.device."); ok {
				tok = after
			}
		}
		tg.mu.Lock()
		defer tg.mu.Unlock()
		if r.Header.Get("Via") == "" {
			return "" // only relayed requests are under test
		}
		return tg.tokens[tok]
	}
	mux.HandleFunc("GET /v1/pair/me", func(w http.ResponseWriter, r *http.Request) {
		role := auth(r)
		if role == "" {
			http.Error(w, `{"error":"not paired"}`, http.StatusUnauthorized)
			return
		}
		tg.mu.Lock()
		pending := tg.pending
		tg.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"role": role, "id": "dev-1", "kind": "machine", "pending": pending})
	})
	mux.HandleFunc("DELETE /v1/pair/me", func(w http.ResponseWriter, r *http.Request) {
		if auth(r) == "" {
			http.Error(w, `{"error":"not paired"}`, http.StatusUnauthorized)
			return
		}
		tg.mu.Lock()
		tg.tokens = map[string]string{}
		tg.mu.Unlock()
		_, _ = io.WriteString(w, `{"revoked":1}`)
	})
	mux.HandleFunc("/v1/echo", func(w http.ResponseWriter, r *http.Request) {
		if auth(r) == "" {
			http.Error(w, `{"error":"not paired"}`, http.StatusUnauthorized)
			return
		}
		tg.mu.Lock()
		tg.seen = r.Header.Clone()
		tg.mu.Unlock()
		_, _ = io.WriteString(w, "ok:"+r.URL.RawQuery)
	})
	mux.HandleFunc("/v1/live", func(w http.ResponseWriter, r *http.Request) {
		if auth(r) == "" {
			http.Error(w, "not paired", http.StatusUnauthorized)
			return
		}
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"caprock.term.v2"}})
		if err != nil {
			return
		}
		defer func() { _ = c.CloseNow() }()
		for {
			typ, msg, err := c.Read(r.Context())
			if err != nil {
				return
			}
			_ = c.Write(r.Context(), typ, append([]byte("echo:"), msg...))
		}
	})
	daemon := httptest.NewServer(mux)
	t.Cleanup(daemon.Close)
	tg.relay = httptest.NewServer(relaysrv.New(nil))
	t.Cleanup(tg.relay.Close)
	set, err := remote.Load(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	set.Relay = "ws" + strings.TrimPrefix(tg.relay.URL, "http")
	keys, _ := set.Keys()
	tg.set, tg.keys = set, keys
	h := remote.NewHost(remote.Options{Relay: set.Relay, Keys: keys, Local: daemon.URL, Version: "9.9.9", Name: "mini"})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go h.Run(ctx)
	deadline := time.Now().Add(5 * time.Second)
	for h.State().Status != "online" {
		if time.Now().After(deadline) {
			t.Fatal("target never reached the relay")
		}
		time.Sleep(10 * time.Millisecond)
	}
	return tg
}

// link shows a fresh code on the target and returns its pairing link.
func (tg *target) link(code string) string {
	tg.mu.Lock()
	tg.code = code
	tg.mu.Unlock()
	return remote.PairLink(tg.set, tg.keys, code, "Mac mini")
}

func (tg *target) revoke() {
	tg.mu.Lock()
	tg.tokens = map[string]string{}
	tg.mu.Unlock()
}

func open(t *testing.T, dir string) *peers.Manager {
	t.Helper()
	m, err := peers.Open(peers.Options{Dir: dir, Name: "MacBook", Idle: 200 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	return m
}

func ctx5(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func TestPairingWithAComputerKeepsItsTokenPrivate(t *testing.T) {
	tg := newTarget(t)
	dir := t.TempDir()
	m := open(t, dir)
	st, err := m.Pair(ctx5(t), tg.link("123456"))
	if err != nil {
		t.Fatal(err)
	}
	if st.ID != tg.keys.HostID() || st.Name != "Mac mini" || st.Role != "controller" || st.Status != "online" || st.Version != "9.9.9" {
		t.Fatalf("status = %+v", st)
	}
	b, _ := json.Marshal(m.List())
	if strings.Contains(string(b), "tok-1") {
		t.Fatalf("the list carries the token: %s", b)
	}
	saved, err := peers.Read(dir)
	if err != nil || len(saved) != 1 || saved[0].Token != "tok-1" || saved[0].DeviceID != "dev-1" || saved[0].Key != tg.keys.StaticPublic() {
		t.Fatalf("saved = %+v, %v", saved, err)
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(filepath.Join(dir, peers.File))
		if fi.Mode().Perm() != 0o600 {
			t.Fatalf("%s is %v, want 0600", peers.File, fi.Mode().Perm())
		}
	}
}

func TestAWrongCodePairsNothing(t *testing.T) {
	tg := newTarget(t)
	dir := t.TempDir()
	m := open(t, dir)
	tg.link("123456")
	if _, err := m.Pair(ctx5(t), remote.PairLink(tg.set, tg.keys, "654321", "Mac mini")); !errors.Is(err, peers.ErrBadCode) {
		t.Fatalf("err = %v, want bad code", err)
	}
	if _, err := m.Pair(ctx5(t), remote.PairLink(tg.set, tg.keys, "", "Mac mini")); !errors.Is(err, peers.ErrNoCode) {
		t.Fatalf("err = %v, want no code", err)
	}
	if len(m.List()) != 0 {
		t.Fatal("a failed pairing was listed")
	}
	if _, err := os.Stat(filepath.Join(dir, peers.File)); err == nil {
		t.Fatal("a failed pairing was saved")
	}
}

func TestALinkForThisComputerIsRefused(t *testing.T) {
	tg := newTarget(t)
	m, _ := peers.Open(peers.Options{Dir: t.TempDir(), Name: "MacBook", Self: tg.keys.HostID()})
	defer m.Close()
	if _, err := m.Pair(ctx5(t), tg.link("123456")); !errors.Is(err, peers.ErrSelf) {
		t.Fatalf("err = %v, want self", err)
	}
}

func TestRequestsArriveAsThePairedDevice(t *testing.T) {
	tg := newTarget(t)
	m := open(t, t.TempDir())
	st, err := m.Pair(ctx5(t), tg.link("111111"))
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequestWithContext(ctx5(t), "GET", "http://127.0.0.1:1/v1/echo?a=1", nil)
	req.Header.Set("Cookie", "session=local")
	req.Header.Set("Origin", "http://127.0.0.1:22776")
	req.Header.Set("X-Caprock-Device", "this-machines-own-guest")
	res, err := m.Do(st.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if res.StatusCode != 200 || string(b) != "ok:a=1" {
		t.Fatalf("%d %s", res.StatusCode, b)
	}
	tg.mu.Lock()
	seen := tg.seen
	tg.mu.Unlock()
	if seen.Get("X-Caprock-Device") != "tok-1" || seen.Get("Cookie") != "" || seen.Get("Origin") != "" || seen.Get("Via") != "1.1 caprock-remote" {
		t.Fatalf("the target saw %v", seen)
	}

	ws, err := m.OpenWS(ctx5(t), st.ID, "/v1/live", []string{"caprock.term.v2"})
	if err != nil {
		t.Fatal(err)
	}
	if ws.Subprotocol() != "caprock.term.v2" {
		t.Fatalf("subprotocol %q", ws.Subprotocol())
	}
	_ = ws.Write(ctx5(t), websocket.MessageText, []byte("hi"))
	if _, msg, err := ws.Read(ctx5(t)); err != nil || string(msg) != "echo:hi" {
		t.Fatalf("%v %q", err, msg)
	}
	_ = ws.Close(websocket.StatusNormalClosure, "")

	if _, err := m.Do("nobody", req); !errors.Is(err, peers.ErrUnknown) {
		t.Fatalf("unknown computer: %v", err)
	}
}

// Removed on the computer, this machine says so — and comes back by itself
// if the computer is wrong about it.
func TestARevokedComputerIsSaidSo(t *testing.T) {
	tg := newTarget(t)
	m := open(t, t.TempDir())
	st, err := m.Pair(ctx5(t), tg.link("222222"))
	if err != nil {
		t.Fatal(err)
	}
	tg.revoke()
	req, _ := http.NewRequestWithContext(ctx5(t), "GET", "http://machine/v1/echo", nil)
	res, err := m.Do(st.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d", res.StatusCode)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		got, _ := m.Get(st.ID)
		if got.Status == peers.StatusRevoked {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("still %+v after a 401", got)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if ws, err := m.OpenWS(ctx5(t), st.ID, "/v1/live", nil); websocket.CloseStatus(err) != 4401 {
		t.Fatalf("a revoked machine's socket: %v %v", ws, err)
	}
	tg.mu.Lock()
	tg.tokens["tok-1"] = "viewer"
	tg.mu.Unlock()
	if got, err := m.Check(ctx5(t), st.ID); err != nil || got.Status == peers.StatusRevoked || got.Role != "viewer" {
		t.Fatalf("after the computer knew it again: %+v %v", got, err)
	}
}

func TestComputersSurviveARestartAndCanBeRenamedAndForgotten(t *testing.T) {
	tg := newTarget(t)
	dir := t.TempDir()
	m := open(t, dir)
	st, err := m.Pair(ctx5(t), tg.link("333333"))
	if err != nil {
		t.Fatal(err)
	}
	m.Close()

	m2 := open(t, dir)
	list := m2.List()
	if len(list) != 1 || list[0].ID != st.ID || list[0].Status != "idle" {
		t.Fatalf("after a restart: %+v", list)
	}
	req, _ := http.NewRequestWithContext(ctx5(t), "GET", "http://machine/v1/echo", nil)
	res, err := m2.Do(st.ID, req)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("after a restart: %v %v", res, err)
	}
	_ = res.Body.Close()

	if err := m2.Rename(st.ID, "  Studio\x07 "); err != nil {
		t.Fatal(err)
	}
	if err := m2.Rename(st.ID, "   "); err == nil {
		t.Fatal("an empty name was taken")
	}
	if saved, _ := peers.Read(dir); saved[0].Name != "Studio" {
		t.Fatalf("renamed to %q", saved[0].Name)
	}
	if err := m2.Forget(st.ID); err != nil {
		t.Fatal(err)
	}
	if err := m2.Forget(st.ID); !errors.Is(err, peers.ErrUnknown) {
		t.Fatalf("forgetting twice: %v", err)
	}
	if saved, _ := peers.Read(dir); len(saved) != 0 || len(m2.List()) != 0 {
		t.Fatalf("still kept: %+v", saved)
	}
}

func TestACorruptListIsEmptyNotFatal(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, peers.File), []byte("{nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	m, err := peers.Open(peers.Options{Dir: dir})
	if err == nil {
		t.Fatal("a corrupt list read without complaint")
	}
	defer m.Close()
	if len(m.List()) != 0 {
		t.Fatal("a corrupt list listed something")
	}
}

// A computer that took the code waits for its owner's Allow, and the list
// says so; once allowed it is online as a computer. Leave asks it to drop
// this machine, after which it is revoked here.
func TestPendingThenAllowedThenLeft(t *testing.T) {
	tg := newTarget(t)
	tg.mu.Lock()
	tg.pending = true
	tg.mu.Unlock()
	m := open(t, t.TempDir())
	st, err := m.Pair(ctx5(t), tg.link("123456"))
	if err != nil {
		t.Fatal(err)
	}
	if st.Status != peers.StatusPending || st.Kind != "machine" || st.Error == "" {
		t.Fatalf("while waiting: %+v", st)
	}
	tg.mu.Lock()
	tg.pending = false
	tg.mu.Unlock()
	if st, _ = m.Check(ctx5(t), st.ID); st.Status != "online" || st.Role != "controller" || st.Kind != "machine" {
		t.Fatalf("after allow: %+v", st)
	}
	if err := m.Leave(ctx5(t), st.ID); err != nil {
		t.Fatal(err)
	}
	if st, _ = m.Check(ctx5(t), st.ID); st.Status != peers.StatusRevoked {
		t.Fatalf("after leaving: %+v", st)
	}
	if err := m.Leave(ctx5(t), st.ID); err == nil {
		t.Fatal("leaving twice succeeded")
	}
	if err := m.Leave(ctx5(t), "nope"); !errors.Is(err, peers.ErrUnknown) {
		t.Fatalf("leave an unknown one: %v", err)
	}
}

func TestABadLinkSaysWhy(t *testing.T) {
	m := open(t, t.TempDir())
	_, err := m.Pair(ctx5(t), "hello")
	if !errors.Is(err, peers.ErrBadLink) || !strings.Contains(err.Error(), "pairing link") {
		t.Fatalf("err = %v", err)
	}
}
