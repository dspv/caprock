//go:build smoke

package smoke

import (
	"context"
	"encoding/json"
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
)

// ADR-067 Phase 2 end to end, the owner's goal (2026-10-27, translated): "put
// Caprock on a desktop at home and drive it from the laptop — agents run on
// the home machine". Two real daemons, "home" and "laptop", each in its own
// home and data directory on its own port, paired through `caprock remote
// relay`'s code (relaysrv) on loopback — the same code relay.caprock.dev
// runs, never the hosted one. With the laptop's dashboard open (a loopback
// /v1/live), the laptop:
//
//   - pairs with home by the link home printed, and home's owner allows it;
//   - lists home's sessions in its one list (GET /v1/machines/sessions);
//   - reads home's folders, and hears "not a directory" for one home lacks;
//   - starts the fake claude on home, and sees it in the list;
//   - types into it and reads the echo;
//   - hears home's permission prompt as a notify frame tagged with home, on
//     its own /v1/live, and sees that session needing its owner in the list;
//   - with home's daemon gone, says offline — in the list, on its live
//     socket, and to a start — instead of showing a stale list.
func TestLaptopDrivesTheHomeMachine(t *testing.T) {
	started := time.Now()
	root := t.TempDir()
	if r, err := filepath.EvalSymlinks(root); err == nil {
		root = r
	}
	bin := filepath.Join(root, "bin")
	hHome, hData := filepath.Join(root, "home-home"), filepath.Join(root, "home-data")
	lHome, lData := filepath.Join(root, "laptop-home"), filepath.Join(root, "laptop-data")
	proj := filepath.Join(hHome, "work", "api")
	for _, d := range []string{bin, hHome, hData, lHome, lData, proj} {
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
		killHolders(t, hData)
		killHolders(t, lData)
		if runtime.GOOS == "windows" {
			time.Sleep(2 * time.Second)
		}
	})

	relay := startRelay(t, "127.0.0.1:0")
	relayURL := "ws://" + relay.addr
	hPort, lPort := freePort(t), freePort(t)
	hBase := "http://127.0.0.1:" + strconv.Itoa(hPort)
	lBase := "http://127.0.0.1:" + strconv.Itoa(lPort)
	hEnv, lEnv := daemonEnv(bin, hHome, hData), daemonEnv(bin, lHome, lData)
	home := startBinary(t, caprock, hEnv, hPort, hData, "home")
	laptop := startBinary(t, caprock, lEnv, lPort, lData, "laptop")
	logs := func() string { return "\nlaptop log:\n" + laptop.log() + "\nhome log:\n" + home.log() }

	// The laptop's dashboard is open: its own /v1/live, from loopback.
	lv := openLive(t, lBase)

	// Pair: on home, access from anywhere and a link for a computer; on the
	// laptop, paste it; on home, allow it from the command line (as over SSH).
	post(t, hBase+"/v1/pair/remote", `{"on":true,"relay":"`+relayURL+`"}`)
	waitRemoteOnline(t, hBase, home)
	link := ""
	for _, f := range strings.Fields(runCLI(t, caprock, hEnv, "pair", "--computer", "--no-wait")) {
		if strings.Contains(f, "#/pair?") {
			link = strings.Trim(f, "'")
		}
	}
	if link == "" {
		t.Fatal("`caprock pair --computer` printed no link")
	}
	var st machineStatus
	if code := callJSON(t, "POST", lBase+"/v1/machines", `{"link":`+strconv.Quote(link)+`}`, &st); code != 200 || st.Status != "pending" {
		t.Fatalf("add: %d %+v%s", code, st, logs())
	}
	mid := st.ID
	// Waiting for Allow is said in the list, with nothing read there.
	if got := machineSessionsOf(t, lBase, mid); got.Status != "pending" || got.Sessions != nil {
		t.Fatalf("before Allow the list said %+v", got)
	}
	var waiting struct {
		Devices []struct {
			Name    string `json:"name"`
			Kind    string `json:"kind"`
			Pending bool   `json:"pending"`
		} `json:"devices"`
	}
	getJSONAt(t, hBase+"/v1/pair/state", &waiting)
	name := ""
	for _, d := range waiting.Devices {
		if d.Kind == "machine" && d.Pending {
			name = d.Name
		}
	}
	if name == "" {
		t.Fatalf("no computer waits on home: %+v", waiting)
	}
	runCLI(t, caprock, hEnv, "machines", "allow", name)
	var list struct {
		Machines []machineStatus `json:"machines"`
	}
	if code := callJSON(t, "GET", lBase+"/v1/machines?check=1", "", &list); code != 200 || len(list.Machines) != 1 || list.Machines[0].Status != "online" {
		t.Fatalf("after allow: %d %+v", code, list)
	}
	t.Logf("paired and allowed after %v", time.Since(started).Round(time.Millisecond))

	// The one list: home answers, with nothing running yet.
	if got := machineSessionsOf(t, lBase, mid); got.Status != "online" || string(got.Sessions) != "[]" {
		t.Fatalf("home's sessions before a start: %+v (%s)", got, got.Sessions)
	}
	// Once the laptop's dashboard is open, its daemon listens on home's live
	// socket: the channel comes up and the laptop hears it.
	lv.waitMachines(t, mid, "online", logs)

	// Home's folders, read from home: the folder exists there, and the
	// laptop's own home does not leak in.
	proxy := lBase + "/v1/m/" + mid
	var stat struct {
		Exists bool `json:"exists"`
		IsDir  bool `json:"is_dir"`
	}
	if code := callJSON(t, "GET", proxy+"/v1/browse/stat?path="+urlQuery(proj), "", &stat); code != 200 || !stat.Exists || !stat.IsDir {
		t.Fatalf("home's folder through the proxy: %d %+v", code, stat)
	}
	// A folder home lacks is refused there, in words.
	var refused struct {
		Error string `json:"error"`
	}
	missing := filepath.Join(hHome, "work", "nope")
	if code := callJSON(t, "POST", proxy+"/v1/agents", `{"cwd":`+strconv.Quote(missing)+`}`, &refused); code != http.StatusBadRequest || !strings.Contains(refused.Error, "not a directory") {
		t.Fatalf("a start in a folder home lacks: %d %+v", code, refused)
	}

	// Start the fake claude on home, from the laptop.
	var spawned struct {
		SessionID string `json:"session_id"`
		Cwd       string `json:"cwd"`
	}
	if code := callJSON(t, "POST", proxy+"/v1/agents", `{"cwd":`+strconv.Quote(proj)+`}`, &spawned); code != 200 || spawned.SessionID == "" {
		t.Fatalf("start on home: %d %+v%s", code, spawned, logs())
	}
	sid := spawned.SessionID
	if s := getSession(t, hBase, sid); s.Status == "ended" {
		t.Fatalf("the session is not running on home: %+v", s)
	}
	// It is in the laptop's list at once: a start through the proxy drops
	// the kept list.
	waitListed(t, lBase, mid, sid, func(s listedSession) bool { return s.Cwd == proj }, logs)
	t.Logf("started on home after %v", time.Since(started).Round(time.Millisecond))

	// Type into it.
	term := proxyTerm(t, proxy, lBase, sid)
	term.waitFor(t, "fake-claude ready")
	term.send(t, "from-the-laptop\r")
	term.waitFor(t, "you-said:from-the-laptop")

	// It needs its owner: the dialog on its screen, and the hook Claude Code
	// fires as it draws it, on home, as home's shim would send it.
	term.send(t, "ask\r")
	term.waitFor(t, "asked")
	asked := time.Now()
	postHook(t, hBase, hData, `{"session_id":"`+sid+`","transcript_path":"`+filepath.ToSlash(filepath.Join(hHome, "t.jsonl"))+`",`+
		`"cwd":"`+filepath.ToSlash(proj)+`","permission_mode":"default","hook_event_name":"PermissionRequest","tool_name":"Bash",`+
		`"tool_input":{"command":"date > out.txt","description":"Write current date to out.txt"},`+
		`"permission_suggestions":[{"type":"addDirectories","directories":["`+filepath.ToSlash(proj)+`"],"destination":"session"}]}`)
	n := lv.waitNotify(t, mid, sid, logs)
	t.Logf("home's prompt reached the laptop's live socket %v after the hook: %+v", time.Since(asked).Round(time.Millisecond), n)
	if n.Kind != "approval" || n.MachineName == "" || !strings.HasPrefix(n.Title, "Needs approval") {
		t.Fatalf("the laptop's notification: %+v", n)
	}
	waitListed(t, lBase, mid, sid, func(s listedSession) bool { return s.Activity.Health == "waiting-on-you" }, logs)

	// Home goes away: its daemon is stopped. The laptop says so — on its live
	// socket, in the list, and to a start — rather than show what ran.
	home.stop(t, false)
	lv.waitMachines(t, mid, "offline", logs)
	deadline := time.Now().Add(30 * time.Second)
	for {
		got := machineSessionsOf(t, lBase, mid)
		if got.Status == "offline" && got.Sessions == nil && got.LastOK > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("with home gone the list said %+v%s", got, logs())
		}
		time.Sleep(500 * time.Millisecond)
	}
	var off struct {
		Error  string `json:"error"`
		Status string `json:"status"`
	}
	if code := callJSON(t, "POST", proxy+"/v1/agents", `{"cwd":`+strconv.Quote(proj)+`}`, &off); code != http.StatusServiceUnavailable || off.Status != "offline" {
		t.Fatalf("a start with home gone: %d %+v", code, off)
	}
	t.Logf("whole run %v", time.Since(started).Round(time.Millisecond))
	relay.stop()
	laptop.stop(t, true)
}

