// The health badge and the failure suffix are the two things on the Now screen
// a user reacts to without reading anything else: red means go look, and
// "— failed" is what tells them which call went wrong. Both are decided here
// from a payload whose shape depends on where the event came from, so the
// shapes are what these tests pin down.
package narrate

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// A tool result arrives in more than one shape: the shim's PostToolUse hook
// wraps it in tool_response, while a transcript-derived event carries is_error
// at the top level. Missing a shape means a failing session shows as healthy —
// the exact case the badge exists to catch — and a false positive is just as
// bad, because a red badge nobody can explain trains people to ignore it.
func TestIsErrorRecognisesEveryFailureShape(t *testing.T) {
	cases := []struct {
		name    string
		payload string
		want    bool
	}{
		{"top-level is_error", `{"is_error":true}`, true},
		{"hook wraps the result", `{"tool_response":{"is_error":true}}`, true},
		{"hook reports a message instead of a flag", `{"tool_response":{"error":"command not found"}}`, true},
		{"a successful call", `{"tool_response":{"stdout":"ok"}}`, false},
		{"explicitly not an error", `{"is_error":false,"tool_response":{"is_error":false}}`, false},
		{"an empty payload", `{}`, false},
		// A tool that returns a plain string result is the common case for Read
		// and Bash; unmarshalling it into the error struct fails, and that must
		// read as "no error", not as one.
		{"a string result is not a failure", `{"tool_response":"file contents here"}`, false},
		{"an array result is not a failure", `{"tool_response":[1,2,3]}`, false},
		// An error field that is present but empty means the tool filled in a
		// struct and left it blank — that is success, not a failure with no
		// message.
		{"an empty error string is not a failure", `{"tool_response":{"error":""}}`, false},
		// Payloads reach here straight off the wire; garbage must not panic and
		// must not paint the session red.
		{"unparsable payload", `not json at all`, false},
		{"null payload", `null`, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := isError(json.RawMessage(c.payload)); got != c.want {
				t.Errorf("isError(%s) = %v; want %v", c.payload, got, c.want)
			}
		})
	}
}

// The badge a session ends on. Each of these is a distinct thing the user is
// meant to read off the row at a glance, and getting one wrong sends them to
// the wrong session.
func TestSummarizeBadgePerLastEvent(t *testing.T) {
	base := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	ev := func(k event.Kind) event.Event { return event.Event{Kind: k, Ts: base} }

	cases := []struct {
		name       string
		last       event.Event
		wantHealth string
		wantPhrase string
	}{
		// Compaction can take a long time and produces no tool calls. Without
		// its own phrase the session looked stalled, which is the one moment a
		// user is most likely to kill a session that is working fine.
		{"compacting", ev(event.KindContextCompact), HealthWorking, "compacting context"},
		{"just spawned", ev(event.KindAgentSpawn), HealthWorking, "session started"},
		{"user turn", ev(event.KindTurnUser), HealthWorking, "reading your prompt"},
		{"assistant turn", ev(event.KindTurnAssistant), HealthWorking, "responding"},
		// A Stop from a subagent is not the session asking the user anything —
		// the parent is still running. Badging it "waiting-on-you" would put a
		// call-to-action on a session that needs nothing.
		{"a subagent stopped", event.Event{Kind: event.KindAgentStop, AgentID: "sub-1", Ts: base}, HealthWorking, "subagent finished"},
		{"the session stopped", ev(event.KindAgentStop), HealthWaiting, "waiting for you"},
		// An unrecognised kind must still render something, not an empty badge:
		// new event kinds are added ahead of the UI that names them.
		{"an event kind narrate does not know", ev(event.KindCostTick), HealthWorking, "working"},
		// tool.post with no preceding tool.pre happens when the window of
		// events starts mid-call.
		{"a result with no call in view", ev(event.KindToolPost), HealthWorking, "working"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			act := Summarize([]event.Event{c.last}, Options{Now: base.Add(time.Second)})
			if act.Health != c.wantHealth || act.Phrase != c.wantPhrase {
				t.Errorf("got %q/%q; want %q/%q", act.Health, act.Phrase, c.wantHealth, c.wantPhrase)
			}
		})
	}
}

