// The acceptance test of terminal protocol v2 (WP-03): a real session in a
// real pty-host, 10,000 sequenced inputs, 50 forced disconnects from either
// side and a daemon restart in the middle. Every input must reach the
// program exactly once and in order, and what the client assembled from its
// frames must be byte-identical to what the terminal printed.
//
// The test binary plays the two other processes, as in internal/ptyhost: the
// holder (`caprock pty-host`), and the program in the terminal — a line REPL
// that logs every line it reads to a file, which is the ground truth for
// "exactly once". The log, not the screen, because ConPTY redraws.
package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/dspv/caprock/internal/ptyhost"
	"github.com/dspv/caprock/internal/ptyman"
	"github.com/dspv/caprock/internal/termbuf"
)

const (
	envTermHolder = "CAPROCK_API_TEST_HOLDER"
	envTermChild  = "CAPROCK_API_TEST_CHILD"
	envTermLog    = "CAPROCK_API_TEST_CHILD_LOG"
)

func TestMain(m *testing.M) {
	switch {
	case os.Getenv(envTermHolder) == "1":
		os.Exit(ptyhost.Main(os.Stdin, os.Stdout))
	case os.Getenv(envTermChild) == "1":
		os.Exit(lineREPL())
	}
	os.Exit(m.Run())
}

func lineREPL() int {
	f, err := os.OpenFile(os.Getenv(envTermLog), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return 2
	}
	defer f.Close()
	fmt.Print("ready\r\n")
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		_, _ = f.WriteString(line + "\n")
		fmt.Printf("got:%s\r\n", line)
	}
	return 0
}

// hostedTerm is what the daemon's adapter is to a session in a pty-host.
type hostedTerm struct {
	sess ptyman.Session
	done chan struct{}
}

func newHostedTerm(s ptyman.Session) *hostedTerm {
	h := &hostedTerm{sess: s, done: make(chan struct{})}
	go func() { _, _ = io.Copy(io.Discard, s.Output()) }() // as the agent's pump does
	go func() {
		if err := s.Wait(); !errors.Is(err, ptyman.ErrDetached) {
			close(h.done)
		}
	}()
	return h
}

func (h *hostedTerm) Ring() *termbuf.Ring   { return h.sess.(ptyman.Ringed).Ring() }
func (h *hostedTerm) Done() <-chan struct{} { return h.done }
func (h *hostedTerm) Exited() (int, bool)   { return 0, false }
func (h *hostedTerm) InputSeq(client string, seq uint64, data []byte) (uint64, error) {
	return h.sess.(ptyman.SeqWriter).WriteSeq(client, seq, data)
}

// killSwitch drops every socket the server holds, as a dying daemon does.
type killSwitch struct {
	mu     sync.Mutex
	ctx    context.Context
	cancel context.CancelFunc
}

func (k *killSwitch) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		k.mu.Lock()
		gen := k.ctx
		k.mu.Unlock()
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		stop := context.AfterFunc(gen, cancel)
		defer stop()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (k *killSwitch) kill() {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.cancel != nil {
		k.cancel()
	}
	k.ctx, k.cancel = context.WithCancel(context.Background())
}

// v2Client is a protocol v2 client as the dashboard's is: it keeps its
// offset and the input not yet acknowledged, and resends that on reconnect.
type v2Client struct {
	t  *testing.T
	id string

	mu      sync.Mutex
	base    uint64 // offset of stream[0]
	stream  []byte
	resets  int
	acked   uint64
	pending []pendingInput
	conn    *websocket.Conn
	lost    chan struct{}
}

type pendingInput struct {
	seq  uint32
	data string
}

func (v *v2Client) pos() uint64 {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.base + uint64(len(v.stream))
}

