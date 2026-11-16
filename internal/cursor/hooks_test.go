package cursor

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/modelclass"
	"github.com/dspv/caprock/internal/sessionlink"
	"github.com/dspv/caprock/internal/store"
)

// The payloads are the shapes cursor.com/docs/agent/hooks gives (read
// 2026-11-16); no Cursor on this machine has run a hook against Caprock.
func post(t *testing.T, h http.Handler, body, session string) int {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/hook/cursor", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer tok")
	if session != "" {
		req.Header.Set("X-Caprock-Session", session)
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr.Code
}

func TestHooksRecordACLIChat(t *testing.T) {
	hh := newHarness(t)
	h := &HookHandler{Token: "tok", Recorder: hh.in.rec, Now: func() time.Time { return time.UnixMilli(1_790_000_000_000) }}
	for _, body := range []string{
		`{"conversation_id":"cli-1","generation_id":"g1","model":"gpt-5","hook_event_name":"beforeSubmitPrompt","workspace_roots":["/work/api"],"prompt":"add a health check"}`,
		`{"conversation_id":"cli-1","generation_id":"g1","model":"gpt-5","hook_event_name":"postToolUse","tool_name":"Shell","tool_input":{"command":"go test ./..."},"tool_output":"\"ok\"","tool_use_id":"tu-1","cwd":"/work/api"}`,
		`{"conversation_id":"cli-1","generation_id":"g1","model":"gpt-5","hook_event_name":"afterAgentResponse","text":"Added /healthz."}`,
		`{"conversation_id":"cli-1","generation_id":"g1","model":"gpt-5","hook_event_name":"stop","status":"completed","loop_count":0}`,
	} {
		if code := post(t, h, body, ""); code != http.StatusNoContent {
			t.Fatalf("%d for %s", code, body)
		}
		// The same hook twice is one event.
		post(t, h, body, "")
	}
	s, err := store.GetSession(hh.ctx, hh.st.DB(), "cli-1")
	if err != nil || s.Agent != Agent || s.Cwd != "/work/api" {
		t.Fatalf("session %+v %v", s, err)
	}
	for kind, want := range map[string]int{"turn.user": 1, "tool.pre": 1, "tool.post": 1, "turn.assistant": 1, "agent.stop": 1} {
		if n := hh.count(t, `kind = '`+kind+`'`); n != want {
			t.Errorf("%s: %d", kind, n)
		}
	}
	if n := hh.count(t, `kind = 'tool.pre' AND tool = 'Bash'`); n != 1 {
		t.Error("Shell was not filed as Bash")
	}
	// No hook carries usage: a reply from one has no tokens and no cost.
	if n := hh.count(t, `tokens_in > 0 OR cost_usd IS NOT NULL`); n != 0 {
		t.Errorf("%d events with usage from hooks", n)
	}
	if code := post(t, &HookHandler{Token: "other", Recorder: hh.in.rec}, `{}`, ""); code != http.StatusUnauthorized {
		t.Errorf("a wrong token got %d", code)
	}
}

// An editor chat is the editor reader's; its hooks would duplicate it.
func TestHooksLeaveEditorChatsToTheDatabase(t *testing.T) {
	hh := newHarness(t)
	h := &HookHandler{Token: "tok", Recorder: hh.in.rec, Editor: func(id string) bool { return id == "editor-1" }}
	post(t, h, `{"conversation_id":"editor-1","generation_id":"g","hook_event_name":"beforeSubmitPrompt","prompt":"hi"}`, "")
	if n := hh.count(t, `1`); n != 0 {
		t.Fatalf("an editor chat's hook became %d events", n)
	}
}

// A CLI Caprock started names its session in the environment, and the shim
// sends it on: the chat is filed under it, and the link is stored.
func TestHooksFromASpawnedCLIAreFiledUnderItsSession(t *testing.T) {
	hh := newHarness(t)
	ctx := context.Background()
	if err := store.UpsertSession(ctx, hh.st.DB(), "cap-1", store.SessionPatch{Cwd: "/work/api", Agent: Agent}); err != nil {
		t.Fatal(err)
	}
	h := &HookHandler{Token: "tok", Recorder: hh.in.rec, Link: sessionlink.New(hh.st, nil)}
	post(t, h, `{"conversation_id":"chat-9","generation_id":"g","hook_event_name":"beforeSubmitPrompt","prompt":"hi","workspace_roots":["/work/api"]}`, "cap-1")
	if n := hh.count(t, `sid = (SELECT sid FROM sessions WHERE session_id = 'cap-1') AND kind = 'turn.user'`); n != 1 {
		t.Fatalf("prompt under cap-1: %d", n)
	}
	if id, _ := store.SessionForNative(ctx, hh.st.DB(), Agent, "chat-9"); id != "cap-1" {
		t.Fatalf("link not stored: %q", id)
	}
	// Later hooks without the header still land there.
	post(t, h, `{"conversation_id":"chat-9","generation_id":"g2","hook_event_name":"stop","status":"completed"}`, "")
	if n := hh.count(t, `sid = (SELECT sid FROM sessions WHERE session_id = 'cap-1') AND kind = 'agent.stop'`); n != 1 {
		t.Fatalf("stop under cap-1: %d", n)
	}
}

