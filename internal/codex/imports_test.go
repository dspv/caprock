package codex

import (
	"context"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	parentFixture   = "../../testdata/codex/rollout-subagent-parent.jsonl"
	childFixture    = "../../testdata/codex/rollout-subagent-child.jsonl"
	importedFixture = "../../testdata/codex/rollout-imported.jsonl"

	parentID   = "01a0b5ac-0000-7931-a042-000000000001"
	childID    = "01a0bff5-0000-7542-b666-000000000002"
	importedID = "01a044ac-0000-7980-903f-000000000003"
)

// A subagent's file names its parent's session id and its own thread id, and
// a copy of the parent's session_meta must not make it read as the parent.
func TestSubagentKeysCarryItsOwnThread(t *testing.T) {
	s, err := ParseFile(childFixture)
	if err != nil {
		t.Fatal(err)
	}
	if !s.Subagent || s.ID != parentID || s.ThreadID != childID {
		t.Fatalf("subagent=%v id=%q thread=%q", s.Subagent, s.ID, s.ThreadID)
	}
	if len(s.Turns) != 2 || len(s.Tools) != 1 {
		t.Fatalf("%d turns, %d tools; want 2 and 1", len(s.Turns), len(s.Tools))
	}
	for _, k := range []string{s.Turns[0].Key, s.Turns[1].Key, s.Tools[0].Key} {
		if !strings.HasPrefix(k, "codex:sub:"+childID+":") {
			t.Errorf("subagent key %q does not carry its thread", k)
		}
	}
	// A session a person started keeps the key every stored row already has.
	p, err := ParseFile(parentFixture)
	if err != nil {
		t.Fatal(err)
	}
	if p.Subagent || p.ThreadID != parentID || p.Turns[0].Key != "codex:turn:4" {
		t.Fatalf("parent: subagent=%v thread=%q key=%q", p.Subagent, p.ThreadID, p.Turns[0].Key)
	}
}

// The parent's and the subagent's records sit on the same line numbers. Both
// must be stored whichever file is read first, the subagent's under the
// parent's session and marked as a sidechain, as a Claude Code subagent's are.
func TestSubagentTurnsSurviveBesideTheParents(t *testing.T) {
	for _, order := range [][2]string{{"a", "b"}, {"b", "a"}} {
		h := newHarness(t)
		h.putFile(parentFixture, "rollout-"+order[0]+"-parent.jsonl")
		h.putFile(childFixture, "rollout-"+order[1]+"-child.jsonl")
		h.poll()
		if n := count(t, h.out, `SELECT COUNT(*) FROM sessions WHERE agent='codex'`); n != 1 {
			t.Errorf("%v: %d sessions, want the parent's only", order, n)
		}
		if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='codex' AND kind='turn.assistant'`); n != 4 {
			t.Errorf("%v: %d turns, want 2 of the parent's and 2 of the subagent's", order, n)
		}
		if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='codex' AND kind='tool.pre'`); n != 3 {
			t.Errorf("%v: %d tool calls, want 3", order, n)
		}
		if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE agent_id = '`+childID+`'
			AND json_extract(payload,'$.sidechain') = 1 AND session_id = '`+parentID+`'`); n != 3 {
			t.Errorf("%v: %d subagent events marked as its sidechain, want 3", order, n)
		}
		h.assertRollupsMatchEvents()
	}
}

// A thread Codex imported from Claude Code is that session replayed, token
// reports included. It is not Codex's work and nothing of it is stored.
func TestImportedThreadIsNotCounted(t *testing.T) {
	h := newHarness(t)
	h.putFile(importedFixture, "rollout-imported.jsonl")
	h.poll()
	if n := count(t, h.out, `SELECT COUNT(*) FROM events`); n != 0 {
		t.Errorf("%d events stored from an imported thread", n)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM sessions`); n != 0 {
		t.Errorf("%d sessions created for an imported thread", n)
	}
	// A restart trusts it as read even though it stored no events, rather
	// than parsing it again on every start.
	h.in.saveSeen(context.Background())
	again := NewIngester(h.in.dirs, h.in.rec, slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError})), time.Second)
	again.restoreSeen(context.Background())
	if len(again.seen) != 1 {
		t.Fatalf("an imported thread was not remembered as read: %d files", len(again.seen))
	}
}

