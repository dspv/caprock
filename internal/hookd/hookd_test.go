package hookd

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "hooks", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestNormalizeAllHookEvents(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	cases := []struct {
		file string
		kind event.Kind
		tool string
		key  string
		ag   string
	}{
		{"session_start.json", event.KindAgentSpawn, "", "", ""},
		{"user_prompt_submit.json", event.KindTurnUser, "", "prompt:p-1", ""},
		{"pre_tool_use.json", event.KindToolPre, "Bash", "pre:toolu_01", ""},
		{"post_tool_use.json", event.KindToolPost, "Bash", "post:toolu_01", ""},
		{"stop.json", event.KindAgentStop, "", "", ""},
		{"subagent_stop.json", event.KindAgentStop, "", "", "agent-9"},
		{"session_end.json", event.KindSessionEnd, "", "", ""},
		{"pre_compact.json", event.KindContextCompact, "", "", ""},
		{"stop_failure.json", event.KindThrottle, "", "", ""},
	}
	for _, c := range cases {
		raw := fixture(t, c.file)
		ev, info, err := Normalize(raw, now)
		if err != nil {
			t.Fatalf("%s: %v", c.file, err)
		}
		if ev.Kind != c.kind || ev.Tool != c.tool || ev.Key != c.key || ev.AgentID != c.ag || ev.SessionID != "sess-abc" || ev.Source != event.SourceHook {
			t.Errorf("%s: got kind=%s tool=%q key=%q agent=%q", c.file, ev.Kind, ev.Tool, ev.Key, ev.AgentID)
		}
		if !bytes.Equal(ev.Payload, raw) {
			t.Errorf("%s: payload not stored verbatim", c.file)
		}
		if info.Cwd != "/home/u/proj" || info.TranscriptPath == "" {
			t.Errorf("%s: session info %+v", c.file, info)
		}
	}
	if _, _, err := Normalize(fixture(t, "unknown_event.json"), now); !errors.Is(err, ErrUnknownEvent) {
		t.Fatalf("unknown: %v", err)
	}
	if _, _, err := Normalize([]byte(`{"hook_event_name":"Stop"}`), now); !errors.Is(err, ErrNoSession) {
		t.Fatalf("no session: %v", err)
	}
	if _, _, err := Normalize([]byte(`not json`), now); err == nil {
		t.Fatal("bad json accepted")
	}
}

func newHandler(t *testing.T) (*Handler, *store.Store) {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	tb, _ := cost.Embedded()
	rec := rollup.New(st, tb, bus.New(), nil)
	return &Handler{Token: "secret", Recorder: rec}, st
}

func post(h http.Handler, token string, body []byte) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/v1/hook", bytes.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func TestHandlerStoresAllEventsAndGates(t *testing.T) {
	h, st := newHandler(t)
	files := []string{"session_start.json", "user_prompt_submit.json", "pre_tool_use.json", "post_tool_use.json", "stop.json", "subagent_stop.json", "pre_compact.json", "stop_failure.json"}
	for _, f := range files {
		if rr := post(h, "secret", fixture(t, f)); rr.Code != http.StatusNoContent {
			t.Fatalf("%s: status %d body %s", f, rr.Code, rr.Body.String())
		}
	}
	evs, err := store.ListEvents(context.Background(), st.DB(), "sess-abc", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 8 {
		t.Fatalf("stored %d events, want 8", len(evs))
	}
	// Replayed keyed events dedupe; keyless (Stop) do not.
	post(h, "secret", fixture(t, "pre_tool_use.json"))
	post(h, "secret", fixture(t, "stop.json"))
	evs, _ = store.ListEvents(context.Background(), st.DB(), "sess-abc", 0, 0)
	if len(evs) != 9 {
		t.Fatalf("after replay %d events, want 9", len(evs))
	}
	s, err := store.GetSession(context.Background(), st.DB(), "sess-abc")
	if err != nil || s.Cwd != "/home/u/proj" || !s.HasHooks || s.Model != "claude-opus-5" || s.TranscriptPath == "" {
		t.Fatalf("session: %+v %v", s, err)
	}
	stats, _ := store.GetStats(context.Background(), st.DB(), "sess-abc")
	if stats.ToolCalls != 1 {
		t.Fatalf("stats: %+v", stats)
	}

	if rr := post(h, "", fixture(t, "stop.json")); rr.Code != http.StatusUnauthorized {
		t.Fatalf("no token: %d", rr.Code)
	}
	if rr := post(h, "wrong", fixture(t, "stop.json")); rr.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token: %d", rr.Code)
	}
	if rr := post(h, "secret", fixture(t, "unknown_event.json")); rr.Code != http.StatusNoContent {
		t.Fatalf("unknown event must be ignored with 204, got %d", rr.Code)
	}
	if rr := post(h, "secret", []byte("{")); rr.Code != http.StatusBadRequest {
		t.Fatalf("bad json: %d", rr.Code)
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/hook", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET: %d", rr.Code)
	}
}

