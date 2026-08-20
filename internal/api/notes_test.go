// The Answers endpoints — Claude's own prose, per session and searched across
// all of them. This is the feature the first outside user called the most
// important thing missing, and its whole value is that the text comes back
// exactly as Claude wrote it, from this machine only.
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

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
