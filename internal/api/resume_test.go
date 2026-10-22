package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// FB-036: whether a session can be continued is decided by what is on disk,
// not by who started it — and when it cannot, the reason is said.
func TestResumeInfoFollowsTheDiskNotTheOwner(t *testing.T) {
	e := newEnv(t)
	fa := &fakeAgents{avail: true, held: map[string]bool{"running": true}}
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, Agents: fa})
	ctx := context.Background()
	db := e.st.DB()

	proj := t.TempDir()
	cwd := t.TempDir()
	transcript := func(id string) {
		if err := os.WriteFile(filepath.Join(proj, id+".jsonl"), []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	add := func(id string, p store.SessionPatch, ended, owned bool) {
		if p.Status == "" && ended {
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
	transcript("ok")
	add("ok", store.SessionPatch{Cwd: cwd, TranscriptPath: filepath.Join(proj, "ok", "subagents", "agent-1.jsonl")}, true, false)
	add("purged", store.SessionPatch{Cwd: cwd, TranscriptPath: filepath.Join(proj, "purged.jsonl")}, true, false)
	transcript("moved")
	add("moved", store.SessionPatch{Cwd: filepath.Join(cwd, "gone"), TranscriptPath: filepath.Join(proj, "moved.jsonl")}, true, false)
	transcript("mine")
	add("mine", store.SessionPatch{Cwd: cwd, TranscriptPath: filepath.Join(proj, "mine.jsonl")}, true, true)
	add("running", store.SessionPatch{Cwd: cwd}, false, true)
	// Started by Caprock before a restart: not ended, but its terminal is gone.
	transcript("orphan")
	add("orphan", store.SessionPatch{Cwd: cwd, TranscriptPath: filepath.Join(proj, "orphan.jsonl")}, false, true)
	add("cx", store.SessionPatch{Cwd: cwd, Agent: "codex"}, true, false)
	// Codex still writing: two processes on one rollout would interleave.
	add("cx-live", store.SessionPatch{Cwd: cwd, Agent: "codex"}, false, false)
	// OpenCode, started by Caprock and linked to OpenCode's own id.
	add("oc-mine", store.SessionPatch{Cwd: cwd, Agent: "opencode"}, true, true)
	if _, err := store.SetNativeID(ctx, db, "oc-mine", "ses_abc"); err != nil {
		t.Fatal(err)
	}
	// Started by Caprock, nothing ever sent: OpenCode never made a session.
	add("oc-empty", store.SessionPatch{Cwd: cwd, Agent: "opencode"}, true, true)

	detail := func(id string) SessionDetail {
		t.Helper()
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, httptest.NewRequest("GET", "/v1/sessions/"+id, nil))
		if rr.Code != 200 {
			t.Fatalf("%s: %d", id, rr.Code)
		}
		var d SessionDetail
		if err := json.Unmarshal(rr.Body.Bytes(), &d); err != nil {
			t.Fatal(err)
		}
		return d
	}

	// The recorded path points into a subagent; the main transcript beside it
	// is what --resume reads, and it is there.
	if r := detail("ok").Resume; r == nil || !r.OK || !strings.Contains(r.Command, "claude --resume ok") || !strings.HasPrefix(r.Command, "cd ") {
		t.Fatalf("ok: %+v", r)
	}
	if r := detail("purged").Resume; r == nil || r.OK || !strings.Contains(r.Reason, "deleted") {
		t.Fatalf("purged: %+v", r)
	}
	if r := detail("moved").Resume; r == nil || r.OK || !strings.Contains(r.Reason, "no longer exists") {
		t.Fatalf("moved: %+v", r)
	}
	// Its folder is gone but its transcript is not: the command to copy must
	// not start by cd-ing into the missing folder.
	if r := detail("moved").Resume; r.Command != "claude --resume moved" {
		t.Fatalf("moved command: %q", r.Command)
	}
	// Started by Caprock and since ended: exactly as resumable as any other.
	if r := detail("mine").Resume; r == nil || !r.OK {
		t.Fatalf("owned and ended: %+v", r)
	}
	// Running under Caprock: typed into, not resumed.
	if d := detail("running"); d.Resume != nil || d.Detached {
		t.Fatalf("owned and live: %+v %v", d.Resume, d.Detached)
	}
	// Its terminal went with the last run of Caprock: continue is the way back
	// (FB-040), not an empty terminal tab.
	if d := detail("orphan"); !d.Detached || d.Resume == nil || !d.Resume.OK {
		t.Fatalf("owned, live, no terminal here: detached=%v resume=%+v", d.Detached, d.Resume)
	}
	if r := detail("cx").Resume; r == nil || !r.OK || !strings.HasSuffix(r.Command, "&& codex resume cx") {
		t.Fatalf("codex: %+v", r)
	}
	if r := detail("cx-live").Resume; r == nil || r.OK || !strings.Contains(r.Reason, "still running") {
		t.Fatalf("live codex: %+v", r)
	}
	// The agent's resume flag takes the agent's id, not Caprock's.
	if r := detail("oc-mine").Resume; r == nil || !r.OK || !strings.HasSuffix(r.Command, "&& opencode --session ses_abc") {
		t.Fatalf("linked opencode: %+v", r)
	}
	if r := detail("oc-empty").Resume; r == nil || r.OK || r.Command != "" || !strings.Contains(r.Reason, "Nothing was sent") {
		t.Fatalf("unlinked opencode: %+v", r)
	}

	// A stale button is refused with the same reason instead of opening a
	// terminal that dies.
	req := httptest.NewRequest("POST", "/v1/agents", strings.NewReader(`{"cwd":"`+filepath.ToSlash(cwd)+`","resume":"purged"}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	e.srv.Config.Handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), "deleted") {
		t.Fatalf("stale resume: %d %s", rr.Code, rr.Body.String())
	}
}

func TestProjectDirNameMatchesClaudeCode(t *testing.T) {
	if got := projectDirName("/Users/ds/dev/my.app_2"); got != "-Users-ds-dev-my-app-2" {
		t.Fatalf("got %q", got)
	}
}

// FB-035: a card says what its session was about.
func TestDescriptionPrefersTitleThenASubstantivePrompt(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	db := e.st.DB()
	prompt := func(id, text string, at int) {
		p, _ := json.Marshal(map[string]string{"prompt": text})
		ev := event.Event{Ts: e.now.Add(time.Duration(at) * time.Second), SessionID: id, Source: event.SourceHook, Kind: event.KindTurnUser, Payload: p}
		if _, err := e.rec.Record(ctx, &ev, rollup.SessionInfo{Cwd: "/repo"}); err != nil {
			t.Fatal(err)
		}
	}
	prompt("s1", "<local-command-caveat>Caveat: the messages below…</local-command-caveat>", 1)
	prompt("s1", "ok", 2)
	prompt("s1", "/Users/ds/Desktop/shot.png", 3)
	prompt("s1", "Fix the paste in the terminal:\nit comes out twice", 4)
	sess, _ := store.GetSession(ctx, db, "s1")
	if text, src := describe(ctx, db, sess); text != "Fix the paste in the terminal:" || src != DescriptionPrompt {
		t.Fatalf("prompt fallback: %q %q", text, src)
	}
	if err := store.SetTitle(ctx, db, "s1", "Terminal paste fix"); err != nil {
		t.Fatal(err)
	}
	sess, _ = store.GetSession(ctx, db, "s1")
	if text, src := describe(ctx, db, sess); text != "Terminal paste fix" || src != DescriptionTitle {
		t.Fatalf("title: %q %q", text, src)
	}
	long := strings.Repeat("ω", 200)
	if got := clipLine(long); len([]rune(got)) != descriptionMaxRunes || !strings.HasSuffix(got, "…") {
		t.Fatalf("clip: %d runes", len([]rune(got)))
	}
}

// ADR-069: an ended Hermes session is continued in a Caprock tab like a Codex
// or OpenCode one — by Hermes's own id, from its state database, with hermes
// installed. HERMES_HOME points at a temporary folder: never the real
// ~/.hermes.
func TestResumeInfoContinuesHermes(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HERMES_HOME", home)
	if err := os.WriteFile(filepath.Join(home, "state.db"), []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}
	e := newEnv(t)
	fa := &fakeAgents{avail: true}
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, Agents: fa})
	ctx := context.Background()
	db := e.st.DB()
	cwd := t.TempDir()

	add := func(id string, cwd string, ended, owned bool) {
		t.Helper()
		p := store.SessionPatch{Cwd: cwd, Agent: "hermes"}
		if ended {
			p.Status = store.StatusEnded
		}
		if err := store.UpsertSession(ctx, db, id, p); err != nil {
			t.Fatal(err)
		}
		if owned {
			if err := store.MarkOwned(ctx, db, id, "", "hermes", 1); err != nil {
				t.Fatal(err)
			}
			if ended {
				if err := store.SetExit(ctx, db, id, 0); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	add("20261015_101500_ab12cd", cwd, true, false)
	add("hm-live", cwd, false, false)
	add("hm-gone", filepath.Join(cwd, "gone"), true, false)
	// Started by Caprock and linked to the id Hermes minted for it.
	add("hm-mine", cwd, true, true)
	if _, err := store.SetNativeID(ctx, db, "hm-mine", "20261015_102000_ef34ab"); err != nil {
		t.Fatal(err)
	}
	// Started by Caprock, nothing sent: Hermes never wrote a row.
	add("hm-empty", cwd, true, true)

	resume := func(id string) *ResumeInfo {
		t.Helper()
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, httptest.NewRequest("GET", "/v1/sessions/"+id, nil))
		if rr.Code != 200 {
			t.Fatalf("%s: %d", id, rr.Code)
		}
		var d SessionDetail
		if err := json.Unmarshal(rr.Body.Bytes(), &d); err != nil {
			t.Fatal(err)
		}
		return d.Resume
	}

	if r := resume("20261015_101500_ab12cd"); r == nil || !r.OK || !strings.HasSuffix(r.Command, "&& hermes chat --resume 20261015_101500_ab12cd") || !strings.HasPrefix(r.Command, "cd ") {
		t.Fatalf("ended hermes: %+v", r)
	}
	if r := resume("hm-mine"); r == nil || !r.OK || !strings.HasSuffix(r.Command, "&& hermes chat --resume 20261015_102000_ef34ab") {
		t.Fatalf("linked hermes: %+v", r)
	}
	// Two processes on one Hermes session: it waits for the first to end.
	if r := resume("hm-live"); r == nil || r.OK || !strings.Contains(r.Reason, "still running") {
		t.Fatalf("live hermes: %+v", r)
	}
	// Hermes finds a session by id from any folder, so the command drops the cd.
	if r := resume("hm-gone"); r == nil || r.OK || !strings.Contains(r.Reason, "no longer exists") || r.Command != "hermes chat --resume hm-gone" {
		t.Fatalf("hermes, folder gone: %+v", r)
	}
	if r := resume("hm-empty"); r == nil || r.OK || r.Command != "" || !strings.Contains(r.Reason, "Nothing was sent") {
		t.Fatalf("unlinked hermes: %+v", r)
	}

	// The continue request goes through to the agent manager.
	post := func(id string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/v1/agents", strings.NewReader(`{"cwd":"`+filepath.ToSlash(cwd)+`","resume":"`+id+`"}`))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, req)
		return rr
	}
	if rr := post("20261015_101500_ab12cd"); rr.Code >= 300 {
		t.Fatalf("continue hermes: %d %s", rr.Code, rr.Body.String())
	}

	// hermes is not installed: the command is still offered for a terminal.
	fa.avail = false
	if r := resume("20261015_101500_ab12cd"); r == nil || r.OK || !strings.Contains(r.Reason, "cannot find hermes") || r.Command == "" {
		t.Fatalf("hermes not installed: %+v", r)
	}
	fa.avail = true

	// Its state database is gone: nothing for `chat --resume` to load.
	if err := os.Remove(filepath.Join(home, "state.db")); err != nil {
		t.Fatal(err)
	}
	if r := resume("20261015_101500_ab12cd"); r == nil || r.OK || !strings.Contains(r.Reason, "state database") {
		t.Fatalf("hermes without state.db: %+v", r)
	}
	if rr := post("20261015_101500_ab12cd"); rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), "state database") {
		t.Fatalf("stale hermes continue: %d %s", rr.Code, rr.Body.String())
	}
}
