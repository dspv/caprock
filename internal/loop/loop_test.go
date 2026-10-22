package loop

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

type fixtureEvent struct {
	SessionID string          `json:"session_id"`
	AgentID   string          `json:"agent_id"`
	Kind      string          `json:"kind"`
	Tool      string          `json:"tool"`
	TsOffsetS int             `json:"ts_offset_s"`
	Payload   json.RawMessage `json:"payload"`
}

func replay(t *testing.T, d *Detector, name string) []*Alert {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "loops", name))
	if err != nil {
		t.Fatal(err)
	}
	var evs []fixtureEvent
	if err := json.Unmarshal(b, &evs); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	var alerts []*Alert
	for _, fe := range evs {
		ev := event.Event{SessionID: fe.SessionID, AgentID: fe.AgentID, Kind: event.Kind(fe.Kind), Tool: fe.Tool, Payload: fe.Payload, Ts: base.Add(time.Duration(fe.TsOffsetS) * time.Second)}
		if a := d.Observe(ev); a != nil {
			alerts = append(alerts, a)
		}
	}
	return alerts
}

func TestLoopingFixtureTriggersExactlyOneAlert(t *testing.T) {
	d := New(5, 3*time.Minute)
	alerts := replay(t, d, "looping.json")
	if len(alerts) != 1 {
		t.Fatalf("got %d alerts, want exactly 1: %+v", len(alerts), alerts)
	}
	a := alerts[0]
	if a.Tool != "Bash" || a.Count != 5 || a.SessionID != "loop-session" || a.WindowMin != 3 || a.Sample != "Bash: go test ./..." {
		t.Fatalf("alert: %+v", a)
	}
}

func TestNonLoopingFixtureTriggersNone(t *testing.T) {
	d := New(5, 3*time.Minute)
	if alerts := replay(t, d, "non_looping.json"); len(alerts) != 0 {
		t.Fatalf("false positive: %+v", alerts)
	}
}

// A parent and its subagents making the same edit, interleaved: nine calls on
// one signature inside the window, three per thread. The subagents' calls
// come under the parent's session id (one by agent id, one marked sidechain
// only); counted as one window they read as the parent looping.
func TestSubagentEditsDoNotRaiseTheParentsLoop(t *testing.T) {
	d := New(5, 3*time.Minute)
	if alerts := replay(t, d, "subagents_interleaved.json"); len(alerts) != 0 {
		t.Fatalf("subagent edits counted toward the parent: %+v", alerts)
	}
	// Each thread still counts its own: two more edits by the agent-id
	// subagent make five of its own, and that is a loop -- on the session it
	// works for.
	base := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	payload := json.RawMessage(`{"tool_input":{"file_path":"/repo/ui/src/App.tsx","old_string":"import { a } from './a'","new_string":"import { a, b } from './a'"}}`)
	var got *Alert
	for i := range 2 {
		ev := event.Event{SessionID: "parent-session", AgentID: "a1b2c3", Kind: event.KindToolPre, Tool: "Edit", Payload: payload, Ts: base.Add(time.Duration(140+i*5) * time.Second)}
		if a := d.Observe(ev); a != nil {
			got = a
		}
	}
	if got == nil || got.SessionID != "parent-session" || got.Count != 5 {
		t.Fatalf("a looping subagent must still alert, with its own count: %+v", got)
	}
	// And the parent's own window was never touched by it: two more of the
	// parent's make five, and that alerts separately.
	got = nil
	for i := range 2 {
		ev := event.Event{SessionID: "parent-session", Kind: event.KindToolPre, Tool: "Edit", Payload: payload, Ts: base.Add(time.Duration(150+i*5) * time.Second)}
		if a := d.Observe(ev); a != nil {
			got = a
		}
	}
	if got == nil || got.Count != 5 {
		t.Fatalf("the parent's own five edits: %+v", got)
	}
	d.Forget("parent-session")
	if len(d.sessions) != 0 {
		t.Fatalf("Forget left %d windows", len(d.sessions))
	}
}

func TestNearDuplicateInputsCount(t *testing.T) {
	d := New(5, 3*time.Minute)
	if alerts := replay(t, d, "near_duplicate.json"); len(alerts) != 1 {
		t.Fatalf("near-duplicate loop missed: %+v", alerts)
	}
}