// machineEntry is one computer in GET /v1/machines/sessions.
type machineEntry struct {
	ID       string          `json:"id"`
	Name     string          `json:"name"`
	Status   string          `json:"status"`
	Error    string          `json:"error"`
	Sessions json.RawMessage `json:"sessions"`
	At       int64           `json:"at"`
	LastOK   int64           `json:"last_ok"`
}

type listedSession struct {
	SessionID string `json:"session_id"`
	Cwd       string `json:"cwd"`
	Status    string `json:"status"`
	Activity  struct {
		Health string `json:"health"`
	} `json:"activity"`
}

func machineSessionsOf(t *testing.T, base, id string) machineEntry {
	t.Helper()
	var r struct {
		Machines []machineEntry `json:"machines"`
	}
	if code := callJSON(t, "GET", base+"/v1/machines/sessions", "", &r); code != 200 {
		t.Fatalf("GET /v1/machines/sessions: %d", code)
	}
	for _, m := range r.Machines {
		if m.ID == id {
			return m
		}
	}
	t.Fatalf("GET /v1/machines/sessions does not list %s: %+v", id, r)
	return machineEntry{}
}

// waitListed waits until the laptop's list holds session sid on computer
// id, as ok says.
func waitListed(t *testing.T, base, id, sid string, ok func(listedSession) bool, logs func() string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	var last machineEntry
	for time.Now().Before(deadline) {
		last = machineSessionsOf(t, base, id)
		var ss []listedSession
		_ = json.Unmarshal(last.Sessions, &ss)
		for _, s := range ss {
			if s.SessionID == sid && ok(s) {
				return
			}
		}
		time.Sleep(300 * time.Millisecond)
	}
	t.Fatalf("session %s never listed as wanted on %s: %+v (%s)%s", sid, id, last, last.Sessions, logs())
}

