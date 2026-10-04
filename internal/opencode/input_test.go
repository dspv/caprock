package opencode

import (
	"encoding/json"
	"strings"
	"testing"
)

// storedInput reads one stored OpenCode tool call's tool_input.
func storedInput(t *testing.T, h *harness, partID string) map[string]any {
	t.Helper()
	var raw string
	if err := h.out.QueryRow(
		`SELECT COALESCE(json_extract(payload,'$.tool_input'),'{}') FROM events WHERE key = ?`,
		"oc-tool:"+partID).Scan(&raw); err != nil {
		t.Fatalf("stored input of %s: %v", partID, err)
	}
	var in map[string]any
	if err := json.Unmarshal([]byte(raw), &in); err != nil {
		t.Fatalf("tool_input of %s is not an object: %q", partID, raw)
	}
	return in
}

// A bash call's command is what the tool drill-down groups by. It was stored
// as an empty tool_input, so every OpenCode bash call read "(input not
// recorded)".
func TestIngestStoresToolInputs(t *testing.T) {
	h := newHarness(t)
	h.f.session(sessionOpts{ID: "s", Directory: "/home/dev/api", Title: "t"})
	h.f.message(messageOpts{ID: "m", SessionID: "s", Cwd: "/home/dev/api"})
	h.f.tool(toolOpts{ID: "p_bash", MessageID: "m", SessionID: "s", Tool: "bash",
		Input: map[string]any{"command": "go test ./...", "description": "Run tests", "workdir": "/home/dev/api/sub"}})
	h.f.tool(toolOpts{ID: "p_edit", MessageID: "m", SessionID: "s", Tool: "edit",
		FilePath: "/home/dev/api/a.go", Input: map[string]any{"oldString": "a", "newString": "b", "replaceAll": true}})
	h.f.tool(toolOpts{ID: "p_grep", MessageID: "m", SessionID: "s", Tool: "grep",
		Input: map[string]any{"pattern": "TODO", "include": "*.go", "path": "/home/dev/api"}})
	h.poll()

	bash := storedInput(t, h, "p_bash")
	if bash["command"] != "go test ./..." || bash["description"] != "Run tests" {
		t.Errorf("bash input = %v", bash)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE key='oc-tool:p_bash' AND json_extract(payload,'$.cwd')='/home/dev/api/sub'`); n != 1 {
		t.Error("bash cwd is not its workdir")
	}
	edit := storedInput(t, h, "p_edit")
	if edit["file_path"] != "/home/dev/api/a.go" || edit["old_string"] != "a" || edit["new_string"] != "b" || edit["replace_all"] != true {
		t.Errorf("edit input = %v", edit)
	}
	if _, ok := edit["filePath"]; ok {
		t.Error("OpenCode's filePath kept beside file_path")
	}
	grep := storedInput(t, h, "p_grep")
	if grep["pattern"] != "TODO" || grep["glob"] != "*.go" || grep["path"] != "/home/dev/api" {
		t.Errorf("grep input = %v", grep)
	}
	// Placement is unchanged: the edit is placed by its file, the bash call
	// by nothing.
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE key='oc-tool:p_edit' AND touch_dir='/home/dev/api'`); n != 1 {
		t.Error("edit lost its touch_dir")
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE key='oc-tool:p_bash' AND COALESCE(touch_dir,'')=''`); n != 1 {
		t.Error("bash call acquired a touch_dir")
	}
}

// Rows stored before inputs were kept are filled from OpenCode's database on
// the next read, touching nothing else; a row with nothing more to add stays.
func TestIngestFillsInputsOfCallsAlreadyStored(t *testing.T) {
	h := newHarness(t)
	h.f.session(sessionOpts{ID: "s", Directory: "/home/dev/api", Title: "t"})
	h.f.message(messageOpts{ID: "m", SessionID: "s", Cwd: "/home/dev/api"})
	h.f.tool(toolOpts{ID: "p_bash", MessageID: "m", SessionID: "s", Tool: "bash",
		Input: map[string]any{"command": "make check"}})
	h.f.tool(toolOpts{ID: "p_read", MessageID: "m", SessionID: "s", Tool: "read",
		FilePath: "/home/dev/api/a.go"})
	h.poll()

	// Rewrite the rows the way the old importer stored them.
	if _, err := h.out.Exec(`UPDATE events SET payload = json_remove(json_set(payload,'$.tool_input',json('{}')),'$.cwd') WHERE key='oc-tool:p_bash'`); err != nil {
		t.Fatal(err)
	}
	if _, err := h.out.Exec(`UPDATE events SET payload = json_remove(payload,'$.cwd') WHERE key='oc-tool:p_read'`); err != nil {
		t.Fatal(err)
	}
	var idBefore int64
	if err := h.out.QueryRow(`SELECT id FROM events WHERE key='oc-tool:p_bash'`).Scan(&idBefore); err != nil {
		t.Fatal(err)
	}

	h.in.seen = map[string]int64{} // a daemon restart re-reads every session
	h.poll()

	if got := storedInput(t, h, "p_bash")["command"]; got != "make check" {
		t.Fatalf("backfilled command = %v", got)
	}
	var idAfter int64
	if err := h.out.QueryRow(`SELECT id FROM events WHERE key='oc-tool:p_bash'`).Scan(&idAfter); err != nil {
		t.Fatal(err)
	}
	if idAfter != idBefore {
		t.Fatalf("backfill replaced the row: id %d→%d", idBefore, idAfter)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE key='oc-tool:p_bash' AND json_extract(payload,'$.cwd')='/home/dev/api' AND json_extract(payload,'$.opencode_tool')='bash'`); n != 1 {
		t.Fatal("backfill did not set cwd or dropped another payload key")
	}
	// The read had nothing beyond its file_path: left as stored.
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE key='oc-tool:p_read' AND json_type(payload,'$.cwd') IS NULL`); n != 1 {
		t.Fatal("a row with nothing to add was rewritten")
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE key LIKE 'oc-tool:%'`); n != 2 {
		t.Fatalf("%d tool rows; the backfill must update, not insert", n)
	}
}

func TestToolInputBoundsLargeFields(t *testing.T) {
	big := strings.Repeat("x", inputCap)
	raw, _ := json.Marshal(map[string]any{"filePath": "/a/b.go", "content": big})
	in := ToolInput(raw)
	if got := string(in["file_path"].(json.RawMessage)); got != `"/a/b.go"` {
		t.Errorf("file_path = %s", got)
	}
	if got := string(in["content"].(json.RawMessage)); !strings.Contains(got, "truncated") {
		t.Errorf("an oversized field was kept: %d bytes", len(got))
	}
	if ToolInput(nil) != nil || ToolInput(json.RawMessage(`{}`)) != nil || ToolInput(json.RawMessage(`"x"`)) != nil {
		t.Error("an empty or non-object input is not nil")
	}
}

func TestSnakeCase(t *testing.T) {
	for in, want := range map[string]string{
		"filePath": "file_path", "replaceAll": "replace_all", "command": "command", "old_string": "old_string",
	} {
		if got := snakeCase(in); got != want {
			t.Errorf("snakeCase(%q) = %q, want %q", in, got, want)
		}
	}
}
