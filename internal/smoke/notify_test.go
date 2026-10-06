//go:build smoke

package smoke

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// WP-09, end to end on the real binary: a Claude Code permission prompt in an
// owned session reaches /v1/live as a notify frame within a second, with
// defaults (Telegram off, the app's approval notification on), carrying the
// prompt's id; an answer with that id applies only while the prompt waits.
func TestAnOwnedPromptNotifiesWithinASecond(t *testing.T) {
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
	d := startBinary(t, caprock, daemonEnv(bin, home, data), port, data, "notify")
	id := spawnOwned(t, base, proj)
	term := attachTerm(t, base, id)
	term.waitFor(t, "fake-claude ready")
	defer term.close()
	// The dialog the answer will read off the screen.
	term.send(t, "ask\r")
	term.waitFor(t, "asked")

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(base, "http")+"/v1/live", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	_, _, _ = c.Read(ctx) // hello
	type notify struct {
		Kind     string   `json:"kind"`
		Session  string   `json:"session_id"`
		Title    string   `json:"title"`
		Body     string   `json:"body"`
		PromptID string   `json:"prompt_id"`
		Actions  []string `json:"actions"`
	}
	got := make(chan notify, 1)
	go func() {
		for {
			_, msg, err := c.Read(ctx)
			if err != nil {
				return
			}
			var f struct {
				Type string `json:"type"`
				Data notify `json:"data"`
			}
			if json.Unmarshal(msg, &f) == nil && f.Type == "notify" {
				got <- f.Data
				return
			}
		}
	}()

	// As Claude Code 2.1.289 sends it as the dialog is drawn.
	sent := time.Now()
	postHook(t, base, data, `{"session_id":"`+id+`","transcript_path":"`+filepath.ToSlash(filepath.Join(home, "t.jsonl"))+`",`+
		`"cwd":"`+filepath.ToSlash(proj)+`","permission_mode":"default","hook_event_name":"PermissionRequest","tool_name":"Bash",`+
		`"tool_input":{"command":"date > out.txt","description":"Write current date to out.txt"},`+
		`"permission_suggestions":[{"type":"addDirectories","directories":["`+filepath.ToSlash(proj)+`"],"destination":"session"}]}`)
	var n notify
	select {
	case n = <-got:
	case <-time.After(time.Second):
		t.Fatalf("no notify frame within 1 s of the prompt\ndaemon log:\n%s", d.log())
	}
	t.Logf("notify frame %v after the hook: %+v", time.Since(sent).Round(time.Millisecond), n)
	promptID := waitPermission(t, base, id, true)
	if n.Kind != "approval" || n.Session != id || n.PromptID != promptID || !reflect.DeepEqual(n.Actions, []string{"allow", "deny"}) {
		t.Fatalf("frame %+v, want an approval for %s with prompt %s and allow/deny", n, id, promptID)
	}
	if !strings.HasPrefix(n.Title, "Needs approval · ") || !strings.Contains(n.Body, "Bash: date > out.txt") {
		t.Fatalf("title %q body %q do not say what is asked", n.Title, n.Body)
	}

	// A notification drawn for another prompt answers nothing; this one
	// answers once, and a second press finds the prompt gone.
	if code := answerPermission(t, base, id, "not-"+promptID); code != http.StatusConflict {
		t.Fatalf("a stale prompt id was answered: %d", code)
	}
	if code := answerPermission(t, base, id, promptID); code != http.StatusNoContent {
		t.Fatalf("answering the waiting prompt: %d\ndaemon log:\n%s", code, d.log())
	}
	if code := answerPermission(t, base, id, promptID); code != http.StatusConflict {
		t.Fatalf("an answered prompt was answered again: %d", code)
	}
}
