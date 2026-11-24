package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// The fold over Claude Code's own records, one rule a case.
func TestFoldBackground(t *testing.T) {
	note := func(ts int64, body string) backgroundRow {
		return backgroundRow{ts: ts, prompt: "<task-notification>\n" + body + "\n</task-notification>"}
	}
	ids := func(ts []BackgroundTask) []string {
		var out []string
		for _, t := range ts {
			out = append(out, t.Kind+":"+t.ID)
		}
		return out
	}
	cases := []struct {
		name string
		rows []backgroundRow
		want []string
	}{
		{"a background command runs until it reports", []backgroundRow{
			{ts: 1, tool: "Bash", bgTaskID: "b1", desc: "Run the release"},
		}, []string{"shell:b1"}},
		{"a foreground command is no background work", []backgroundRow{
			{ts: 1, tool: "Bash", desc: "Run the tests"},
		}, nil},
		{"completed, failed and killed end it", []backgroundRow{
			{ts: 1, tool: "Bash", bgTaskID: "b1"}, {ts: 2, tool: "Bash", bgTaskID: "b2"}, {ts: 3, tool: "Bash", bgTaskID: "b3"},
			note(4, "<task-id>b1</task-id>\n<status>completed</status>"),
			note(5, "<task-id>b2</task-id>\n<status>failed</status>"),
			note(6, "<task-id>b3</task-id>\n<status>killed</status>"),
		}, nil},
		{"a sync agent is no background work; an async one is", []backgroundRow{
			{ts: 1, tool: "Agent", agentID: "a1"}, {ts: 2, tool: "Task", agentID: "a2", async: true},
		}, []string{"agent:a2"}},
		{"an agent waiting on its own background work has not ended", []backgroundRow{
			{ts: 1, tool: "Agent", agentID: "a1", async: true},
			note(2, `<task-id>a1</task-id>
<status>completed</status>
<summary>Agent "x" is waiting on its own background work</summary>`),
		}, []string{"agent:a1"}},
		{"then it finishes", []backgroundRow{
			{ts: 1, tool: "Agent", agentID: "a1", async: true},
			note(2, `<task-id>a1</task-id>
<status>completed</status>
<summary>Agent "x" is waiting on its own background work</summary>`),
			note(3, `<task-id>a1</task-id>
<status>completed</status>
<summary>Agent "x" finished</summary>`),
		}, nil},
		{"a monitor's events are progress; stream ended ends it", []backgroundRow{
			{ts: 1, tool: "Monitor", taskID: "m1", desc: "watch", command: "tail -F log"},
			note(2, "<task-id>m1</task-id>\n<summary>Monitor event: \"watch\"</summary>\n<event>merged</event>"),
		}, []string{"monitor:m1"}},
		{"TaskStop and KillShell end what they name", []backgroundRow{
			{ts: 1, tool: "Bash", bgTaskID: "b1"}, {ts: 2, tool: "Bash", bgTaskID: "b2"}, {ts: 3, tool: "Bash", bgTaskID: "b3"},
			{ts: 4, tool: "TaskStop", stopID: "b1"}, {ts: 5, tool: "KillShell", stopID: "b2"},
		}, []string{"shell:b3"}},
		{"one notification names several", []backgroundRow{
			{ts: 1, tool: "Agent", agentID: "a1", async: true}, {ts: 2, tool: "Agent", agentID: "a2", async: true},
			note(3, "<task-id>a1</task-id>\n<task-id>a2</task-id>\n<status>stopped</status>\n<summary>2 background agents didn't finish</summary>"),
		}, nil},
		{"SendMessage resumes a finished agent", []backgroundRow{
			{ts: 1, tool: "Agent", agentID: "a1", async: true, desc: "Fix it"},
			note(2, "<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent \"Fix it\" finished</summary>"),
			{ts: 3, tool: "SendMessage", resumed: "a1"},
		}, []string{"agent:a1"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ids(foldBackground(c.rows))
			if len(got) != len(c.want) {
				t.Fatalf("got %v, want %v", got, c.want)
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Fatalf("got %v, want %v", got, c.want)
				}
			}
		})
	}
	// A resumed agent keeps what it was launched for, from the resume on.
	got := foldBackground([]backgroundRow{
		{ts: 1, tool: "Agent", agentID: "a1", async: true, desc: "Fix it"},
		note(2, "<task-id>a1</task-id>\n<status>completed</status>"),
		{ts: 9, tool: "SendMessage", resumed: "a1"},
	})
	if len(got) != 1 || got[0].Description != "Fix it" || got[0].StartedAt != 9 {
		t.Fatalf("resumed = %+v", got)
	}
}

