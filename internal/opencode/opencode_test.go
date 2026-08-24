package opencode

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSessions(t *testing.T) {
	f := newFixture(t)
	f.typical()
	db := f.open()

	got, err := Sessions(context.Background(), db)
	if err != nil {
		t.Fatalf("Sessions: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d sessions, want 3", len(got))
	}
	// Newest activity first, which is the order every screen presents.
	if got[0].ID != "ses_b" {
		t.Errorf("first session is %s, want ses_b (most recently updated)", got[0].ID)
	}

	byID := map[string]Session{}
	for _, s := range got {
		byID[s.ID] = s
	}

	a := byID["ses_a"]
	if a.Directory != "/home/dev/api" {
		t.Errorf("directory = %q, want /home/dev/api", a.Directory)
	}
	if a.Cost != 1.50 {
		t.Errorf("cost = %v, want 1.50", a.Cost)
	}
	if a.TokensIn != 1000 || a.TokensOut != 200 || a.CacheRead != 5000 || a.CacheWrite != 100 {
		t.Errorf("tokens = %d/%d/%d/%d, want 1000/200/5000/100",
			a.TokensIn, a.TokensOut, a.CacheRead, a.CacheWrite)
	}
	if a.Model != "claude-opus-5" || a.Provider != "anthropic" {
		t.Errorf("model = %q/%q, want claude-opus-5/anthropic", a.Model, a.Provider)
	}
	if a.IsChild() {
		t.Error("ses_a reported as a child; it has no parent")
	}

	// The subagent is what makes a naive SUM double-count.
	if !byID["ses_child"].IsChild() {
		t.Error("ses_child not reported as a child; parent_id is not being read")
	}
	if byID["ses_child"].ParentID != "ses_a" {
		t.Errorf("parent = %q, want ses_a", byID["ses_child"].ParentID)
	}
}

func TestSessionsEmptyDatabase(t *testing.T) {
	f := newFixture(t)
	got, err := Sessions(context.Background(), f.open())
	if err != nil {
		t.Fatalf("Sessions on empty db: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("got %d sessions from an empty database", len(got))
	}
}

func TestParseModel(t *testing.T) {
	// A session that has not run a turn has no model, and a future OpenCode
	// release may change the shape. Neither is worth failing an import over.
	cases := []struct {
		name, in, model, provider string
	}{
		{"normal", `{"id":"claude-opus-5","providerID":"anthropic"}`, "claude-opus-5", "anthropic"},
		{"empty string", "", "", ""},
		{"null", "null", "", ""},
		{"malformed json", `{"id":`, "", ""},
		{"unexpected shape", `["a","b"]`, "", ""},
		{"missing provider", `{"id":"m"}`, "m", ""},
		{"extra fields ignored", `{"id":"m","providerID":"p","variant":"x"}`, "m", "p"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, p := parseModel(c.in)
			if m != c.model || p != c.provider {
				t.Errorf("parseModel(%q) = %q/%q, want %q/%q", c.in, m, p, c.model, c.provider)
			}
		})
	}
}

func TestSessionsMalformedModel(t *testing.T) {
	// A broken model value must not abort the import of the row it is on.
	f := newFixture(t)
	bad := `{"id":`
	f.session(sessionOpts{ID: "ses_bad", Directory: "/d", Title: "t", RawModel: &bad, Cost: 1})
	got, err := Sessions(context.Background(), f.open())
	if err != nil {
		t.Fatalf("Sessions: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d sessions, want 1", len(got))
	}
	if got[0].Cost != 1 {
		t.Errorf("cost lost to a malformed model: %v", got[0].Cost)
	}
}

func TestMessages(t *testing.T) {
	f := newFixture(t)
	f.typical()
	db := f.open()

	got, err := Messages(context.Background(), db, "ses_a")
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d messages, want 2", len(got))
	}
	// Chronological: the user's question precedes the assistant's reply.
	if got[0].ID != "msg_a2" {
		t.Errorf("first message is %s, want msg_a2 (oldest)", got[0].ID)
	}

	var assistant Message
	for _, m := range got {
		if m.Role == "assistant" {
			assistant = m
		}
	}
	if assistant.Cost != 1.00 {
		t.Errorf("cost = %v, want 1.00", assistant.Cost)
	}
	if assistant.TokensIn != 600 || assistant.CacheRead != 3000 {
		t.Errorf("tokens = %d in / %d cache-read, want 600/3000",
			assistant.TokensIn, assistant.CacheRead)
	}
	if assistant.Cwd != "/home/dev/api" {
		t.Errorf("cwd = %q, want /home/dev/api", assistant.Cwd)
	}
}

