package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

type turnFixture struct {
	*weekFixture
	at time.Time
}

func newTurnFixture(t *testing.T) *turnFixture {
	return &turnFixture{weekFixture: &weekFixture{t: t, s: openTest(t), loc: time.UTC}, at: time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)}
}

func (f *turnFixture) sess(id, agent, cwd, repoRoot string, owned bool, last time.Time) {
	f.t.Helper()
	f.session(id, agent, cwd)
	o := 0
	if owned {
		o = 1
	}
	if _, err := f.s.DB().Exec(`UPDATE sessions SET repo_root = ?, owned = ?, last_event_at = ? WHERE session_id = ?`, repoRoot, o, last.UnixMilli(), id); err != nil {
		f.t.Fatal(err)
	}
}

// ev records one turn bound at f.at + sec seconds.
func (f *turnFixture) ev(sess string, sec int, kind event.Kind, src event.Source, agentID, prompt string) {
	p := []byte(`{}`)
	if prompt != "" {
		p, _ = json.Marshal(map[string]string{"prompt": prompt})
	}
	f.put(event.Event{SessionID: sess, AgentID: agentID, Source: src, Kind: kind, Ts: f.at.Add(time.Duration(sec) * time.Second), Payload: p})
}

func (f *turnFixture) user(sess string, sec int, prompt string) {
	f.ev(sess, sec, event.KindTurnUser, event.SourceHook, "", prompt)
}
func (f *turnFixture) stop(sess string, sec int) {
	f.ev(sess, sec, event.KindAgentStop, event.SourceHook, "", "")
}

func TestProjectTurnsPairsPromptAndStop(t *testing.T) {
	f := newTurnFixture(t)
	f.sess("a", "claude", "/r/wt", "/r", false, f.at)
	f.sess("b", "claude", "/r", "/r", true, f.at)
	f.sess("other", "claude", "/elsewhere", "", false, f.at)
	f.sess("cx", "codex", "/r", "/r", false, f.at)

	f.user("a", 0, "one")
	f.ev("a", 5, event.KindAgentStop, event.SourceHook, "subagent", "") // a subagent's stop ends nothing
	f.stop("a", 10)                                                     // 10 s
	f.user("a", 20, "interrupted")                                      // Escape: no Stop
	f.user("a", 30, "two")
	f.ev("a", 31, event.KindTurnUser, event.SourceTranscript, "", "the same prompt, read from the transcript")
	f.ev("a", 90, event.KindThrottle, event.SourceHook, "", "") // 60 s, failed
	f.user("b", 100, "three")
	f.stop("b", 130) // 30 s
	f.stop("b", 140) // a Stop with no prompt before it: nothing
	f.user("b", 200, "running")
	f.user("other", 0, "x")
	f.stop("other", 5)
	f.ev("cx", 0, event.KindTurnUser, event.SourceHook, "", "codex")
	f.ev("cx", 9, event.KindAgentStop, event.SourceHook, "", "")

	turns, err := ProjectTurns(context.Background(), f.s.DB(), "/r", f.at.Add(-time.Hour), 0)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, tu := range turns {
		got = append(got, tu.SessionID+":"+tu.Duration().String())
	}
	if strings.Join(got, " ") != "a:10s a:1m0s b:30s" {
		t.Fatalf("turns = %v, want a:10s a:1m0s b:30s (oldest end first, the subagent's, codex's and another project's left out)", got)
	}
	if !turns[1].Failed {
		t.Fatal("a turn ended by StopFailure is not marked failed")
	}

	// The window keeps the newest.
	turns, _ = ProjectTurns(context.Background(), f.s.DB(), "/r", f.at.Add(-time.Hour), 2)
	if len(turns) != 2 || turns[0].SessionID != "a" || turns[1].SessionID != "b" {
		t.Fatalf("limit 2 = %+v", turns)
	}
	// Since cuts by time.
	turns, _ = ProjectTurns(context.Background(), f.s.DB(), "/r", f.at.Add(25*time.Second), 0)
	if len(turns) != 2 {
		t.Fatalf("since +25s = %+v", turns)
	}
}

func TestSessionTurnsOpenTurnAndPrompts(t *testing.T) {
	f := newTurnFixture(t)
	f.sess("b", "claude", "/r", "/r", true, f.at.Add(5*time.Minute))
	f.sess("old", "claude", "/r", "/r", true, f.at.Add(-48*time.Hour))
	f.user("b", 0, "first")
	f.stop("b", 40)
	f.user("b", 100, strings.Repeat("é", 300))

	ids, err := RecentOwnedSessions(context.Background(), f.s.DB(), f.at.Add(-time.Hour))
	if err != nil || len(ids) != 1 || ids[0] != "b" {
		t.Fatalf("recent owned = %v, %v", ids, err)
	}
	done, open, err := SessionTurns(context.Background(), f.s.DB(), ids, f.at, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if len(done) != 1 || done[0].Duration() != 40*time.Second {
		t.Fatalf("done = %+v", done)
	}
	o, ok := open["b"]
	if !ok || o.Start != f.at.Add(100*time.Second).UnixMilli() || o.End != 0 {
		t.Fatalf("open = %+v", open)
	}
	texts, err := PromptTexts(context.Background(), f.s.DB(), []int64{done[0].PromptID, o.PromptID}, 200)
	if err != nil {
		t.Fatal(err)
	}
	if texts[done[0].PromptID] != "first" {
		t.Fatalf("prompt = %q", texts[done[0].PromptID])
	}
	if r := []rune(texts[o.PromptID]); len(r) != 201 || r[200] != '…' {
		t.Fatalf("a long prompt is not clipped to 200 runes: %d", len(r))
	}
	// Turns that ended before since are not "done"; the open one stays.
	done, open, _ = SessionTurns(context.Background(), f.s.DB(), ids, f.at.Add(time.Minute), time.Hour)
	if len(done) != 0 || open["b"].Start == 0 {
		t.Fatalf("since after the first turn: done %+v open %+v", done, open)
	}
	if d, o, err := SessionTurns(context.Background(), f.s.DB(), nil, f.at, time.Hour); err != nil || d != nil || len(o) != 0 {
		t.Fatal("no sessions is not an empty answer")
	}
}

// The query must use the partial index; anything else walks every event.
func TestTurnBoundsUseTheirIndex(t *testing.T) {
	f := newTurnFixture(t)
	q := strings.Replace(turnBoundsSQL, "%s", "?", 1)
	rows, err := f.s.DB().Query(`EXPLAIN QUERY PLAN `+q, 0, "s")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var plan []string
	for rows.Next() {
		var id, parent, notused int
		var detail string
		if err := rows.Scan(&id, &parent, &notused, &detail); err != nil {
			t.Fatal(err)
		}
		plan = append(plan, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	p := strings.Join(plan, " | ")
	if !strings.Contains(p, "COVERING INDEX idx_events_turn_bounds") || strings.Contains(p, "TEMP B-TREE") {
		t.Fatalf("plan = %s", p)
	}
}
