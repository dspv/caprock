package api

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// TestSummaryCacheMatchesFresh is F14's correctness check: every summary the
// sessions list builds through the per-session cache is identical, field by
// field, to one built with nothing cached, across every kind of change to a
// session's events: hook and transcript inserts (one older than the newest),
// a subagent burst that pushes the main thread out of the window, an in-place
// rewrite, /clear (a new session in the same process), the session ending, a
// rename, deleted events and retention.
func TestSummaryCacheMatchesFresh(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	dir := t.TempDir()
	e.seed(t, dir)
	db := e.st.DB()

	// fresh shares every dependency and has an empty cache of its own on
	// every call, so it reads everything.
	fresh := func(sess store.Session) (SessionSummary, []event.Event) {
		t.Helper()
		f := &Server{d: e.api.d}
		sum, last, err := f.summarize(ctx, sess)
		if err != nil {
			t.Fatal(err)
		}
		return sum, last
	}
	check := func(step string) {
		t.Helper()
		sessions, err := store.ListSessionsQuery(ctx, db, store.SessionQuery{}, 0)
		if err != nil {
			t.Fatal(err)
		}
		if len(sessions) == 0 {
			t.Fatalf("%s: no sessions", step)
		}
		for _, sess := range sessions {
			// Twice through the cache: the first may fill it, the second
			// must be served from it and still agree.
			for range 2 {
				got, gotLast, err := e.api.summarize(ctx, sess)
				if err != nil {
					t.Fatal(err)
				}
				want, wantLast := fresh(sess)
				gj, _ := json.Marshal(got)
				wj, _ := json.Marshal(want)
				if string(gj) != string(wj) {
					t.Fatalf("%s: %s cached summary differs\n got %s\nwant %s", step, sess.SessionID, gj, wj)
				}
				if !reflect.DeepEqual(gotLast, wantLast) {
					t.Fatalf("%s: %s cached events differ", step, sess.SessionID)
				}
			}
		}
	}
	record := func(ev *event.Event) {
		t.Helper()
		if _, err := e.rec.Record(ctx, ev, rollup.SessionInfo{Cwd: dir}); err != nil {
			t.Fatal(err)
		}
	}
	activity := func(id string) string {
		t.Helper()
		sess, err := store.GetSession(ctx, db, id)
		if err != nil {
			t.Fatal(err)
		}
		sum, _, err := e.api.summarize(ctx, sess)
		if err != nil {
			t.Fatal(err)
		}
		return sum.Activity.Phrase + "|" + sum.Activity.Health
	}

	check("seeded")
	before := activity("s1")

	// A hook insert changes what the session is doing.
	record(&event.Event{SessionID: "s1", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Bash", Key: "pre:t2",
		Ts: e.now.Add(3 * time.Second), Payload: json.RawMessage(`{"tool_name":"Bash","tool_input":{"command":"go test ./..."}}`)})
	check("hook insert")
	if activity("s1") == before {
		t.Fatalf("the cached summary did not see the insert: %q", before)
	}

	// A transcript line older than the newest event already stored.
	record(&event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: "msg:m2",
		Ts: e.now.Add(2500 * time.Millisecond), Model: "claude-opus-5",
		Tokens: &event.TokenDelta{In: 10, Out: 20, CacheRead: 90000, CacheWrite: 10}, Payload: json.RawMessage(`{"text":"older line"}`)})
	check("out-of-order transcript insert")

	// Subagents fill the whole window, so the main thread's newest event and
	// turn are read beyond it.
	for i := range 70 {
		record(&event.Event{SessionID: "s1", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Read", AgentID: "a1",
			Key: fmt.Sprintf("sub:%d", i), Ts: e.now.Add(time.Duration(4+i) * time.Second),
			Payload: json.RawMessage(`{"tool_name":"Read","tool_input":{"file_path":"x.go"}}`)})
	}
	check("subagent burst")

	// An in-place rewrite, as Codex ingest and the repairs do.
	if _, err := db.ExecContext(ctx, `UPDATE events SET payload = json_set(payload, '$.text', 'rewritten') WHERE sid = (SELECT sid FROM sessions WHERE session_id = 's1') AND kind = 'turn.assistant'`); err != nil {
		t.Fatal(err)
	}
	check("payload rewrite")

	// /clear: a new session in the same process; then the old one ends.
	record(&event.Event{SessionID: "s2", Source: event.SourceHook, Kind: event.KindTurnUser, Key: "prompt:p2",
		Ts: e.now.Add(80 * time.Second), Payload: json.RawMessage(`{"prompt":"start again with the parser"}`)})
	check("clear")
	if err := store.SetSessionStatus(ctx, db, "s1", store.StatusEnded); err != nil {
		t.Fatal(err)
	}
	check("ended")

	// A name decides the description over the cached prompts.
	if _, err := db.ExecContext(ctx, `UPDATE sessions SET name = 'renamed' WHERE session_id = 's2'`); err != nil {
		t.Fatal(err)
	}
	check("renamed")

	// Deleting the newest events brings older ones back into the window.
	if _, err := db.ExecContext(ctx, `DELETE FROM events WHERE id IN (SELECT id FROM events JOIN sessions USING (sid) WHERE session_id = 's1' ORDER BY ts DESC, id DESC LIMIT 30)`); err != nil {
		t.Fatal(err)
	}
	check("deleted newest")

	// Retention drops the oldest.
	if _, err := store.PruneEventsBefore(ctx, db, e.now.Add(10*time.Second).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	check("retention")
}

// TestSummaryCacheEntries covers the cache's own rules: a newer generation
// replaces an entry, an older one is answered without being kept, and the
// number of sessions kept is bounded, least recently used first.
func TestSummaryCacheEntries(t *testing.T) {
	var c recentCache
	g1, g2 := store.EventsGen{MaxID: 5}, store.EventsGen{Gen: 1, MaxID: 3}
	a := c.entry("a", g1)
	if c.entry("a", g1) != a {
		t.Fatal("same generation should share the entry")
	}
	b := c.entry("a", g2)
	if b == a {
		t.Fatal("a newer generation should replace the entry")
	}
	if old := c.entry("a", g1); old == b || c.entry("a", g2) != b {
		t.Fatal("an older generation must not replace a newer entry")
	}
	for i := range recentCacheMax + 10 {
		c.entry(fmt.Sprint("s", i), g1)
		c.entry("a", g2) // kept in use
	}
	if n := c.size(); n != recentCacheMax {
		t.Fatalf("size %d, want %d", n, recentCacheMax)
	}
	if c.entry("a", g2) != b {
		t.Fatal("the entry in use was evicted")
	}
}