// What earlier versions stored is repaired from the transcripts once: the
// imported thread's turns and session go, with the totals they were added to,
// and the subagent's rows move off the parent's line-number keys, letting the
// parent's own turns that they blocked come back. The result is exactly what
// a fresh import of the same files stores.
func TestRepairUndoesWhatEarlierVersionsStored(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t)
	paths := []string{
		h.putFileAt(childFixture, "rollout-a-child.jsonl"),
		h.putFileAt(parentFixture, "rollout-b-parent.jsonl"),
		h.putFileAt(importedFixture, "rollout-c-imported.jsonl"),
	}
	// The old importer, file by file in the order it listed them: the
	// subagent first, under its parent's session and line-number keys, so it
	// took the parent's lines 4, 5 and 6; then the parent; then the import.
	for _, p := range paths {
		s, err := ParseFile(p)
		if err != nil {
			t.Fatal(err)
		}
		old := *s
		old.Subagent, old.Imported = false, false
		old.Turns = append([]Turn(nil), s.Turns...)
		old.Tools = append([]ToolCall(nil), s.Tools...)
		for i := range old.Turns {
			old.Turns[i].Key = LegacyKey(old.Turns[i].Line, "turn")
		}
		for i := range old.Tools {
			old.Tools[i].Key = LegacyKey(old.Tools[i].Line, "tool")
		}
		if err := h.in.session(ctx, &old); err != nil {
			t.Fatal(err)
		}
		st, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		h.in.seen[p] = fileState{mod: st.ModTime(), size: st.Size(), session: s.ID}
	}
	h.in.loaded = true
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE session_id='`+parentID+`' AND kind='turn.assistant'`); n != 2 {
		t.Fatalf("setup: %d turns in the parent, want 2 (the subagent's, the parent's lost)", n)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE session_id='`+importedID+`'`); n != 2 {
		t.Fatalf("setup: %d imported turns, want 2", n)
	}

	h.poll() // files unchanged: only the one-time repair has work to do

	if n := count(t, h.out, `SELECT COUNT(*) FROM sessions WHERE session_id='`+importedID+`'`); n != 0 {
		t.Error("the imported thread's session is still there")
	}
	for _, q := range []string{
		`SELECT COUNT(*) FROM events WHERE session_id='` + importedID + `'`,
		`SELECT COUNT(*) FROM session_stats WHERE session_id='` + importedID + `'`,
		`SELECT COUNT(*) FROM daily_sessions WHERE session_id='` + importedID + `'`,
		`SELECT COALESCE(SUM(tokens_total),0) FROM daily_stats WHERE day < '2026-09-01'`,
		`SELECT COALESCE(SUM(sessions),0) FROM daily_stats WHERE day < '2026-09-01'`,
	} {
		if n := count(t, h.out, q); n != 0 {
			t.Errorf("%s = %d after the repair, want 0", q, n)
		}
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE session_id='`+parentID+`' AND kind='turn.assistant'`); n != 4 {
		t.Errorf("%d turns in the parent after the repair, want 4", n)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE session_id='`+parentID+`' AND kind='tool.pre'`); n != 3 {
		t.Errorf("%d tool calls in the parent after the repair, want 3", n)
	}
	h.assertRollupsMatchEvents()

	// Byte for byte what a fresh import of the same files stores.
	fresh := newHarness(t)
	fresh.putFile(parentFixture, "rollout-parent.jsonl")
	fresh.putFile(childFixture, "rollout-child.jsonl")
	fresh.putFile(importedFixture, "rollout-imported.jsonl")
	fresh.poll()
	for _, q := range []string{
		`SELECT turns || '/' || tool_calls || '/' || tokens_in || '/' || tokens_out || '/' || cache_read || '/' || printf('%.9f', cost_usd) FROM session_stats WHERE session_id='` + parentID + `'`,
		`SELECT group_concat(day || ':' || tokens_total || ':' || printf('%.9f', cost_usd) || ':' || sessions, ',') FROM (SELECT * FROM daily_stats WHERE tokens_total != 0 OR sessions != 0 ORDER BY day, project, model)`,
		`SELECT group_concat(key, ',') FROM (SELECT key FROM events WHERE source='codex' ORDER BY key)`,
	} {
		var got, want string
		if err := h.out.QueryRow(q).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if err := fresh.out.QueryRow(q).Scan(&want); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Errorf("repaired %q, fresh import %q (%s)", got, want, q)
		}
	}

	// Once: a second start does not run it again.
	if done, _ := h.in.rec.Store.GetMeta(ctx, "codex_split_repaired"); done != "1" {
		t.Error("the repair did not record that it ran")
	}
}

// putFileAt is putFile, returning the path it wrote.
func (h *harness) putFileAt(src, name string) string {
	h.putFile(src, name)
	return filepath.Join(h.dir, "2026", "09", "15", name)
}

// assertRollupsMatchEvents checks that session_stats and daily_stats add up to
// the events they were built from — what every screen relies on.
func (h *harness) assertRollupsMatchEvents() {
	h.t.Helper()
	var evTokens, dayTokens int64
	var evCost, dayCost, sessCost float64
	var evTurns, sessTurns, evTools, sessTools int64
	if err := h.out.QueryRow(`SELECT COUNT(*), COALESCE(SUM(tokens_in+tokens_out+cache_read+cache_write),0), COALESCE(SUM(cost_usd),0)
		FROM events WHERE kind='turn.assistant' AND internal=0`).Scan(&evTurns, &evTokens, &evCost); err != nil {
		h.t.Fatal(err)
	}
	if err := h.out.QueryRow(`SELECT COUNT(*) FROM events WHERE kind='tool.pre' AND internal=0`).Scan(&evTools); err != nil {
		h.t.Fatal(err)
	}
	if err := h.out.QueryRow(`SELECT COALESCE(SUM(turns),0), COALESCE(SUM(tool_calls),0), COALESCE(SUM(cost_usd),0) FROM session_stats`).Scan(&sessTurns, &sessTools, &sessCost); err != nil {
		h.t.Fatal(err)
	}
	if err := h.out.QueryRow(`SELECT COALESCE(SUM(tokens_total),0), COALESCE(SUM(cost_usd),0) FROM daily_stats`).Scan(&dayTokens, &dayCost); err != nil {
		h.t.Fatal(err)
	}
	if evTurns != sessTurns || evTools != sessTools || evTokens != dayTokens ||
		math.Abs(evCost-sessCost) > 1e-9 || math.Abs(evCost-dayCost) > 1e-9 {
		h.t.Fatalf("rollups disagree with events: turns %d/%d tools %d/%d tokens %d/%d cost %.6f/%.6f/%.6f",
			evTurns, sessTurns, evTools, sessTools, evTokens, dayTokens, evCost, sessCost, dayCost)
	}
}
