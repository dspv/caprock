package ptyhost

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dspv/caprock/internal/ptyman"
)

// Manager starts sessions inside pty-host processes and reattaches to the ones
// a previous daemon left running. It is a ptyman.Manager, so the agents
// package spawns through it exactly as it spawns in-process.
type Manager struct {
	// Exe is the binary to run as the holder; Args the arguments that select
	// the holder (default: "pty-host").
	Exe  string
	Args []string
	// Env is the holder process's own environment (nil: this process's).
	// The child's environment is the Spec's, as it always was.
	Env     []string
	DataDir string
	Version string
	Log     *slog.Logger
	// Fallback starts a session in-process when a holder cannot be started.
	// Such a session works as before and ends with the daemon, which beats
	// refusing to start it.
	Fallback ptyman.Manager
}

// ReadyTimeout is how long a new holder gets to start its child and report.
const ReadyTimeout = 15 * time.Second

func (m *Manager) log() *slog.Logger {
	if m.Log != nil {
		return m.Log
	}
	return slog.Default()
}

func (m *Manager) dir() string { return Dir(m.DataDir) }

// Spawn starts spec in a new holder, or in-process via Fallback when that is
// not possible.
func (m *Manager) Spawn(ctx context.Context, spec ptyman.Spec) (ptyman.Session, error) {
	s, err := m.spawnHosted(ctx, spec)
	if err == nil {
		return s, nil
	}
	var ce *childError
	if m.Fallback == nil || errors.As(err, &ce) {
		// No fallback, or the child itself would not start — a missing
		// binary, a bad directory — which the fallback would only repeat.
		return nil, err
	}
	m.log().Warn("could not start a pty-host; this session will not survive a Caprock restart",
		"component", "ptyhost", "session_id", spec.ID, "err", err)
	return m.Fallback.Spawn(ctx, spec)
}

