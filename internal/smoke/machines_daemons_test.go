//go:build smoke

package smoke

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// ADR-067 Phase 1 PR2 end to end: two real daemons, each in its own home and
// data directory on its own port, and a relay in this test on loopback
// (relaysrv — never the hosted one). The controller pairs with a link the
// target printed for a computer; the target's owner allows it from the
// command line, as over SSH; the controller starts the fake claude on the
// target through its own /v1/m/{id}/… proxy, types into it and reads the
// echo; then the target revokes it, the open terminal closes with 1008 and
// the proxy answers revoked.
func TestTwoDaemonsOneControlsTheOther(t *testing.T) {
	root := t.TempDir()
	if r, err := filepath.EvalSymlinks(root); err == nil {
		root = r // macOS: /var is /private/var, and spawns are checked against the real home
	}
	bin := filepath.Join(root, "bin")
	tHome, tData := filepath.Join(root, "target-home"), filepath.Join(root, "target-data")
	cHome, cData := filepath.Join(root, "controller-home"), filepath.Join(root, "controller-data")
	proj := filepath.Join(tHome, "proj")
	for _, d := range []string{bin, tHome, tData, cHome, cData, proj} {
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
		killHolders(t, tData)
		killHolders(t, cData)
		if runtime.GOOS == "windows" {
			time.Sleep(2 * time.Second)
		}
	})

	relay := startRelay(t, "127.0.0.1:0")
	relayURL := "ws://" + relay.addr

	tPort, cPort := freePort(t), freePort(t)
	tBase := "http://127.0.0.1:" + strconv.Itoa(tPort)
	cBase := "http://127.0.0.1:" + strconv.Itoa(cPort)
	tEnv := append(daemonEnv(bin, tHome, tData), "CAPROCK_SECRET_STORE=file")
	cEnv := append(daemonEnv(bin, cHome, cData), "CAPROCK_SECRET_STORE=file")
	target := startBinary(t, caprock, tEnv, tPort, tData, "target")
	controller := startBinary(t, caprock, cEnv, cPort, cData, "controller")

	// On the target, by its owner: access from anywhere at this relay, then
	// a link for a computer — what `caprock pair --computer` prints.
	post(t, tBase+"/v1/pair/remote", `{"on":true,"relay":"`+relayURL+`"}`)
	waitRemoteOnline(t, tBase, target)
	out := runCLI(t, caprock, tEnv, "pair", "--computer", "--no-wait")
	link := ""
	for _, f := range strings.Fields(out) {
		if strings.Contains(f, "#/pair?") {
			link = strings.Trim(f, "'")
		}
	}
	if link == "" {
		t.Fatalf("`caprock pair --computer` printed no link:\n%s", out)
	}

	// On the controller: paste it. It waits for the target's owner.
	var st machineStatus
	if code := callJSON(t, "POST", cBase+"/v1/machines", `{"link":`+strconv.Quote(link)+`}`, &st); code != 200 {
		t.Fatalf("add: %d %+v\ncontroller log:\n%s\ntarget log:\n%s", code, st, controller.log(), target.log())
	}
	if st.Status != "pending" || st.Kind != "machine" {
		t.Fatalf("before the owner allowed it: %+v", st)
	}
	proxy := cBase + "/v1/m/" + st.ID
	if code := callJSON(t, "GET", proxy+"/v1/sessions", "", nil); code != http.StatusForbidden {
		t.Fatalf("a computer read sessions before it was allowed: %d", code)
	}

	// On the target, over "SSH": the command line is the screen.
	pending := runCLI(t, caprock, tEnv, "machines", "pending")
	var name string
	var waiting struct {
		Devices []struct {
			Name    string `json:"name"`
			Kind    string `json:"kind"`
			Pending bool   `json:"pending"`
		} `json:"devices"`
	}
	getJSONAt(t, tBase+"/v1/pair/state", &waiting)
	for _, d := range waiting.Devices {
		if d.Kind == "machine" && d.Pending {
			name = d.Name
		}
	}
	if name == "" || !strings.Contains(pending, name) {
		t.Fatalf("no computer waits on the target: %+v\n%s", waiting, pending)
	}
	runCLI(t, caprock, tEnv, "machines", "allow", name)
	var list struct {
		Machines []machineStatus `json:"machines"`
	}
	if code := callJSON(t, "GET", cBase+"/v1/machines?check=1", "", &list); code != 200 || len(list.Machines) != 1 || list.Machines[0].Status != "online" || list.Machines[0].Role != "controller" {
		t.Fatalf("after allow: %d %+v", code, list)
	}

	// Send secrets (ADR-107): a key set on the controller lands in the
	// target's store through the channel, and nowhere else on either side.
	sendSecretsSmoke(t, cBase, tBase, st.ID, cData, tData, controller.log, target.log)

	// The controller's proxy is its own machine's only: a request relayed
	// onto its loopback by a tunnel is not the owner.
	req, _ := http.NewRequest(http.MethodGet, proxy+"/v1/sessions", nil)
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	if res, err := http.DefaultClient.Do(req); err != nil || (res.StatusCode != 401 && res.StatusCode != 403) {
		t.Fatalf("a tunnelled request reached the proxy: %v %v", res, err)
	} else {
		_ = res.Body.Close()
	}

	// Start the fake claude on the target, through the controller.
	var spawned struct {
		SessionID string `json:"session_id"`
	}
	if code := callJSON(t, "POST", proxy+"/v1/agents", `{"cwd":`+strconv.Quote(proj)+`}`, &spawned); code != 200 || spawned.SessionID == "" {
		t.Fatalf("spawn through the proxy: %d %+v\ntarget log:\n%s", code, spawned, target.log())
	}
	id := spawned.SessionID
	if s := getSession(t, tBase, id); s.Status == "ended" {
		t.Fatalf("the session is not running on the target: %+v", s)
	}
	term := proxyTerm(t, proxy, cBase, id)
	term.waitFor(t, "fake-claude ready")
	term.send(t, "over-two-daemons\r")
	term.waitFor(t, "you-said:over-two-daemons")

	// Revoked on the target: the open terminal closes at once with 1008,
	// and the proxy says revoked.
	runCLI(t, caprock, tEnv, "machines", "revoke", name)
	select {
	case code := <-term.closed:
		if code != websocket.StatusPolicyViolation {
			t.Fatalf("after revoke the terminal closed with %d, want 1008", code)
		}
	case <-time.After(30 * time.Second):
		t.Fatalf("after revoke the terminal stayed open\ntarget log:\n%s\ncontroller log:\n%s", target.log(), controller.log())
	}
	var refused struct {
		Status string `json:"status"`
	}
	if code := callJSON(t, "GET", proxy+"/v1/sessions", "", &refused); code != http.StatusForbidden || refused.Status != "revoked" {
		t.Fatalf("after revoke the proxy answered %d %+v", code, refused)
	}
	relay.stop()
	// The session was the target's to start and is the target's to stop.
	post(t, tBase+"/v1/agents/"+id+"/signal", `{"action":"kill"}`)
	controller.stop(t, true)
	target.stop(t, true)
}

