//go:build smoke

package smoke

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// ADR-033, end to end: a session Caprock starts survives the daemon
// restarting — the way an upgrade restarts it — and the next daemon picks it
// back up, repaints it, and types into it.
//
// This runs the real binary as a separate process, because what is under test
// is precisely what happens across processes: the daemon going away, a
// pty-host that must not go with it, and a different daemon process finding
// it. An in-process daemon would share the test's process and prove nothing.
// The agent is testdata/fakeclaude, so no model is called.
func TestOwnedSessionSurvivesDaemonRestart(t *testing.T) {
	root := t.TempDir()
	bin := filepath.Join(root, "bin")
	home := filepath.Join(root, "home")
	data := filepath.Join(root, "data")
	proj := filepath.Join(root, "proj")
	for _, d := range []string{bin, home, data, proj} {
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
			// A holder runs from a copy of the binary under the data
			// directory, and Windows will not delete an executable until the
			// process running it is gone. Give the last one a moment, or the
			// temporary directory's removal fails the test after it passed.
			time.Sleep(2 * time.Second)
		}
	})

	port := freePort(t)
	env := daemonEnv(bin, home, data)
	base := "http://127.0.0.1:" + strconv.Itoa(port)

	d1 := startBinary(t, caprock, env, port, data, "first")
	id := spawnOwned(t, base, proj)
	if !getSession(t, base, id).Survives {
		t.Fatalf("the session did not start in a pty-host\ndaemon log:\n%s", d1.log())
	}
	term := attachTerm(t, base, id)
	term.waitFor(t, "fake-claude ready")
	term.send(t, "before\r")
	term.waitFor(t, "you-said:before")
	// A permission dialog is open when the daemon goes (ADR-035): its buttons
	// must come back with the session, under the same prompt id, and the
	// answer must find the menu on the screen the pty-host kept.
	term.send(t, "ask1\r")
	term.waitFor(t, "asked1")
	term.close()
	hookPermissionRequest(t, base, data, id)
	promptID := waitPermission(t, base, id, true)

	// The upgrade path: launchd and systemd stop the daemon with SIGTERM.
	// Windows has no SIGTERM, so it gets the harder stop.
	d1.stop(t, true)
	if _, err := os.Stat(filepath.Join(data, "ptyhost", id+".json")); err != nil {
		t.Fatalf("the session's pty-host is gone after the daemon stopped: %v\ndaemon log:\n%s", err, d1.log())
	}

	d2 := startBinary(t, caprock, env, port, data, "second")
	sess := getSession(t, base, id)
	if !sess.Owned || sess.Status == "ended" || sess.Detached {
		t.Fatalf("after a restart the session reads owned=%v status=%s detached=%v; want it running and attached\ndaemon log:\n%s",
			sess.Owned, sess.Status, sess.Detached, d2.log())
	}
	if got := waitPermission(t, base, id, true); got != promptID {
		t.Fatalf("after a restart the prompt is %q, want %q\ndaemon log:\n%s", got, promptID, d2.log())
	}
	// A button drawn for another prompt still answers nothing.
	if code := answerPermission(t, base, id, "not-"+promptID); code != http.StatusConflict {
		t.Fatalf("a stale prompt id was answered: %d", code)
	}
	if code := answerPermission(t, base, id, promptID); code != http.StatusNoContent {
		t.Fatalf("answering the restored prompt: %d\ndaemon log:\n%s", code, d2.log())
	}
	waitPermission(t, base, id, false)
	term = attachTerm(t, base, id)
	// The holder's scrollback repaints what happened before the restart.
	term.waitFor(t, "you-said:before")
	// The answer pressed "1" into the session; the next line carries it.
	term.send(t, "after\r")
	term.waitFor(t, "you-said:1after")
	term.close()

	// A crash, not a stop: the daemon gets no chance to let go cleanly.
	d2.stop(t, false)
	d3 := startBinary(t, caprock, env, port, data, "third")
	// Answered before the crash, so it does not come back after it.
	waitPermission(t, base, id, false)
	term = attachTerm(t, base, id)
	term.send(t, "again\r")
	term.waitFor(t, "you-said:again")
	term.send(t, "ask2\r")
	term.waitFor(t, "asked2")
	term.close()

	// A crash the moment the hook that drew a dialog has been answered, on
	// every OS: nothing waits for the prompt to be seen first, and no
	// shutdown gets to flush it. The dialog is still on the session's screen,
	// so its buttons must come back.
	hookPermissionRequest(t, base, data, id)
	d3.stop(t, false)
	d4 := startBinary(t, caprock, env, port, data, "fourth")
	crashed := waitPermission(t, base, id, true)
	if crashed == "" || crashed == promptID {
		t.Fatalf("after a crash the prompt is %q; want a new one, not %q\ndaemon log:\n%s", crashed, promptID, d4.log())
	}
	if code := answerPermission(t, base, id, crashed); code != http.StatusNoContent {
		t.Fatalf("answering the prompt restored after a crash: %d\ndaemon log:\n%s", code, d4.log())
	}
	waitPermission(t, base, id, false)
	term = attachTerm(t, base, id)
	term.send(t, "more\r")
	term.waitFor(t, "you-said:1more")
	term.close()

	// Kill from the dashboard still reaches the process, through its holder.
	post(t, base+"/v1/agents/"+id+"/signal", `{"action":"kill"}`)
	deadline := time.Now().Add(20 * time.Second)
	for getSession(t, base, id).Status != "ended" {
		if time.Now().After(deadline) {
			t.Fatalf("the session did not end after a kill\ndaemon log:\n%s", d4.log())
		}
		time.Sleep(200 * time.Millisecond)
	}
	deadline = time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(data, "ptyhost", id+".json")); os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the pty-host left its registry entry behind after its session ended")
		}
		time.Sleep(100 * time.Millisecond)
	}
	d4.stop(t, true)
}