func (v *v2Client) connect(ctx context.Context, srv string) error {
	q := "?client=" + v.id
	if v.resets > 0 {
		q += fmt.Sprintf("&since=%d", v.pos())
	}
	u := "ws" + strings.TrimPrefix(srv, "http") + "/v1/agents/s1/term" + q
	c, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {"http://localhost:5173"}}, Subprotocols: []string{TermV2Protocol},
	})
	if err != nil {
		return err
	}
	c.SetReadLimit(16 << 20)
	f, err := readFrame(ctx, c)
	var h termHello
	if err != nil || json.Unmarshal(f.text["hello"], &h) != nil {
		_ = c.CloseNow()
		return fmt.Errorf("no hello: %w", err)
	}
	v.mu.Lock()
	if h.Reset {
		snap, err := readFrame(ctx, c)
		if err != nil {
			v.mu.Unlock()
			_ = c.CloseNow()
			return err
		}
		_ = snap
		v.resets++
		v.base, v.stream = h.Offset, nil
	} else if h.Offset != v.base+uint64(len(v.stream)) {
		v.mu.Unlock()
		_ = c.CloseNow()
		return fmt.Errorf("resumed at %d, asked for %d", h.Offset, v.base+uint64(len(v.stream)))
	}
	v.ackLocked(h.Ack)
	resend := append([]pendingInput(nil), v.pending...)
	v.conn, v.lost = c, make(chan struct{})
	lost := v.lost
	v.mu.Unlock()
	go v.read(ctx, c, lost)
	resendAll(ctx, c, resend)
	return nil
}

// resendAll sends what was not acknowledged. A failed write is a dropped
// socket, and the next reconnect resends again.
func resendAll(ctx context.Context, c *websocket.Conn, list []pendingInput) {
	for _, p := range list {
		if c.Write(ctx, websocket.MessageBinary, input(p.seq, p.data)) != nil {
			return
		}
	}
}

func (v *v2Client) ackLocked(a uint64) {
	if a > v.acked {
		v.acked = a
	}
	kept := v.pending[:0]
	for _, p := range v.pending {
		if uint64(p.seq) > v.acked {
			kept = append(kept, p)
		}
	}
	v.pending = kept
}

func (v *v2Client) read(ctx context.Context, c *websocket.Conn, lost chan struct{}) {
	defer close(lost)
	for {
		f, err := readFrame(ctx, c)
		if err != nil {
			return
		}
		v.mu.Lock()
		switch {
		case f.text == nil:
			at := v.base + uint64(len(v.stream))
			if f.offset > at {
				v.mu.Unlock()
				v.t.Errorf("gap in the output: frame at %d, client at %d", f.offset, at)
				_ = c.CloseNow()
				return
			}
			if skip := at - f.offset; skip < uint64(len(f.data)) {
				v.stream = append(v.stream, f.data[skip:]...)
			}
		case f.text["ack"] != nil:
			var a uint64
			_ = json.Unmarshal(f.text["ack"], &a)
			v.ackLocked(a)
		case f.text["reset"] != nil:
			var r struct{ Offset uint64 }
			_ = json.Unmarshal(f.text["reset"], &r)
			v.mu.Unlock()
			if _, err := readFrame(ctx, c); err != nil {
				return
			}
			v.mu.Lock()
			v.resets++
			v.base, v.stream = r.Offset, nil
		}
		v.mu.Unlock()
	}
}

// send queues one input and sends it if a socket is open.
func (v *v2Client) send(ctx context.Context, seq uint32, data string) {
	v.mu.Lock()
	v.pending = append(v.pending, pendingInput{seq, data})
	c := v.conn
	v.mu.Unlock()
	if c != nil {
		_ = c.Write(ctx, websocket.MessageBinary, input(seq, data))
	}
}

func (v *v2Client) drop() {
	v.mu.Lock()
	c, lost := v.conn, v.lost
	v.conn = nil
	v.mu.Unlock()
	if c != nil {
		_ = c.CloseNow()
		<-lost
	}
}

