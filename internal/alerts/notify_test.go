package alerts

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// An approval names the project first, then the session and branch, then the
// tool and its command — in plain text, since a notification is not HTML —
// and offers Approve and Deny with the prompt they answer.
func TestAnApprovalNotificationSaysWhoWantsWhat(t *testing.T) {
	a := approval("Bash", `{"tool_name":"Bash","tool_input":{"command":"rm -rf <dist> && go test ./..."}}`)
	a.Trigger.Ts = time.UnixMilli(1_700_000_000_000)
	d := Details{Title: "Tidy the <cache>", Project: "caprock", Cwd: "/home/u/dev/caprock", Home: "/home/u", Branch: "main", Agent: "Claude Code", Link: link}
	n := Notify(a, d, "p1")
	want := Notification{
		ID: "approval-s-1700000000000", Kind: "approval", SessionID: "s", Project: "caprock",
		Title:    "Needs approval · caprock",
		Body:     "Tidy the <cache> · main\nBash: rm -rf <dist> && go test ./...",
		PromptID: "p1", Actions: []string{"allow", "deny"},
	}
	if !reflect.DeepEqual(n, want) {
		t.Fatalf("got  %+v\nwant %+v", n, want)
	}
}

// Without a prompt Caprock can answer (a session it did not start, another
// agent, AskUserQuestion's menu) there are no buttons: the click opens it.
func TestNoPromptNoActions(t *testing.T) {
	d := Details{Cwd: "/w/proj", Agent: "Codex"}
	n := Notify(approval("Write", `{"tool_input":{"file_path":"/w/proj/a.go"}}`), d, "")
	if n.PromptID != "" || n.Actions != nil {
		t.Fatalf("actions without a prompt: %+v", n)
	}
	if n.Title != "Needs approval · proj" || n.Body != "proj · Codex\nWrite: a.go" {
		t.Fatalf("title %q body %q", n.Title, n.Body)
	}
	q := Notify(approval("AskUserQuestion", `{"tool_input":{"questions":[{"question":"Which port?"}]}}`), d, "p2")
	if q.Actions != nil || q.Title != "Needs your answer · proj" || q.Body != "proj · Codex\nWhich port?" {
		t.Fatalf("question: %+v", q)
	}
}

// A finished run says what it took and changed and how the reply began; a
// failed one says why, as kind "error".
func TestAFinishedNotificationSaysWhatTheRunDid(t *testing.T) {
	d := Details{Title: "Fix alerts", Project: "caprock", Branch: "feat/x", Run: 12 * time.Minute, CostUSD: 0.75, Tools: 4,
		Files: []string{"/w/a.go", "/w/b.go"}, Reply: "## All green.\nDetails follow."}
	n := Notify(finished(`{}`), d, "p9")
	if n.Kind != "finished" || n.Title != "Finished · caprock" || n.Actions != nil {
		t.Fatalf("%+v", n)
	}
	if want := "Fix alerts · feat/x\n12m · $0.75 · 4 tool calls\n2 files changed: a.go, b.go\n“All green.”"; n.Body != want {
		t.Fatalf("body %q, want %q", n.Body, want)
	}
	failed := Alert{Kind: KindFinished, SessionID: "s", LastThisHour: true,
		Trigger: event.Event{Kind: event.KindThrottle, Payload: json.RawMessage(`{"error":"rate_limit"}`)}}
	e := Notify(failed, Details{Cwd: "/w/proj"}, "")
	if e.Kind != "error" || e.Title != "Stopped: rate limit · proj" {
		t.Fatalf("%+v", e)
	}
	if want := "That is 20 this hour; the rest wait until it is over."; e.Body != want {
		t.Fatalf("body %q", e.Body)
	}
}