func urlQuery(s string) string {
	r := strings.NewReplacer("%", "%25", " ", "%20", "&", "%26", "+", "%2B", "#", "%23", "?", "%3F", `\`, "%5C", ":", "%3A")
	return r.Replace(filepath.ToSlash(s))
}

// liveWatch is the laptop dashboard's /v1/live, every frame kept.
type liveWatch struct {
	mu     sync.Mutex
	frames []liveSeen
}

type liveSeen struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type machineNotify struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	SessionID   string `json:"session_id"`
	Title       string `json:"title"`
	PromptID    string `json:"prompt_id"`
	Machine     string `json:"machine"`
	MachineName string `json:"machine_name"`
}

func openLive(t *testing.T, base string) *liveWatch {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	dctx, dcancel := context.WithTimeout(ctx, 20*time.Second)
	defer dcancel()
	c, _, err := websocket.Dial(dctx, "ws"+strings.TrimPrefix(base, "http")+"/v1/live", nil)
	if err != nil {
		t.Fatal(err)
	}
	c.SetReadLimit(4 << 20)
	t.Cleanup(func() { _ = c.CloseNow() })
	lw := &liveWatch{}
	go func() {
		for {
			_, msg, err := c.Read(ctx)
			if err != nil {
				return
			}
			var f liveSeen
			if json.Unmarshal(msg, &f) == nil {
				lw.mu.Lock()
				lw.frames = append(lw.frames, f)
				lw.mu.Unlock()
			}
		}
	}()
	return lw
}

func (lw *liveWatch) find(match func(liveSeen) bool) bool {
	lw.mu.Lock()
	defer lw.mu.Unlock()
	for _, f := range lw.frames {
		if match(f) {
			return true
		}
	}
	return false
}

// waitMachines waits for a machines frame about computer id saying why.
func (lw *liveWatch) waitMachines(t *testing.T, id, why string, logs func() string) {
	t.Helper()
	deadline := time.Now().Add(45 * time.Second)
	for time.Now().Before(deadline) {
		if lw.find(func(f liveSeen) bool {
			var d struct {
				ID  string `json:"id"`
				Why string `json:"why"`
			}
			return f.Type == "machines" && json.Unmarshal(f.Data, &d) == nil && d.ID == id && d.Why == why
		}) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("no machines frame %q for %s on the laptop's live socket%s", why, id, logs())
}

// waitNotify waits for a notify frame from computer id about session sid.
func (lw *liveWatch) waitNotify(t *testing.T, id, sid string, logs func() string) machineNotify {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	var n machineNotify
	for time.Now().Before(deadline) {
		if lw.find(func(f liveSeen) bool {
			return f.Type == "notify" && json.Unmarshal(f.Data, &n) == nil && n.Machine == id && n.SessionID == sid
		}) {
			return n
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("home's prompt never reached the laptop's live socket%s", logs())
	return n
}