func goBuild(t *testing.T, out, pkg string) {
	t.Helper()
	cmd := exec.Command("go", "build", "-o", out, pkg)
	cmd.Dir = "../.."
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build %s: %v\n%s", pkg, err, b)
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

// daemonEnv isolates the daemon from the machine it runs on: its own home
// (so ~/.claude.json and settings are throwaway), its own data directory, and
// a PATH that finds the fake claude first.
func daemonEnv(bin, home, data string) []string {
	var env []string
	for _, kv := range os.Environ() {
		k := strings.ToUpper(strings.SplitN(kv, "=", 2)[0])
		switch k {
		case "HOME", "USERPROFILE", "CAPROCK_DATA_DIR", "PATH", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR":
			continue
		}
		env = append(env, kv)
	}
	path := bin + string(os.PathListSeparator) + "/usr/bin" + string(os.PathListSeparator) + "/bin"
	if runtime.GOOS == "windows" {
		path = bin + string(os.PathListSeparator) + os.Getenv("PATH")
	}
	return append(env, "HOME="+home, "USERPROFILE="+home, "CAPROCK_DATA_DIR="+data, "PATH="+path)
}

type proc struct {
	cmd    *exec.Cmd
	mu     sync.Mutex
	out    bytes.Buffer
	exited chan struct{}
}

func (p *proc) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.out.Write(b)
}

func (p *proc) log() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.out.String()
}

func startBinary(t *testing.T, caprock string, env []string, port int, data, name string) *proc {
	t.Helper()
	p := &proc{exited: make(chan struct{})}
	p.cmd = exec.Command(caprock, "up", "--foreground", "--no-hooks", "--no-open", "--port", strconv.Itoa(port), "--data-dir", data)
	p.cmd.Env = env
	p.cmd.Stdout, p.cmd.Stderr = p, p
	if err := p.cmd.Start(); err != nil {
		t.Fatalf("start %s daemon: %v", name, err)
	}
	go func() { _ = p.cmd.Wait(); close(p.exited) }()
	t.Cleanup(func() {
		select {
		case <-p.exited:
		default:
			_ = p.cmd.Process.Kill()
			<-p.exited
		}
	})
	deadline := time.Now().Add(30 * time.Second)
	for {
		resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/healthz", port))
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return p
			}
		}
		select {
		case <-p.exited:
			t.Fatalf("%s daemon exited before it was ready:\n%s", name, p.log())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s daemon did not become ready:\n%s", name, p.log())
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// stop ends the daemon: gracefully (SIGTERM, what a service manager sends)
// or not at all gracefully (a kill). Windows has no SIGTERM, so there even a
// graceful stop is a kill.
func (p *proc) stop(t *testing.T, graceful bool) {
	t.Helper()
	if graceful && runtime.GOOS != "windows" {
		_ = p.cmd.Process.Signal(syscall.SIGTERM)
	} else {
		_ = p.cmd.Process.Kill()
	}
	select {
	case <-p.exited:
	case <-time.After(20 * time.Second):
		_ = p.cmd.Process.Kill()
		t.Fatalf("daemon did not stop:\n%s", p.log())
	}
}

func post(t *testing.T, url, body string) []byte {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var b bytes.Buffer
	_, _ = b.ReadFrom(resp.Body)
	if resp.StatusCode >= 300 {
		t.Fatalf("POST %s: %d %s", url, resp.StatusCode, b.String())
	}
	return b.Bytes()
}

func spawnOwned(t *testing.T, base, cwd string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"cwd": cwd})
	var res struct {
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(post(t, base+"/v1/agents", string(body)), &res); err != nil || res.SessionID == "" {
		t.Fatalf("spawn: %v %+v", err, res)
	}
	return res.SessionID
}

