package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// The prose search walks idx_events_prose and tests a turn's text there, and
// the prompt lookup runs either over the span a full page of text matches
// leaves or only inside sessions with a matching prompt. Through
// idx_events_kind_id it opened every assistant turn's payload: 9.5 s a search
// on a copy of the owner's database (migration 0085).
func TestSearchNotesReadsTheProseIndex(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	for _, tc := range []struct {
		name   string
		query  string
		before int64
		stmts  int
	}{
		{"latest", "", 0, 1},
		{"older page", "", 100, 1},
		{"search", "sso", 0, 2},
		{"search, older page", "sso", 100, 2},
		{"search, not ASCII", "café", 0, 2},
	} {
		rec := &planRecorder{Querier: s.db}
		if _, err := SearchNotes(ctx, rec, tc.query, 50, tc.before); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if len(rec.seen) != tc.stmts {
			t.Fatalf("%s: expected %d statements, saw %d", tc.name, tc.stmts, len(rec.seen))
		}
		for i, r := range rec.seen {
			plan := explainPlan(t, s, r)
			if !strings.Contains(plan, "SEARCH e USING INDEX idx_events_prose (id<?)") {
				t.Fatalf("%s: the reply scan must seek idx_events_prose; plan: %s", tc.name, plan)
			}
			if strings.Contains(plan, "SEARCH e USING INDEX idx_events_kind_id") {
				t.Fatalf("%s: the reply scan walked every assistant turn by kind; plan: %s", tc.name, plan)
			}
			// An empty database fills no page, so the prompt step is the
			// one over all of history: it must read the matching sessions
			// once, not look up a prompt for every reply.
			if i == 1 && !strings.Contains(plan, "LIST SUBQUERY") {
				t.Fatalf("%s: the sessions with a matching prompt must be read once, not per reply; plan: %s", tc.name, plan)
			}
		}
	}
}

// A page is the newest replies matched by their text or by their prompt,
// together: when the text alone fills a page, a reply found by its prompt
// that is newer than the page's oldest still takes its place, and one older
// does not.
func TestSearchNotesMergesTextAndPromptMatches(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	at := int64(1000)
	add := func(kind event.Kind, field, text string) {
		t.Helper()
		at++
		payload, _ := json.Marshal(map[string]any{field: text})
		ev := &event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: kind,
			Ts: time.UnixMilli(at), Key: fmt.Sprintf("k%d", at), Payload: payload}
		if _, err := InsertEvent(ctx, s.db, ev); err != nil {
			t.Fatal(err)
		}
	}
	add(event.KindTurnUser, "prompt", "look at the gizmo")
	add(event.KindTurnAssistant, "text", "an old reply to the question") // by prompt, oldest
	add(event.KindTurnUser, "prompt", "next")
	add(event.KindTurnAssistant, "text", "gizmo one")
	add(event.KindTurnAssistant, "text", "gizmo two")
	add(event.KindTurnUser, "prompt", "and the gizmo again?")
	add(event.KindTurnAssistant, "text", "a newer reply to it") // by prompt, newest
	add(event.KindTurnAssistant, "text", "gizmo three")

	got, err := SearchNotes(ctx, s.db, "gizmo", 3, 0)
	if err != nil {
		t.Fatal(err)
	}
	var texts []string
	for _, n := range got {
		texts = append(texts, n.Text)
	}
	want := []string{"gizmo three", "a newer reply to it", "gizmo two"}
	if strings.Join(texts, " | ") != strings.Join(want, " | ") {
		t.Fatalf("page %q, want %q", texts, want)
	}
	// The next page goes on from the oldest shown, and reaches the old
	// reply found by its prompt.
	got, err = SearchNotes(ctx, s.db, "gizmo", 3, got[len(got)-1].EventID)
	if err != nil {
		t.Fatal(err)
	}
	texts = texts[:0]
	for _, n := range got {
		texts = append(texts, n.Text)
	}
	want = []string{"gizmo one", "an old reply to the question"}
	if strings.Join(texts, " | ") != strings.Join(want, " | ") {
		t.Fatalf("second page %q, want %q", texts, want)
	}
}

// A search holding a character the stored JSON may escape finds the prompt
// by its text read out of the JSON, never by the stored form: `"` is stored
// as `\"`, and a non-ASCII letter may be stored as `é`.
func TestSearchNotesFindsAPromptThatJSONEscapes(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	at := int64(1000)
	add := func(kind event.Kind, payload string) {
		t.Helper()
		at++
		ev := &event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: kind,
			Ts: time.UnixMilli(at), Key: fmt.Sprintf("k%d", at), Payload: json.RawMessage(payload)}
		if _, err := InsertEvent(ctx, s.db, ev); err != nil {
			t.Fatal(err)
		}
	}
	add(event.KindTurnUser, `{"prompt":"why does \"résumé\" break the parser?"}`)
	add(event.KindTurnAssistant, `{"text":"The accent is read as two bytes."}`)
	add(event.KindTurnUser, `{"prompt":"and café <b>&</b>?"}`)
	add(event.KindTurnAssistant, `{"text":"The same."}`)
	for _, q := range []string{`"résumé"`, `café`, `<b>&</b>`} {
		got, err := SearchNotes(ctx, s.db, q, 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 1 {
			t.Fatalf("search %q found %d replies, want 1", q, len(got))
		}
	}
}