// "waiting-on-you" must survive silence. The user is the thing being waited on,
// so the staleness rule that turns working into idle must not apply — a session
// that has been waiting an hour is the one most in need of the badge.
func TestWaitingOnYouIsNotDemotedByStaleness(t *testing.T) {
	base := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	evs := []event.Event{{Kind: event.KindAgentStop, Ts: base}}
	act := Summarize(evs, Options{Now: base.Add(6 * time.Hour), IdleAfter: time.Minute})
	if act.Health != HealthWaiting {
		t.Errorf("health = %q after six hours of waiting; want %q", act.Health, HealthWaiting)
	}
	if strings.HasPrefix(act.Phrase, "was ") {
		t.Errorf("phrase = %q; waiting is present tense, it has not stopped happening", act.Phrase)
	}
}

// The ended badge is terminal: a session whose process is gone is not looping
// and not idle, whatever its last event said. This ordering is what stops a
// dead session sitting in the loop-alert list forever.
func TestEndedOutranksEverythingElse(t *testing.T) {
	base := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	_, payload := in("Bash", `{"command":"go test ./..."}`)
	evs := []event.Event{{Kind: event.KindToolPre, Tool: "Bash", Payload: payload, Ts: base}}
	act := Summarize(evs, Options{Now: base.Add(time.Second), Looping: true, SessionEnded: true})
	if act.Health != HealthEnded {
		t.Errorf("health = %q for an ended session flagged as looping; want %q", act.Health, HealthEnded)
	}
}

// A failed result keeps the phrase of the call that failed, so the row says
// which one. Losing the tool name here turns "running `go test` — failed" into
// a bare "failed" with nothing to act on.
func TestAFailedResultNamesTheCallThatFailed(t *testing.T) {
	base := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	_, pre := in("Bash", `{"command":"go build ./..."}`)
	evs := []event.Event{
		{Kind: event.KindToolPre, Tool: "Bash", Payload: pre, Ts: base},
		{Kind: event.KindToolPost, Tool: "Bash", Payload: json.RawMessage(`{"tool_response":{"error":"exit status 2"}}`), Ts: base.Add(time.Second)},
	}
	act := Summarize(evs, Options{Now: base.Add(2 * time.Second)})
	if act.Health != HealthError {
		t.Fatalf("health = %q; want %q", act.Health, HealthError)
	}
	if !strings.Contains(act.Phrase, "go build") || !strings.HasSuffix(act.Phrase, "— failed") {
		t.Errorf("phrase = %q; want the failing command and the failed suffix", act.Phrase)
	}
	if act.Tool != "Bash" {
		t.Errorf("tool = %q; want Bash so the UI can link to the call", act.Tool)
	}
}

// Repeat counting keys on the rendered phrase, not the raw payload. Two `go
// test` runs with different descriptions are the same attempt from the user's
// point of view, and two different commands are not — this is what the loop
// badge is built on, so counting the wrong thing either cries wolf or misses a
// real loop.
func TestRepeatsCountTheSameCallNotTheSamePayload(t *testing.T) {
	base := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	tp := func(off int, tool, input string) event.Event {
		_, p := in(tool, input)
		return event.Event{Kind: event.KindToolPre, Tool: tool, Payload: p, Ts: base.Add(time.Duration(off) * time.Second)}
	}
	cases := []struct {
		name string
		evs  []event.Event
		want int
	}{
		{
			// Same command, different description field: one attempt repeated.
			name: "the same command described differently",
			evs: []event.Event{
				tp(1, "Bash", `{"command":"go test ./...","description":"run tests"}`),
				tp(2, "Bash", `{"command":"go test ./...","description":"try again"}`),
			},
			want: 2,
		},
		{
			// A different command breaks the run. Counting through it would
			// report a loop that is really progress.
			name: "a different call resets the count",
			evs: []event.Event{
				tp(1, "Bash", `{"command":"go test ./..."}`),
				tp(2, "Bash", `{"command":"go vet ./..."}`),
				tp(3, "Bash", `{"command":"go vet ./..."}`),
			},
			want: 2,
		},
		{
			// The same file read by two different tools is two different calls.
			name: "the same argument to a different tool",
			evs: []event.Event{
				tp(1, "Read", `{"file_path":"/a/main.go"}`),
				tp(2, "Edit", `{"file_path":"/a/main.go"}`),
			},
			want: 1,
		},
		{
			// Non-tool events in between do not break a run: the model
			// narrating between two identical retries is still two retries.
			name: "an assistant turn between two identical calls",
			evs: []event.Event{
				tp(1, "Bash", `{"command":"npm test"}`),
				{Kind: event.KindTurnAssistant, Ts: base.Add(2 * time.Second)},
				tp(3, "Bash", `{"command":"npm test"}`),
			},
			want: 2,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			act := Summarize(c.evs, Options{Now: base.Add(time.Minute)})
			if act.Repeats != c.want {
				t.Errorf("Repeats = %d; want %d (phrase %q)", act.Repeats, c.want, act.Phrase)
			}
		})
	}
}