// The reads: the main thread's calls and notifications, from either plane;
// a subagent's own background command is its own; a launch before the
// process started again, past the window, or in an ended session is gone.
func TestBackgroundWorkReads(t *testing.T) {
	ctx := context.Background()
	f := &weekFixture{t: t, s: openTest(t), loc: time.UTC}
	now := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	put := func(agent string, src event.Source, kind event.Kind, tool string, at time.Time, payload string) {
		f.put(event.Event{SessionID: "s", AgentID: agent, Source: src, Kind: kind, Tool: tool, Ts: at, Payload: json.RawMessage(payload)})
	}
	put("", event.SourceHook, event.KindAgentSpawn, "", now.Add(-14*time.Hour), `{"source":"startup"}`)
	put("", event.SourceHook, event.KindToolPost, "Bash", now.Add(-13*time.Hour), `{"tool_input":{"description":"Too old"},"tool_response":{"backgroundTaskId":"old"}}`)
	put("", event.SourceHook, event.KindToolPost, "Bash", now.Add(-time.Hour), `{"tool_input":{"description":"Release","command":"./rel.sh\nmore"},"tool_response":{"backgroundTaskId":"b1"}}`)
	put("", event.SourceHook, event.KindToolPost, "Agent", now.Add(-50*time.Minute), `{"tool_input":{"description":"Fix it"},"tool_response":{"isAsync":true,"agentId":"a1"}}`)
	put("sub", event.SourceHook, event.KindToolPost, "Bash", now.Add(-40*time.Minute), `{"tool_input":{"description":"Its own"},"tool_response":{"backgroundTaskId":"bsub"}}`)
	// Delivered mid-turn: the transcript's copy alone.
	put("", event.SourceTranscript, event.KindTurnUser, "", now.Add(-30*time.Minute), `{"_from":"transcript","prompt":"<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent \"Fix it\" finished</summary>\n</task-notification>"}`)
	put("", event.SourceHook, event.KindAgentStop, "", now.Add(-time.Minute), `{}`)

	got, err := BackgroundWork(ctx, f.s.DB(), "s", now.UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != (BackgroundTask{Kind: BackgroundShell, ID: "b1", Description: "Release", Command: "./rel.sh", StartedAt: now.Add(-time.Hour).UnixMilli()}) {
		t.Fatalf("work = %+v", got)
	}
	if open := BackgroundAgentIDs(got); open != nil {
		t.Fatalf("agents = %v", open)
	}

	// A compaction's SessionStart is no restart; a resume is.
	put("", event.SourceHook, event.KindAgentSpawn, "", now.Add(-20*time.Second), `{"source":"compact"}`)
	if got, _ := BackgroundWork(ctx, f.s.DB(), "s", now.UnixMilli()); len(got) != 1 {
		t.Fatalf("after a compaction: %+v", got)
	}
	put("", event.SourceHook, event.KindAgentSpawn, "", now.Add(-10*time.Second), `{"source":"resume"}`)
	if got, _ := BackgroundWork(ctx, f.s.DB(), "s", now.UnixMilli()); len(got) != 0 {
		t.Fatalf("after a resume: %+v", got)
	}

	if got, err := BackgroundWork(ctx, f.s.DB(), "nobody", now.UnixMilli()); err != nil || got != nil {
		t.Fatalf("unknown session: %v %v", got, err)
	}
}

// Claude Code's own list of what still runs, from the owner's session of
// 2026-11-24 (ids and shapes as recorded, UTC, payloads trimmed): two
// release scripts the lead stopped with pkill, and three agents whose last
// word was "is waiting on its own background work", read open for 12 hours
// because no notification ever named their end. Every Stop lists the
// session's running background work in background_tasks.
func TestBackgroundWorkTaskList(t *testing.T) {
	ctx := context.Background()
	f := &weekFixture{t: t, s: openTest(t), loc: time.UTC}
	at := func(s string) time.Time {
		ts, err := time.Parse("2006-01-02 15:04:05", s)
		if err != nil {
			t.Fatal(err)
		}
		return ts
	}
	now := at("2026-11-24 08:30:00")
	put := func(agent string, kind event.Kind, tool string, ts time.Time, payload string) {
		f.put(event.Event{SessionID: "s", AgentID: agent, Source: event.SourceHook, Kind: kind, Tool: tool, Ts: ts, Payload: json.RawMessage(payload)})
	}
	shell := func(agent, id, desc, ts string) {
		put(agent, event.KindToolPost, "Bash", at(ts),
			`{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"/tmp/rel.sh","description":"`+desc+`","run_in_background":true},"tool_response":{"stdout":"","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false,"backgroundTaskId":"`+id+`"}}`)
	}
	launch := func(id, desc, ts string) {
		put("", event.KindToolPost, "Agent", at(ts),
			`{"hook_event_name":"PostToolUse","tool_name":"Agent","tool_input":{"description":"`+desc+`","prompt":"…","subagent_type":"general-purpose","run_in_background":true},"tool_response":{"isAsync":true,"status":"async_launched","agentId":"`+id+`","description":"`+desc+`"}}`)
	}
	waiting := func(id, desc, ts string) {
		put("", event.KindTurnUser, "", at(ts), `{"hook_event_name":"UserPromptSubmit","prompt":"<task-notification>\n<task-id>`+id+`</task-id>\n<status>completed</status>\n<summary>Agent \"`+desc+`\" is waiting on its own background work</summary>\n<note>This agent stopped with background work of its own still running. It may resume on its own when that work completes or reports, and the same task-id notifies again if it does; the result below may be interim.</note>\n<result>Pushed.</result>\n</task-notification>"}`)
	}
	// stop is a Stop (a SubagentStop with an agent) listing what runs; an
	// id's first letter gives its type, as Claude Code's ids do.
	stop := func(agent, ts string, running ...string) {
		var tasks []string
		for _, id := range running {
			typ := map[byte]string{'a': "subagent", 's': "monitor"}[id[0]]
			if typ == "" {
				typ = "shell"
			}
			tasks = append(tasks, `{"id":"`+id+`","type":"`+typ+`","status":"running","description":"x"}`)
		}
		put(agent, event.KindAgentStop, "", at(ts),
			`{"hook_event_name":"Stop","stop_hook_active":false,"background_tasks":[`+strings.Join(tasks, ",")+`],"session_crons":[]}`)
	}
	expect := func(what string, want ...string) {
		t.Helper()
		got, err := BackgroundWork(ctx, f.s.DB(), "s", now.UnixMilli())
		if err != nil {
			t.Fatal(err)
		}
		var ids []string
		for _, w := range got {
			ids = append(ids, w.Kind+":"+w.ID)
		}
		if strings.Join(ids, " ") != strings.Join(want, " ") {
			t.Fatalf("%s: got %v, want %v", what, ids, want)
		}
	}

	// The release scripts, stopped with pkill: no notification, and gone
	// from the next Stop's list.
	shell("", "b56qabcki", "Merge remaining PRs and release 0.192.0", "2026-11-23 20:31:45")
	stop("", "2026-11-23 20:32:22", "b56qabcki", "a5d2405293ee74d39")
	expect("listed", "shell:b56qabcki")
	shell("", "bq7wfzgvs", "Merge #1045, wait master CI, release 0.192.0", "2026-11-23 21:04:39")
	stop("", "2026-11-23 21:04:45", "bq7wfzgvs")
	expect("the first killed", "shell:bq7wfzgvs")
	stop("", "2026-11-23 21:17:40", "bql6fmq5d")
	expect("both killed")

	// An agent waiting on its own work is off the list while what it
	// launched itself is on it: still open.
	launch("ad2f45955863f7dd0", "Checks popover clipped at bottom", "2026-11-23 22:05:33")
	shell("ad2f45955863f7dd0", "bq28ppx7x", "Run full vitest suite", "2026-11-23 22:13:41")
	put("ad2f45955863f7dd0", event.KindToolPost, "Monitor", at("2026-11-23 22:13:46"),
		`{"tool_name":"Monitor","tool_input":{"description":"full vitest result","command":"until grep -q x; do sleep 5; done"},"tool_response":{"taskId":"bd2f3vrwc","timeoutMs":300000,"persistent":false}}`)
	stop("ad2f45955863f7dd0", "2026-11-23 22:26:00", "ad2f45955863f7dd0", "bd2f3vrwc", "scay0ef18")
	waiting("ad2f45955863f7dd0", "Checks popover clipped at bottom", "2026-11-23 22:26:00")
	stop("", "2026-11-23 22:26:23", "bd2f3vrwc", "scay0ef18")
	expect("waiting on its own watch", "agent:ad2f45955863f7dd0")

	// Its watch ended and it never came back: neither it nor its work is
	// listed, so it has ended. Another agent's own shell (an until-loop
	// that never matched) is still listed, so that one still waits; and a
	// launch after the newest Stop is believed until the next.
	launch("ab08e246b3224f2a3", "Release groups: aligned counts, chevrons", "2026-11-23 22:22:10")
	shell("ab08e246b3224f2a3", "badf1dbfl", "until grep", "2026-11-23 22:30:25")
	waiting("ab08e246b3224f2a3", "Release groups: aligned counts, chevrons", "2026-11-23 22:56:25")
	stop("", "2026-11-24 00:35:14", "badf1dbfl", "scay0ef18")
	shell("", "b1vj1vsiq", "Merge #1050 and #1030, release 0.193.0", "2026-11-24 08:20:00")
	expect("after the lists", "agent:ab08e246b3224f2a3", "shell:b1vj1vsiq")

	// A Stop with no list (a Claude Code from before it) says nothing.
	put("", event.KindAgentStop, "", at("2026-11-24 08:25:00"), `{"hook_event_name":"Stop","stop_hook_active":false}`)
	expect("with no list", "shell:b56qabcki", "shell:bq7wfzgvs", "agent:ad2f45955863f7dd0", "agent:ab08e246b3224f2a3", "shell:b1vj1vsiq")
}
