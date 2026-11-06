package daemon

import (
	"context"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/peers"
)

// scriptedSocket answers the frames it was given, then ends as a dropped
// socket does.
type scriptedSocket struct {
	mu     sync.Mutex
	frames [][]byte
}

func (s *scriptedSocket) Read(ctx context.Context) (websocket.MessageType, []byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.frames) == 0 {
		return 0, nil, io.EOF
	}
	f := s.frames[0]
	s.frames = s.frames[1:]
	return websocket.MessageText, f, nil
}
func (s *scriptedSocket) Write(context.Context, websocket.MessageType, []byte) error { return nil }
func (s *scriptedSocket) Close(websocket.StatusCode, string) error                   { return nil }
func (s *scriptedSocket) Subprotocol() string                                        { return "" }

// watchFake is one computer whose /v1/live answers the next script on each
// open, and records the paths asked and when.
type watchFake struct {
	mu      sync.Mutex
	paths   []string
	at      []time.Time
	scripts [][][]byte
	opened  chan struct{}
	// status is what Get says until Check is asked; Check makes it online.
	status string
	checks int
	// refuse is how many opens are refused with 4403, as a computer that
	// waits for its owner's Allow refuses them.
	refuse int
	// refusing is true while the last open was refused: a check then
	// still hears "pending".
	refusing bool
}

func (f *watchFake) List() []peers.Status { return []peers.Status{{ID: "m1", Name: "home"}} }
func (f *watchFake) Get(string) (peers.Status, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	st := f.status
	if st == "" {
		st = "online"
	}
	return peers.Status{ID: "m1", Name: "home", Status: st}, nil
}
func (f *watchFake) Check(context.Context, string) (peers.Status, error) {
	f.mu.Lock()
	f.checks++
	if !f.refusing {
		f.status = "online"
	}
	f.mu.Unlock()
	return f.Get("m1")
}
func (f *watchFake) OpenWS(_ context.Context, _, path string, _ []string) (api.MachineSocket, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.paths = append(f.paths, path)
	f.at = append(f.at, time.Now())
	f.refusing = f.refuse > 0
	if f.refusing {
		f.refuse--
		return nil, websocket.CloseError{Code: 4403, Reason: "waiting to be allowed"}
	}
	var frames [][]byte
	if len(f.scripts) > 0 {
		frames, f.scripts = f.scripts[0], f.scripts[1:]
	}
	if f.opened != nil {
		select {
		case f.opened <- struct{}{}:
		default:
		}
	}
	return &scriptedSocket{frames: frames}, nil
}