// ADR-108 end to end: the same two daemons, linked with a join key instead
// of a link and Allow. The computer the user works on makes a key (`caprock
// machines key`, with access from anywhere off there); the new computer,
// with access from anywhere off too, runs `caprock join <key>`. Afterwards
// the new computer is reached from the first with no Allow pressed, lists it
// as an allowed computer bound to its key, and the key is in no log or file
// on either side and works no second time.
func TestTwoDaemonsJoinWithAKey(t *testing.T) {
	root := t.TempDir()
	if r, err := filepath.EvalSymlinks(root); err == nil {
		root = r
	}
	bin := filepath.Join(root, "bin")
	nHome, nData := filepath.Join(root, "new-home"), filepath.Join(root, "new-data")
	mHome, mData := filepath.Join(root, "main-home"), filepath.Join(root, "main-data")
	for _, d := range []string{bin, nHome, nData, mHome, mData} {
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
		killHolders(t, nData)
		killHolders(t, mData)
		if runtime.GOOS == "windows" {
			time.Sleep(2 * time.Second)
		}
	})

	relay := startRelay(t, "127.0.0.1:0")
	relayURL := "ws://" + relay.addr

	nPort, mPort := freePort(t), freePort(t)
	nBase := "http://127.0.0.1:" + strconv.Itoa(nPort)
	mBase := "http://127.0.0.1:" + strconv.Itoa(mPort)
	nEnv := daemonEnv(bin, nHome, nData)
	mEnv := daemonEnv(bin, mHome, mData)
	newer := startBinary(t, caprock, nEnv, nPort, nData, "new")
	main := startBinary(t, caprock, mEnv, mPort, mData, "main")

	// On the computer the user works on: its relay chosen, access from
	// anywhere left off; then a key, from the command line.
	post(t, mBase+"/v1/pair/remote", `{"on":false,"relay":"`+relayURL+`"}`)
	out := runCLI(t, caprock, mEnv, "machines", "key")
	key := ""
	for _, f := range strings.Fields(out) {
		if strings.HasPrefix(f, "cj1-") {
			key = f
		}
	}
	if key == "" || !strings.Contains(out, "caprock join "+key) || !strings.Contains(out, "https://caprock.dev/win.ps1") {
		t.Fatalf("`caprock machines key` printed:\n%s", out)
	}
	var desk struct {
		State       string `json:"state"`
		RelayStatus string `json:"relay_status"`
	}
	deadline := time.Now().Add(30 * time.Second)
	for desk.RelayStatus != "online" {
		if time.Now().After(deadline) {
			t.Fatalf("the key's rendezvous never reached the relay: %+v\nmain log:\n%s", desk, main.log())
		}
		getJSONAt(t, mBase+"/v1/machines/join-key", &desk)
		time.Sleep(100 * time.Millisecond)
	}

	// On the new computer: one command.
	joined := runCLI(t, caprock, nEnv, "join", key)
	for _, want := range []string{"Joined.", "turned on access from anywhere", "Next, on", "Send secrets"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("`caprock join` did not say %q:\n%s\nnew log:\n%s\nmain log:\n%s", want, joined, newer.log(), main.log())
		}
	}

	// The new computer: access from anywhere on, at the key's relay, and the
	// computer that made the key allowed there and bound to its key.
	var here struct {
		Devices []struct {
			Kind    string `json:"kind"`
			Pending bool   `json:"pending"`
			Bound   bool   `json:"bound"`
			Role    string `json:"role"`
		} `json:"devices"`
		Remote struct {
			Enabled bool   `json:"enabled"`
			Relay   string `json:"relay"`
		} `json:"remote"`
	}
	getJSONAt(t, nBase+"/v1/pair/state", &here)
	if !here.Remote.Enabled || here.Remote.Relay != relayURL || len(here.Devices) != 1 || here.Devices[0].Kind != "machine" || here.Devices[0].Pending || !here.Devices[0].Bound || here.Devices[0].Role != "controller" {
		t.Fatalf("the new computer after the join: %+v", here)
	}

	// The computer the user works on reaches it, with no Allow pressed.
	var list struct {
		Machines []machineStatus `json:"machines"`
	}
	if code := callJSON(t, "GET", mBase+"/v1/machines?check=1", "", &list); code != 200 || len(list.Machines) != 1 || list.Machines[0].Status != "online" || list.Machines[0].Role != "controller" {
		t.Fatalf("machines after the join: %d %+v", code, list)
	}
	id := list.Machines[0].ID
	var after struct {
		State   string         `json:"state"`
		Machine *machineStatus `json:"machine"`
	}
	getJSONAt(t, mBase+"/v1/machines/join-key", &after)
	if after.State != "joined" || after.Machine == nil || after.Machine.ID != id {
		t.Fatalf("the key after the join: %+v", after)
	}
	if code := callJSON(t, "GET", mBase+"/v1/m/"+id+"/v1/sessions", "", nil); code != 200 {
		t.Fatalf("read the new computer's sessions: %d", code)
	}

	// Single use.
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	again := exec.CommandContext(ctx, caprock, "join", key)
	again.Env = nEnv
	b, err := again.CombinedOutput()
	cancel()
	if err == nil {
		t.Fatalf("a spent key joined again:\n%s", b)
	}

	// The key is in no log and no file on either computer.
	jk := strings.TrimPrefix(key, "cj1-")
	if strings.Contains(main.log(), jk) || strings.Contains(newer.log(), jk) {
		t.Fatal("a daemon logged the key")
	}
	for _, dir := range []string{mData, nData} {
		_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return nil //nolint:nilerr // a file that vanished mid-walk holds nothing
			}
			if d.IsDir() {
				return nil
			}
			if raw, err := os.ReadFile(p); err == nil && strings.Contains(string(raw), jk) {
				t.Errorf("%s holds the key", p)
			}
			return nil
		})
	}
	relay.stop()
	main.stop(t, true)
	newer.stop(t, true)
}

