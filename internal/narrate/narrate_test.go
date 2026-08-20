package narrate

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/event"
)

func in(tool string, input string) (string, json.RawMessage) {
	return tool, json.RawMessage(`{"tool_name":"` + tool + `","tool_input":` + input + `}`)
}

func TestPhraseMap(t *testing.T) {
	cases := []struct {
		tool, input, want string
	}{
		{"Read", `{"file_path":"/a/b/auth.go"}`, "reading auth.go"},
		{"Edit", `{"file_path":"/x/auth/middleware.go","old_string":"a"}`, "editing middleware.go"},
		{"Write", `{"file_path":"C:\\proj\\main.go"}`, "writing main.go"},
		{"Bash", `{"command":"go test ./... && echo done","description":"tests"}`, "running `go test ./... …`"},
		{"Bash", `{"command":"npm run build\nnpm test"}`, "running `npm run build`"},
		{"Grep", `{"pattern":"TODO"}`, "searching for “TODO”"},
		{"Glob", `{"pattern":"**/*.go"}`, "finding files “**/*.go”"},
		{"WebFetch", `{"url":"https://www.example.com/x?y=1"}`, "fetching example.com"},
		{"WebSearch", `{"query":"go 1.26 release notes"}`, "searching the web for “go 1.26 release notes”"},
		{"TodoWrite", `{"todos":[{"content":"a","status":"completed"},{"content":"b","status":"in_progress","activeForm":"Doing b"},{"content":"c","status":"pending"}]}`, "planning — 1/3 done"},
		{"Task", `{"subagent_type":"Explore","prompt":"x"}`, "delegating to a Explore subagent"},
		{"mcp__github__create_issue", `{"title":"x"}`, "create_issue via github"},
		{"AskUserQuestion", `{}`, "asking you a question"},
		{"SomethingNew", `{}`, "using SomethingNew"},
	}
	for _, c := range cases {
		tool, payload := in(c.tool, c.input)
		if got := Phrase(tool, payload); got != c.want {
			t.Errorf("Phrase(%s, %s) = %q, want %q", c.tool, c.input, got, c.want)
		}
	}
	if Ordinal(2) != "2nd" || Ordinal(3) != "3rd" || Ordinal(11) != "11th" || Ordinal(21) != "21st" || Ordinal(4) != "4th" {
		t.Fatal("ordinal")
	}
}

func TestSummarizeHealthAndRepeats(t *testing.T) {
	base := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	tp := func(off int, tool, input string) event.Event {
		_, p := in(tool, input)
		return event.Event{Kind: event.KindToolPre, Tool: tool, Payload: p, Ts: base.Add(time.Duration(off) * time.Second)}
	}
	evs := []event.Event{
		{Kind: event.KindTurnUser, Ts: base},
		tp(1, "TodoWrite", `{"todos":[{"content":"a","status":"completed"},{"content":"b","status":"in_progress","activeForm":"Running tests"}]}`),
		tp(2, "Bash", `{"command":"go test ./..."}`),
		tp(3, "Bash", `{"command":"go test ./..."}`),
	}
	act := Summarize(evs, Options{Now: base.Add(5 * time.Second)})
	if act.Health != HealthWorking || act.Phrase != "running `go test ./...` — 2nd attempt" || act.Repeats != 2 {
		t.Fatalf("working: %+v", act)
	}
	if act.Plan == nil || act.Plan.Done != 1 || act.Plan.Total != 2 || act.Plan.Next != "Running tests" {
		t.Fatalf("plan: %+v", act.Plan)
	}
	// Idle after silence.
	if a := Summarize(evs, Options{Now: base.Add(10 * time.Minute)}); a.Health != HealthIdle {
		t.Fatalf("idle: %+v", a)
	}
	// Waiting on you after a top-level Stop, even much later.
	evs2 := append(append([]event.Event(nil), evs...), event.Event{Kind: event.KindAgentStop, Ts: base.Add(4 * time.Second)})
	if a := Summarize(evs2, Options{Now: base.Add(time.Hour)}); a.Health != HealthWaiting || a.Phrase != "waiting for you" {
		t.Fatalf("waiting: %+v", a)
	}
	// Error on a failed tool result.
	evs3 := append(append([]event.Event(nil), evs...), event.Event{Kind: event.KindToolPost, Tool: "Bash", Payload: json.RawMessage(`{"is_error":true}`), Ts: base.Add(4 * time.Second)})
	if a := Summarize(evs3, Options{Now: base.Add(5 * time.Second)}); a.Health != HealthError || a.Repeats != 2 {
		t.Fatalf("error: %+v", a)
	}
	// Looping flag wins.
	if a := Summarize(evs, Options{Now: base.Add(5 * time.Second), Looping: true}); a.Health != HealthLooping {
		t.Fatalf("looping: %+v", a)
	}
	if a := Summarize(nil, Options{}); a.Health != HealthIdle || a.Phrase != "idle" {
		t.Fatalf("empty: %+v", a)
	}
	if a := Summarize(nil, Options{SessionEnded: true}); a.Health != HealthEnded {
		t.Fatalf("ended: %+v", a)
	}
}

// These strings go straight into the API as a session's activity phrase.
// Slicing UTF-8 by byte cut through characters, and encoding/json silently
// substitutes U+FFFD rather than erroring — so the dashboard showed mojibake.
func TestNarrateClipsOnRunes(t *testing.T) {
	long := "эхо " + strings.Repeat("ф", 200)
	for name, got := range map[string]string{
		"commandHead": commandHead(long),
		"quote":       quote(long),
	} {
		if !utf8.ValidString(got) {
			t.Errorf("%s produced invalid UTF-8: %q", name, got)
		}
		if strings.ContainsRune(got, utf8.RuneError) {
			t.Errorf("%s cut through a rune: %q", name, got)
		}
	}
	// Short input is untouched.
	if q := quote("привет"); q != "“привет”" {
		t.Errorf("quote clipped a short string: %q", q)
	}
}
