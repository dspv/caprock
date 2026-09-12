package deepseek

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
)

// writeSession compresses JSONL lines into a v3 session file under a temp dir
// and returns its path. The fixture is written in the test rather than
// committed, so the shape it exercises is visible in the source; klauspost's
// encoder produces the same standard zstd frames DSH's native encoder writes.
func writeSession(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "sessions", "ws"), 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "sessions", "ws", "session.v3.jsonl.zstd")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	enc, err := zstd.NewWriter(f)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := enc.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if err := enc.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

const fixture = `{"type":"session","version":3,"id":"session-1","createdAt":1789135258998,"cwd":"/home/u/proj","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
{"type":"user/message","seq":8,"time":1789135308420,"data":{"content":[{"type":"text","text":"hello"}]}}
{"type":"assistant/message","seq":16,"time":1789135312847,"data":{"message":{"role":"assistant","content":[{"type":"reasoning","text":"secret thinking"},{"type":"text","text":"hi there"},{"type":"tool-call","id":"c1","name":"bash","arguments":"{\"command\":\"ls\"}"}],"source":{"kind":"model","provider":"deepseek-official","model":"deepseek-v4-pro"}},"usage":{"inputTokens":1904,"outputTokens":250,"totalTokens":13034,"cacheReadTokens":10880,"reasoningTokens":114}}}
{"type":"tool/call","seq":17,"time":1789135312848,"data":{"turn":1,"step":1,"callId":"c1","name":"bash","arguments":"{\"command\":\"ls\"}"}}
`

func TestParseFile(t *testing.T) {
	path := writeSession(t, fixture)
	s, err := ParseFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.ID != "session-1" || s.Cwd != "/home/u/proj" {
		t.Fatalf("header: id=%q cwd=%q", s.ID, s.Cwd)
	}
	if s.Model != "deepseek-v4-pro" {
		t.Fatalf("model = %q", s.Model)
	}
	if len(s.Turns) != 1 || len(s.Tools) != 1 || len(s.Users) != 1 {
		t.Fatalf("counts: turns=%d tools=%d users=%d", len(s.Turns), len(s.Tools), len(s.Users))
	}

	// DSH reports fresh input and cache read separately, so the delta is taken
	// straight through — no subtraction, unlike Codex.
	tu := s.Turns[0]
	if tu.In != 1904 || tu.CacheRead != 10880 || tu.Out != 250 || tu.CacheWrite != 0 {
		t.Fatalf("tokens = %+v", tu)
	}
	if tu.Reasoning != 114 {
		t.Fatalf("reasoning = %d", tu.Reasoning)
	}
	// Reasoning text is dropped; visible prose is kept.
	if tu.Text != "hi there" {
		t.Fatalf("text = %q", tu.Text)
	}
	if s.Tools[0].Name != "bash" || s.Tools[0].Input != `{"command":"ls"}` {
		t.Fatalf("tool = %+v", s.Tools[0])
	}
	if s.Users[0].Text != "hello" {
		t.Fatalf("user text = %q", s.Users[0].Text)
	}
}

func TestListFindsBothFormatNames(t *testing.T) {
	path := writeSession(t, fixture)
	wsDir := filepath.Dir(path)         // .../sessions/ws
	sessionsRoot := filepath.Dir(wsDir) // .../sessions
	if err := os.WriteFile(filepath.Join(wsDir, "session.jsonl.zstd"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	ts, err := List(sessionsRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(ts) != 2 {
		t.Fatalf("transcripts = %d, want 2", len(ts))
	}
}

func TestDirHonoursOverride(t *testing.T) {
	t.Setenv(EnvDir, "/tmp/override")
	if got := Dir(); got != "/tmp/override" {
		t.Fatalf("Dir() = %q", got)
	}
}

func TestDirDefaultsToDshHome(t *testing.T) {
	t.Setenv(EnvDir, "")
	t.Setenv(EnvHome, "/custom/dsh-home")
	if got := Dir(); got != filepath.Join("/custom/dsh-home", "sessions") {
		t.Fatalf("Dir() = %q", got)
	}
}

func TestParseFileRejectsNonSession(t *testing.T) {
	path := writeSession(t, `{"type":"other","seq":1,"time":1,"data":{}}`+"\n")
	if _, err := ParseFile(path); !errors.Is(err, ErrNotASession) {
		t.Fatalf("err = %v, want ErrNotASession", err)
	}
}

func TestKeyStableAcrossRereads(t *testing.T) {
	path := writeSession(t, fixture)
	s1, err := ParseFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s2, err := ParseFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if s1.Turns[0].Key != s2.Turns[0].Key || s1.Tools[0].Key != s2.Tools[0].Key {
		t.Fatalf("keys drifted across re-reads")
	}
	if s1.Turns[0].At.IsZero() || s1.Turns[0].At != time.UnixMilli(1789135312847) {
		t.Fatalf("turn time = %v", s1.Turns[0].At)
	}
}
