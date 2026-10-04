package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/nativeterm"
	"github.com/dspv/caprock/internal/store"
)

// The ownership rule, as a table: what may be done with a session in the
// user's own terminal, by who started it and whether it is still running.
func TestOpenTerminalModes(t *testing.T) {
	cases := []struct {
		agent              string
		ended, owned, held bool
		want               []string
	}{
		// Ended: resumed, whoever started it.
		{"claude", true, false, false, []string{"resume"}},
		{"claude", true, true, false, []string{"resume"}},
		{"codex", true, false, false, []string{"resume"}},
		{"opencode", true, true, false, []string{"resume"}},
		// Running under Caprock, which holds it: Caprock's to stop.
		{"claude", false, true, true, []string{"move", "fork"}},
		{"", false, true, true, []string{"move", "fork"}},
		{"codex", false, true, true, []string{"move"}},
		// Running anywhere else: never stopped, only branched — and only
		// Claude Code branches without a second copy of the cost.
		{"claude", false, false, false, []string{"fork"}},
		{"claude", false, true, false, []string{"fork"}},
		{"codex", false, false, false, nil},
		{"opencode", false, true, false, nil},
	}
	for _, c := range cases {
		got, reason := openTerminalModes(c.agent, c.ended, c.owned, c.held)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s ended=%v owned=%v held=%v: %v, want %v", c.agent, c.ended, c.owned, c.held, got, c.want)
		}
		if len(got) == 0 && reason == "" {
			t.Errorf("%s ended=%v owned=%v held=%v: nothing allowed and no reason", c.agent, c.ended, c.owned, c.held)
		}
		for _, m := range got {
			if m == OpenMove && (!c.owned || !c.held) {
				t.Errorf("move offered for a process Caprock does not hold: %+v", c)
			}
		}
	}
}

type fakeTerminals struct {
	opened []struct {
		terminal, cwd string
		argv          []string
	}
	// heldAtLaunch is whether the session was still held when the window
	// would have opened — a move must stop Caprock's process first.
	heldAtLaunch []bool
	agents       *fakeAgents
	id           string
	fail         error
}

func (f *fakeTerminals) List() ([]nativeterm.Terminal, string) {
	return []nativeterm.Terminal{{ID: "iterm2", Name: "iTerm2"}, {ID: "terminal", Name: "Terminal"}}, "iterm2"
}

func (f *fakeTerminals) Open(_ context.Context, terminal, cwd string, argv []string, before func() error) (nativeterm.Terminal, string, error) {
	cmd := nativeterm.Display("darwin", cwd, argv)
	if f.fail != nil {
		return nativeterm.Terminal{}, cmd, f.fail
	}
	if before != nil {
		if err := before(); err != nil {
			return nativeterm.Terminal{}, cmd, err
		}
	}
	f.opened = append(f.opened, struct {
		terminal, cwd string
		argv          []string
	}{terminal, cwd, argv})
	if f.agents != nil {
		f.heldAtLaunch = append(f.heldAtLaunch, f.agents.Holds(f.id))
	}
	if terminal == "" {
		terminal = "iterm2"
	}
	return nativeterm.Terminal{ID: terminal, Name: terminal}, cmd, nil
}