func TestNeutralReplies(t *testing.T) {
	if string(NeutralReply("beforeSubmitPrompt")) != `{"continue":true}` || string(NeutralReply("stop")) != `{}` {
		t.Fatal("replies")
	}
	for _, ev := range HookEvents {
		switch ev {
		case "preToolUse", "beforeShellExecution", "beforeMCPExecution", "beforeReadFile", "subagentStart":
			t.Errorf("%s is a permission hook", ev)
		}
	}
}

// The CLI's meta row as cursor-agent 2025.09.12's source writes it: hex of a
// JSON object.
func TestCLIChatMeta(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CURSOR_CONFIG_DIR", dir)
	cwd := "/work/api"
	chat := ChatDir(cwd, "5f0c7a52-1d1b-4c7e-9a43-0b7f0d1c2e3a")
	if err := os.MkdirAll(chat, 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(chat, "store.db")))
	if err != nil {
		t.Fatal(err)
	}
	meta := `{"agentId":"5f0c7a52-1d1b-4c7e-9a43-0b7f0d1c2e3a","latestRootBlobId":"ab","name":"Health check","createdAt":1790000000000,"mode":"default","lastUsedModel":"gpt-5"}`
	for _, q := range []string{
		`CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)`,
		`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`,
		`INSERT INTO meta VALUES ('0', '` + hex.EncodeToString([]byte(meta)) + `')`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	_ = db.Close()
	if !ChatExists(cwd, "5f0c7a52-1d1b-4c7e-9a43-0b7f0d1c2e3a") || ChatExists("/elsewhere", "5f0c7a52-1d1b-4c7e-9a43-0b7f0d1c2e3a") {
		t.Fatal("ChatExists")
	}
	chats := CLIChats(context.Background(), dir, 10)
	if len(chats) != 1 || chats[0].Model != "gpt-5" || chats[0].Name != "Health check" || chats[0].FolderHash != FolderHash(cwd) {
		t.Fatalf("chats %+v", chats)
	}
	if err := os.WriteFile(filepath.Join(dir, "cli-config.json"), []byte(`{"version":1,"model":{"modelId":"sonnet-4","displayModelId":"sonnet-4"}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if m := CLIConfiguredModel(dir); m != "sonnet-4" {
		t.Fatalf("configured model %q", m)
	}
}

func TestModelFamilies(t *testing.T) {
	for in, want := range map[string]string{
		"claude-4.5-sonnet-thinking":  "claude-sonnet-4-5",
		"claude-4-sonnet":             "claude-sonnet-4",
		"claude-4.1-opus-thinking":    "claude-opus-4-1",
		"claude-sonnet-4-5-20250929":  "claude-sonnet-4-5",
		"claude-sonnet-4-20250514":    "claude-sonnet-4",
		"claude-opus-5-5":             "claude-opus-5-5",
		"claude-opus-4-1-20250805":    "claude-opus-4-1",
		"claude-sonnet-4-5[1m]":       "claude-sonnet-4-5",
		"gpt-5-fast":                  "gpt-5",
		"composer-1":                  "composer-1",
		"anthropic/claude-sonnet-4.6": "anthropic/claude-sonnet-4.6",
	} {
		if in == "anthropic/claude-sonnet-4.6" {
			want = "claude-sonnet-4-6"
		}
		if got := modelclass.Family(in); got != want {
			t.Errorf("Family(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPaths(t *testing.T) {
	env := func(m map[string]string) Getenv { return func(k string) string { return m[k] } }
	if got := userDir(env(nil), "darwin", "/Users/x"); got != filepath.Join("/Users/x", "Library", "Application Support", "Cursor", "User") {
		t.Errorf("darwin %s", got)
	}
	if got := userDir(env(map[string]string{"APPDATA": `C:\Users\x\AppData\Roaming`}), "windows", `C:\Users\x`); got != filepath.Join(`C:\Users\x\AppData\Roaming`, "Cursor", "User") {
		t.Errorf("windows %s", got)
	}
	if got := userDir(env(nil), "linux", "/home/x"); got != filepath.Join("/home/x", ".config", "Cursor", "User") {
		t.Errorf("linux %s", got)
	}
	if got := configDir(env(map[string]string{"XDG_CONFIG_HOME": "/xdg"}), "/home/x"); got != filepath.Join("/xdg", "cursor") {
		t.Errorf("config %s", got)
	}
	if got := configDir(env(nil), "/home/x"); got != filepath.Join("/home/x", ".cursor") {
		t.Errorf("config default %s", got)
	}
	if got := fileURIPath("file:///Users/x/dev/site"); got != filepath.FromSlash("/Users/x/dev/site") {
		t.Errorf("uri %s", got)
	}
	if got := fileURIPath("file:///c%3A/dev/site"); got != filepath.FromSlash("C:/dev/site") {
		t.Errorf("windows uri %s", got)
	}
	if fileURIPath("vscode-remote://background-composer/x") != "" {
		t.Error("a remote folder is no folder of this machine's")
	}
}
