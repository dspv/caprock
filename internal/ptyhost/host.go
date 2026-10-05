package ptyhost

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/dspv/caprock/internal/ptyman"
	"github.com/dspv/caprock/internal/termbuf"
)

// LaunchSpec is what the daemon hands a new holder on its stdin. Stdin rather
// than argv or a file: argv is readable by every process on the machine, and
// the spec carries the token and the child's environment (which can hold an
// API key), none of which should touch the disk.
type LaunchSpec struct {
	Proto     int         `json:"proto"`
	SessionID string      `json:"session_id"`
	Dir       string      `json:"dir"` // registry directory
	Token     string      `json:"token"`
	Version   string      `json:"version,omitempty"`
	Spec      ptyman.Spec `json:"spec"`
}

// ready is the holder's one line on stdout: the session started, or why not.
type ready struct {
	OK       bool   `json:"ok"`
	Error    string `json:"error,omitempty"`
	Addr     string `json:"addr,omitempty"`
	ChildPID int    `json:"child_pid,omitempty"`
}

// ringSize matches the daemon's own ring: what a reattached terminal repaints.
const ringSize = 256 << 10

// clientQueue is how many frames may wait for a slow client before it is
// dropped. The daemon reads continuously, so a full queue means it is gone or
// wedged, and the child must not stall on it.
const clientQueue = 1024

// Main runs a holder: read the LaunchSpec from stdin, start the child, report
// on stdout, then serve until the child exits. Returns the process exit code.
//
// After the ready line stdout is closed. The holder outlives the daemon that
// started it, and a write to a pipe whose reader has gone is a SIGPIPE.
func Main(stdin io.Reader, stdout io.WriteCloser) int {
	var spec LaunchSpec
	if err := json.NewDecoder(io.LimitReader(stdin, 4<<20)).Decode(&spec); err != nil {
		return fail(stdout, fmt.Errorf("read launch spec: %w", err))
	}
	if spec.Proto < 1 || !validID(spec.SessionID) || spec.Dir == "" || spec.Token == "" {
		return fail(stdout, errors.New("incomplete launch spec"))
	}
	// A holder has no terminal of its own and must not be stopped by one:
	// SIGHUP from a closing session, or Ctrl+C / Ctrl+Break delivered to a
	// process group it has already left, are not reasons to drop a session.
	signal.Ignore(syscall.SIGHUP, os.Interrupt)
	if err := os.MkdirAll(spec.Dir, 0o700); err != nil {
		return fail(stdout, err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fail(stdout, err)
	}
	sess, err := ptyman.New().Spawn(context.Background(), spec.Spec)
	if err != nil {
		_ = ln.Close()
		return fail(stdout, err)
	}
	h := &host{
		spec: spec, sess: sess, ln: ln, ring: termbuf.NewRing(ringSize), inputs: termbuf.NewInputs(termbuf.InputTTL),
		pumpDone: make(chan struct{}),
		rec: Record{
			Proto: Proto, SessionID: spec.SessionID, HostPID: os.Getpid(), ChildPID: sess.PID(),
			Addr: ln.Addr().String(), Token: spec.Token, Cwd: spec.Spec.Dir,
			Command: label(spec.Spec), StartedAt: time.Now().UTC(), Version: spec.Version,
			Meta: spec.Spec.Meta,
		},
	}
	if err := writeJSONAtomic(recordPath(spec.Dir, spec.SessionID), h.rec); err != nil {
		_ = sess.Signal(ptyman.SignalKill)
		_ = sess.Close()
		_ = ln.Close()
		return fail(stdout, fmt.Errorf("write registry entry: %w", err))
	}
	b, _ := json.Marshal(ready{OK: true, Addr: h.rec.Addr, ChildPID: h.rec.ChildPID})
	_, _ = stdout.Write(append(b, '\n'))
	_ = stdout.Close()
	return h.serve()
}

func fail(stdout io.WriteCloser, err error) int {
	b, _ := json.Marshal(ready{Error: err.Error()})
	_, _ = stdout.Write(append(b, '\n'))
	_ = stdout.Close()
	return 1
}

// label is the command line shown for the session, the same shape the daemon
// stores as spawn_command.
func label(s ptyman.Spec) string {
	return strings.TrimSpace(s.Command + " " + strings.Join(s.Args, " "))
}

type host struct {
	spec     LaunchSpec
	sess     ptyman.Session
	ln       net.Listener
	ring     *termbuf.Ring
	inputs   *termbuf.Inputs // sequenced input applied so far, per client (J frames)
	rec      Record
	pumpDone chan struct{}

	mu     sync.Mutex // guards client and exited, and orders ring writes against attaches
	client *client
	exited bool
}

type client struct {
	conn   net.Conn
	out    chan []byte
	mu     sync.Mutex // guards closed: a send after close would panic
	closed bool
	done   chan struct{} // closed when the writer has stopped
}

// send queues a frame without blocking; a client that cannot keep up is
// dropped rather than allowed to stall the child's output.
func (c *client) send(f []byte) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return false
	}
	select {
	case c.out <- f:
		return true
	default:
		c.closed = true
		close(c.out)
		_ = c.conn.Close()
		return false
	}
}