func TestOpenTerminalEndpoint(t *testing.T) {
	e := newEnv(t)
	fa := &fakeAgents{avail: true, held: map[string]bool{"mine-live": true}}
	ft := &fakeTerminals{agents: fa, id: "mine-live"}
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, Agents: fa, Terminals: ft})
	ctx := context.Background()
	db := e.st.DB()

	cwd := t.TempDir()
	tdir := t.TempDir()
	add := func(id string, p store.SessionPatch, ended, owned bool) {
		t.Helper()
		if p.TranscriptPath == "" {
			p.TranscriptPath = filepath.Join(tdir, id+".jsonl")
			if err := os.WriteFile(p.TranscriptPath, []byte("{}\n"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		if ended {
			p.Status = store.StatusEnded
		}
		if err := store.UpsertSession(ctx, db, id, p); err != nil {
			t.Fatal(err)
		}
		if owned {
			if err := store.MarkOwned(ctx, db, id, "", "claude", 1); err != nil {
				t.Fatal(err)
			}
			if ended {
				if err := store.SetExit(ctx, db, id, 0); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	add("ended", store.SessionPatch{Cwd: cwd}, true, false)
	add("mine-live", store.SessionPatch{Cwd: cwd}, false, true)
	add("theirs-live", store.SessionPatch{Cwd: cwd}, false, false)
	add("cx-live", store.SessionPatch{Cwd: cwd, Agent: "codex"}, false, false)
	add("gem", store.SessionPatch{Cwd: cwd, Agent: "gemini"}, true, false)
	add("gone", store.SessionPatch{Cwd: filepath.Join(cwd, "gone")}, true, false)
	// Started here as Codex and linked to its own thread: the resume takes
	// Codex's id, not Caprock's.
	add("cx-mine", store.SessionPatch{Cwd: cwd, Agent: "codex"}, true, true)
	if _, err := store.SetNativeID(ctx, db, "cx-mine", "019a0000-aaaa-7bbb-8ccc-000000000001"); err != nil {
		t.Fatal(err)
	}
	// Started here as OpenCode and never sent anything: nothing to resume.
	add("oc-empty", store.SessionPatch{Cwd: cwd, Agent: "opencode"}, true, true)

	post := func(id, body string) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest("POST", "/v1/sessions/"+id+"/open-terminal", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, req)
		var out map[string]any
		_ = json.Unmarshal(rr.Body.Bytes(), &out)
		return rr.Code, out
	}
	detail := func(id string) SessionDetail {
		t.Helper()
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, httptest.NewRequest("GET", "/v1/sessions/"+id, nil))
		var d SessionDetail
		_ = json.Unmarshal(rr.Body.Bytes(), &d)
		return d
	}

	// The detail says what the button may do.
	if o := detail("mine-live").OpenTerminal; o == nil || !reflect.DeepEqual(o.Modes, []string{"move", "fork"}) {
		t.Fatalf("mine-live info: %+v", o)
	}
	if o := detail("gem").OpenTerminal; o != nil {
		t.Fatalf("gemini has no resume by id, so no button: %+v", o)
	}

	// Ended: resumed in its folder, in the preferred terminal.
	code, out := post("ended", `{}`)
	if code != 200 || out["mode"] != "resume" || !strings.Contains(out["command"].(string), "claude --resume ended") {
		t.Fatalf("ended: %d %v", code, out)
	}
	if last := ft.opened[len(ft.opened)-1]; last.cwd != cwd || !reflect.DeepEqual(last.argv, []string{"claude", "--resume", "ended"}) {
		t.Fatalf("ended launch: %+v", last)
	}
	// A named terminal is passed on.
	if code, _ := post("ended", `{"terminal":"terminal","mode":"resume"}`); code != 200 || ft.opened[len(ft.opened)-1].terminal != "terminal" {
		t.Fatalf("named terminal: %d", code)
	}
	// Its folder is gone: Claude Code finds it by id from anywhere.
	if code, _ := post("gone", `{}`); code != 200 || ft.opened[len(ft.opened)-1].cwd != "" {
		t.Fatalf("gone folder: %d %+v", code, ft.opened[len(ft.opened)-1])
	}

	if code, _ := post("cx-mine", `{}`); code != 200 || !reflect.DeepEqual(ft.opened[len(ft.opened)-1].argv, []string{"codex", "resume", "019a0000-aaaa-7bbb-8ccc-000000000001"}) {
		t.Fatalf("codex native id: %d %+v", code, ft.opened[len(ft.opened)-1])
	}
	if o := detail("oc-empty").OpenTerminal; o == nil || len(o.Modes) != 0 || !strings.Contains(o.Reason, "Nothing was sent") {
		t.Fatalf("unlinked opencode: %+v", o)
	}

	// Someone else's live session: never stopped, only branched.
	if code, out := post("theirs-live", `{"mode":"move"}`); code != http.StatusConflict {
		t.Fatalf("move theirs: %d %v", code, out)
	}
	if len(fa.sigs) != 0 {
		t.Fatalf("a process Caprock did not start was signalled: %v", fa.sigs)
	}
	code, out = post("theirs-live", `{}`)
	if code != 200 || out["mode"] != "fork" || !reflect.DeepEqual(ft.opened[len(ft.opened)-1].argv, []string{"claude", "--resume", "theirs-live", "--fork-session"}) {
		t.Fatalf("fork theirs: %d %v", code, out)
	}
	// A live Codex session that is not Caprock's: nothing to do yet.
	if code, _ := post("cx-live", `{}`); code != http.StatusConflict {
		t.Fatalf("codex live: %d", code)
	}
	if code, _ := post("gem", `{}`); code != http.StatusConflict {
		t.Fatalf("gemini: %d", code)
	}
	if code, _ := post("nope", `{}`); code != http.StatusNotFound {
		t.Fatalf("unknown: %d", code)
	}
	if code, _ := post("ended", `{"mode":"teleport"}`); code != http.StatusBadRequest {
		t.Fatalf("bad mode: %d", code)
	}

	// Caprock's own live session, moved: stopped first, then resumed, and no
	// longer Caprock's.
	code, out = post("mine-live", `{"mode":"move"}`)
	if code != 200 || out["mode"] != "move" {
		t.Fatalf("move: %d %v", code, out)
	}
	if !reflect.DeepEqual(fa.sigs, []string{"resume", "term"}) {
		t.Fatalf("move signals: %v", fa.sigs)
	}
	if !reflect.DeepEqual(ft.heldAtLaunch[len(ft.heldAtLaunch)-1:], []bool{false}) {
		t.Fatalf("the window opened while Caprock's process still ran")
	}
	if !reflect.DeepEqual(ft.opened[len(ft.opened)-1].argv, []string{"claude", "--resume", "mine-live"}) {
		t.Fatalf("move argv: %v", ft.opened[len(ft.opened)-1].argv)
	}
	if sess, _ := store.GetSession(ctx, db, "mine-live"); sess.Owned {
		t.Fatal("a moved session is still recorded as Caprock's")
	}

	// A launch that fails says why and hands back the command to copy.
	ft.fail = nativeterm.ErrNoTerminal
	code, out = post("ended", `{}`)
	if code != http.StatusBadRequest || out["command"] == "" {
		t.Fatalf("failure: %d %v", code, out)
	}
}

func TestTerminalsEndpointAndSetting(t *testing.T) {
	e := newEnv(t)
	rr := httptest.NewRecorder()
	e.srv.Config.Handler.ServeHTTP(rr, httptest.NewRequest("GET", "/v1/terminals", nil))
	if rr.Code != http.StatusNotImplemented {
		t.Fatalf("no controller: %d", rr.Code)
	}
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok", Terminals: &fakeTerminals{}, Settings: &fakeSettings{}})
	rr = httptest.NewRecorder()
	e.srv.Config.Handler.ServeHTTP(rr, httptest.NewRequest("GET", "/v1/terminals", nil))
	if rr.Code != 200 || !strings.Contains(rr.Body.String(), `"preferred":"iterm2"`) || !strings.Contains(rr.Body.String(), `"name":"iTerm2"`) {
		t.Fatalf("list: %d %s", rr.Code, rr.Body.String())
	}
	put := func(body string) int {
		req := httptest.NewRequest("PUT", "/v1/settings", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, req)
		return rr.Code
	}
	if c := put(`{"terminal":"rm -rf"}`); c != http.StatusBadRequest {
		t.Fatalf("unknown terminal accepted: %d", c)
	}
	if c := put(`{"terminal":""}`); c != 200 {
		t.Fatalf("clear: %d", c)
	}
}