type machineStatus struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
	Role   string `json:"role"`
	Kind   string `json:"kind"`
	Error  string `json:"error"`
}

// runCLI runs the caprock CLI against the daemon env names, and fails the
// test on an error. Stdin is not a terminal, so nothing waits for an answer.
func runCLI(t *testing.T, caprock string, env []string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, caprock, args...)
	cmd.Env = env
	b, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("caprock %s: %v\n%s", strings.Join(args, " "), err, b)
	}
	return string(b)
}

// callJSON makes one request and decodes an answer; it returns the status.
func callJSON(t *testing.T, method, url, body string, out any) int {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, _ := http.NewRequest(method, url, rd)
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: 90 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if out != nil {
		_ = json.Unmarshal(b, out)
	}
	return res.StatusCode
}

// localTerm is a terminal opened on the controller's own loopback, through
// its proxy: what the app does in PR3.
type localTerm struct {
	c      *websocket.Conn
	mu     sync.Mutex
	buf    strings.Builder
	closed chan websocket.StatusCode
}

func proxyTerm(t *testing.T, proxy, origin, id string) *localTerm {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	u := "ws" + strings.TrimPrefix(proxy, "http") + "/v1/agents/" + id + "/term"
	c, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{origin}}})
	if err != nil {
		t.Fatalf("open the terminal through the proxy: %v", err)
	}
	c.SetReadLimit(4 << 20)
	lt := &localTerm{c: c, closed: make(chan websocket.StatusCode, 1)}
	go func() {
		for {
			_, b, err := c.Read(context.Background())
			if err != nil {
				code := websocket.StatusAbnormalClosure
				var ce websocket.CloseError
				if errors.As(err, &ce) {
					code = ce.Code
				}
				lt.closed <- code
				return
			}
			lt.mu.Lock()
			lt.buf.Write(b)
			lt.mu.Unlock()
		}
	}()
	t.Cleanup(func() { _ = c.CloseNow() })
	return lt
}

