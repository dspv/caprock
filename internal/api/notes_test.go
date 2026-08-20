// The Answers endpoints — Claude's own prose, per session and searched across
// all of them. This is the feature the first outside user called the most
// important thing missing, and its whole value is that the text comes back
// exactly as Claude wrote it, from this machine only.
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// note writes one assistant turn, the shape the ingest path produces.
func (e *env) note(t *testing.T, sessionID, text string, ts time.Time) {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"text": text})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertSession(context.Background(), e.st.DB(), sessionID, store.SessionPatch{
		Project: "proj-" + sessionID, LastEventAt: ts.UnixMilli(), StartedAt: ts.UnixMilli(), FromTranscript: true,
	}); err != nil {
		t.Fatal(err)
	}
	ev := event.Event{
		SessionID: sessionID, Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
		Ts: ts, Payload: payload, Key: sessionID + "-" + ts.String(),
	}
	if _, err := store.InsertEvent(context.Background(), e.st.DB(), &ev); err != nil {
		t.Fatal(err)
	}
}

func TestSessionNotesReturnsTheProse(t *testing.T) {
	e := newEnv(t)
	e.note(t, "s1", "I could not verify the SSO redirect; ask the team.", e.now)

	var got []store.AssistantNote
	if code := e.get(t, "/v1/sessions/s1/notes", &got); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if len(got) != 1 {
		t.Fatalf("got %d notes; want 1", len(got))
	}
	// Verbatim: this is the paragraph people currently copy out of scrollback.
	if !strings.Contains(got[0].Text, "SSO redirect") {
		t.Errorf("text = %q; want Claude's own words", got[0].Text)
	}
	if got[0].SessionID != "s1" {
		t.Errorf("session_id = %q", got[0].SessionID)
	}
}

// A session with no assistant turns must answer with an empty list, not null —
// the dashboard iterates the result and a null would throw.
func TestSessionNotesEmptyIsAListNotNull(t *testing.T) {
	e := newEnv(t)
	resp, err := http.Get(e.srv.URL + "/v1/sessions/nobody/notes")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d; an unknown session is empty, not an error", resp.StatusCode)
	}
	var raw json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(raw)) == "null" {
		t.Error("returned null; the UI iterates this and would throw")
	}
}

func TestSearchNotesFindsAcrossSessions(t *testing.T) {
	e := newEnv(t)
	e.note(t, "s1", "The migration needs a backfill before it can run.", e.now)
	e.note(t, "s2", "Nothing to do with databases at all.", e.now.Add(time.Minute))

	var got []store.AssistantNote
	if code := e.get(t, "/v1/notes?q=backfill", &got); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if len(got) != 1 {
		t.Fatalf("got %d matches; want just the one session that mentions it", len(got))
	}
	if got[0].SessionID != "s1" {
		t.Errorf("matched session %q; want s1", got[0].SessionID)
	}
}

// Substring, not whole-word: people search their sessions for fragments, which
// is the reason an FTS index was rejected for this query.
func TestSearchNotesMatchesAFragment(t *testing.T) {
	e := newEnv(t)
	e.note(t, "s1", "Consider using orchestration for this.", e.now)

	var got []store.AssistantNote
	e.get(t, "/v1/notes?q=chestr", &got)
	if len(got) != 1 {
		t.Errorf("got %d matches for a mid-word fragment; want 1", len(got))
	}
}

// An empty query must not dump every note on the machine.
func TestSearchNotesWithoutAQuery(t *testing.T) {
	e := newEnv(t)
	e.note(t, "s1", "something", e.now)

	resp, err := http.Get(e.srv.URL + "/v1/notes?q=")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d; an empty query is not an error", resp.StatusCode)
	}
}

// SQL wildcards typed by a user are text, not syntax: searching for "100%"
// must not become a match-everything query.
//
// Two things are checked here, and they fail differently. A properly encoded
// %25 reaches the query as a literal percent and must match only the note
// containing it — that is escapeLike's job. A bare "%" in the URL is a broken
// percent-escape, so it never becomes a search term at all; what matters then
// is that the endpoint does not answer as though the user had asked for
// everything.
func TestSearchNotesTreatsWildcardsAsText(t *testing.T) {
	e := newEnv(t)
	e.note(t, "s1", "Coverage reached 100% on that package.", e.now)
	e.note(t, "s2", "An unrelated sentence.", e.now.Add(time.Minute))

	// A bare percent is the sharpest case: as a LIKE wildcard it matches every
	// note, so if escaping is dropped this returns both. With "100%" the "100"
	// already narrows it to one note and the leak stays invisible — which is
	// why the assertion is on the wildcard alone.
	var got []store.AssistantNote
	e.get(t, "/v1/notes?q=%25", &got)
	if len(got) != 1 || got[0].SessionID != "s1" {
		t.Errorf("searching for a literal %% matched %v; want only the note containing one", sessionsOf(got))
	}

	// An underscore is the other LIKE wildcard, and it appears in real paths.
	e.note(t, "s3", "Look at internal_store for that.", e.now.Add(2*time.Minute))
	var got2 []store.AssistantNote
	e.get(t, "/v1/notes?q=internal_store", &got2)
	if len(got2) != 1 || got2[0].SessionID != "s3" {
		t.Errorf("an underscore search matched %v; _ must be a literal, not a single-char wildcard", sessionsOf(got2))
	}
}

