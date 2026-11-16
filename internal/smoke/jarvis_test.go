//go:build smoke

package smoke

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"
)

// ADR-096, end to end on the real binary with the fake claude: a question
// dialog's hook makes a decision card in the digest — options, the
// recommended one marked, answerable only for the session Caprock started —
// and POST /v1/jarvis/answer types the Other row's keys into that session
// only while the dialog is on its screen. The fake binary draws the dialog
// and echoes what reaches it; that the keys are the ones Claude Code reads
// is pinned against its bundle in agents.TestQuestionKeysMatchClaudeCode.
func TestJarvisAnswersAQuestionDialog(t *testing.T) {
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
	d := startBinary(t, caprock, daemonEnv(bin, home, data), port, data, "jarvis")
	id := spawnOwned(t, base, proj)
	term := attachTerm(t, base, id)
	term.waitFor(t, "fake-claude ready")
	defer term.close()

	ask := `"hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Which database?",` +
		`"header":"Database","multiSelect":false,"options":[{"label":"SQLite","description":"One file"},` +
		`{"label":"Postgres (Recommended)","description":"What prod runs"}]}]}}`
	postHook(t, base, data, `{"session_id":"`+id+`","cwd":"`+filepath.ToSlash(proj)+`",`+ask)
	postHook(t, base, data, `{"session_id":"by-hand","cwd":"`+filepath.ToSlash(proj)+`",`+ask)

	type need struct {
		SessionID string `json:"session_id"`
		Kind      string `json:"kind"`
		Options   []struct {
			Label       string `json:"label"`
			Recommended bool   `json:"recommended"`
		} `json:"options"`
		Answerable bool `json:"answerable"`
	}
	var mine need
	deadline := time.Now().Add(10 * time.Second)
	for mine.SessionID == "" {
		var dg struct {
			NeedsYou []need `json:"needs_you"`
		}
		callJSON(t, "GET", base+"/v1/jarvis", "", &dg)
		for _, n := range dg.NeedsYou {
			if n.SessionID == id {
				mine = n
			}
			if n.SessionID == "by-hand" && n.Answerable {
				t.Fatalf("a session Caprock did not start is answerable: %+v", n)
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no question card for %s: %+v\ndaemon log:\n%s", id, dg, d.log())
		}
		if mine.SessionID == "" {
			time.Sleep(100 * time.Millisecond)
		}
	}
	if mine.Kind != "question" || !mine.Answerable || len(mine.Options) != 2 || mine.Options[1].Label != "Postgres" || !mine.Options[1].Recommended {
		t.Fatalf("card %+v", mine)
	}

	// Not on the screen yet: nothing is typed.
	if code := callJSON(t, "POST", base+"/v1/jarvis/answer", `{"session_id":"`+id+`","text":"MySQL"}`, nil); code != 409 {
		t.Fatalf("answered a dialog not on the screen: %d", code)
	}
	if code := callJSON(t, "POST", base+"/v1/jarvis/answer", `{"session_id":"by-hand","option":0}`, nil); code != 403 {
		t.Fatalf("a session Caprock did not start: %d", code)
	}
	term.send(t, "question\r")
	term.waitFor(t, "questioned")
	if code := callJSON(t, "POST", base+"/v1/jarvis/answer", `{"session_id":"`+id+`","text":"MySQL"}`, nil); code != 200 {
		t.Fatalf("answer: %d\ndaemon log:\n%s", code, d.log())
	}
	// The Other row's number, the text, Enter: the fake reads them as one line.
	term.waitFor(t, "you-said:3MySQL")
}