func TestMessagesSkipsMalformed(t *testing.T) {
	// One unreadable row must not abort an import of thousands.
	f := newFixture(t)
	f.session(sessionOpts{ID: "s", Directory: "/d", Title: "t"})
	broken := `{"role": "assistant", "tokens":`
	f.message(messageOpts{ID: "m_bad", SessionID: "s", RawData: &broken})
	f.message(messageOpts{ID: "m_ok", SessionID: "s", Cost: 0.5, Created: 1_700_000_100_000})

	got, err := Messages(context.Background(), f.open(), "s")
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d messages, want 1 (the malformed one skipped)", len(got))
	}
	if got[0].ID != "m_ok" {
		t.Errorf("survivor is %s, want m_ok", got[0].ID)
	}
}

func TestToolCalls(t *testing.T) {
	f := newFixture(t)
	f.typical()

	got, err := ToolCalls(context.Background(), f.open(), "ses_a")
	if err != nil {
		t.Fatalf("ToolCalls: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d tool calls, want 2", len(got))
	}
	if got[0].Tool != "Read" || got[0].RawTool != "read" {
		t.Errorf("first tool = %q (raw %q), want Read/read", got[0].Tool, got[0].RawTool)
	}
	if got[0].FilePath != "/home/dev/api/src/auth.go" {
		t.Errorf("file path = %q", got[0].FilePath)
	}
	// bash names no file, and must not invent one.
	if got[1].FilePath != "" {
		t.Errorf("bash reported a file path: %q", got[1].FilePath)
	}
	if got[1].Tool != "Bash" {
		t.Errorf("second tool = %q, want Bash", got[1].Tool)
	}
	if got[0].MessageID != "msg_a1" {
		t.Errorf("message id = %q, want msg_a1 — the turn↔tool link", got[0].MessageID)
	}
}

func TestToolCallsIgnoresNonToolParts(t *testing.T) {
	// Parts carry text, reasoning, patches and step markers as well as tools.
	// Reading a text part as a tool call would put prose in the activity feed.
	f := newFixture(t)
	f.session(sessionOpts{ID: "s", Directory: "/d", Title: "t"})
	f.message(messageOpts{ID: "m", SessionID: "s"})
	f.tool(toolOpts{ID: "p1", MessageID: "m", SessionID: "s", Tool: "read",
		FilePath: "/d/a.go"})
	f.tool(toolOpts{ID: "p2", MessageID: "m", SessionID: "s", Type: "text"})
	f.tool(toolOpts{ID: "p3", MessageID: "m", SessionID: "s", Type: "step-finish"})

	got, err := ToolCalls(context.Background(), f.open(), "s")
	if err != nil {
		t.Fatalf("ToolCalls: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d tool calls, want 1; non-tool parts are leaking in", len(got))
	}
}

func TestFilePathFrom(t *testing.T) {
	// OpenCode's own tools use filePath; MCP tools and future built-ins may
	// use another name, which is why several are accepted.
	cases := []struct {
		name, in, want string
	}{
		{"filePath", `{"filePath":"/a/b.go"}`, "/a/b.go"},
		{"file_path", `{"file_path":"/a/b.go"}`, "/a/b.go"},
		{"path", `{"path":"/a/b.go"}`, "/a/b.go"},
		{"notebook_path", `{"notebook_path":"/a/b.ipynb"}`, "/a/b.ipynb"},
		{"no path", `{"command":"ls"}`, ""},
		{"empty object", `{}`, ""},
		{"empty string value", `{"filePath":""}`, ""},
		{"malformed", `{"filePath":`, ""},
		{"not an object", `"a string"`, ""},
		{"wrong type", `{"filePath":42}`, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := filePathFrom([]byte(c.in)); got != c.want {
				t.Errorf("filePathFrom(%s) = %q, want %q", c.in, got, c.want)
			}
		})
	}
	if got := filePathFrom(nil); got != "" {
		t.Errorf("filePathFrom(nil) = %q, want empty", got)
	}
}