func (v *v2Client) reconnect(ctx context.Context, srv string) {
	v.drop()
	deadline := time.Now().Add(20 * time.Second)
	for {
		err := v.connect(ctx, srv)
		if err == nil {
			return
		}
		if time.Now().After(deadline) {
			v.t.Fatalf("could not reconnect: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestTermV2InputExactlyOnceAcrossDropsAndADaemonRestart(t *testing.T) {
	if testing.Short() {
		t.Skip("spawns pty-hosts")
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data := t.TempDir()
	logPath := data + string(os.PathSeparator) + "typed.log"
	newMgr := func() *ptyhost.Manager {
		return &ptyhost.Manager{Exe: exe, Args: []string{}, Env: append(os.Environ(), envTermHolder+"=1"), DataDir: data, Version: "test"}
	}
	var childEnv []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, envTermHolder+"=") {
			childEnv = append(childEnv, kv)
		}
	}
	childEnv = append(childEnv, envTermChild+"=1", envTermLog+"="+logPath, "TERM=xterm-256color")
	sess, err := newMgr().Spawn(context.Background(), ptyman.Spec{ID: "s-fuzz", Command: exe, Dir: t.TempDir(), Env: childEnv, Cols: 200, Rows: 50})
	if err != nil {
		t.Fatal(err)
	}
	cur := sess
	t.Cleanup(func() { _ = cur.Close() })

	srv, ag := v2Server(t, newHostedTerm(sess))
	ks := &killSwitch{}
	ks.kill()
	srv.Config.Handler = ks.wrap(srv.Config.Handler)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cl := &v2Client{t: t, id: "fuzz-tab"}
	cl.reconnect(ctx, srv.URL)

	const n, drops = 10000, 50
	rng := rand.New(rand.NewSource(time.Now().UnixNano())) //nolint:gosec // test schedule, not security
	t.Logf("seed-free schedule; %d inputs, %d drops", n, drops)
	dropAt := map[int]bool{}
	for len(dropAt) < drops {
		dropAt[1+rng.Intn(n-1)] = true
	}
	restartAt := n / 2
	for seq := 1; seq <= n; seq++ {
		cl.send(ctx, uint32(seq), fmt.Sprintf("k%d\r", seq)) //nolint:gosec // n fits
		switch {
		case seq == restartAt:
			// The daemon dies: every socket drops, it lets go of the
			// session, and the next daemon picks the session up from its
			// pty-host with a fresh ring restored from the holder's.
			ks.kill()
			if err := cur.(ptyman.Detacher).Detach(); err != nil {
				t.Fatal(err)
			}
			att, _ := newMgr().Reattach()
			if len(att) != 1 {
				t.Fatalf("reattached %d sessions", len(att))
			}
			cur = att[0].Session
			ag.swap(newHostedTerm(cur))
			cl.reconnect(ctx, srv.URL)
		case dropAt[seq] && rng.Intn(2) == 0:
			ks.kill() // the server side drops
			cl.reconnect(ctx, srv.URL)
		case dropAt[seq]:
			cl.reconnect(ctx, srv.URL) // the client side drops
		}
	}

	// Everything acknowledged, and the program saw each line once, in order.
	waitUntil(t, 60*time.Second, func() bool {
		cl.mu.Lock()
		defer cl.mu.Unlock()
		return cl.acked == n
	}, "every input acknowledged")
	var lines []string
	waitUntil(t, 60*time.Second, func() bool {
		b, _ := os.ReadFile(logPath)
		lines = strings.Fields(string(b))
		return len(lines) >= n
	}, "the program read every line")
	if len(lines) != n {
		t.Fatalf("the program read %d lines for %d inputs", len(lines), n)
	}
	for i, l := range lines {
		if want := fmt.Sprintf("k%d", i+1); l != want {
			t.Fatalf("line %d is %q, want %q: input lost, doubled or reordered", i+1, l, want)
		}
	}

	// The client's stream is byte-identical to the terminal's output.
	ring := cur.(ptyman.Ringed).Ring()
	waitUntil(t, 30*time.Second, func() bool { return cl.pos() == ring.Total() }, "the client caught up with the output")
	cl.mu.Lock()
	defer cl.mu.Unlock()
	from := max(cl.base, ring.Start())
	want, ok := ring.Since(from)
	if !ok {
		t.Fatalf("ring lost offset %d", from)
	}
	if got := cl.stream[from-cl.base:]; string(got) != string(want) {
		t.Fatalf("client output differs from the terminal's: %d bytes vs %d", len(got), len(want))
	}
	if cl.resets != 1 {
		t.Fatalf("%d resets; every reconnect, the restart included, should have resumed from its offset", cl.resets)
	}
}

func waitUntil(t *testing.T, d time.Duration, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for: %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
