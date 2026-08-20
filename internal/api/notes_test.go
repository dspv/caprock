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