// Plan progress comes from the last TodoWrite. The "next" item is what the row
// shows as the thing being worked on, and the fallbacks matter: a list with
// nothing in progress still has a next thing, and an item with no activeForm
// still has a name.
func TestPlanNextFallsBackThroughTheList(t *testing.T) {
	cases := []struct {
		name     string
		todos    string
		wantDone int
		wantNext string
	}{
		{
			name:     "in_progress wins and prefers its activeForm",
			todos:    `[{"content":"Write tests","status":"in_progress","activeForm":"Writing tests"},{"content":"b","status":"pending"}]`,
			wantNext: "Writing tests",
		},
		{
			// activeForm is optional; without it the row would otherwise be
			// blank while a task is plainly running.
			name:     "in_progress without an activeForm uses the content",
			todos:    `[{"content":"Write tests","status":"in_progress"}]`,
			wantNext: "Write tests",
		},
		{
			// Nothing started yet: the first pending item is what happens next.
			name:     "nothing in progress falls back to the first pending item",
			todos:    `[{"content":"a","status":"completed"},{"content":"b","status":"pending"},{"content":"c","status":"pending"}]`,
			wantDone: 1,
			wantNext: "b",
		},
		{
			// A finished plan has no next item, and must not borrow one from a
			// completed row.
			name:     "a finished plan has no next item",
			todos:    `[{"content":"a","status":"completed"},{"content":"b","status":"completed"}]`,
			wantDone: 2,
			wantNext: "",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in := parseInput(json.RawMessage(`{"tool_input":{"todos":` + c.todos + `}}`))
			p := planFrom(in)
			if p == nil {
				t.Fatal("planFrom returned nil for a non-empty todo list")
			}
			if p.Done != c.wantDone {
				t.Errorf("Done = %d; want %d", p.Done, c.wantDone)
			}
			if p.Next != c.wantNext {
				t.Errorf("Next = %q; want %q", p.Next, c.wantNext)
			}
		})
	}
	// An empty list is not a plan at all — rendering "0/0 done" would be worse
	// than rendering nothing.
	if p := planFrom(parseInput(json.RawMessage(`{"tool_input":{"todos":[]}}`))); p != nil {
		t.Errorf("planFrom on an empty list = %+v; want nil", p)
	}
}