// drop disconnects the client now.
func (c *client) drop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		c.closed = true
		close(c.out)
	}
	_ = c.conn.Close()
}

// finish stops queueing and lets the writer flush what is already queued.
func (c *client) finish() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		c.closed = true
		close(c.out)
	}
}

func (c *client) writer() {
	defer close(c.done)
	for f := range c.out {
		_ = c.conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
		if _, err := c.conn.Write(f); err != nil {
			c.drop()
			// Drain what is left; drop has closed the channel, so this ends.
			for range c.out {
			}
			return
		}
	}
}

func (h *host) serve() int {
	terms := make(chan os.Signal, 1)
	signal.Notify(terms, syscall.SIGTERM)
	go func() {
		// Somebody asked the holder to stop. It passes that on to its own
		// child — the one process it may signal — and ends when the child does.
		for range terms {
			_ = h.sess.Signal(ptyman.SignalTerm)
		}
	}()
	go h.pump()
	go h.accept()

	err := h.sess.Wait()
	code := exitCode(err)
	// Let the last output reach the ring and the client before saying the
	// session is over, so the final screen is not cut short.
	select {
	case <-h.pumpDone:
	case <-time.After(2 * time.Second):
	}
	_ = h.ln.Close()

	h.mu.Lock()
	h.exited = true
	c := h.client
	h.client = nil
	h.mu.Unlock()
	told := false
	if c != nil {
		b, _ := json.Marshal(exitMsg{Code: code})
		if c.send(encodeFrame(frameExit, b)) {
			c.finish()
			select {
			case <-c.done:
				told = true
			case <-time.After(2 * time.Second):
			}
			_ = c.conn.Close()
		}
	}
	// The registry entry is named by the session id, and continuing a
	// session under its own id starts a new holder for that id — after this
	// one's child was stopped, and possibly before this holder has finished
	// exiting. The entry is then the successor's, and neither removing it nor
	// leaving an exit code for it is this holder's business.
	if h.ownsRecord() {
		if !told {
			// No daemon heard it. Leave the exit code for the next one.
			_ = writeJSONAtomic(exitPath(h.spec.Dir, h.spec.SessionID), ExitRecord{SessionID: h.spec.SessionID, Code: code, At: time.Now().UTC()})
		}
		_ = os.Remove(recordPath(h.spec.Dir, h.spec.SessionID))
	}
	_ = h.sess.Close()
	return 0
}

// ownsRecord reports whether the registry entry for this session is still
// this holder's.
func (h *host) ownsRecord() bool {
	b, err := os.ReadFile(recordPath(h.spec.Dir, h.spec.SessionID))
	if err != nil {
		return false
	}
	var r Record
	return json.Unmarshal(b, &r) == nil && r.HostPID == os.Getpid() && r.Token == h.spec.Token
}