func sessionsOf(ns []store.AssistantNote) []string {
	out := make([]string, 0, len(ns))
	for _, n := range ns {
		out = append(out, n.SessionID)
	}
	return out
}

// The limit is what keeps one request from serialising an entire history.
func TestSearchNotesHonoursLimit(t *testing.T) {
	e := newEnv(t)
	for i := 0; i < 5; i++ {
		e.note(t, "s1", "repeated marker text", e.now.Add(time.Duration(i)*time.Minute))
	}
	var got []store.AssistantNote
	e.get(t, "/v1/notes?q=marker&limit=2", &got)
	if len(got) > 2 {
		t.Errorf("got %d notes with limit=2", len(got))
	}
}

// The dashboard is mounted at "/" so client-side routes resolve, which means an
// unmatched path falls through to index.html. That is right for a page and
// wrong for the API: a caller that mistypes an endpoint, or uses one that was
// removed in an upgrade, would get 200 and a document, then fail somewhere else
// while parsing HTML as JSON.
func TestUnknownAPIPathIs404JSON(t *testing.T) {
	e := newEnv(t)
	for _, path := range []string{
		"/v1/nonexistent",
		"/v1/stats/nope",
		"/v1/sessions/x/not-a-tab",
	} {
		t.Run(path, func(t *testing.T) {
			resp, err := http.Get(e.srv.URL + path)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusNotFound {
				t.Errorf("status %d for %s; want 404", resp.StatusCode, path)
			}
			if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "json") {
				t.Errorf("Content-Type %q; an API path must not answer with a document", ct)
			}
			var body map[string]string
			if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
				t.Errorf("body is not JSON: %v", err)
			}
		})
	}
}

// A real endpoint must keep working — the 404 branch must not shadow the mux.
func TestKnownAPIPathsStillResolve(t *testing.T) {
	e := newEnv(t)
	// /v1/settings is deliberately absent: newEnv does not wire a Settings
	// provider, so it answers 501 here and 200 in a real daemon.
	for _, path := range []string{"/v1/sessions", "/v1/stats/summary?range=today", "/v1/history?range=today"} {
		resp, err := http.Get(e.srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("%s returned %d; want 200", path, resp.StatusCode)
		}
	}
}

// The dashboard itself still has to load, including deep links the router
// handles client-side.
func TestUIRoutesStillServeThePage(t *testing.T) {
	e := newEnv(t)
	for _, path := range []string{"/", "/cost", "/session/abc"} {
		resp, err := http.Get(e.srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("UI path %s returned %d; the SPA fallback must still work", path, resp.StatusCode)
		}
	}
}

// An out-of-range `days` must clamp to the ceiling, not fall back to the
// default. Asking for 5000 days and silently getting 30 returns a total that is
// simply wrong: a caller summing the result sees a fraction of the real spend
// with nothing indicating it was truncated. Found by summing /v1/stats/daily
// against /v1/stats/summary on a real database — they disagreed by $1,603.
func TestDailyClampsToTheCeilingNotTheDefault(t *testing.T) {
	e := newEnv(t)
	// daily_stats is written by the recorder, not by a raw event insert, so
	// these go through the same path the ingest uses.
	priced := func(id string, ts time.Time) {
		t.Helper()
		ev := &event.Event{
			SessionID: id, Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
			Key: "msg:" + id, Ts: ts, Model: "claude-opus-5",
			Tokens:  &event.TokenDelta{In: 100, Out: 200},
			Payload: json.RawMessage(`{"text":"hi"}`),
		}
		if _, err := e.rec.Record(context.Background(), ev, rollup.SessionInfo{Cwd: "/tmp/p"}); err != nil {
			t.Fatal(err)
		}
	}
	// 45 days apart: inside a 3650-day window, outside a 30-day one.
	priced("s-old", e.now.AddDate(0, 0, -45))
	priced("s-new", e.now)

	var huge, def []map[string]any
	e.get(t, "/v1/stats/daily?days=99999", &huge)
	e.get(t, "/v1/stats/daily?days=30", &def)

	if len(huge) <= len(def) {
		t.Errorf("days=99999 returned %d rows and days=30 returned %d; an absurd value must clamp to the ceiling, not to the default",
			len(huge), len(def))
	}
}