func (lt *localTerm) send(t *testing.T, s string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := lt.c.Write(ctx, websocket.MessageBinary, []byte(s)); err != nil {
		t.Fatalf("type through the proxy: %v", err)
	}
}

func (lt *localTerm) waitFor(t *testing.T, want string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		lt.mu.Lock()
		hit := strings.Contains(lt.buf.String(), want)
		lt.mu.Unlock()
		if hit {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	lt.mu.Lock()
	defer lt.mu.Unlock()
	t.Fatalf("the terminal through the proxy never showed %q; it showed %q", want, lt.buf.String())
}

// sendSecretsSmoke sets a DeepSeek key on the controller, sends it to the
// target on the owner's click (POST /v1/machines/{id}/secrets), and checks it
// reached the target's file store (CAPROCK_SECRET_STORE=file), that the target
// uses it and names it among what arrived, and that the value is in no answer,
// log or other file on either machine.
func sendSecretsSmoke(t *testing.T, cBase, tBase, id, cData, tData string, cLog, tLog func() string) {
	t.Helper()
	value := strings.Join([]string{"smoke", "deepseek", "value", "not", "a", "key"}, "-")
	if code := callJSON(t, "PUT", cBase+"/v1/settings", `{"deepseek_api_key":`+strconv.Quote(value)+`}`, nil); code != 200 {
		t.Fatalf("set the key on the controller: %d", code)
	}
	var here struct {
		Secrets []struct {
			Name string `json:"name"`
			Set  bool   `json:"set"`
		} `json:"secrets"`
	}
	if code := callJSON(t, "GET", cBase+"/v1/machines/secrets", "", &here); code != 200 {
		t.Fatalf("what the controller can send: %d", code)
	}
	set := false
	for _, s := range here.Secrets {
		set = set || (s.Name == "deepseek" && s.Set)
	}
	if !set {
		t.Fatalf("the controller does not offer its DeepSeek key: %+v", here)
	}
	var sent struct {
		Stored []string `json:"stored"`
		Failed []struct {
			Name  string `json:"name"`
			Error string `json:"error"`
		} `json:"failed"`
	}
	if code := callJSON(t, "POST", cBase+"/v1/machines/"+id+"/secrets", `{"names":["deepseek"]}`, &sent); code != 200 || len(sent.Stored) != 1 || sent.Stored[0] != "deepseek" {
		t.Fatalf("send: %d %+v\ncontroller log:\n%s\ntarget log:\n%s", code, sent, cLog(), tLog())
	}
	b, err := os.ReadFile(filepath.Join(tData, "deepseek-api-key"))
	if err != nil || strings.TrimSpace(string(b)) != value {
		t.Fatalf("the target's store does not hold the key: %v", err)
	}
	var tset struct {
		Set bool `json:"deepseek_key_set"`
	}
	getJSONAt(t, tBase+"/v1/settings", &tset)
	if !tset.Set {
		t.Fatal("the target does not use the key it received")
	}
	var arrived struct {
		Arrivals []struct {
			Names []string `json:"names"`
			At    int64    `json:"at"`
		} `json:"arrivals"`
	}
	getJSONAt(t, tBase+"/v1/secrets/received", &arrived)
	if len(arrived.Arrivals) != 1 || len(arrived.Arrivals[0].Names) != 1 || arrived.Arrivals[0].Names[0] != "deepseek" || arrived.Arrivals[0].At == 0 {
		t.Fatalf("the target does not say what arrived: %+v", arrived)
	}
	if strings.Contains(cLog(), value) || strings.Contains(tLog(), value) {
		t.Fatal("a daemon logged the value")
	}
	// The value is in each machine's store file and nowhere else: not the
	// database, config.json, the record of arrivals or a log.
	for _, dir := range []string{cData, tData} {
		_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return nil //nolint:nilerr // a file that vanished mid-walk holds nothing
			}
			if d.IsDir() || filepath.Base(p) == "deepseek-api-key" {
				return nil
			}
			if raw, err := os.ReadFile(p); err == nil && strings.Contains(string(raw), value) {
				t.Errorf("%s holds the value", p)
			}
			return nil
		})
	}
}