// pump moves the child's output into the ring and to the connected client.
func (h *host) pump() {
	defer close(h.pumpDone)
	buf := make([]byte, 32<<10)
	r := h.sess.Output()
	for {
		n, err := r.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			h.mu.Lock()
			h.ring.Write(chunk)
			if h.client != nil && !h.client.send(encodeFrame(frameOutput, chunk)) {
				h.client = nil
			}
			h.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

func (h *host) accept() {
	for {
		conn, err := h.ln.Accept()
		if err != nil {
			return
		}
		go h.handle(conn)
	}
}

// handle authenticates one connection and, if it is the daemon, makes it the
// client — replacing any previous one, which is a daemon that has gone.
func (h *host) handle(conn net.Conn) {
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	typ, payload, err := readFrame(conn)
	var hi hello
	if err != nil || typ != frameHello || json.Unmarshal(payload, &hi) != nil || hi.Proto < 1 {
		_ = conn.Close()
		return
	}
	if subtle.ConstantTimeCompare([]byte(hi.Token), []byte(h.spec.Token)) != 1 {
		_ = writeFrame(conn, frameError, []byte("bad token"))
		_ = conn.Close()
		return
	}
	_ = conn.SetReadDeadline(time.Time{})

	c := &client{conn: conn, out: make(chan []byte, clientQueue), done: make(chan struct{})}
	h.mu.Lock()
	if h.exited {
		h.mu.Unlock()
		_ = writeFrame(conn, frameError, []byte("session has ended"))
		_ = conn.Close()
		return
	}
	if h.client != nil {
		h.client.drop()
	}
	// Under h.mu the ring cannot move, so the offsets in the welcome are the
	// ones the snapshot or the catch-up that follows it starts from.
	snap, offset := h.ring.SnapshotAt()
	start := h.ring.Start()
	w, _ := json.Marshal(welcome{
		Proto: Proto, ChildPID: h.rec.ChildPID, Paused: h.sess.Paused(), Version: h.spec.Version,
		Offset: &offset, RingStart: &start, SeqInput: true,
	})
	c.send(encodeFrame(frameWelcome, w))
	switch {
	case !hi.Resume:
		c.send(encodeFrame(frameSnapshot, snap))
	case hi.Since != nil:
		// A daemon coming back after a dropped connection: what it missed,
		// or the whole screen when the ring has moved past it.
		if missed, ok := h.ring.Since(*hi.Since); ok {
			if len(missed) > 0 {
				c.send(encodeFrame(frameOutput, missed))
			}
		} else {
			c.send(encodeFrame(frameSnapshot, snap))
		}
	}
	h.client = c
	h.mu.Unlock()
	go c.writer()

	for {
		typ, payload, err := readFrame(conn)
		if err != nil {
			h.mu.Lock()
			if h.client == c {
				h.client = nil
			}
			h.mu.Unlock()
			c.drop()
			return
		}
		switch typ {
		case frameInput:
			_, _ = h.sess.Write(payload)
		case frameResize:
			var m resizeMsg
			if json.Unmarshal(payload, &m) == nil && m.Cols > 0 && m.Rows > 0 {
				_ = h.sess.Resize(m.Cols, m.Rows)
			}
		case frameSignal:
			var m signalMsg
			if json.Unmarshal(payload, &m) == nil {
				_ = h.sess.Signal(ptyman.Signal(m.Signal))
			}
		case frameSeqInput:
			h.seqInput(c, payload)
		default:
			// A newer daemon's frame this holder does not know: ignored, so
			// the two keep talking (see the package comment).
		}
	}
}

// seqInput types a J frame's bytes unless this client's sequence says they
// were typed already, and answers with the client's last applied sequence.
func (h *host) seqInput(c *client, payload []byte) {
	id, seq, data, err := decodeSeqInput(payload)
	if err != nil {
		return
	}
	last, werr := h.inputs.Apply(id, seq, func() error {
		_, err := h.sess.Write(data)
		return err
	})
	ack := seqAck{Client: id, Req: seq, Seq: last}
	if werr != nil {
		ack.Error = werr.Error()
	}
	b, _ := json.Marshal(ack)
	c.send(encodeFrame(frameSeqAck, b))
}

// exitCoder lets a session report an exit code without an *exec.ExitError.
type exitCoder interface{ ExitCode() int }

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	var ec exitCoder
	if errors.As(err, &ec) {
		return ec.ExitCode()
	}
	return -1
}
