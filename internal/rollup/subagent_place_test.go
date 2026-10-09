package rollup

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// A background subagent working in a git worktree of its own reports that
// worktree as its cwd and its branch as gitBranch. Recorded as the session's,
// the owner's session in ~/dev/caprock on master read as `feat/…` in an
// agent's worktree (2026-10-09). Its place fills an empty row only.
func TestASubagentDoesNotMoveItsSession(t *testing.T) {
	ctx := context.Background()
	r, _ := newRecorder(t)
	at := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	rec := func(ev *event.Event, info SessionInfo) store.Session {
		t.Helper()
		res, err := r.Record(ctx, ev, info)
		if err != nil {
			t.Fatal(err)
		}
		return res.Session
	}
	main := SessionInfo{Cwd: "/home/u/caprock", GitBranch: "master", TranscriptPath: "/p/s1.jsonl"}
	sub := SessionInfo{Cwd: "/home/u/caprock/.claude/worktrees/agent-a1", GitBranch: "feat/x", TranscriptPath: "/p/s1/subagents/agent-a1.jsonl"}

	rec(&event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnUser, Key: "prompt:1", Ts: at, Payload: json.RawMessage(`{}`)}, main)
	// A hook fired inside the subagent (agent id), and its transcript line
	// (agent id and the sidechain flag).
	rec(&event.Event{SessionID: "s1", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Bash", Key: "pre:t1", Ts: at.Add(time.Second),
		AgentID: "a1", Payload: json.RawMessage(`{"tool_name":"Bash"}`)}, sub)
	s := rec(&event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: "msg:sub", Ts: at.Add(2 * time.Second),
		AgentID: "a1", Payload: json.RawMessage(`{"sidechain":true}`)}, sub)
	if s.Cwd != main.Cwd || s.GitBranch != "master" || s.TranscriptPath != main.TranscriptPath {
		t.Fatalf("a subagent moved its session: cwd=%q branch=%q transcript=%q", s.Cwd, s.GitBranch, s.TranscriptPath)
	}
	if s.RepoRoot != "" && s.RepoRoot != main.Cwd {
		t.Fatalf("a subagent re-resolved its session's repository: %q", s.RepoRoot)
	}

	// The main thread moving still moves the session.
	s = rec(&event.Event{SessionID: "s1", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Read", Key: "pre:t2", Ts: at.Add(3 * time.Second),
		Payload: json.RawMessage(`{"tool_name":"Read"}`)}, SessionInfo{Cwd: "/home/u/other", GitBranch: "dev"})
	if s.Cwd != "/home/u/other" || s.GitBranch != "dev" {
		t.Fatalf("the main thread's move was not recorded: cwd=%q branch=%q", s.Cwd, s.GitBranch)
	}

	// A session first heard of through a subagent still gets a place.
	s = rec(&event.Event{SessionID: "s2", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Bash", Key: "pre:t3", Ts: at,
		AgentID: "a2", Payload: json.RawMessage(`{"tool_name":"Bash"}`)}, sub)
	if s.Cwd != sub.Cwd || s.GitBranch != "feat/x" {
		t.Fatalf("an empty session was not filled from its subagent: cwd=%q branch=%q", s.Cwd, s.GitBranch)
	}
}