func TestHandlerStopDecision(t *testing.T) {
	h, _ := newHandler(t)
	h.Decide = func(_ context.Context, p Payload) []byte {
		if p.SessionID == "sess-abc" {
			// Canonical Stop-decision shape (the one board.StopDecision emits).
			return []byte(`{"hookSpecificOutput":{"hookEventName":"Stop","decision":"block","reason":"process your inbox"}}`)
		}
		return nil
	}
	rr := post(h, "secret", fixture(t, "stop.json"))
	if rr.Code != http.StatusOK || rr.Header().Get("Content-Type") != "application/json" || !bytes.Contains(rr.Body.Bytes(), []byte("block")) {
		t.Fatalf("stop decision: %d %s", rr.Code, rr.Body.String())
	}
	// SubagentStop never gets a decision.
	if rr := post(h, "secret", fixture(t, "subagent_stop.json")); rr.Code != http.StatusNoContent {
		t.Fatalf("subagent stop: %d", rr.Code)
	}
}

// SessionEnd is not only "the user left". These four reasons were all observed
// on one real machine, and treating every one of them as the end retired
// sessions people were still working in — including one that had been running
// for six days when a /clear closed it in the dashboard.
func TestOnlyARealExitEndsTheSession(t *testing.T) {
	for _, tc := range []struct {
		reason string
		kind   event.Kind
	}{
		// Same session, fresh context — and its own kind. A compact keeps the
		// substance of the context, /clear throws it away, so borrowing
		// context.compact had the dashboard narrating "compacting context" at
		// a session that had just been cleared.
		{"clear", event.KindContextClear},
		// Escape at the prompt. Still sitting there, and the context is
		// untouched — so this claims nothing about the context at all.
		{"prompt_input_exit", event.KindSessionContinue},
		// Unspecified, which is not evidence of an ending.
		{"other", event.KindSessionContinue},
		// The session is over.
		{"exit", event.KindSessionEnd},
		{"logout", event.KindSessionEnd},
	} {
		raw := []byte(`{"session_id":"s1","hook_event_name":"SessionEnd","reason":"` + tc.reason + `"}`)
		ev, _, err := Normalize(raw, time.Unix(0, 0))
		if err != nil {
			t.Fatalf("%s: %v", tc.reason, err)
		}
		if ev.Kind != tc.kind {
			t.Errorf("reason %q produced %q, want %q", tc.reason, ev.Kind, tc.kind)
		}
	}
}

// A reason that continues the session must still reach the timeline: /clear is
// something the reader wants to see, it just is not an ending.
func TestAClearIsRecordedRatherThanDropped(t *testing.T) {
	raw := []byte(`{"session_id":"s1","hook_event_name":"SessionEnd","reason":"clear"}`)
	ev, _, err := Normalize(raw, time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if ev == nil || ev.SessionID != "s1" {
		t.Fatalf("the event was dropped: %+v", ev)
	}
}

// A continuing reason must never be stored as session.end: rollup retires the
// session on that kind, which would resurrect the six-day bug from the other
// direction — the shim reporting "still here" and the daemon reading it as
// "gone".
func TestAContinuingReasonIsNeverSessionEnd(t *testing.T) {
	for _, reason := range []string{"clear", "prompt_input_exit", "other"} {
		raw := []byte(`{"session_id":"s1","hook_event_name":"SessionEnd","reason":"` + reason + `"}`)
		ev, _, err := Normalize(raw, time.Unix(0, 0))
		if err != nil {
			t.Fatalf("%s: %v", reason, err)
		}
		if ev.Kind == event.KindSessionEnd {
			t.Errorf("reason %q was stored as session.end, which retires the session", reason)
		}
	}
}

// /clear starts a new session inside the running process. Only the
// SessionStart names that new session, so it is what the supersede keys off;
// the SessionEnd beside it carries the id being replaced.
func TestSessionStartFlagsAClearAsAReplacement(t *testing.T) {
	for _, tc := range []struct {
		source string
		want   bool
	}{
		{"clear", true},
		{"startup", false},
		{"resume", false},
		{"compact", false},
		{"", false},
	} {
		raw := []byte(`{"session_id":"new","hook_event_name":"SessionStart","source":"` + tc.source + `"}`)
		_, info, err := Normalize(raw, time.Unix(0, 0))
		if err != nil {
			t.Fatalf("%s: %v", tc.source, err)
		}
		if info.ReplacesPID != tc.want {
			t.Errorf("source %q: ReplacesPID = %v, want %v", tc.source, info.ReplacesPID, tc.want)
		}
	}
}