func explainPlan(t *testing.T, s *Store, r recorded) string {
	t.Helper()
	rows, err := s.db.QueryContext(context.Background(), "EXPLAIN QUERY PLAN "+r.sql, r.args...)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
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
	return strings.Join(plan, " | ")
}

// An index expression that raised an error would fail the INSERT, and an
// event must never be lost to an index: a turn whose payload is not JSON is
// stored, and the search skips it rather than failing.
func TestProseIndexNeverRefusesAnEvent(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	add := func(key, payload string) {
		t.Helper()
		ev := &event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
			Ts: time.UnixMilli(1000), Key: key, Payload: json.RawMessage(payload)}
		if _, err := InsertEvent(ctx, s.db, ev); err != nil {
			t.Fatalf("insert %s: %v", key, err)
		}
	}
	add("a1", `{"text":"the sso header resolves late"}`)
	add("a2", `{"text":"the sso`) // cut off mid-write
	var sid int64
	if err := s.db.QueryRowContext(ctx, `SELECT sid FROM sessions WHERE session_id = 's1'`).Scan(&sid); err != nil {
		t.Fatal(err)
	}
	// Raw, as an older build or a damaged file may have left it.
	if _, err := s.db.ExecContext(ctx, `INSERT INTO events(ts, sid, source, kind, payload) VALUES (2000, ?, 'transcript', 'turn.assistant', 'not json')`, sid); err != nil {
		t.Fatalf("a malformed turn was refused: %v", err)
	}
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM events WHERE kind = 'turn.assistant'`).Scan(&n); err != nil || n != 3 {
		t.Fatalf("stored %d assistant turns (err %v), want 3", n, err)
	}
	got, err := SearchNotes(ctx, s.db, "sso", 0, 0)
	if err != nil {
		t.Fatalf("a malformed turn failed the search: %v", err)
	}
	if len(got) != 1 || !strings.Contains(got[0].Text, "resolves late") {
		t.Fatalf("got %+v, want the one well-formed turn", got)
	}
}

// The prompt lookup runs only in sessions with a matching prompt, and that
// narrowing must never lose a reply: a reply found by its prompt in one
// session is found beside a session whose prompts never match, and a reply in
// a session whose only matching prompt is outside the reply's window is not.
func TestSearchNotesPromptMatchAcrossSessions(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	at := int64(1000)
	add := func(sess string, kind event.Kind, field, text string) {
		t.Helper()
		at++
		payload, _ := json.Marshal(map[string]any{field: text})
		ev := &event.Event{SessionID: sess, Source: event.SourceTranscript, Kind: kind,
			Ts: time.UnixMilli(at), Key: fmt.Sprintf("%s-%d", sess, at), Payload: payload}
		if _, err := InsertEvent(ctx, s.db, ev); err != nil {
			t.Fatal(err)
		}
	}
	add("hit", event.KindTurnUser, "prompt", "why is the BigQuery export late?")
	add("hit", event.KindTurnAssistant, "text", "The scheduler runs after the window closes.")
	add("miss", event.KindTurnUser, "prompt", "run the tests")
	add("miss", event.KindTurnAssistant, "text", "All green.")
	// A matching prompt, then more than the window of events, then a reply.
	add("far", event.KindTurnUser, "prompt", "BigQuery again")
	for i := 0; i < promptLookback+5; i++ {
		add("far", event.KindToolPre, "tool_name", "Read")
	}
	add("far", event.KindTurnAssistant, "text", "Done with the refactor.")

	got, err := SearchNotes(ctx, s.db, "bigquery", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].SessionID != "hit" {
		t.Fatalf("got %+v, want only the reply in session hit", got)
	}
}

// The cockpit's calls are read off idx_events_attr_work, which holds the kind,
// cost and message id the two reads test: a row is read from the table only
// when it is a candidate.
func TestSessionCallsReadTheCoveringSessionIndex(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	ev := &event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
		Ts: time.UnixMilli(1000), Key: "a1", Payload: json.RawMessage(`{"text":"hi"}`)}
	if _, err := InsertEvent(ctx, s.db, ev); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE events SET cost_usd = 0.1, msg_id = 'm1'`); err != nil {
		t.Fatal(err)
	}
	rec := &planRecorder{Querier: s.db}
	if _, err := SessionCalls(ctx, rec, "s1", 0); err != nil {
		t.Fatal(err)
	}
	if len(rec.seen) != 2 {
		t.Fatalf("expected the calls and their tools, saw %d statements", len(rec.seen))
	}
	for _, r := range rec.seen {
		plan := explainPlan(t, s, r)
		if !strings.Contains(plan, "SEARCH e USING INDEX idx_events_attr_work (sid=?)") {
			t.Fatalf("SessionCalls must walk idx_events_attr_work; plan: %s", plan)
		}
	}
}