func frame(t *testing.T, typ string, seq uint64, data any) []byte {
	t.Helper()
	b, err := json.Marshal(map[string]any{"type": typ, "seq": seq, "data": data})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// A computer that restarted counts its frames from 1 again. The watch must
// resume from where that computer now stands, not from the highest seq it
// ever heard: a since past the computer's newest frame earns a reset on every
// reconnect, and whatever was said while the socket was down is lost.
func TestMachineWatchFollowsARestartedComputer(t *testing.T) {
	d := &Daemon{bus: bus.New()}
	f := &watchFake{opened: make(chan struct{}, 8), scripts: [][][]byte{
		// Before the restart: far along.
		{
			frame(t, "hello", 500, map[string]any{"reset": false}),
			frame(t, "notify", 501, map[string]any{"id": "n1", "title": "t", "session_id": "s1"}),
		},
		// After it: the since of 501 is past its newest, so a reset, then
		// its own count.
		{
			frame(t, "hello", 3, map[string]any{"reset": true}),
			frame(t, "reset", 3, map[string]any{"seq": 3}),
			frame(t, "permission", 4, map[string]any{"session_id": "s2", "permission": map[string]any{"tool": "Bash"}}),
			frame(t, "ping", 7, 0),
		},
	}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		d.watchMachine(ctx, f, "m1", watchPace{min: time.Millisecond, max: 4 * time.Millisecond, stable: time.Hour})
	}()
	for range 3 {
		select {
		case <-f.opened:
		case <-time.After(5 * time.Second):
			t.Fatal("the watch did not reopen the socket")
		}
	}
	cancel()
	<-done
	f.mu.Lock()
	defer f.mu.Unlock()
	want := []string{
		"/v1/live?types=notify,permission",
		"/v1/live?types=notify,permission&since=501",
		"/v1/live?types=notify,permission&since=7",
	}
	for i, w := range want {
		if f.paths[i] != w {
			t.Fatalf("open %d asked %q, want %q (all: %q)", i+1, f.paths[i], w, f.paths)
		}
	}
}

// A computer that lets the socket in and drops it at once is waited out as a
// failed attempt is, the wait doubling, rather than re-dialled — and every
// window's list re-read — at the shortest wait for as long as it does so.
func TestMachineWatchBacksOffASocketThatDropsAtOnce(t *testing.T) {
	d := &Daemon{bus: bus.New()}
	f := &watchFake{}
	ctx, cancel := context.WithTimeout(context.Background(), 700*time.Millisecond)
	defer cancel()
	d.watchMachine(ctx, f, "m1", watchPace{min: 20 * time.Millisecond, max: 160 * time.Millisecond, stable: time.Hour})
	f.mu.Lock()
	defer f.mu.Unlock()
	// 20, 40, 80, 160, 160, … ms apart: about 7 opens in 700 ms, where a
	// fixed 20 ms would be about 35.
	if len(f.at) > 10 {
		t.Fatalf("%d opens in 700 ms: the watch did not back off", len(f.at))
	}
	if len(f.at) < 3 {
		t.Fatalf("only %d opens: the watch stopped retrying", len(f.at))
	}
	first, last := f.at[1].Sub(f.at[0]), f.at[len(f.at)-1].Sub(f.at[len(f.at)-2])
	if last < 2*first {
		t.Fatalf("the wait did not grow: first gap %v, last %v", first, last)
	}
}

// A socket that stood is retried at the shortest wait after it drops: a
// network blip on a computer that was up for hours is not waited out a
// minute.
func TestMachineWatchRetriesAStableSocketSoon(t *testing.T) {
	d := &Daemon{bus: bus.New()}
	f := &watchFake{}
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	// stable 0: every socket counts as having stood.
	d.watchMachine(ctx, f, "m1", watchPace{min: 20 * time.Millisecond, max: time.Second, stable: 0})
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.at) < 6 {
		t.Fatalf("only %d opens in 400 ms at a 20 ms wait: a stable socket was backed off", len(f.at))
	}
}

// A computer recorded as waiting for Allow whose socket opens has let this
// machine in: the watch asks who this machine is there before it says
// "online", so the lists that re-read on that word no longer say pending.
func TestMachineWatchLearnsAnAllowBeforeSayingOnline(t *testing.T) {
	d := &Daemon{bus: bus.New()}
	sub := d.bus.Subscribe(16)
	defer sub.Unsubscribe()
	f := &watchFake{status: peers.StatusPending}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.watchMachine(ctx, f, "m1", watchPace{min: time.Hour, max: time.Hour, stable: time.Hour})
	for {
		select {
		case fr := <-sub.C:
			mf, ok := fr.Data.(machinesFrame)
			if fr.Type != bus.FrameMachines || !ok || mf.Why != "online" {
				continue
			}
			if !fr.LocalOnly {
				t.Fatal("a word about another computer reached past this machine")
			}
			f.mu.Lock()
			checks, st := f.checks, f.status
			f.mu.Unlock()
			if checks != 1 || st != "online" {
				t.Fatalf("said online with %d checks, status %q", checks, st)
			}
			return
		case <-time.After(5 * time.Second):
			t.Fatal("the watch never said online")
		}
	}
}

// A computer that waits for its owner's Allow is looked at again soon — the
// owner is usually at it — not a minute later as a removed one is.
func TestMachineWatchLooksSoonForAnAllow(t *testing.T) {
	d := &Daemon{bus: bus.New()}
	f := &watchFake{status: peers.StatusPending, refuse: 2, opened: make(chan struct{}, 8)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.watchMachine(ctx, f, "m1", watchPace{min: time.Millisecond, max: time.Hour, stable: time.Hour, allow: 20 * time.Millisecond})
	// Two refusals, then the open that is let in.
	select {
	case <-f.opened:
	case <-time.After(5 * time.Second):
		t.Fatal("a computer waiting for Allow was not looked at again soon")
	}
	// The check the watch makes before it says "online".
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(5 * time.Millisecond) {
		if st, _ := f.Get("m1"); st.Status == "online" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("still pending after the socket opened")
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	// 20 ms, then 40 ms: the allow wait, doubling.
	if g := f.at[1].Sub(f.at[0]); g < 20*time.Millisecond {
		t.Fatalf("first look again after %v, want at least 20 ms", g)
	}
}