// A missing or nonsense value still gets the dashboard's own window.
func TestDailyDefaultsWhenUnset(t *testing.T) {
	e := newEnv(t)
	e.note(t, "s", "x", e.now)
	for _, q := range []string{"", "?days=0", "?days=-5", "?days=abc"} {
		var rows []map[string]any
		if code := e.get(t, "/v1/stats/daily"+q, &rows); code != http.StatusOK {
			t.Errorf("%q returned %d", q, code)
		}
	}
}

// A partial settings body must change what it names and leave the rest alone.
//
// Decoding into a plain struct made an absent field indistinguishable from a
// cleared one, so `PUT {}` answered 200 and wiped everything: a stated plan
// reverted to "not stated", and the release-check opt-in switched itself off.
// That second one is rule 4's only outbound call, and a client that sent a
// short body — or a retry that lost fields — should not be able to toggle it by
// omission in either direction.
func TestPartialSettingsUpdateKeepsTheRest(t *testing.T) {
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	tb, _ := cost.Embedded()
	srv := httptest.NewServer(New(Deps{
		Store: st, Bus: bus.New(), Table: tb, Version: "test", Now: time.Now,
		Status:   func(context.Context) any { return map[string]string{} },
		Settings: &fakeSettings{},
	}))
	t.Cleanup(srv.Close)

	put := func(body string) int {
		req, _ := http.NewRequest(http.MethodPut, srv.URL+"/v1/settings", strings.NewReader(body))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}
	get := func() map[string]any {
		resp, err := http.Get(srv.URL + "/v1/settings")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	if code := put(`{"update_checks":true,"plan_kind":"flat","plan_label":"Max 20x","plan_usd_per_month":200}`); code != http.StatusOK {
		t.Fatalf("initial settings: %d", code)
	}

	// An empty body must be a no-op, not a reset.
	if code := put(`{}`); code != http.StatusOK {
		t.Fatalf("empty patch: %d", code)
	}
	got := get()
	if got["update_checks"] != true {
		t.Error("an empty body switched the release check off")
	}
	if got["plan_label"] != "Max 20x" || got["plan_usd_per_month"] != float64(200) {
		t.Errorf("an empty body cleared the plan: %+v", got)
	}

	// Naming one field changes that field only.
	if code := put(`{"plan_label":"Pro"}`); code != http.StatusOK {
		t.Fatalf("single-field patch: %d", code)
	}
	got = get()
	if got["plan_label"] != "Pro" {
		t.Errorf("plan_label = %v; want the new value", got["plan_label"])
	}
	if got["update_checks"] != true {
		t.Error("changing the label switched the release check off")
	}
	if got["plan_kind"] != "flat" {
		t.Errorf("plan_kind = %v; want it untouched", got["plan_kind"])
	}

	// And an explicit false is still honoured — this must not become a
	// write-only setting.
	if code := put(`{"update_checks":false}`); code != http.StatusOK {
		t.Fatalf("explicit false: %d", code)
	}
	if get()["update_checks"] != false {
		t.Error("an explicit false did not switch the release check off")
	}
}

// `newest=1` returns the tail of a session rather than the head.
//
// Paging from the start is right for a timeline read forwards and wrong for
// anything showing recent activity: on a session with thousands of events,
// `after=0` hands back the first few hundred — hours old — so a caller asking
// "what just happened" renders an empty window with no indication why. The
// pulse panel hit exactly that.
func TestSessionEventsNewestReturnsTheTail(t *testing.T) {
	e := newEnv(t)
	base := e.now.Add(-2 * time.Hour)
	for i := 0; i < 30; i++ {
		ev := &event.Event{
			SessionID: "s-tail", Source: event.SourceHook, Kind: event.KindToolPre,
			Tool: "Bash", Key: "k" + strconv.Itoa(i), Ts: base.Add(time.Duration(i) * time.Minute),
		}
		if _, err := store.InsertEvent(context.Background(), e.st.DB(), ev); err != nil {
			t.Fatal(err)
		}
	}

	var head, tail []event.Event
	e.get(t, "/v1/sessions/s-tail/events?after=0&limit=5", &head)
	e.get(t, "/v1/sessions/s-tail/events?newest=1&limit=5", &tail)

	if len(head) != 5 || len(tail) != 5 {
		t.Fatalf("head=%d tail=%d; want 5 each", len(head), len(tail))
	}
	if !tail[len(tail)-1].Ts.After(head[len(head)-1].Ts) {
		t.Errorf("newest=1 returned %v, no later than the head's %v", tail[len(tail)-1].Ts, head[len(head)-1].Ts)
	}
	// Oldest-first within the page, so a caller can render it left to right.
	for i := 1; i < len(tail); i++ {
		if tail[i].Ts.Before(tail[i-1].Ts) {
			t.Errorf("page is not in chronological order at %d", i)
		}
	}
}
