package api

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/hookd"
	"github.com/dspv/caprock/internal/narrate"
	"github.com/dspv/caprock/internal/store"
)

// backgroundFixture is a lead that launched two background agents, three
// background commands and a Monitor, in Claude Code's own hook bodies, and
// heard the end of all but one agent (stopped to wait on its own e2e run)
// and one command (the release chain), then ended its turn.
const backgroundFixture = "../../testdata/background/lead-waits.jsonl"

// replay records the fixture's lines through the hook normalizer, each at
// its offset before e.now.
func replay(t *testing.T, e *env, path string) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		var line struct {
			Ago   int             `json:"ago_s"`
			Plane string          `json:"plane"`
			Body  json.RawMessage `json:"body"`
		}
		if err := json.Unmarshal(sc.Bytes(), &line); err != nil {
			t.Fatal(err)
		}
		ev, info, err := hookd.Normalize(line.Body, e.now.Add(-time.Duration(line.Ago)*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		if line.Plane == "transcript" {
			ev.Source = event.SourceTranscript
		}
		info.Cwd = "/Users/me/dev/app"
		if _, err := e.rec.Record(context.Background(), ev, info); err != nil {
			t.Fatal(err)
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
}

// Owner, 2026-11-24: "it looks like work stopped and I don't understand
// what's happening". Now said "Done" and "Subagents · 1 done" while the lead
// waited on a background agent and a release script.
func TestNowWaitsOnBackgroundWork(t *testing.T) {
	e := newEnv(t)
	replay(t, e, backgroundFixture)

	var sum SessionSummary
	if code := e.get(t, "/v1/sessions/bg-lead", &sum); code != 200 {
		t.Fatalf("status %d", code)
	}
	act := sum.Activity
	if act.Health != narrate.HealthWorking || act.Phrase != "waiting on background work · 1 agent, 1 shell" || act.Background != 1 || act.BackgroundTasks != 1 {
		t.Fatalf("activity = %+v", act)
	}
	want := []store.BackgroundTask{
		{Kind: store.BackgroundAgent, ID: "ad2f45955863f7dd0", Description: "Checks popover clipped at bottom", StartedAt: e.now.Add(-3400 * time.Second).UnixMilli()},
		{Kind: store.BackgroundShell, ID: "bja8lc5fk", Description: "Restart chain: merge #1045, release 0.192.0", Command: "/private/tmp/claude-501/app/scratchpad/rel0192b.sh", StartedAt: e.now.Add(-2400 * time.Second).UnixMilli()},
	}
	if len(sum.BackgroundWork) != len(want) {
		t.Fatalf("background_work = %+v", sum.BackgroundWork)
	}
	for i := range want {
		if sum.BackgroundWork[i] != want[i] {
			t.Errorf("background_work[%d] = %+v, want %+v", i, sum.BackgroundWork[i], want[i])
		}
	}
	if sum.LiveSubagents != 1 {
		t.Errorf("live_subagents = %d, want 1: the agent waiting on its own work", sum.LiveSubagents)
	}

	// The subagents: the one whose SubagentStop fired as it began to wait
	// on its own e2e run works; the one that finished is done.
	var subs SubagentsResponse
	e.get(t, "/v1/sessions/bg-lead/subagents", &subs)
	if len(subs.Working) != 1 || subs.Working[0].AgentID != "ad2f45955863f7dd0" || subs.Working[0].Description != "Checks popover clipped at bottom" {
		t.Errorf("working = %+v", subs.Working)
	}
	if subs.Finished != 1 || len(subs.Recent) != 1 || subs.Recent[0].AgentID != "abcc57ae71f2f89dc" {
		t.Errorf("finished = %d, recent = %+v", subs.Finished, subs.Recent)
	}
	var d SubagentDetail
	e.get(t, "/v1/sessions/bg-lead/subagents/ad2f45955863f7dd0", &d)
	if d.State != "working" || d.StoppedAt != 0 {
		t.Errorf("detail state = %q stopped_at = %d", d.State, d.StoppedAt)
	}

	// The release chain reports: one agent left.
	note := `{"session_id":"bg-lead","cwd":"/Users/me/dev/app","prompt_id":"p-8","hook_event_name":"UserPromptSubmit","prompt":"<task-notification>\n<task-id>bja8lc5fk</task-id>\n<status>completed</status>\n<summary>Background command \"Restart chain: merge #1045, release 0.192.0\" completed (exit code 0)</summary>\n</task-notification>"}`
	stop := `{"session_id":"bg-lead","cwd":"/Users/me/dev/app","hook_event_name":"Stop","stop_hook_active":false}`
	for i, body := range []string{note, stop} {
		ev, info, err := hookd.Normalize([]byte(body), e.now.Add(time.Duration(i+1)*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := e.rec.Record(context.Background(), ev, info); err != nil {
			t.Fatal(err)
		}
	}
	sum = SessionSummary{}
	e.get(t, "/v1/sessions/bg-lead", &sum)
	if sum.Activity.Phrase != "waiting on background work · 1 agent" || len(sum.BackgroundWork) != 1 || sum.BackgroundWork[0].Kind != store.BackgroundAgent {
		t.Fatalf("after the shell reported: activity = %+v, work = %+v", sum.Activity, sum.BackgroundWork)
	}

	// The process starts again: what it ran went with it.
	resume := `{"session_id":"bg-lead","cwd":"/Users/me/dev/app","hook_event_name":"SessionStart","source":"resume"}`
	ev, info, err := hookd.Normalize([]byte(resume), e.now.Add(5*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.rec.Record(context.Background(), ev, info); err != nil {
		t.Fatal(err)
	}
	sum = SessionSummary{}
	e.get(t, "/v1/sessions/bg-lead", &sum)
	if len(sum.BackgroundWork) != 0 || sum.Activity.Background != 0 || sum.Activity.BackgroundTasks != 0 || sum.LiveSubagents != 0 {
		t.Fatalf("after a restart: activity = %+v, work = %+v, live = %d", sum.Activity, sum.BackgroundWork, sum.LiveSubagents)
	}
	subs = SubagentsResponse{}
	e.get(t, "/v1/sessions/bg-lead/subagents", &subs)
	if len(subs.Working) != 0 {
		t.Errorf("after a restart: working = %+v", subs.Working)
	}
}