func (m *Manager) spawnHosted(ctx context.Context, spec ptyman.Spec) (ptyman.Session, error) {
	if m.Exe == "" || m.DataDir == "" {
		return nil, errors.New("no pty-host binary configured")
	}
	if !validID(spec.ID) {
		return nil, fmt.Errorf("session id %q cannot name a registry entry", spec.ID)
	}
	if spec.Command == "" {
		return nil, errors.New("ptyman: empty command")
	}
	// Resolve the command here, as the in-process backend does, so the holder
	// runs exactly what this daemon would have.
	if !filepath.IsAbs(spec.Command) {
		if resolved, err := exec.LookPath(spec.Command); err == nil {
			spec.Command = resolved
		}
	}
	if spec.Env == nil {
		spec.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	}
	dir := m.dir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	token, err := newToken()
	if err != nil {
		return nil, err
	}
	args := m.Args
	if args == nil {
		args = []string{"pty-host"}
	}
	// The holder's stderr goes to a log beside the registry, so a holder that
	// dies on its own leaves a reason behind. Holders write nothing there in
	// the normal course.
	logf, err := os.OpenFile(filepath.Join(dir, "host.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err == nil {
		defer logf.Close()
	}
	var (
		cmd    *exec.Cmd
		stdin  io.WriteCloser
		stdout io.ReadCloser
	)
	for _, attr := range detachAttempts() {
		// Not CommandContext: the holder must outlive the request, and the daemon.
		cmd = exec.Command(m.Exe, args...) //nolint:gosec // our own binary, fixed arguments
		cmd.Env = m.Env
		// The system temp directory, not the data directory or wherever the
		// daemon was started: on Windows a process's working directory cannot
		// be deleted while it runs, and a holder runs as long as its session.
		cmd.Dir = os.TempDir()
		cmd.SysProcAttr = attr
		if logf != nil {
			cmd.Stderr = logf
		}
		if stdin, err = cmd.StdinPipe(); err != nil {
			return nil, err
		}
		if stdout, err = cmd.StdoutPipe(); err != nil {
			return nil, err
		}
		if err = cmd.Start(); err == nil {
			break
		}
	}
	if err != nil {
		return nil, fmt.Errorf("start pty-host: %w", err)
	}
	// Reap the holder if it exits while this daemon is still running; if the
	// daemon goes first, the holder is reparented and the goroutine goes with
	// the daemon. Started only after the ready line is read: Wait closes the
	// pipe, and must not race the read.
	reap := func() { go func() { _ = cmd.Wait() }() }

	ls := LaunchSpec{Proto: Proto, SessionID: spec.ID, Dir: dir, Token: token, Version: m.Version, Spec: spec}
	if err := json.NewEncoder(stdin).Encode(ls); err != nil {
		_ = cmd.Process.Kill()
		reap()
		return nil, fmt.Errorf("hand the launch spec to the pty-host: %w", err)
	}
	_ = stdin.Close()

	type result struct {
		r   ready
		err error
	}
	got := make(chan result, 1)
	go func() {
		line, err := bufio.NewReader(stdout).ReadBytes('\n')
		if err != nil && len(line) == 0 {
			got <- result{err: fmt.Errorf("pty-host exited before it was ready: %w", err)}
			return
		}
		var r ready
		if err := json.Unmarshal(line, &r); err != nil {
			got <- result{err: fmt.Errorf("pty-host said %q", line)}
			return
		}
		got <- result{r: r}
	}()
	var res result
	select {
	case res = <-got:
	case <-time.After(ReadyTimeout):
		_ = cmd.Process.Kill()
		reap()
		return nil, errors.New("pty-host did not report ready in time")
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		reap()
		return nil, ctx.Err()
	}
	reap()
	if res.err != nil {
		return nil, res.err
	}
	if !res.r.OK {
		// The holder could not start the child — a missing binary, a bad
		// directory. That is the spawn's own failure, not the holder's, so
		// say it as such rather than falling back to the same failure.
		return nil, &childError{msg: res.r.Error}
	}
	rec := Record{
		Proto: Proto, SessionID: spec.ID, HostPID: cmd.Process.Pid, ChildPID: res.r.ChildPID,
		Addr: res.r.Addr, Token: token, Cwd: spec.Dir, Command: label(spec), StartedAt: time.Now().UTC(), Version: m.Version,
		Meta: spec.Meta,
	}
	s, err := attach(dir, rec, false)
	if err != nil {
		return nil, err
	}
	return s, nil
}

// childError is the holder's report that the child itself would not start.
type childError struct{ msg string }

func (e *childError) Error() string { return e.msg }

// Attached is a session a previous daemon left running, now connected.
type Attached struct {
	Record  Record
	Session ptyman.Session
}

// Reattach connects to every holder in the registry. It also returns the exit
// codes of sessions that ended while no daemon was connected, and removes the
// files it has read. A registry entry nothing answers for is a holder that
// died without cleaning up, and is removed; one that answers but refuses is
// left alone and logged.
func (m *Manager) Reattach() ([]Attached, []ExitRecord) {
	dir := m.dir()
	recs, exits, err := readRecords(dir)
	if err != nil {
		m.log().Warn("could not read the pty-host registry", "component", "ptyhost", "dir", dir, "err", err)
		return nil, nil
	}
	for _, x := range exits {
		_ = os.Remove(exitPath(dir, x.SessionID))
	}
	var out []Attached
	for _, r := range recs {
		if r.Proto < 1 || r.Proto > Proto {
			// A holder from a newer Caprock, met by an older one after a
			// downgrade. Its protocol may not be ours; leave it running.
			m.log().Warn("pty-host speaks a newer protocol; leaving it alone", "component", "ptyhost", "session_id", r.SessionID, "proto", r.Proto)
			continue
		}
		s, err := attach(dir, r, false)
		if err != nil {
			if errors.Is(err, errUnreachable) {
				// Nothing listens where the holder said it would: it is gone,
				// and so is its child (a PTY whose master closed hangs up).
				_ = os.Remove(recordPath(dir, r.SessionID))
				m.log().Info("removed the registry entry of a pty-host that is gone", "component", "ptyhost", "session_id", r.SessionID)
				continue
			}
			m.log().Warn("could not reattach a session; leaving its pty-host running", "component", "ptyhost", "session_id", r.SessionID, "err", err)
			continue
		}
		out = append(out, Attached{Record: r, Session: s})
	}
	// An exit beside a live holder for the same id belongs to a predecessor
	// whose session was continued under that id; the session is running.
	live := map[string]bool{}
	for _, a := range out {
		live[a.Record.SessionID] = true
	}
	kept := exits[:0]
	for _, x := range exits {
		if !live[x.SessionID] {
			kept = append(kept, x)
		}
	}
	return out, kept
}

var (
	errRefused     = errors.New("pty-host refused the connection")
	errUnreachable = errors.New("no pty-host is listening")
)

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// remote is a session held by a pty-host, seen from the daemon.
type remote struct {
	dir      string // registry directory, where an exit file would be
	rec      Record
	childPID int

	wmu  sync.Mutex // serialises frames to the holder
	cmu  sync.Mutex // guards conn across a reconnect
	conn net.Conn

	pr *io.PipeReader
	pw *io.PipeWriter

	done     chan struct{}
	err      error
	paused   atomic.Bool
	detached atomic.Bool
	closed   atomic.Bool
}

// attach dials a holder and completes the handshake.
func attach(dir string, rec Record, resume bool) (*remote, error) {
	conn, w, err := dial(rec, resume)
	if err != nil {
		return nil, err
	}
	pr, pw := io.Pipe()
	r := &remote{dir: dir, rec: rec, childPID: w.ChildPID, conn: conn, pr: pr, pw: pw, done: make(chan struct{})}
	r.paused.Store(w.Paused)
	go r.read()
	return r, nil
}

func dial(rec Record, resume bool) (net.Conn, welcome, error) {
	conn, err := net.DialTimeout("tcp", rec.Addr, 2*time.Second)
	if err != nil {
		return nil, welcome{}, fmt.Errorf("%w: %w", errUnreachable, err)
	}
	b, _ := json.Marshal(hello{Proto: Proto, Token: rec.Token, Resume: resume})
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if err := writeFrame(conn, frameHello, b); err != nil {
		_ = conn.Close()
		return nil, welcome{}, err
	}
	typ, payload, err := readFrame(conn)
	if err != nil {
		_ = conn.Close()
		return nil, welcome{}, err
	}
	if typ == frameError {
		_ = conn.Close()
		return nil, welcome{}, fmt.Errorf("%w: %s", errRefused, payload)
	}
	var w welcome
	if typ != frameWelcome || json.Unmarshal(payload, &w) != nil {
		_ = conn.Close()
		return nil, welcome{}, fmt.Errorf("%w: unexpected first frame %q", errRefused, typ)
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, w, nil
}

// read moves the holder's frames into the output pipe until the session ends,
// the daemon lets go, or the connection is lost for good.
func (r *remote) read() {
	defer close(r.done)
	defer func() { _ = r.pw.Close() }()
	for {
		r.cmu.Lock()
		conn := r.conn
		r.cmu.Unlock()
		typ, payload, err := readFrame(conn)
		if err != nil {
			if r.detached.Load() {
				r.err = ptyman.ErrDetached
				return
			}
			if r.closed.Load() {
				r.err = errors.New("ptyhost: closed")
				return
			}
			// A dropped connection is not an ended session. Try the holder
			// again, without a snapshot: the screen is already here.
			if r.reconnect() {
				continue
			}
			r.err = r.lostErr(err)
			return
		}
		switch typ {
		case frameSnapshot, frameOutput:
			if len(payload) > 0 {
				if _, werr := r.pw.Write(payload); werr != nil {
					// Nobody reads the output any more; keep the
					// connection so input and exit still work.
					continue
				}
			}
		case frameExit:
			var x exitMsg
			_ = json.Unmarshal(payload, &x)
			if x.Code != 0 {
				r.err = ExitError(x)
			}
			_ = conn.Close()
			return
		case frameError:
			r.err = fmt.Errorf("pty-host: %s", payload)
			_ = conn.Close()
			return
		default:
			// A newer holder's frame; ignored by protocol rule.
		}
	}
}

func (r *remote) reconnect() bool {
	for i := 0; i < 5; i++ {
		if r.detached.Load() || r.closed.Load() {
			return false
		}
		conn, _, err := dial(r.rec, true)
		if err == nil {
			r.cmu.Lock()
			r.conn = conn
			r.cmu.Unlock()
			return true
		}
		if errors.Is(err, errRefused) {
			return false
		}
		time.Sleep(300 * time.Millisecond)
	}
	return false
}

// lostErr is the ending of a session whose holder went away: its recorded exit
// code if it left one, otherwise a lost-connection error.
func (r *remote) lostErr(err error) error {
	dir := r.dir
	if b, rerr := os.ReadFile(exitPath(dir, r.rec.SessionID)); rerr == nil {
		var x ExitRecord
		if json.Unmarshal(b, &x) == nil {
			_ = os.Remove(exitPath(dir, r.rec.SessionID))
			if x.Code == 0 {
				return nil
			}
			return ExitError{Code: x.Code}
		}
	}
	return fmt.Errorf("lost the pty-host: %w", err)
}

// ExitError is a non-zero exit reported by a holder.
type ExitError struct{ Code int }

func (e ExitError) Error() string { return fmt.Sprintf("exit status %d", e.Code) }

// ExitCode reports the code, for callers that read it through an interface.
func (e ExitError) ExitCode() int { return e.Code }

func (r *remote) send(typ byte, payload []byte) error {
	r.wmu.Lock()
	defer r.wmu.Unlock()
	r.cmu.Lock()
	conn := r.conn
	r.cmu.Unlock()
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return writeFrame(conn, typ, payload)
}

func (r *remote) Output() io.Reader { return r.pr }

func (r *remote) Write(p []byte) (int, error) {
	if err := r.send(frameInput, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (r *remote) Resize(cols, rows int) error {
	b, _ := json.Marshal(resizeMsg{Cols: cols, Rows: rows})
	return r.send(frameResize, b)
}

func (r *remote) Signal(sig ptyman.Signal) error {
	b, _ := json.Marshal(signalMsg{Signal: string(sig)})
	if err := r.send(frameSignal, b); err != nil {
		return err
	}
	switch sig {
	case ptyman.SignalPause:
		r.paused.Store(true)
	case ptyman.SignalResume:
		r.paused.Store(false)
	}
	return nil
}

func (r *remote) Wait() error {
	<-r.done
	return r.err
}

func (r *remote) PID() int { return r.childPID }

func (r *remote) Paused() bool { return r.paused.Load() }

// Close ends the session: the child is killed through its holder.
func (r *remote) Close() error {
	if r.closed.Swap(true) {
		return nil
	}
	select {
	case <-r.done:
	default:
		_ = r.Signal(ptyman.SignalKill)
		select {
		case <-r.done:
		case <-time.After(5 * time.Second):
		}
	}
	r.cmu.Lock()
	_ = r.conn.Close()
	r.cmu.Unlock()
	_ = r.pr.Close()
	return nil
}

// Detach lets go of the session and leaves it running in its holder.
func (r *remote) Detach() error {
	if r.closed.Load() {
		return nil
	}
	r.detached.Store(true)
	r.cmu.Lock()
	_ = r.conn.Close()
	r.cmu.Unlock()
	<-r.done
	return nil
}
