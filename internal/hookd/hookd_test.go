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

func TestNormalizeAllSevenEvents(t *testing.T) {
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
		{"pre_compact.json", event.KindContextCompact, "", "", ""},
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
	files := []string{"session_start.json", "user_prompt_submit.json", "pre_tool_use.json", "post_tool_use.json", "stop.json", "subagent_stop.json", "pre_compact.json"}
	for _, f := range files {
		if rr := post(h, "secret", fixture(t, f)); rr.Code != http.StatusNoContent {
			t.Fatalf("%s: status %d body %s", f, rr.Code, rr.Body.String())
		}
	}
	evs, err := store.ListEvents(context.Background(), st.DB(), "sess-abc", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 7 {
		t.Fatalf("stored %d events, want 7", len(evs))
	}
	// Replayed keyed events dedupe; keyless (Stop) do not.
	post(h, "secret", fixture(t, "pre_tool_use.json"))
	post(h, "secret", fixture(t, "stop.json"))
	evs, _ = store.ListEvents(context.Background(), st.DB(), "sess-abc", 0, 0)
	if len(evs) != 8 {
		t.Fatalf("after replay %d events, want 8", len(evs))
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
			return []byte(`{"decision":"block","reason":"process your inbox"}`)
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
