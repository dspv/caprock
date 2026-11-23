package store

import (
	"context"
	"encoding/json"
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
