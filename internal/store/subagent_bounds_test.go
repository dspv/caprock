package store

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// Owner, 2026-11-23: the lead's process restarted while background
// subagents ran; their SubagentStop never fired, and one stayed "working"
// in the Now tree with none of the lead's agents running.
func TestSubagentsLostToARestartReadStopped(t *testing.T) {
	ctx := context.Background()
	f := &weekFixture{t: t, s: openTest(t), loc: time.UTC}
	now := time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)
	since := now.Add(-LiveSubagentWindow).UnixMilli()
	put := func(agent string, kind event.Kind, at time.Time, payload string) {
		e := event.Event{SessionID: "s", AgentID: agent, Source: event.SourceHook, Kind: kind, Tool: "Bash", Ts: at}
		if payload != "" {
			e.Payload = json.RawMessage(payload)
		}
		f.put(e)
	}
	// The process started, ran a subagent, and started again (a resume) at
	// -10m; "old" never stopped. "new" works after the restart. A
	// compaction's SessionStart at -2m is not a restart.
	put("", event.KindAgentSpawn, now.Add(-25*time.Minute), `{"source":"startup"}`)
	put("old", event.KindToolPre, now.Add(-20*time.Minute), "")
	put("old", event.KindToolPost, now.Add(-19*time.Minute), "")
	put("", event.KindAgentSpawn, now.Add(-10*time.Minute), `{"source":"resume"}`)
	put("new", event.KindToolPre, now.Add(-5*time.Minute), "")
	put("", event.KindAgentSpawn, now.Add(-2*time.Minute), `{"source":"compact"}`)
	put("", event.KindTurnUser, now.Add(-time.Minute), "")

	n, err := LiveSubagents(ctx, f.s.DB(), "s", since)
	if err != nil || n != 1 {
		t.Fatalf("live = %d, %v; want 1 (only new)", n, err)
	}
	working, finished, err := SubagentsNow(ctx, f.s.DB(), "s", since, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(working) != 1 || working[0].AgentID != "new" || finished != 1 {
		t.Fatalf("working %+v, finished %d; want new working and old finished", working, finished)
	}
	done, err := SubagentsDone(ctx, f.s.DB(), "s", since, 5, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(done) != 1 || done[0].AgentID != "old" || done[0].Lost != SubagentLostRestart || done[0].StoppedAt != now.Add(-10*time.Minute).UnixMilli() {
		t.Fatalf("done = %+v; want old lost to the restart at -10m", done)
	}
	spans, err := SubagentSpans(ctx, f.s.DB(), "s", since, since, now.UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	for _, sp := range spans {
		if sp.AgentID == "old" && sp.To != now.Add(-19*time.Minute).UnixMilli() {
			t.Fatalf("old's span runs to %d; want its newest event", sp.To)
		}
	}

	// The session ended: nothing of it works.
	if _, err := f.s.DB().ExecContext(ctx, `UPDATE sessions SET status = 'ended' WHERE session_id = 's'`); err != nil {
		t.Fatal(err)
	}
	if n, err := LiveSubagents(ctx, f.s.DB(), "s", since); err != nil || n != 0 {
		t.Fatalf("live after the end = %d, %v; want 0", n, err)
	}
	done, err = SubagentsDone(ctx, f.s.DB(), "s", since, 5, nil)
	if err != nil || len(done) != 2 || done[0].Lost == "" || done[1].Lost == "" {
		t.Fatalf("done after the end = %+v, %v; want both lost", done, err)
	}
}

// A subagent silent past SubagentQuietMax while its parent sits at its
// prompt has stopped; one in the middle of a long call has not, nor any
// while the parent is in a turn.
func TestQuietSubagentsBehindAnIdleParentReadStopped(t *testing.T) {
	ctx := context.Background()
	f := &weekFixture{t: t, s: openTest(t), loc: time.UTC}
	now := time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)
	since := now.Add(-LiveSubagentWindow).UnixMilli()
	put := func(agent string, kind event.Kind, at time.Time) {
		f.put(event.Event{SessionID: "s", AgentID: agent, Source: event.SourceHook, Kind: kind, Tool: "Bash", Ts: at})
	}
	put("quiet", event.KindToolPre, now.Add(-25*time.Minute))
	put("quiet", event.KindToolPost, now.Add(-24*time.Minute))
	put("long", event.KindToolPre, now.Add(-20*time.Minute)) // a long command, no result yet
	put("busy", event.KindToolPost, now.Add(-time.Minute))
	put("", event.KindTurnUser, now.Add(-26*time.Minute))
	put("", event.KindAgentStop, now.Add(-23*time.Minute))

	n, err := LiveSubagents(ctx, f.s.DB(), "s", since)
	if err != nil || n != 2 {
		t.Fatalf("live = %d, %v; want 2 (long, busy)", n, err)
	}
	done, err := SubagentsDone(ctx, f.s.DB(), "s", since, 5, nil)
	if err != nil || len(done) != 1 || done[0].AgentID != "quiet" || done[0].Lost != SubagentLostQuiet {
		t.Fatalf("done = %+v, %v; want quiet lost as quiet", done, err)
	}

	// The parent in a turn again: nothing is read as quiet.
	put("", event.KindTurnUser, now.Add(-30*time.Second))
	if n, err := LiveSubagents(ctx, f.s.DB(), "s", since); err != nil || n != 3 {
		t.Fatalf("live with the parent in a turn = %d, %v; want 3", n, err)
	}
}

func TestSubagentBoundsLost(t *testing.T) {
	b := SubagentBounds{RestartAt: 100, QuietBefore: 200}
	for _, c := range []struct {
		last    int64
		pending bool
		want    string
	}{{50, false, SubagentLostRestart}, {150, false, SubagentLostQuiet}, {150, true, ""}, {250, false, ""}} {
		if got := b.Lost(c.last, c.pending); got != c.want {
			t.Errorf("Lost(%d, %v) = %q; want %q", c.last, c.pending, got, c.want)
		}
	}
	if got := (SubagentBounds{Ended: true}).Lost(1<<40, true); got != SubagentLostEnded {
		t.Errorf("ended: %q", got)
	}
}
