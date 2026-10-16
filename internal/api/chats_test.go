package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// chatEnv is an env whose data directory holds one chat, c1, in its own
// folder under chats/, and one work session, w1, in a project folder.
func chatEnv(t *testing.T) (*env, string) {
	t.Helper()
	e := newEnv(t)
	data := t.TempDir()
	e.api.d.DataDir = data
	chat := filepath.Join(data, "chats", "2026-10-16-101010")
	if err := os.MkdirAll(chat, 0o700); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	record := func(id, cwd, prompt string) {
		for _, ev := range []*event.Event{
			{SessionID: id, Source: event.SourceHook, Kind: event.KindTurnUser, Key: "prompt:" + id, Ts: e.now, Payload: json.RawMessage(`{"prompt":"` + prompt + `"}`)},
			{SessionID: id, Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: "msg:" + id, Ts: e.now.Add(time.Second), Model: "claude-opus-5", Tokens: &event.TokenDelta{In: 10, Out: 20}, Payload: json.RawMessage(`{"text":"sure"}`)},
		} {
			if _, err := e.rec.Record(ctx, ev, rollup.SessionInfo{Cwd: cwd}); err != nil {
				t.Fatal(err)
			}
		}
	}
	record("c1", chat, "what is a monad")
	record("w1", t.TempDir(), "fix the build")
	if err := store.MarkChat(ctx, e.st.DB(), "c1"); err != nil {
		t.Fatal(err)
	}
	return e, chat
}

func TestChatsAreListedApartFromWork(t *testing.T) {
	e, _ := chatEnv(t)
	var l ChatList
	if code := e.get(t, "/v1/chats", &l); code != 200 {
		t.Fatalf("chats: %d", code)
	}
	if len(l.Items) != 1 || l.Items[0].SessionID != "c1" || !l.Items[0].Chat || l.Total != 1 || l.Chats != 1 || l.Archived != 0 {
		t.Fatalf("chats: %+v", l)
	}
	var work, only []SessionSummary
	e.get(t, "/v1/sessions?chats=exclude", &work)
	e.get(t, "/v1/sessions?chats=only", &only)
	if len(work) != 1 || work[0].SessionID != "w1" || len(only) != 1 || only[0].SessionID != "c1" {
		t.Fatalf("work %+v, only %+v", work, only)
	}
	var all []SessionSummary
	if e.get(t, "/v1/sessions", &all); len(all) != 2 {
		t.Fatalf("every session without the parameter: %d", len(all))
	}
	// A search reads every prompt of a chat, as the session search does.
	if e.get(t, "/v1/chats?q=monad", &l); len(l.Items) != 1 || l.Total != 1 {
		t.Fatalf("search monad: %+v", l)
	}
	if e.get(t, "/v1/chats?q=build", &l); len(l.Items) != 0 || l.Chats != 1 {
		t.Fatalf("search build finds no chat: %+v", l)
	}
}

func TestAChatIsArchivedAndBroughtBack(t *testing.T) {
	e, _ := chatEnv(t)
	if code := e.send(t, http.MethodPut, "/v1/chats/c1/archived", `{"archived":true}`, nil); code != 200 {
		t.Fatalf("archive: %d", code)
	}
	var l ChatList
	if e.get(t, "/v1/chats", &l); len(l.Items) != 0 || l.Chats != 0 || l.Archived != 1 {
		t.Fatalf("after archive: %+v", l)
	}
	if e.get(t, "/v1/chats?archived=1", &l); len(l.Items) != 1 || l.Items[0].ArchivedAt == 0 {
		t.Fatalf("archived list: %+v", l)
	}
	if code := e.send(t, http.MethodPut, "/v1/chats/c1/archived", `{"archived":false}`, nil); code != 200 {
		t.Fatalf("unarchive: %d", code)
	}
	if e.get(t, "/v1/chats", &l); len(l.Items) != 1 || l.Archived != 0 {
		t.Fatalf("after unarchive: %+v", l)
	}
	// A work session is not a chat, and is not archived from here.
	if code := e.send(t, http.MethodPut, "/v1/chats/w1/archived", `{"archived":true}`, nil); code != 404 {
		t.Fatalf("archive a work session: %d, want 404", code)
	}
	if code := e.send(t, http.MethodPut, "/v1/chats/c1/archived", `{}`, nil); code != 400 {
		t.Fatalf("no archived field: %d, want 400", code)
	}
}

type chatFiles struct {
	Files     []ChatFile `json:"files"`
	Truncated bool       `json:"truncated"`
}