type sessionView struct {
	Owned    bool   `json:"owned"`
	Status   string `json:"status"`
	Detached bool   `json:"detached"`
	Survives bool   `json:"survives_restart"`
}

func getSession(t *testing.T, base, id string) sessionView {
	t.Helper()
	resp, err := http.Get(base + "/v1/sessions/" + id)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var v sessionView
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
		t.Fatalf("session %s: %v", id, err)
	}
	return v
}

type termConn struct {
	c      *websocket.Conn
	cancel context.CancelFunc
	mu     sync.Mutex
	buf    bytes.Buffer
}

func attachTerm(t *testing.T, base, id string) *termConn {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	url := "ws" + strings.TrimPrefix(base, "http") + "/v1/agents/" + id + "/term"
	c, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{base}}})
	if err != nil {
		cancel()
		t.Fatalf("attach terminal: %v", err)
	}
	c.SetReadLimit(4 << 20)
	tc := &termConn{c: c, cancel: cancel}
	go func() {
		for {
			_, b, err := c.Read(ctx)
			if err != nil {
				return
			}
			tc.mu.Lock()
			tc.buf.Write(b)
			tc.mu.Unlock()
		}
	}()
	return tc
}

func (tc *termConn) send(t *testing.T, s string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := tc.c.Write(ctx, websocket.MessageBinary, []byte(s)); err != nil {
		t.Fatalf("type into the terminal: %v", err)
	}
}

func (tc *termConn) waitFor(t *testing.T, want string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
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
	t.Fatalf("terminal never showed %q; it showed %q", want, tc.buf.String())
}

func (tc *termConn) close() {
	_ = tc.c.Close(websocket.StatusNormalClosure, "")
	tc.cancel()
}

// killHolders ends whatever a failed run left behind: the holder and its child,
// read from the test's own registry. Only processes this test started.
func killHolders(t *testing.T, data string) {
	entries, _ := filepath.Glob(filepath.Join(data, "ptyhost", "*.json"))
	for _, e := range entries {
		b, err := os.ReadFile(e)
		if err != nil {
			continue
		}
		var r struct {
			HostPID  int `json:"host_pid"`
			ChildPID int `json:"child_pid"`
		}
		if json.Unmarshal(b, &r) != nil {
			continue
		}
		for _, pid := range []int{r.ChildPID, r.HostPID} {
			if p, err := os.FindProcess(pid); err == nil && pid > 1 {
				_ = p.Kill()
			}
		}
		t.Logf("cleaned up a leftover pty-host (pid %d)", r.HostPID)
	}
}

// hookPermissionRequest sends the hook Claude Code fires as it draws a
// permission dialog, the way the shim would.
func hookPermissionRequest(t *testing.T, base, data, id string) {
	t.Helper()
	postHook(t, base, data, `{"session_id":"`+id+`","hook_event_name":"PermissionRequest","tool_name":"Bash",`+
		`"tool_input":{"command":"date > out.txt"},`+
		`"permission_suggestions":[{"type":"addDirectories","directories":["/x"],"destination":"session"}]}`)
}

// postHook sends one hook payload the way the shim would.
func postHook(t *testing.T, base, data, body string) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(data, "runtime.json"))
	if err != nil {
		t.Fatal(err)
	}
	var rt struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(raw, &rt); err != nil || rt.Token == "" {
		t.Fatalf("runtime.json: %v", err)
	}
	req, _ := http.NewRequest(http.MethodPost, base+"/v1/hook", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+rt.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode >= 300 {
		t.Fatalf("hook: %d", resp.StatusCode)
	}
}

// waitPermission waits until the session is (or is not) waiting on a prompt,
// and returns the prompt's id.
func waitPermission(t *testing.T, base, id string, want bool) string {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		resp, err := http.Get(base + "/v1/agents/" + id + "/permission")
		if err != nil {
			t.Fatal(err)
		}
		var v struct {
			Permission *struct {
				ID string `json:"id"`
			} `json:"permission"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&v)
		_ = resp.Body.Close()
		if (v.Permission != nil) == want {
			if v.Permission != nil {
				return v.Permission.ID
			}
			return ""
		}
		if time.Now().After(deadline) {
			t.Fatalf("permission prompt present = %v, want %v", v.Permission != nil, want)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func answerPermission(t *testing.T, base, id, promptID string) int {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, base+"/v1/agents/"+id+"/permission",
		strings.NewReader(`{"id":"`+promptID+`","choice":"allow"}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}
