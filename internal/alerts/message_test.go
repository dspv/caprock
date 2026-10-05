package alerts

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

const link = "http://100.64.0.2:4173/#/session/s"

func finished(payload string) Alert {
	return Alert{Kind: KindFinished, SessionID: "s", Trigger: event.Event{Kind: event.KindAgentStop, Payload: json.RawMessage(payload)}}
}

func approval(tool, payload string) Alert {
	return Alert{Kind: KindApproval, SessionID: "s", Question: tool == "AskUserQuestion",
		Trigger: event.Event{Kind: event.KindPermissionPrompt, Tool: tool, Payload: json.RawMessage(payload)}}
}

// The owner's complaint: "caprock has finished / Claude Code / link" said
// nothing he could act on. The first line now names what happened and the
// session; the rest says where, what the run took and changed, and how the
// reply began.
func TestAFinishedAlertSaysWhatTheRunDid(t *testing.T) {
	d := Details{
		Title: "Make phone alerts informative", Cwd: "/Users/ds/Downloads/caprock", Home: "/Users/ds",
		Branch: "feat/alert-content", Agent: "Claude Code", Link: link,
		Run: 12*time.Minute + 30*time.Second, CostUSD: 1.844, Tools: 37,
		Files: []string{"/Users/ds/Downloads/caprock/internal/alerts/message.go", "/Users/ds/Downloads/caprock/internal/alerts/alerts.go", "/x/phonealerts.go", "/x/api.go"},
		Reply: "## Done\nAlerts now carry the title.",
	}
	got := Message(finished(`{}`), d)
	want := "✅ <b>Finished</b> · Make phone alerts informative\n" +
		"<code>~/Downloads/caprock</code> · feat/alert-content\n" +
		"12m · $1.84 · 37 tool calls\n" +
		"4 files changed: message.go, alerts.go, phonealerts.go +1\n" +
		"💬 <i>Done</i>\n" +
		link
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}

func TestAFailedTurnSaysWhy(t *testing.T) {
	a := finished(`{"hook_event_name":"StopFailure","error":"rate_limit"}`)
	a.Trigger.Kind = event.KindThrottle
	got := Message(a, Details{Title: "t"})
	if !strings.HasPrefix(got, "⚠️ <b>Stopped: rate limit</b> · t") {
		t.Fatalf("got %q", got)
	}
}

func TestAnApprovalNamesTheToolAndWhatItAsks(t *testing.T) {
	d := Details{Title: "Fix CI", Cwd: "/home/u/dev/caprock", Home: "/home/u", Branch: "main"}
	cases := []struct{ tool, payload, want string }{
		{"Bash", `{"tool_input":{"command":"go test ./...\necho more"}}`, "Bash: <code>go test ./...</code>"},
		{"Edit", `{"tool_input":{"file_path":"/home/u/dev/caprock/internal/a.go"}}`, "Edit: <code>internal/a.go</code>"},
		{"Write", `{"tool_input":{"file_path":"/home/u/.zshrc"}}`, "Write: <code>~/.zshrc</code>"},
		{"WebFetch", `{"tool_input":{"url":"https://example.com/a"}}`, "WebFetch: <code>https://example.com/a</code>"},
		{"mcp__github__create_issue", `{"tool_input":{}}`, "create_issue via github"},
		{"AskUserQuestion", `{"tool_input":{"questions":[{"question":"Which branch?"}]}}`, "Which branch?"},
	}
	for _, c := range cases {
		got := Message(approval(c.tool, c.payload), d)
		lines := strings.Split(got, "\n")
		head := "⏳ <b>Needs approval</b> · Fix CI"
		if c.tool == "AskUserQuestion" {
			head = "❓ <b>Needs your answer</b> · Fix CI"
		}
		if len(lines) != 3 || lines[0] != head || lines[1] != "<code>~/dev/caprock</code> · main" || lines[2] != c.want {
			t.Errorf("%s: got\n%s", c.tool, got)
		}
	}
}

