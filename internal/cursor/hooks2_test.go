package cursor

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// Item 10: the observational hooks a cursor-agent chat sends — its start
// and end, a subagent's end, a shell command's output, a file edit, a
// thought, a tool's duration — become the events Claude Code's hooks make.
// Shapes from cursor.com/docs/agent/hooks (read 2026-11-17).
func TestObservationalHooks(t *testing.T) {
	hh := newHarness(t)
	h := &HookHandler{Token: "tok", Recorder: hh.in.rec, Now: func() time.Time { return time.UnixMilli(1_790_000_000_000) }}
	common := `"conversation_id":"cli-2","generation_id":"g2","model":"gpt-5","workspace_roots":["/work/api"],"user_email":"someone@example.com",`
	push := `To github.com:example/api.git\n * [new branch]      HEAD -> feat/health\n`
	for _, body := range []string{
		`{` + common + `"hook_event_name":"sessionStart","session_id":"s-2","is_background_agent":false,"composer_mode":"plan"}`,
		`{` + common + `"hook_event_name":"afterAgentThought","text":"thinking about it","duration_ms":1500}`,
		`{` + common + `"hook_event_name":"afterAgentThought","text":"more","duration_ms":500}`,
		`{` + common + `"hook_event_name":"afterShellExecution","command":"git push -u origin HEAD","output":"` + push + `","duration":1234,"sandbox":false}`,
		`{` + common + `"hook_event_name":"postToolUse","tool_name":"Shell","tool_input":{"command":"git push -u origin HEAD"},"tool_output":"{\"exitCode\":0}","tool_use_id":"tu-9","cwd":"/work/api","duration":1300}`,
		`{` + common + `"hook_event_name":"postToolUse","tool_name":"Read","tool_input":{"file_path":"main.go"},"tool_output":"\"package main\"","tool_use_id":"tu-10","duration":12}`,
		`{` + common + `"hook_event_name":"afterFileEdit","file_path":"/work/api/main.go","edits":[{"old_string":"a","new_string":"b"}]}`,
		`{` + common + `"hook_event_name":"subagentStop","subagent_type":"generalPurpose","status":"completed","task":"look","description":"Find the handler","summary":"done","duration_ms":45000,"message_count":12,"tool_call_count":8,"loop_count":0,"modified_files":["src/a.ts"]}`,
		`{` + common + `"hook_event_name":"stop","status":"completed","loop_count":0}`,
		`{` + common + `"hook_event_name":"sessionEnd","session_id":"s-2","reason":"window_close","duration_ms":45000,"is_background_agent":false,"final_status":"completed"}`,
	} {
		if code := post(t, h, body, ""); code != http.StatusNoContent {
			t.Fatalf("%d for %s", code, body)
		}
		post(t, h, body, "")
	}
	if n := hh.count(t, `CAST(payload AS TEXT) LIKE '%example.com%'`); n != 0 {
		t.Fatalf("%d events kept the user's email", n)
	}
	if n := hh.count(t, `CAST(payload AS TEXT) LIKE '%thinking about it%'`); n != 0 {
		t.Fatal("a thought's text was stored")
	}
	for kind, want := range map[string]int{"agent.spawn": 1, "tool.post": 3, "agent.stop": 2, "session.continue": 1, "session.end": 0} {
		if n := hh.count(t, `kind = '`+kind+`'`); n != want {
			t.Errorf("%s: %d, want %d", kind, n, want)
		}
	}
	mode, err := store.LastPermissionMode(hh.ctx, hh.st.DB(), "cli-2")
	if err != nil || mode != "plan" {
		t.Errorf("mode %q %v, want sessionStart's plan", mode, err)
	}
	if got := hh.scalar(t, `SELECT json_extract(payload,'$.thinking_ms') FROM events WHERE key = 'cu-hook-stop:g2'`); got != 2000 {
		t.Errorf("stop's thinking %v", got)
	}
	if got := hh.scalar(t, `SELECT json_extract(payload,'$.duration_ms') FROM events WHERE kind = 'tool.post' AND tool = 'Read'`); got != 12 {
		t.Errorf("postToolUse duration %v", got)
	}
	var agent string
	if err := hh.st.DB().QueryRow(`SELECT agent_id FROM events WHERE kind = 'agent.stop' AND agent_id <> ''`).Scan(&agent); err != nil || !strings.HasPrefix(agent, "sub-") {
		t.Errorf("subagent stop id %q %v", agent, err)
	}
	// The shell command's output, in Claude Code's shape, gives the CLI
	// chat its pushed branch — once, though two hooks reported it.
	if got := hh.scalar(t, `SELECT COUNT(*) FROM session_branches WHERE session_id = 'cli-2' AND branch = 'feat/health'`); got != 1 {
		t.Errorf("pushed branch recorded %v times", got)
	}
	if n := hh.count(t, `kind = 'tool.post' AND tool = 'Bash'`); n != 1 {
		t.Errorf("%d results for one command", n)
	}

	// A session that completed ends.
	post(t, h, `{`+common+`"hook_event_name":"sessionEnd","session_id":"s-2","reason":"completed","final_status":"completed"}`, "")
	if n := hh.count(t, `kind = 'session.end'`); n != 1 {
		t.Errorf("a completed session did not end")
	}
}

func TestHookEventsAreObservational(t *testing.T) {
	for _, ev := range HookEvents {
		switch ev {
		case "preToolUse", "beforeShellExecution", "beforeMCPExecution", "beforeReadFile", "beforeTabFileRead", "subagentStart":
			t.Errorf("%s is a permission hook and must never be registered", ev)
		}
		if r := string(NeutralReply(ev)); r != "{}" && ev != "beforeSubmitPrompt" {
			t.Errorf("%s answers %s", ev, r)
		}
	}
}
