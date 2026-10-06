package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// Someone who runs Claude Code with permissions skipped continued a session
// from Caprock and got one that asked before every command: the resume named
// no mode, so it started in the default. A continue picks up in the mode the
// session was last in, whoever posts it, and the detail says which.
func TestContinueCarriesThePermissionMode(t *testing.T) {
	e := newEnv(t)
	fa := &fakeAgents{avail: true}
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok", Settings: e.settings,
		Now: func() time.Time { return e.now }, Agents: fa})
	ctx := context.Background()
	db := e.st.DB()
	cwd := t.TempDir()
	proj := t.TempDir()

	session := func(id string, modes ...string) {
		t.Helper()
		tp := filepath.Join(proj, id+".jsonl")
		if err := os.WriteFile(tp, []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := store.UpsertSession(ctx, db, id, store.SessionPatch{Cwd: cwd, TranscriptPath: tp, Status: store.StatusEnded}); err != nil {
			t.Fatal(err)
		}
		for i, m := range modes {
			ev := event.Event{SessionID: id, Source: event.SourceHook, Kind: event.KindTurnUser, Ts: e.now.Add(time.Duration(i) * time.Second),
				Payload: json.RawMessage(`{"permission_mode":"` + m + `"}`)}
			if _, err := store.InsertEvent(ctx, db, &ev); err != nil {
				t.Fatal(err)
			}
		}
	}
	// Started asking, then switched to bypass with ⇧Tab: the newest wins.
	session("skips", "default", "bypassPermissions")
	session("asks", "default")
	session("silent")

	modeOf := func(id string) string {
		t.Helper()
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, httptest.NewRequest("GET", "/v1/sessions/"+id, nil))
		var d SessionDetail
		if rr.Code != 200 || json.Unmarshal(rr.Body.Bytes(), &d) != nil || d.Resume == nil || !d.Resume.OK {
			t.Fatalf("%s: %d %s", id, rr.Code, rr.Body.String())
		}
		return d.Resume.PermissionMode
	}
	spawn := func(body map[string]any) any {
		t.Helper()
		b, _ := json.Marshal(body)
		req := httptest.NewRequest("POST", "/v1/agents", bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("spawn %v: %d %s", body, rr.Code, rr.Body.String())
		}
		return fa.spawns[len(fa.spawns)-1]["permission_mode"]
	}

	if got := modeOf("skips"); got != "bypassPermissions" {
		t.Errorf("detail of a bypass session says %q", got)
	}
	if got := spawn(map[string]any{"cwd": cwd, "resume": "skips"}); got != "bypassPermissions" {
		t.Errorf("continue sent permission_mode %v, want bypassPermissions", got)
	}
	if got := spawn(map[string]any{"cwd": cwd, "resume": "skips", "fork": true}); got != "bypassPermissions" {
		t.Errorf("branch sent permission_mode %v, want bypassPermissions", got)
	}
	// A mode the request names is the one used.
	if got := spawn(map[string]any{"cwd": cwd, "resume": "skips", "permission_mode": "plan"}); got != "plan" {
		t.Errorf("an explicit mode was replaced with %v", got)
	}
	// A relay carries the source session on, mode included.
	if got := spawn(map[string]any{"relay_from": "skips", "prompt": "carry on"}); got != "bypassPermissions" {
		t.Errorf("relay sent permission_mode %v, want bypassPermissions", got)
	}
	// "default" is Claude Code's word for the mode no flag starts: no flag.
	if got := modeOf("asks"); got != "" {
		t.Errorf("a default-mode session reports %q", got)
	}
	if got := spawn(map[string]any{"cwd": cwd, "resume": "asks"}); got != nil {
		t.Errorf("a default-mode session was continued with %v", got)
	}
	if got := spawn(map[string]any{"cwd": cwd}); got != nil {
		t.Errorf("a new session with no preference got %v", got)
	}

	// With a preference stated, a session with nothing to carry and a new
	// session both start in it; a session with its own mode keeps its own.
	if code := e.putSettings(t, map[string]any{"spawn_permission_mode": "acceptEdits"}); code != 200 {
		t.Fatalf("PUT preference: %d", code)
	}
	if got := modeOf("silent"); got != "acceptEdits" {
		t.Errorf("a session with no recorded mode reports %q, want the preference", got)
	}
	if got := spawn(map[string]any{"cwd": cwd, "resume": "asks"}); got != "acceptEdits" {
		t.Errorf("continue with nothing to carry sent %v, want the preference", got)
	}
	if got := spawn(map[string]any{"cwd": cwd}); got != "acceptEdits" {
		t.Errorf("new session sent %v, want the preference", got)
	}
	if got := spawn(map[string]any{"cwd": cwd, "resume": "skips"}); got != "bypassPermissions" {
		t.Errorf("the preference overrode the session's own mode: %v", got)
	}
	// An explicit command is launched as given, flags and all.
	if got := spawn(map[string]any{"cwd": cwd, "command": "sh"}); got != nil {
		t.Errorf("a command spawn was given %v", got)
	}
}

func TestSpawnModePreferenceRoundTripsAndValidates(t *testing.T) {
	e := newEnv(t)
	if code := e.putSettings(t, map[string]any{"spawn_permission_mode": "bypassPermissions"}); code != 200 {
		t.Fatalf("PUT: %d", code)
	}
	var got Settings
	if code := e.get(t, "/v1/settings", &got); code != 200 || got.SpawnMode != "bypassPermissions" {
		t.Fatalf("came back as %q", got.SpawnMode)
	}
	// A word Claude Code refuses would stop every new session from starting.
	if code := e.putSettings(t, map[string]any{"spawn_permission_mode": "yolo"}); code != http.StatusBadRequest {
		t.Fatalf("PUT unknown mode: %d, want 400", code)
	}
	// An unrelated save leaves it alone; an empty one clears it.
	if code := e.putSettings(t, map[string]any{"editor": ""}); code != 200 {
		t.Fatalf("PUT editor: %d", code)
	}
	if e.get(t, "/v1/settings", &got); got.SpawnMode != "bypassPermissions" {
		t.Fatalf("an unrelated save changed it to %q", got.SpawnMode)
	}
	if code := e.putSettings(t, map[string]any{"spawn_permission_mode": ""}); code != 200 {
		t.Fatalf("PUT clear: %d", code)
	}
	if e.get(t, "/v1/settings", &got); got.SpawnMode != "" {
		t.Fatalf("clear left %q", got.SpawnMode)
	}
}