func TestAChatsFilesAreListedAndServedSandboxed(t *testing.T) {
	e, chat := chatEnv(t)
	write := func(rel, body string) {
		p := filepath.Join(chat, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("notes.md", "# Notes\n")
	write("out/page.html", "<h1>hi</h1><script>alert(1)</script>")
	write("report.pdf", "%PDF-1.4\n")
	write(".claude/settings.json", "{}")
	write(".secret", "x")
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("not yours"), 0o600); err != nil {
		t.Fatal(err)
	}
	linked := os.Symlink(outside, filepath.Join(chat, "link.txt")) == nil

	var l chatFiles
	if code := e.get(t, "/v1/chats/c1/files", &l); code != 200 {
		t.Fatalf("files: %d", code)
	}
	kinds := map[string]string{}
	for _, f := range l.Files {
		kinds[f.Path] = f.Kind
	}
	want := map[string]string{"notes.md": "markdown", "out/page.html": "html", "report.pdf": "pdf"}
	for p, k := range want {
		if kinds[p] != k {
			t.Errorf("%s: kind %q, want %q (listed %v)", p, kinds[p], k, kinds)
		}
	}
	for _, p := range []string{".secret", ".claude/settings.json", "link.txt"} {
		if _, ok := kinds[p]; ok {
			t.Errorf("%s is listed", p)
		}
	}
	if code := e.get(t, "/v1/chats/w1/files", nil); code != 404 {
		t.Errorf("a work session's files: %d, want 404", code)
	}

	fetch := func(q string) *http.Response {
		t.Helper()
		resp, err := http.Get(e.srv.URL + "/v1/chats/c1/file?path=" + q)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = resp.Body.Close() })
		return resp
	}
	html := fetch("out/page.html")
	body, _ := io.ReadAll(html.Body)
	csp := html.Header.Get("Content-Security-Policy")
	if html.StatusCode != 200 || !strings.HasPrefix(html.Header.Get("Content-Type"), "text/html") || !strings.Contains(csp, "sandbox") || !strings.Contains(csp, "default-src 'none'") || html.Header.Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(string(body), "<h1>hi</h1>") {
		t.Errorf("html: %d %v %q", html.StatusCode, html.Header, body)
	}
	if md := fetch("notes.md"); md.StatusCode != 200 || !strings.HasPrefix(md.Header.Get("Content-Type"), "text/markdown") {
		t.Errorf("markdown: %d %q", md.StatusCode, md.Header.Get("Content-Type"))
	}
	pdf := fetch("report.pdf")
	if pdf.StatusCode != 200 || pdf.Header.Get("Content-Type") != "application/pdf" || pdf.Header.Get("Content-Security-Policy") != "" {
		t.Errorf("pdf: %d %v", pdf.StatusCode, pdf.Header)
	}
	if dl := fetch("notes.md&download=1"); !strings.HasPrefix(dl.Header.Get("Content-Disposition"), "attachment;") {
		t.Errorf("download: %q", dl.Header.Get("Content-Disposition"))
	}
	for _, bad := range []string{"../x", "/etc/passwd", ".secret", "out/../notes.md", ""} {
		if r := fetch(bad); r.StatusCode != 400 {
			t.Errorf("%q: %d, want 400", bad, r.StatusCode)
		}
	}
	if r := fetch("missing.md"); r.StatusCode != 404 {
		t.Errorf("missing: %d, want 404", r.StatusCode)
	}
	if linked {
		if r := fetch("link.txt"); r.StatusCode != 403 {
			t.Errorf("a symlink out of the folder: %d, want 403", r.StatusCode)
		}
	}
}

func TestAChatIsDeletedWithItsFolder(t *testing.T) {
	e, chat := chatEnv(t)
	ctx := context.Background()
	if err := os.WriteFile(filepath.Join(chat, "answer.md"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Still active and not Caprock's: not removed under whoever runs it.
	if code := e.send(t, http.MethodDelete, "/v1/chats/c1", ``, nil); code != http.StatusConflict {
		t.Fatalf("active chat: %d, want 409", code)
	}
	if err := store.SetExit(ctx, e.st.DB(), "c1", 0); err != nil {
		t.Fatal(err)
	}
	if code := e.send(t, http.MethodDelete, "/v1/chats/w1", ``, nil); code != 404 {
		t.Fatalf("a work session: %d, want 404", code)
	}
	var res struct {
		FolderRemoved bool `json:"folder_removed"`
	}
	if code := e.send(t, http.MethodDelete, "/v1/chats/c1", ``, &res); code != 200 || !res.FolderRemoved {
		t.Fatalf("delete: %d %+v", code, res)
	}
	if _, err := os.Stat(chat); !os.IsNotExist(err) {
		t.Errorf("the chat's folder is still there: %v", err)
	}
	if code := e.get(t, "/v1/sessions/c1", nil); code != 404 {
		t.Errorf("the chat's session: %d, want 404", code)
	}
	if gone, _ := store.IsRemoved(ctx, e.st.DB(), "c1"); !gone {
		t.Error("no tombstone: the transcript would be read back in")
	}
	var l ChatList
	if e.get(t, "/v1/chats", &l); len(l.Items) != 0 || l.Chats != 0 {
		t.Errorf("after delete: %+v", l)
	}
}