func TestNormalizeTool(t *testing.T) {
	// Caprock's loop detection, narration and work-kind classification all
	// match on the Claude Code spelling, so normalising here is what keeps
	// them working for a second agent without changes.
	cases := []struct{ in, want string }{
		{"bash", "Bash"},
		{"read", "Read"},
		{"edit", "Edit"},
		{"write", "Write"},
		{"grep", "Grep"},
		{"glob", "Glob"},
		{"list", "LS"},
		{"ls", "LS"},
		{"webfetch", "WebFetch"},
		{"websearch", "WebSearch"},
		{"todowrite", "TodoWrite"},
		{"todoread", "TodoWrite"},
		{"task", "Agent"},
		{"patch", "Edit"},
		{"question", "AskUserQuestion"},
		{"skill", "Skill"},
		{"", ""},
		// Case is normalised, so a future capitalisation change is absorbed.
		{"BASH", "Bash"},
		{"Read", "Read"},
		// Unknown tools appear as themselves rather than vanishing.
		{"somethingnew", "Somethingnew"},
		// MCP-style names are already namespaced; title-casing would corrupt them.
		{"mcp__server__tool", "mcp__server__tool"},
		{"server.tool", "server.tool"},
	}
	for _, c := range cases {
		t.Run(c.in, func(t *testing.T) {
			if got := NormalizeTool(c.in); got != c.want {
				t.Errorf("NormalizeTool(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestOpenRejectsMissingPath(t *testing.T) {
	if _, err := Open(""); err == nil {
		t.Error("Open(\"\") returned no error")
	}
}

func TestOpenIsReadOnly(t *testing.T) {
	// The database belongs to another running program. A monitor that can
	// write to what it monitors is a monitor that can corrupt it.
	f := newFixture(t)
	f.session(sessionOpts{ID: "s", Directory: "/d", Title: "t"})
	db := f.open()
	if _, err := db.Exec(`DELETE FROM session`); err == nil {
		t.Fatal("a write succeeded against a read-only handle")
	}
}

func TestDBPathEnvOverride(t *testing.T) {
	f := newFixture(t)
	t.Setenv("OPENCODE_DB", f.path)
	if got := DBPath(); got != f.path {
		t.Errorf("DBPath() = %q, want %q", got, f.path)
	}
	if !Available() {
		t.Error("Available() is false with OPENCODE_DB set to a real file")
	}
}

func TestDBPathEnvMissingFile(t *testing.T) {
	// Pointing at a file that is not there means "no database", not a crash.
	t.Setenv("OPENCODE_DB", filepath.Join(t.TempDir(), "absent.db"))
	if got := DBPath(); got != "" {
		t.Errorf("DBPath() = %q, want empty for a missing file", got)
	}
}

func TestDBPathEnvMemory(t *testing.T) {
	// ":memory:" is legal for OpenCode but cannot be read from another process.
	t.Setenv("OPENCODE_DB", ":memory:")
	if got := DBPath(); got != "" {
		t.Errorf("DBPath() = %q, want empty for :memory:", got)
	}
}

func TestDBPathDiscovery(t *testing.T) {
	// XDG_DATA_HOME is the documented location on Linux and is honoured
	// everywhere; this is the path most users will hit.
	t.Setenv("OPENCODE_DB", "")
	dir := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dir)
	// The home directory is also searched, and on a developer's machine it
	// holds a real OpenCode database — which would make this test pass or fail
	// depending on whose machine it runs on. Point it somewhere empty.
	// USERPROFILE is what os.UserHomeDir reads on Windows.
	t.Setenv("HOME", filepath.Join(dir, "home"))
	t.Setenv("USERPROFILE", filepath.Join(dir, "home"))
	ocdir := filepath.Join(dir, "opencode")
	if err := os.MkdirAll(ocdir, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := DBPath(); got != "" {
		t.Errorf("DBPath() = %q with no database present", got)
	}
	if err := os.WriteFile(filepath.Join(ocdir, "opencode.db"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(ocdir, "opencode.db")
	if got := DBPath(); got != want {
		t.Errorf("DBPath() = %q, want %q", got, want)
	}
}

func TestDataDirsIncludesPlatformLocation(t *testing.T) {
	dirs := dataDirs()
	if len(dirs) == 0 {
		t.Fatal("no candidate directories")
	}
	if runtime.GOOS == "windows" {
		t.Setenv("LOCALAPPDATA", `C:\Users\dev\AppData\Local`)
		found := false
		for _, d := range dataDirs() {
			if filepath.Base(d) == "opencode" && filepath.VolumeName(d) != "" {
				found = true
			}
		}
		if !found {
			t.Error("no LOCALAPPDATA candidate on Windows")
		}
	}
}
