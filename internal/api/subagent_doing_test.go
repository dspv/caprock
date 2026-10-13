package api

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestSubagentDoingSaysWhatItIsDoing(t *testing.T) {
	const task = "Fix the cockpit's subagent rows"
	for _, c := range []struct {
		name, tool, input, task string
		want, from              string
	}{
		{"a Bash call's own description wins", "Bash", `{"command":"go -C /Users/x test ./...","description":"Rerun the store tests"}`, task, "Rerun the store tests", "call"},
		{"an Agent launch's description", "Agent", `{"description":"Find the pricing table","prompt":"long"}`, task, "Find the pricing table", "call"},
		{"read", "Read", `{"file_path":"/w/ui/src/components/FootprintPanel.tsx"}`, task, "Reading FootprintPanel.tsx", "tool"},
		{"edit", "Edit", `{"file_path":"/w/ui/src/components/Cockpit.tsx","old_string":"a"}`, task, "Editing Cockpit.tsx", "tool"},
		{"write", "Write", `{"file_path":"C:\\w\\notes.md"}`, task, "Writing notes.md", "tool"},
		{"grep", "Grep", `{"pattern":"chipGroupsThatFit"}`, task, "Searching for 'chipGroupsThatFit'", "tool"},
		{"glob", "Glob", `{"pattern":"**/*.test.ts"}`, task, "Finding **/*.test.ts", "tool"},
		{"fetch", "WebFetch", `{"url":"https://www.docs.github.com/en/rest","prompt":"x"}`, task, "Fetching docs.github.com", "tool"},
		{"search", "WebSearch", `{"query":"sqlite covering index"}`, task, "Searching the web for 'sqlite covering index'", "tool"},
		{"go test past the setup", "Bash", `{"command":"cd /w && go test ./internal/api"}`, task, "Running tests", "tool"},
		{"go -C test", "Bash", `{"command":"go -C /w test -run X ./..."}`, task, "Running tests", "tool"},
		{"vitest via npm", "Bash", `{"command":"npm --prefix ui test -- --run x"}`, task, "Running tests", "tool"},
		{"git names its subcommand", "Bash", `{"command":"git -C /w status --short"}`, task, "Running git status", "tool"},
		{"anything else names the program", "Bash", `{"command":"GOOS=windows /usr/local/go/bin/go vet ./..."}`, task, "Running go", "tool"},
		{"mcp", "mcp__github__get_pr", `{"number":1}`, task, "Calling github", "tool"},
		{"an unknown tool falls to the task", "TaskStop", `{"task_id":"x"}`, task, task, "task"},
		{"a known tool without its target falls to the task", "Read", `{}`, task, task, "task"},
		{"no call yet", "", ``, task, task, "task"},
		{"nothing at all", "", ``, "", "", ""},
	} {
		got, from := subagentDoing(c.tool, json.RawMessage(c.input), c.task)
		if got != c.want || from != c.from {
			t.Errorf("%s: got %q (%s), want %q (%s)", c.name, got, from, c.want, c.from)
		}
	}
}

func TestSubagentDoingStaysShort(t *testing.T) {
	long := strings.Repeat("Rebuild the dist and stage everything ", 4)
	got, _ := subagentDoing("Bash", json.RawMessage(`{"command":"make","description":"`+long+`\nsecond line"}`), "")
	if n := utf8.RuneCountInString(got); n != doingMax || !strings.HasSuffix(got, "…") {
		t.Errorf("got %q (%d runes), want %d ending in an ellipsis", got, n, doingMax)
	}
}
