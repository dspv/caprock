//go:build smoke

package smoke

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"
)

// end_when_done, end to end on the real binary with the fake claude: a
// session started with it is ended when its turn's Stop arrives; one started
// without it is left at its prompt; one that asks for a permission right
// after the Stop is not done, and is ended only by the Stop that follows the
// answer. The flag outlives a daemon restart (it rides in the pty-host's
// metadata).
func TestEndWhenDoneEndsOnlyFlaggedFinishedSessions(t *testing.T) {
	root := t.TempDir()
	bin, home, data, proj := filepath.Join(root, "bin"), filepath.Join(root, "home"), filepath.Join(root, "data"), filepath.Join(root, "proj")
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
			time.Sleep(2 * time.Second)
		}
	})
	port := freePort(t)
	base := "http://127.0.0.1:" + strconv.Itoa(port)
	env := daemonEnv(bin, home, data)
	d := startBinary(t, caprock, env, port, data, "end-when-done")

	spawn := func(flag bool) string {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"cwd": proj, "prompt": "do the one job", "end_when_done": flag})
		var res struct {
			SessionID string `json:"session_id"`
		}
		if err := json.Unmarshal(post(t, base+"/v1/agents", string(body)), &res); err != nil || res.SessionID == "" {
			t.Fatalf("spawn: %v %+v", err, res)
		}
		return res.SessionID
	}
	hook := func(id, name string, extra string) {
		t.Helper()
		postHook(t, base, data, `{"session_id":"`+id+`","hook_event_name":"`+name+`"`+extra+`}`)
	}
	turn := func(id string) {
		t.Helper()
		hook(id, "UserPromptSubmit", `,"prompt":"do the one job"`)
		hook(id, "PreToolUse", `,"tool_name":"Bash","tool_input":{"command":"true"},"tool_use_id":"t1"`)
		hook(id, "PostToolUse", `,"tool_name":"Bash","tool_input":{"command":"true"},"tool_use_id":"t1","tool_response":{}`)
	}
	// waitEnded waits up to `within` for the session to end (want) or
	// watches it not end for that long (!want).
	waitEnded := func(id string, want bool, within time.Duration) {
		t.Helper()
		deadline := time.Now().Add(within)
		for {
			ended := getSession(t, base, id).Status == "ended"
			switch {
			case ended && want:
				return
			case ended:
				t.Fatalf("session %s was ended\ndaemon log:\n%s", id, d.log())
			case time.Now().After(deadline):
				if want {
					t.Fatalf("session %s was not ended within %v\ndaemon log:\n%s", id, within, d.log())
				}
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
	}

	flagged, plain, asks := spawn(true), spawn(false), spawn(true)
	for _, id := range []string{flagged, plain, asks} {
		term := attachTerm(t, base, id)
		term.waitFor(t, "fake-claude ready")
		term.close()
		turn(id)
	}
	// Mid-turn, nothing is ended.
	waitEnded(flagged, false, 2500*time.Millisecond)

	hook(flagged, "Stop", "")
	hook(plain, "Stop", "")
	hook(asks, "Stop", "")
	// Within the settle pause, the third session asks for a permission.
	hookPermissionRequest(t, base, data, asks)
	waitEnded(flagged, true, 15*time.Second)
	waitEnded(plain, false, 4*time.Second)
	waitEnded(asks, false, time.Second)
	if getSession(t, base, plain).Owned != true {
		t.Fatalf("the session without the flag is no longer Caprock's")
	}
	// Answered, the tool runs and the turn finishes: now it is done.
	waitPermission(t, base, asks, true)
	hook(asks, "PostToolUse", `,"tool_name":"Bash","tool_input":{"command":"date > out.txt"},"tool_use_id":"t2","tool_response":{}`)
	hook(asks, "Stop", "")
	waitEnded(asks, true, 15*time.Second)

	// Across a restart: the flag comes back with the session.
	later := spawn(true)
	term := attachTerm(t, base, later)
	term.waitFor(t, "fake-claude ready")
	term.close()
	turn(later)
	d.stop(t, true)
	d = startBinary(t, caprock, env, port, data, "end-when-done, restarted")
	if v := getSession(t, base, later); v.Status == "ended" || !v.Owned {
		t.Fatalf("the session did not survive the restart: %+v\ndaemon log:\n%s", v, d.log())
	}
	hook(later, "Stop", "")
	waitEnded(later, true, 15*time.Second)
	waitEnded(plain, false, time.Second)
}
