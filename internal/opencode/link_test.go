package opencode

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/sessionlink"
	"github.com/dspv/caprock/internal/store"
)

// The frames are the shape a real TUI's server sent (opencode 1.15.10,
// 2026-10-04, `--port`): server.connected first, then session.created with the
// session under properties.info.
func TestWaitCreatedReturnsTheTopLevelSessionTheServerMade(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/event" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fl := w.(http.Flusher)
		frames := []string{
			`{"id":"evt_1","type":"server.connected","properties":{}}`,
			`not json`,
			// A subagent's session belongs to its parent and must not be taken.
			`{"id":"evt_2","type":"session.created","properties":{"sessionID":"ses_child","info":{"id":"ses_child","parentID":"ses_parent"}}}`,
			`{"id":"evt_3","type":"session.updated","properties":{"sessionID":"ses_x","info":{"id":"ses_x"}}}`,
			`{"id":"evt_4","type":"session.created","properties":{"sessionID":"ses_top","info":{"id":"ses_top","slug":"quick-canyon","directory":"/p"}}}`,
		}
		for _, f := range frames {
			fmt.Fprintf(w, "data: %s\n\n", f)
			fl.Flush()
		}
		<-r.Context().Done()
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	id, err := WaitCreated(ctx, srv.URL)
	if err != nil || id != "ses_top" {
		t.Fatalf("got %q, %v; want ses_top", id, err)
	}
}

// The TUI's server is not up the moment the process starts: a refused
// connection is retried, and the wait ends with the process.
func TestWaitCreatedGivesUpWhenTheProcessEnds(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	if id, err := WaitCreated(ctx, "http://127.0.0.1:1"); id != "" || err == nil {
		t.Fatalf("got %q, %v; want nothing and the context's error", id, err)
	}
}

// Once OpenCode's session is claimed for the session Caprock started, its
// turns, prompts and tools are stored under Caprock's id, so the terminal and
// the cost are one page.
func TestAClaimedSessionIsStoredUnderTheSessionThatStartedIt(t *testing.T) {
	h := newHarness(t)
	h.f.typical()
	ctx := context.Background()
	st := h.in.rec.Store
	if err := store.UpsertSession(ctx, st.DB(), "cap-1", store.SessionPatch{Cwd: "/home/dev/api", Agent: Agent}); err != nil {
		t.Fatal(err)
	}
	l := sessionlink.New(st, nil)
	if !l.Claim(ctx, Agent, "cap-1", "ses_a") {
		t.Fatal("claim refused")
	}
	h.in.Link = l
	h.poll()

	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE session_id='cap-1'`); n == 0 {
		t.Fatal("nothing stored under the spawned session")
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM sessions WHERE session_id='ses_a'`); n != 0 {
		t.Error("the session was also stored under OpenCode's id: one session shown twice")
	}
	// The subagent stays its own row, as for every OpenCode session.
	if n := count(t, h.out, `SELECT COUNT(*) FROM sessions WHERE session_id='ses_child'`); n != 1 {
		t.Error("the subagent's session went missing")
	}
	// An unrelated session is untouched.
	if n := count(t, h.out, `SELECT COUNT(*) FROM sessions WHERE session_id='ses_b'`); n != 1 {
		t.Error("an unclaimed session was moved")
	}
	var title string
	if err := h.out.QueryRow(`SELECT COALESCE(title,'') FROM sessions WHERE session_id='cap-1'`).Scan(&title); err != nil || title != "add auth" {
		t.Errorf("title %q (%v) did not reach the spawned session", title, err)
	}
}
