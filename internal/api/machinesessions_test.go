package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/peers"
	"github.com/dspv/caprock/internal/remote"
)

type machineSessionsAnswer struct {
	Machines []MachineSessions `json:"machines"`
}

func readMachineSessions(t *testing.T, s *Server) MachineSessions {
	t.Helper()
	w := serve(s, local("GET", "/v1/machines/sessions", ""))
	var got machineSessionsAnswer
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != 200 || len(got.Machines) != 1 {
		t.Fatalf("GET /v1/machines/sessions: %d %s", w.Code, w.Body)
	}
	return got.Machines[0]
}

// One read per computer serves every window for a while; a word from the
// computer, or a start through the proxy, has it read again.
func TestMachineSessionsAreKeptAndDropped(t *testing.T) {
	var hits atomic.Int32
	fm := &fakeMachines{status: "online", far: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/sessions" {
			hits.Add(1)
			if r.URL.Query().Get("active") != "true" || r.URL.Query().Get("chats") != "exclude" {
				t.Errorf("asked %s", r.URL)
			}
			_, _ = w.Write([]byte(`[{"session_id":"s1","status":"active"}]`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	})}
	s := machinesServer(t, fm)
	got := readMachineSessions(t, s)
	if got.Status != "online" || got.Name != "Mac mini" || !strings.Contains(string(got.Sessions), `"s1"`) || got.At == 0 || got.LastOK != got.At {
		t.Fatalf("first read: %+v (%s)", got, got.Sessions)
	}
	readMachineSessions(t, s)
	if n := hits.Load(); n != 1 {
		t.Fatalf("two reads asked the computer %d times, want once", n)
	}
	s.MachineChanged("mini")
	readMachineSessions(t, s)
	if n := hits.Load(); n != 2 {
		t.Fatalf("after the computer's word: %d asks, want 2", n)
	}
	if w := serve(s, local("POST", "/v1/m/mini/v1/agents", `{"cwd":"/x"}`)); w.Code != 200 {
		t.Fatalf("a start through the proxy: %d", w.Code)
	}
	readMachineSessions(t, s)
	if n := hits.Load(); n != 3 {
		t.Fatalf("after a start through the proxy: %d asks, want 3", n)
	}
}

// Offline is said with why, and a list from before is not shown as what
// runs there now; the last good read is dated.
func TestMachineSessionsOffline(t *testing.T) {
	fm := &fakeMachines{status: "online", far: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[]`))
	})}
	s := machinesServer(t, fm)
	first := readMachineSessions(t, s)
	fm.mu.Lock()
	fm.doErr = remote.ErrMachineOffline
	fm.mu.Unlock()
	s.MachineChanged("mini")
	got := readMachineSessions(t, s)
	if got.Status != "offline" || got.Sessions != nil || got.Error == "" || got.LastOK != first.At {
		t.Fatalf("offline: %+v", got)
	}
	if b, _ := json.Marshal(got); strings.Contains(string(b), `"sessions"`) {
		t.Fatalf("an offline computer carries a list: %s", b)
	}
}

// A computer waiting for Allow, or one that removed this machine, is said
// and not asked: nothing there answers until its owner acts.
func TestMachineSessionsNotAskedBeforeAllow(t *testing.T) {
	for _, st := range []string{peers.StatusPending, peers.StatusRevoked} {
		var hits atomic.Int32
		fm := &fakeMachines{status: st, far: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			hits.Add(1)
			_, _ = w.Write([]byte(`[]`))
		})}
		got := readMachineSessions(t, machinesServer(t, fm))
		if got.Status != st || got.Sessions != nil || hits.Load() != 0 {
			t.Fatalf("%s: %+v, asked %d times", st, got, hits.Load())
		}
	}
	// The computer's own 403 while it waits reads as pending too.
	fm := &fakeMachines{status: "online", far: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"this computer is waiting to be allowed"}`))
	})}
	if got := readMachineSessions(t, machinesServer(t, fm)); got.Status != peers.StatusPending || !strings.Contains(got.Error, "waiting") {
		t.Fatalf("a 403 there: %+v", got)
	}
}

// The one list is this machine's own, like every computer route.
func TestMachineSessionsAreThisMachinesOnly(t *testing.T) {
	s := machinesServer(t, &fakeMachines{status: "online", far: http.NotFoundHandler()})
	r := local("GET", "/v1/machines/sessions", "")
	r.Header.Set("Via", "1.1 caprock-remote")
	if w := serve(s, r); w.Code != 401 && w.Code != 403 {
		t.Fatalf("relayed: %d", w.Code)
	}
}

// What another computer said reaches this machine's own clients only, and a
// client that asked for some types gets those and the socket's own frames.
func TestLiveSkips(t *testing.T) {
	remoteNotify := bus.Frame{Type: bus.FrameNotify, LocalOnly: true}
	if liveSkips(remoteNotify, true, nil) || !liveSkips(remoteNotify, false, nil) {
		t.Fatal("a local-only frame: shown here, never to a device")
	}
	only, err := liveTypes("notify, permission")
	if err != nil || len(only) != 2 {
		t.Fatalf("types: %v %v", only, err)
	}
	for typ, skipped := range map[bus.FrameType]bool{bus.FrameNotify: false, bus.FramePermission: false, bus.FrameEvent: true, bus.FrameSession: true, "reset": false, "ping": false} {
		if got := liveSkips(bus.Frame{Type: typ}, false, only); got != skipped {
			t.Errorf("%s with types=notify,permission: skipped %v, want %v", typ, got, skipped)
		}
	}
	for _, bad := range []string{"Notify", "a;b", strings.Repeat("x", 40)} {
		if _, err := liveTypes(bad); err == nil {
			t.Errorf("types=%q accepted", bad)
		}
	}
	if only, err := liveTypes(""); only != nil || err != nil {
		t.Fatal("no types is every type")
	}
}

// ?types= on a real socket: an event is not sent, a notify is, in order.
func TestLiveTypesOnTheSocket(t *testing.T) {
	e := newEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c := dialLive(t, ctx, e, "?types=notify")
	if hello := nextLive(t, ctx, c); hello.Type != "hello" {
		t.Fatalf("hello: %+v", hello)
	}
	waitSubscribers(t, e.bus, 1)
	e.bus.Publish(bus.Frame{Type: bus.FrameEvent, Data: "not asked for"})
	e.bus.Publish(bus.Frame{Type: bus.FrameNotify, Data: "asked for"})
	if f := nextLive(t, ctx, c); f.Type != "notify" || string(f.Data) != `"asked for"` {
		t.Fatalf("got %+v", f)
	}
}
