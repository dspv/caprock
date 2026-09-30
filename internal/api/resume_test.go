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
	if r := detail("cx").Resume; r == nil || r.OK || r.Command != "codex resume cx" {
		t.Fatalf("codex: %+v", r)
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
	prompt("s1", "так", 2)
	prompt("s1", "/Users/ds/Desktop/shot.png", 3)
	prompt("s1", "Почини вставку в терминале:\nона дублируется", 4)
	sess, _ := store.GetSession(ctx, db, "s1")
	if text, src := describe(ctx, db, sess); text != "Почини вставку в терминале:" || src != DescriptionPrompt {
		t.Fatalf("prompt fallback: %q %q", text, src)
	}
	if err := store.SetTitle(ctx, db, "s1", "Terminal paste fix"); err != nil {
		t.Fatal(err)
	}
	sess, _ = store.GetSession(ctx, db, "s1")
	if text, src := describe(ctx, db, sess); text != "Terminal paste fix" || src != DescriptionTitle {
		t.Fatalf("title: %q %q", text, src)
	}
	long := strings.Repeat("я", 200)
	if got := clipLine(long); len([]rune(got)) != descriptionMaxRunes || !strings.HasSuffix(got, "…") {
		t.Fatalf("clip: %d runes", len([]rune(got)))
	}
}
