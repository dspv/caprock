package store

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// The agent filter touches five aggregate queries that produce money figures,
// which is the part of this codebase where a mistake is worst: a wrong total
// looks like a real total. These tests pin the arithmetic rather than the
// wiring — that the parts sum to the whole, that neither agent's spend leaks
// into the other's heading, and that an unfiltered summary is unchanged.

func filterStore(t *testing.T) *Store {
	t.Helper()
	lg := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	st, err := Open(context.Background(), filepath.Join(t.TempDir(), "c.db"), lg)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// seed writes one assistant turn and one tool call for a session, tagged with
// an agent, so a summary over it has something to add up.
func seed(t *testing.T, st *Store, id, agent, project string, ts int64, cost float64, tokens int64) {
	t.Helper()
	ctx := context.Background()
	err := st.WithTx(ctx, func(q Querier) error {
		if err := UpsertSession(ctx, q, id, SessionPatch{
			Cwd: "/home/dev/" + project, Project: project, Model: "m",
			StartedAt: ts, LastEventAt: ts, Agent: agent,
		}); err != nil {
			return err
		}
		c := cost
		if _, err := InsertEvent(ctx, q, &event.Event{
			Ts: time.UnixMilli(ts), SessionID: id, Source: event.SourceTranscript,
			Kind: event.KindTurnAssistant, Model: "m", Key: "turn:" + id,
			Tokens: &event.TokenDelta{In: tokens, Out: tokens / 10}, CostUSD: &c,
		}); err != nil {
			return err
		}
		_, err := InsertEvent(ctx, q, &event.Event{
			Ts: time.UnixMilli(ts), SessionID: id, Source: event.SourceTranscript,
			Kind: event.KindToolPre, Tool: "Bash", Key: "tool:" + id,
		})
		return err
	})
	if err != nil {
		t.Fatalf("seed %s: %v", id, err)
	}
}

// seedModel is seed with a named model, for the model-breakdown test.
func seedModel(t *testing.T, st *Store, id, agent, project, model string, ts int64, cost float64) {
	t.Helper()
	ctx := context.Background()
	err := st.WithTx(ctx, func(q Querier) error {
		if err := UpsertSession(ctx, q, id, SessionPatch{
			Cwd: "/home/dev/" + project, Project: project, Model: model,
			StartedAt: ts, LastEventAt: ts, Agent: agent,
		}); err != nil {
			return err
		}
		c := cost
		_, err := InsertEvent(ctx, q, &event.Event{
			Ts: time.UnixMilli(ts), SessionID: id, Source: event.SourceTranscript,
			Kind: event.KindTurnAssistant, Model: model, Key: "turn:" + id,
			Tokens: &event.TokenDelta{In: 100, Out: 10}, CostUSD: &c,
		})
		return err
	})
	if err != nil {
		t.Fatalf("seed %s: %v", id, err)
	}
}

// bothAgents is the fixture every test below shares: two Claude sessions and
// one OpenCode session, with distinct costs so a leak between them is visible
// in the totals rather than hidden by equal numbers.
func bothAgents(t *testing.T, st *Store) (claudeCost, openCost float64) {
	t.Helper()
	now := time.Now().UnixMilli()
	seed(t, st, "cc-1", "claude", "api", now-60_000, 3.00, 1000)
	seed(t, st, "cc-2", "claude", "web", now-50_000, 1.50, 500)
	seed(t, st, "oc-1", "opencode", "mobile", now-40_000, 7.25, 2000)
	return 4.50, 7.25
}

func summaryFor(t *testing.T, st *Store, agent AgentFilter) Summary {
	t.Helper()
	s, err := SummarizeSparkFor(context.Background(), st.DB(), 0, SparkSpec{}, agent)
	if err != nil {
		t.Fatalf("summarize %q: %v", agent, err)
	}
	return s
}

func TestFilterSplitsCostExactly(t *testing.T) {
	st := filterStore(t)
	claudeCost, openCost := bothAgents(t, st)

	all := summaryFor(t, st, "")
	cc := summaryFor(t, st, "claude")
	oc := summaryFor(t, st, "opencode")

	if got := round(all.CostUSD); got != round(claudeCost+openCost) {
		t.Errorf("unfiltered cost = %v, want %v", got, claudeCost+openCost)
	}
	if got := round(cc.CostUSD); got != round(claudeCost) {
		t.Errorf("claude cost = %v, want %v", got, claudeCost)
	}
	if got := round(oc.CostUSD); got != round(openCost) {
		t.Errorf("opencode cost = %v, want %v", got, openCost)
	}
	// The property that matters: the parts add up to the whole. A filter that
	// drops or double-counts a row fails here even when each half looks
	// plausible on its own.
	if round(cc.CostUSD+oc.CostUSD) != round(all.CostUSD) {
		t.Errorf("parts %v + %v do not sum to %v", cc.CostUSD, oc.CostUSD, all.CostUSD)
	}
}

func TestFilterSplitsSessionsAndTurns(t *testing.T) {
	st := filterStore(t)
	bothAgents(t, st)

	all := summaryFor(t, st, "")
	cc := summaryFor(t, st, "claude")
	oc := summaryFor(t, st, "opencode")

	if all.Sessions != 3 || cc.Sessions != 2 || oc.Sessions != 1 {
		t.Errorf("sessions: all=%d claude=%d opencode=%d, want 3/2/1",
			all.Sessions, cc.Sessions, oc.Sessions)
	}
	if cc.Sessions+oc.Sessions != all.Sessions {
		t.Error("session counts do not partition")
	}
	if cc.Turns+oc.Turns != all.Turns {
		t.Errorf("turns %d + %d do not sum to %d", cc.Turns, oc.Turns, all.Turns)
	}
	if cc.ToolCalls+oc.ToolCalls != all.ToolCalls {
		t.Errorf("tool calls %d + %d do not sum to %d", cc.ToolCalls, oc.ToolCalls, all.ToolCalls)
	}
}

func TestFilterSplitsTokens(t *testing.T) {
	st := filterStore(t)
	bothAgents(t, st)

	all := summaryFor(t, st, "")
	cc := summaryFor(t, st, "claude")
	oc := summaryFor(t, st, "opencode")

	if cc.TokensIn+oc.TokensIn != all.TokensIn {
		t.Errorf("tokens in %d + %d ≠ %d", cc.TokensIn, oc.TokensIn, all.TokensIn)
	}
	if cc.TokensOut+oc.TokensOut != all.TokensOut {
		t.Errorf("tokens out %d + %d ≠ %d", cc.TokensOut, oc.TokensOut, all.TokensOut)
	}
	if oc.TokensIn != 2000 {
		t.Errorf("opencode tokens in = %d, want 2000", oc.TokensIn)
	}
}

func TestFilterSplitsModels(t *testing.T) {
	// The model breakdown is its own query, and a filter forgotten there shows
	// one agent's models under the other's heading — the Cost screen's "model
	// mix" would list models the filtered agent never ran.
	st := filterStore(t)
	now := time.Now().UnixMilli()
	seedModel(t, st, "cc-1", "claude", "api", "claude-opus-5", now-60_000, 3.00)
	seedModel(t, st, "oc-1", "opencode", "mobile", "deepseek-v4-pro", now-40_000, 7.25)

	cc := summaryFor(t, st, "claude")
	oc := summaryFor(t, st, "opencode")

	names := func(s Summary) []string {
		out := make([]string, 0, len(s.Models))
		for _, m := range s.Models {
			out = append(out, m.Model)
		}
		return out
	}
	if got := names(cc); len(got) != 1 || got[0] != "claude-opus-5" {
		t.Errorf("claude models = %v, want [claude-opus-5]", got)
	}
	if got := names(oc); len(got) != 1 || got[0] != "deepseek-v4-pro" {
		t.Errorf("opencode models = %v, want [deepseek-v4-pro]", got)
	}
	// And the money attached to each model stays with its agent.
	for _, m := range oc.Models {
		if round(m.CostUSD) != 7.25 {
			t.Errorf("opencode model %s carries %v, want 7.25", m.Model, m.CostUSD)
		}
	}
}

func TestFilterSplitsProjects(t *testing.T) {
	st := filterStore(t)
	bothAgents(t, st)

	cc := summaryFor(t, st, "claude")
	oc := summaryFor(t, st, "opencode")

	names := func(s Summary) []string {
		out := make([]string, 0, len(s.Projects))
		for _, p := range s.Projects {
			out = append(out, p.Project)
		}
		return out
	}
	ccNames, ocNames := names(cc), names(oc)
	if len(ccNames) != 2 {
		t.Errorf("claude projects = %v, want two", ccNames)
	}
	if len(ocNames) != 1 || ocNames[0] != "mobile" {
		t.Errorf("opencode projects = %v, want [mobile]", ocNames)
	}
	// A project belonging to one agent must never appear under the other.
	for _, n := range ocNames {
		for _, c := range ccNames {
			if n == c {
				t.Errorf("project %q appears under both agents", n)
			}
		}
	}
}

func TestFilterTagsProjectsByAgent(t *testing.T) {
	st := filterStore(t)
	bothAgents(t, st)

	all := summaryFor(t, st, "")
	byName := map[string]string{}
	for _, p := range all.Projects {
		byName[p.Project] = p.Agent
	}
	if byName["mobile"] != "opencode" {
		t.Errorf("mobile tagged %q, want opencode", byName["mobile"])
	}
	if byName["api"] != "claude" {
		t.Errorf("api tagged %q, want claude", byName["api"])
	}
}

func TestProjectWorkedOnByBothCarriesNoAgent(t *testing.T) {
	// Claiming either agent would be wrong, and claiming one silently is the
	// kind of small lie that makes a whole dashboard untrustworthy.
	st := filterStore(t)
	now := time.Now().UnixMilli()
	seed(t, st, "s-cc", "claude", "shared", now-60_000, 1.00, 100)
	seed(t, st, "s-oc", "opencode", "shared", now-50_000, 2.00, 200)

	all := summaryFor(t, st, "")
	var found bool
	for _, p := range all.Projects {
		if p.Project == "shared" {
			found = true
			if p.Agent != "" {
				t.Errorf("a project worked on by both is tagged %q", p.Agent)
			}
		}
	}
	if !found {
		t.Fatal("the shared project is missing from the summary")
	}

	// And it belongs in either filter rather than in neither: its cost is
	// partly each agent's, so hiding it from both would lose money from the
	// screen entirely.
	for _, a := range []AgentFilter{"claude", "opencode"} {
		s := summaryFor(t, st, a)
		if len(s.Projects) == 0 {
			t.Errorf("filter %q dropped the shared project", a)
		}
	}
}

func TestUnfilteredSummaryIsUnchanged(t *testing.T) {
	// The old entry point must behave exactly as it did: every existing screen
	// calls it, and this change is meant to add an option, not alter a default.
	st := filterStore(t)
	bothAgents(t, st)

	old, err := SummarizeSpark(context.Background(), st.DB(), 0, SparkSpec{})
	if err != nil {
		t.Fatalf("SummarizeSpark: %v", err)
	}
	explicit := summaryFor(t, st, "")
	if round(old.CostUSD) != round(explicit.CostUSD) || old.Sessions != explicit.Sessions {
		t.Errorf("SummarizeSpark and an empty filter disagree: %v/%d vs %v/%d",
			old.CostUSD, old.Sessions, explicit.CostUSD, explicit.Sessions)
	}
}

func TestFilterOnAgentWithNoSessions(t *testing.T) {
	// A Claude-Code-only machine asking for OpenCode gets zeros, not an error
	// and not everything.
	st := filterStore(t)
	now := time.Now().UnixMilli()
	seed(t, st, "cc-only", "claude", "api", now-60_000, 5.00, 1000)

	oc := summaryFor(t, st, "opencode")
	if oc.CostUSD != 0 || oc.Sessions != 0 || len(oc.Projects) != 0 {
		t.Errorf("empty filter returned cost=%v sessions=%d projects=%d",
			oc.CostUSD, oc.Sessions, len(oc.Projects))
	}
}

func TestPreExistingSessionsCountAsClaude(t *testing.T) {
	// Every row that predates the agent column was written by Claude Code, and
	// migration 0015 gives them all 'claude' — the column is NOT NULL with that
	// default, so a NULL cannot exist and this is the shape an upgraded
	// database actually has. On such a machine the entire history is claude,
	// and it must all survive the claude filter.
	st := filterStore(t)
	now := time.Now().UnixMilli()
	seed(t, st, "legacy", "", "old", now-60_000, 2.00, 400)

	var stored string
	if err := st.DB().QueryRowContext(context.Background(),
		`SELECT agent FROM sessions WHERE session_id = 'legacy'`).Scan(&stored); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if stored != "claude" {
		t.Fatalf("an unspecified agent stored as %q, want claude", stored)
	}

	cc := summaryFor(t, st, "claude")
	if round(cc.CostUSD) != 2.00 {
		t.Errorf("a session with no explicit agent is missing from the claude filter: cost %v", cc.CostUSD)
	}
	oc := summaryFor(t, st, "opencode")
	if oc.CostUSD != 0 {
		t.Errorf("it also appears under opencode: cost %v", oc.CostUSD)
	}
}

func round(f float64) float64 { return float64(int(f*100+0.5)) / 100 }