// Each session's first priced turn is a seek and a short walk, never every
// assistant turn of the range grouped by session; Cursor's estimates are
// found by their kind, never by walking each chat's events.
func TestContextOverheadSeeksTheFirstTurn(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	rec := &planRecorder{Querier: s.db}
	if _, err := ContextOverhead(ctx, rec, 0); err != nil {
		t.Fatal(err)
	}
	if len(rec.seen) != 2 {
		t.Fatalf("expected two statements, saw %d", len(rec.seen))
	}
	if plan := explainPlan(t, s, rec.seen[0]); !strings.Contains(plan, "SEARCH e USING INDEX idx_events_kind_id (kind=?)") {
		t.Fatalf("Cursor's estimates must be found by their kind; plan: %s", plan)
	}
	plan := explainPlan(t, s, rec.seen[1])
	if strings.Contains(plan, "GROUP BY") || !strings.Contains(plan, "CORRELATED SCALAR SUBQUERY") ||
		!strings.Contains(plan, "SEARCH e USING INDEX idx_events_session_id (sid=?)") {
		t.Fatalf("the first turn must be one seek per session; plan: %s", plan)
	}
	// One chat's estimate, the same way: by its kind, never every event of a
	// long session read to learn it has none.
	rec = &planRecorder{Querier: s.db}
	if _, err := SessionOverheadFor(ctx, rec, "s1"); err != nil {
		t.Fatal(err)
	}
	if plan := explainPlan(t, s, rec.seen[0]); !strings.Contains(plan, "SEARCH e USING INDEX idx_events_kind_id (kind=?)") ||
		strings.Contains(plan, "TEMP B-TREE") {
		t.Fatalf("a chat's estimate must be found by its kind; plan: %s", plan)
	}
}

// The first-turn seek finds the turn MIN(id) found: the earliest priced
// main-thread turn, past an unpriced one, a subagent's, an internal one and a
// sidechain line.
func TestContextOverheadReadsTheFirstPricedMainTurn(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	at := int64(1_000_000)
	add := func(kind event.Kind, key, payload string, tokens int64, agent string) int64 {
		t.Helper()
		at++
		ev := &event.Event{SessionID: "c1", Source: event.SourceTranscript, Kind: kind, Ts: time.UnixMilli(at),
			Key: key, Payload: json.RawMessage(payload), Model: "claude-opus-5", AgentID: agent}
		if tokens > 0 {
			ev.Tokens = &event.TokenDelta{In: tokens}
		}
		id, err := InsertEvent(ctx, s.db, ev)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	add(event.KindTurnUser, "u1", `{"prompt":"abcdefgh"}`, 0, "")
	add(event.KindTurnAssistant, "a0", `{"text":""}`, 0, "")          // nothing priced
	add(event.KindTurnAssistant, "a1", `{"text":""}`, 900, "agent-1") // a subagent's
	internal := add(event.KindTurnAssistant, "a2", `{"text":""}`, 800, "")
	add(event.KindTurnAssistant, "a3", `{"sidechain":true}`, 700, "") // a sidechain line
	add(event.KindTurnAssistant, "a4", `{"text":"x"}`, 5000, "")      // the first that counts
	add(event.KindTurnAssistant, "a5", `{"text":"y"}`, 9000, "")
	if _, err := s.db.ExecContext(ctx, `UPDATE events SET internal = 1 WHERE id = ?`, internal); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE sessions SET agent = 'claude', started_at = 1000000, chat = 0 WHERE session_id = 'c1'`); err != nil {
		t.Fatal(err)
	}

	rep, err := ContextOverhead(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Claude) != 1 || rep.Claude[0].Samples != 1 {
		t.Fatalf("got %+v, want one sample", rep.Claude)
	}
	// 5000 tokens of prompt less the 8 bytes typed, at four bytes a token.
	if got := rep.Claude[0].MedianTokens; got != 5000-2 {
		t.Fatalf("median %d, want %d: the first priced main-thread turn", got, 5000-2)
	}
}

// A spelling LIKE would fold to one already tried is not tried again; one it
// would not fold (a letter outside ASCII) still is.
func TestSearchVariantsSkipWhatLikeFolds(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want []string
	}{
		{"release", []string{"release"}},
		{"Release", []string{"Release"}},
		{"RELEASE notes", []string{"RELEASE notes"}},
		{"Ελλάδα", []string{"Ελλάδα", "ελλάδα"}},
		{"ελλάδα", []string{"ελλάδα", "Ελλάδα"}},
		{"émile", []string{"émile", "Émile"}},
	} {
		if got := searchVariants(tc.in); strings.Join(got, "|") != strings.Join(tc.want, "|") {
			t.Errorf("searchVariants(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