// Everything from a session goes through the HTML escaper: a title, a path,
// a branch, a command or a reply with <, > or & in it must neither break the
// message (Telegram refuses unparseable entities) nor inject markup.
func TestNastyTextIsEscaped(t *testing.T) {
	d := Details{
		Title: `<b>fix</b> & "quote" </code>`, Cwd: `/tmp/a&b/<dir>`, Branch: `feat/<x>&y`,
		Agent: "Codex", Link: "http://h/#/session/a&b", Reply: `use <script>alert(1)</script> & go`,
		Files: []string{"/tmp/<evil>.go"}, Tools: 1,
	}
	for _, got := range []string{
		Message(finished(`{}`), d),
		Message(approval("Bash", `{"tool_input":{"command":"echo '<i>' && rm -rf </code>"}}`), d),
	} {
		stripped := got
		for _, tag := range []string{"<b>", "</b>", "<code>", "</code>", "<i>", "</i>"} {
			stripped = strings.ReplaceAll(stripped, tag, "")
		}
		if strings.ContainsAny(stripped, "<>") {
			t.Fatalf("unescaped markup left:\n%s", got)
		}
		if strings.Contains(strings.ReplaceAll(got, "&amp;", ""), "&") && !strings.Contains(got, "&lt;") {
			t.Fatalf("bare ampersand:\n%s", got)
		}
		if !strings.Contains(got, "&lt;b&gt;fix&lt;/b&gt; &amp; \"quote\" &lt;/code&gt;") {
			t.Fatalf("title not escaped as text:\n%s", got)
		}
	}
	if got := Message(finished(`{}`), d); !strings.Contains(got, "· feat/&lt;x&gt;&amp;y · Codex") {
		t.Fatalf("branch/agent:\n%s", got)
	}
}

func TestLongTextIsClippedOnARuneBoundary(t *testing.T) {
	d := Details{Title: strings.Repeat("ω", 200), Reply: strings.Repeat("é", 300)}
	got := Message(finished(`{}`), d)
	first := strings.Split(got, "\n")[0]
	if !strings.HasSuffix(first, "…") || len([]rune(first)) > 100 {
		t.Fatalf("title not clipped: %q", first)
	}
	if !strings.Contains(got, strings.Repeat("é", replyMaxRunes-1)+"…</i>") {
		t.Fatalf("reply not clipped: %q", got)
	}
}

// With nothing known the message still reads, and invents nothing.
func TestAnUnknownSessionStillReads(t *testing.T) {
	if got := Message(Alert{Kind: KindApproval}, Details{}); got != "⏳ <b>Needs approval</b> · a session" {
		t.Fatalf("got %q", got)
	}
	got := Message(Alert{Kind: KindFinished, LastThisHour: true}, Details{Cwd: "/home/u/caprock"})
	if !strings.HasPrefix(got, "✅ <b>Finished</b> · caprock\n<code>/home/u/caprock</code>\n\nThat is 20 alerts") {
		t.Fatalf("got %q", got)
	}
	if strings.Contains(CheckMessage(""), "http") {
		t.Fatal("test message invented a link")
	}
}

// A long path keeps its end, where the file's name is, and a detached
// checkout's HEAD is not a branch.
func TestLongPathsKeepTheirName(t *testing.T) {
	deep := "/private/tmp/" + strings.Repeat("x", 120) + "/proj"
	d := Details{Title: "t", Cwd: deep, Branch: "HEAD"}
	got := Message(approval("Write", `{"tool_input":{"file_path":"/elsewhere/`+strings.Repeat("y", 120)+`/hello.txt"}}`), d)
	lines := strings.Split(got, "\n")
	if !strings.HasPrefix(lines[1], "<code>…") || !strings.HasSuffix(lines[1], "/proj</code>") {
		t.Fatalf("folder line: %q", lines[1])
	}
	if !strings.HasSuffix(lines[2], "/hello.txt</code>") || !strings.Contains(lines[2], "<code>…") {
		t.Fatalf("subject line: %q", lines[2])
	}
}

func TestDurations(t *testing.T) {
	for d, want := range map[time.Duration]string{45 * time.Second: "45s", 12 * time.Minute: "12m", 65 * time.Minute: "1h 05m"} {
		if got := duration(d); got != want {
			t.Errorf("%v: %q, want %q", d, got, want)
		}
	}
}