// Paths come from whichever machine the transcript was written on, so both
// separators have to be handled everywhere and not just on the OS running the
// test. This is the reason baseName exists instead of filepath.Base.
func TestBaseNameHandlesEitherSeparatorOnEveryOS(t *testing.T) {
	cases := map[string]string{
		"/a/b/auth.go":            "auth.go",
		`C:\proj\src\main.go`:     "main.go",
		`\\server\share\notes.md`: "notes.md",
		"main.go":                 "main.go",
		// A trailing separator is a directory; the name is still the last
		// segment rather than an empty string.
		"/a/b/":   "b",
		`C:\a\`:   "a",
		"":        "",
		"/":       "",
		`\`:       "",
		"/a//b":   "b",
		"./rel":   "rel",
		"../x.go": "x.go",
	}
	for in, want := range cases {
		if got := baseName(in); got != want {
			t.Errorf("baseName(%q) = %q; want %q", in, got, want)
		}
	}
}

// The phrase falls back rather than rendering a half-sentence. Every one of
// these is a real payload shape: a tool called with no arguments, a URL the
// model made up, an MCP tool whose name has no method part.
func TestPhraseFallsBackWhenTheInputIsMissing(t *testing.T) {
	cases := []struct {
		tool, input, want string
	}{
		{"Read", `{}`, "reading a file"},
		{"Edit", `{}`, "editing a file"},
		{"Write", `{}`, "writing a file"},
		{"NotebookEdit", `{"notebook_path":"/a/b/explore.ipynb"}`, "editing notebook explore.ipynb"},
		{"NotebookEdit", `{}`, "editing a notebook"},
		{"Bash", `{"command":"   "}`, "running a command"},
		{"Bash", `{}`, "running a command"},
		{"Grep", `{}`, "searching"},
		{"Glob", `{}`, "finding files"},
		{"WebSearch", `{}`, "searching the web"},
		{"TodoWrite", `{}`, "planning"},
		{"Task", `{}`, "delegating to a subagent"},
		{"Skill", `{"skill":"code-review"}`, "using skill code-review"},
		{"Skill", `{}`, "using a skill"},
		// A URL with no host — a bare path, or something unparsable — must not
		// render "fetching " with nothing after it.
		{"WebFetch", `{"url":"not a url"}`, "fetching a page"},
		{"WebFetch", `{"url":"/relative/path"}`, "fetching a page"},
		{"WebFetch", `{}`, "fetching a page"},
		// An MCP tool with no method segment still names its server.
		{"mcp__linear", `{}`, "calling linear"},
		// The empty tool name is how a thinking block reaches here.
		{"", `{}`, "thinking"},
	}
	for _, c := range cases {
		tool, payload := in(c.tool, c.input)
		if got := Phrase(tool, payload); got != c.want {
			t.Errorf("Phrase(%q, %s) = %q; want %q", c.tool, c.input, got, c.want)
		}
	}
}

// A payload that is not the shape narrate expects must still produce a phrase.
// These arrive from third-party MCP servers and from transcripts written by
// older Claude Code versions, and a panic here takes down the Now screen for
// every session, not just the odd one.
func TestPhraseSurvivesAMalformedPayload(t *testing.T) {
	for _, payload := range []string{
		``,
		`null`,
		`{"tool_input":null}`,
		`{"tool_input":"a string, not an object"}`,
		`{"tool_input":[1,2,3]}`,
		`{"tool_input":{"file_path":123}}`,
		`{{{ broken`,
	} {
		got := Phrase("Read", json.RawMessage(payload))
		if got == "" {
			t.Errorf("Phrase with payload %q produced an empty phrase; the row would render blank", payload)
		}
	}
}

// commandHead is what stops one pasted heredoc filling the activity column. The
// cut has to happen at the first separator and at a word boundary, and the
// result has to stay valid UTF-8 — a byte-index cut through a multi-byte
// character was shipped once and rendered as mojibake in the dashboard.
func TestCommandHeadCutsAtTheFirstBoundary(t *testing.T) {
	cases := map[string]string{
		"go test ./...":       "`go test ./...`",
		"go build && go test": "`go build …`",
		"cat x || true":       "`cat x …`",
		"ls | wc -l":          "`ls …`",
		"cd /tmp; ls":         "`cd /tmp …`",
		"echo one\necho two":  "`echo one`",
		"a b c d e f g h":     "`a b c d e f …`",
		"  go test  ":         "`go test`",
	}
	for in, want := range cases {
		if got := commandHead(in); got != want {
			t.Errorf("commandHead(%q) = %q; want %q", in, got, want)
		}
	}
	// Long single-token commands are clipped by rune count, with an ellipsis so
	// the reader knows something was cut.
	long := commandHead(strings.Repeat("x", 200))
	if !strings.HasSuffix(long, "…`") {
		t.Errorf("a 200-character command was not clipped: %q", long)
	}
	if len([]rune(long)) > 64 {
		t.Errorf("clipped command is %d runes; the activity column cannot hold that", len([]rune(long)))
	}
}