func TestSpreadOutRepeatsAreNotALoop(t *testing.T) {
	d := New(5, 3*time.Minute)
	if alerts := replay(t, d, "stale.json"); len(alerts) != 0 {
		t.Fatalf("stale repeats alerted: %+v", alerts)
	}
}

func TestNewEpisodeAfterCooldownAlertsAgain(t *testing.T) {
	d := New(3, time.Minute)
	base := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	mk := func(ts time.Time) event.Event {
		return event.Event{SessionID: "s", Kind: event.KindToolPre, Tool: "Bash", Ts: ts, Payload: json.RawMessage(`{"tool_input":{"command":"make test"}}`)}
	}
	n := 0
	for i := 0; i < 5; i++ {
		if d.Observe(mk(base.Add(time.Duration(i)*10*time.Second))) != nil {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("first episode alerts %d", n)
	}
	// Quiet for 5 minutes, then loops again → new episode → new alert.
	later := base.Add(6 * time.Minute)
	for i := 0; i < 3; i++ {
		if a := d.Observe(mk(later.Add(time.Duration(i) * 10 * time.Second))); a != nil {
			n++
		}
	}
	if n != 2 {
		t.Fatalf("second episode not alerted, total %d", n)
	}
	d.Forget("s")
	if len(d.sessions) != 0 {
		t.Fatal("forget did not drop session")
	}
}

func TestSignatureNormalization(t *testing.T) {
	a, _ := Signature("Bash", json.RawMessage(`{"tool_input":{"command":"go test ./... -count=1","description":"x"}}`))
	b, _ := Signature("Bash", json.RawMessage(`{"tool_input":{"command":"go   test ./... -count=7","description":"y","timeout":5}}`))
	c, _ := Signature("Bash", json.RawMessage(`{"tool_input":{"command":"go build ./..."}}`))
	if a != b {
		t.Fatal("volatile differences should normalize away")
	}
	if a == c {
		t.Fatal("different commands collided")
	}
	if s, _ := Signature("", nil); s != "" {
		t.Fatal("empty tool should have empty signature")
	}
	if _, sample := Signature("Edit", json.RawMessage(`{"tool_input":{"file_path":"/a/b.go","old_string":"x"}}`)); sample != "Edit: /a/b.go" {
		t.Fatalf("sample %q", sample)
	}
	if got := Describe("mcp__gh__issue", map[string]json.RawMessage{"query": json.RawMessage(`"bugs"`)}); got != "mcp__gh__issue: bugs" {
		t.Fatalf("describe %q", got)
	}
	// Codex's exec: a loop alert names the command, not the JavaScript.
	if _, sample := Signature("exec", json.RawMessage(`{"tool_input":{"command":"const r = await tools.exec_command({cmd:\"git status --short\",\"workdir\":\"/p\"});text(r.output)\n"}}`)); sample != "exec: git status --short" {
		t.Fatalf("exec sample %q", sample)
	}
}

// A repeated read is ordinary work, not a loop worth interrupting someone over.
//
// Measured over 64,733 real tool calls: 54% of everything the detector fired on
// was a repeated Read of one file — re-reading after an edit, while searching,
// while comparing. Tool calls cost nothing (verified: zero across every
// tool.pre), so none of those alerts could have been about the budget this
// package exists to protect.
func TestReadOnlyToolsDoNotRaiseLoops(t *testing.T) {
	for _, tool := range []string{"Read", "Glob", "Grep", "ToolSearch"} {
		t.Run(tool, func(t *testing.T) {
			d := New(3, time.Minute)
			var got *Alert
			for i := 0; i < 20; i++ {
				ev := event.Event{
					SessionID: "s", Kind: event.KindToolPre, Tool: tool,
					Ts:      time.Now().Add(time.Duration(i) * time.Second),
					Payload: json.RawMessage(`{"tool_input":{"file_path":"/x/main.go"}}`),
				}
				if a := d.Observe(ev); a != nil {
					got = a
				}
			}
			if got != nil {
				t.Errorf("%s raised a loop alert after 20 identical reads: %+v", tool, got)
			}
		})
	}
}

// The tools that can actually spend money must still be caught — the exclusion
// above must not quietly disable the feature.
func TestSpendingToolsStillRaiseLoops(t *testing.T) {
	for _, tool := range []string{"Bash", "Edit", "Write", "WebFetch"} {
		t.Run(tool, func(t *testing.T) {
			d := New(3, time.Minute)
			var got *Alert
			for i := 0; i < 10; i++ {
				ev := event.Event{
					SessionID: "s", Kind: event.KindToolPre, Tool: tool,
					Ts:      time.Now().Add(time.Duration(i) * time.Second),
					Payload: json.RawMessage(`{"tool_input":{"command":"go test ./..."}}`),
				}
				if a := d.Observe(ev); a != nil {
					got = a
				}
			}
			if got == nil {
				t.Errorf("%s repeated ten times raised nothing; the detector must still fire", tool)
			}
		})
	}
}

// A browser agent screenshots, scrolls and waits again and again as the way it
// works; five identical screenshots in three minutes raised a red LOOP card
// the owner could do nothing about (2026-10-22). Those steps are skipped. A
// repeated click, and the same Bash or Edit, still raise one.
func TestBrowserObservationStepsAreNotLoops(t *testing.T) {
	base := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	run := func(tool, input string) []*Alert {
		d := New(5, 3*time.Minute)
		var alerts []*Alert
		for i := 0; i < 8; i++ {
			ev := event.Event{SessionID: "s", Kind: event.KindToolPre, Tool: tool,
				Payload: json.RawMessage(`{"tool_input":` + input + `}`), Ts: base.Add(time.Duration(i) * 10 * time.Second)}
			if a := d.Observe(ev); a != nil {
				alerts = append(alerts, a)
			}
		}
		return alerts
	}
	quiet := []struct{ tool, input string }{
		{"mcp__claude-in-chrome__computer", `{"action":"screenshot","tabId":1}`},
		{"mcp__claude-in-chrome__computer", `{"action":"scroll","coordinate":[640,400],"scroll_direction":"down","tabId":1}`},
		{"mcp__claude-in-chrome__computer", `{"action":"wait","duration":2,"tabId":1}`},
		{"mcp__claude-in-chrome__computer", `{"action":"key","text":"Page_Down","tabId":1}`},
		{"mcp__claude-in-chrome__computer", `{"action":"zoom","region":[0,0,100,100],"tabId":1}`},
		{"mcp__computer-use__computer", `{"action":"screenshot"}`},
		{"computer", `{"action":"screenshot"}`},
		{"mcp__claude-in-chrome__read_page", `{"tabId":1}`},
		{"mcp__claude-in-chrome__navigate", `{"url":"https://example.com","tabId":1}`},
		{"mcp__playwright__browser_take_screenshot", `{}`},
		{"mcp__playwright__browser_snapshot", `{}`},
		{"mcp__playwright__browser_wait_for", `{"time":2}`},
	}
	for _, c := range quiet {
		if alerts := run(c.tool, c.input); len(alerts) != 0 {
			t.Errorf("%s %s: %d alerts, want none", c.tool, c.input, len(alerts))
		}
		if !Ignored(c.tool, json.RawMessage(c.input)) {
			t.Errorf("Ignored(%s, %s) = false; the week replay would count what the live alert skips", c.tool, c.input)
		}
	}
	loud := []struct{ tool, input string }{
		{"mcp__claude-in-chrome__computer", `{"action":"left_click","coordinate":[100,200],"tabId":1}`},
		{"mcp__playwright__browser_click", `{"element":"Submit","ref":"e12"}`},
		{"Bash", `{"command":"go test ./..."}`},
		{"Edit", `{"file_path":"/w/a.go","old_string":"a","new_string":"b"}`},
		{"mcp__github__screenshot", `{"action":"screenshot"}`}, // not a browser tool by name
	}
	for _, c := range loud {
		if alerts := run(c.tool, c.input); len(alerts) != 1 {
			t.Errorf("%s %s: %d alerts, want 1", c.tool, c.input, len(alerts))
		}
		if Ignored(c.tool, json.RawMessage(c.input)) {
			t.Errorf("Ignored(%s, %s) = true", c.tool, c.input)
		}
	}
}
