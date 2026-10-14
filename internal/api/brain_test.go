package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/license"
	"github.com/dspv/caprock/internal/store"
)

func brainDo(t *testing.T, e *env, method, path string, body any) (int, map[string]any) {
	t.Helper()
	rr := inboxDo(t, e.api, method, path, body)
	var out map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	return rr.Code, out
}

func licenseEnv(t *testing.T, e *env) {
	t.Helper()
	cur := e.settings.Get()
	cur.LicenseKey = license.Issue(time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC), license.RandomSuffix)
	if err := e.settings.Set(cur); err != nil {
		t.Fatal(err)
	}
}

func TestBrainDropFromANoteReadsTheRecord(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if err := store.UpsertSession(ctx, e.st.DB(), "s1", store.SessionPatch{Project: "caprock", LastEventAt: 1000, StartedAt: 1000, FromHook: true}); err != nil {
		t.Fatal(err)
	}
	ev := event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: time.UnixMilli(900), Key: "a",
		Payload: []byte(`{"text":"## Decision\n\n**Keep SQLite** with WAL: Postgres is too much for one machine.\n\nThe cache stays local."}`)}
	id, err := store.InsertEvent(ctx, e.st.DB(), &ev)
	if err != nil {
		t.Fatal(err)
	}
	sub := e.bus.Subscribe(8)
	defer sub.Unsubscribe()

	code, out := brainDo(t, e, "POST", "/v1/brain/nodes", map[string]any{"event_id": id, "kind": "decision", "topics": []string{"SQLite", "sqlite "}})
	if code != 200 {
		t.Fatalf("drop: %d %v", code, out)
	}
	node := out["node"].(map[string]any)
	if node["title"] != "Decision" {
		t.Errorf("title = %q; the first line without its Markdown", node["title"])
	}
	if !strings.Contains(node["summary"].(string), "Keep SQLite with WAL") {
		t.Errorf("summary = %q", node["summary"])
	}
	src := node["source"].(map[string]any)
	if src["session_id"] != "s1" || src["project"] != "caprock" || src["ts"].(float64) != 900 {
		t.Errorf("source = %v, read from the record", src)
	}
	select {
	case f := <-sub.C:
		if f.Type != bus.FrameBrain {
			t.Errorf("frame %q, want brain", f.Type)
		}
	default:
		t.Error("no brain frame for a new memory")
	}

	// It hangs off its project and one topic (the two spellings are one).
	var g store.BrainGraph
	if code := e.get(t, "/v1/brain", &g); code != 200 {
		t.Fatalf("graph: %d", code)
	}
	if len(g.Nodes) != 3 || len(g.Edges) != 2 || g.Total != 1 {
		t.Fatalf("graph: %d nodes, %d edges, total %d; want 3, 2, 1", len(g.Nodes), len(g.Edges), g.Total)
	}
	if g.Nodes[0].Summary != "" {
		t.Error("the graph leaves summaries out unless asked")
	}
	if code := e.get(t, "/v1/brain?summaries=1&q=wal", &g); code != 200 || g.Total != 1 || g.Nodes[0].Summary == "" {
		t.Errorf("search with summaries: %d %+v", code, g)
	}

	// The same answer again is the same memory.
	if code, out := brainDo(t, e, "POST", "/v1/brain/nodes", map[string]any{"event_id": id}); code != 200 || out["created"] != false {
		t.Errorf("a second drop: %d %v, want the first memory back", code, out)
	}
	// A sidechain or a tool call is not a note.
	if code, _ := brainDo(t, e, "POST", "/v1/brain/nodes", map[string]any{"event_id": id + 999}); code != 400 {
		t.Errorf("an unknown event: %d, want 400", code)
	}
}

func TestBrainQuickCaptureEditAndDelete(t *testing.T) {
	e := newEnv(t)
	code, out := brainDo(t, e, "POST", "/v1/brain/nodes", map[string]any{"text": "  Try a Bloom filter for dedupe  "})
	if code != 200 {
		t.Fatalf("capture: %d %v", code, out)
	}
	node := out["node"].(map[string]any)
	id := int64(node["id"].(float64))
	if node["title"] != "Try a Bloom filter for dedupe" || node["summary"] != "" || node["kind"] != "idea" || node["manual"] != true {
		t.Errorf("one short line is a title and nothing else: %v", node)
	}
	if code, _ := brainDo(t, e, "POST", "/v1/brain/nodes", map[string]any{"text": "  \n "}); code != 400 {
		t.Errorf("nothing to keep: %d, want 400", code)
	}
	if code, _ := brainDo(t, e, "POST", "/v1/brain/nodes", map[string]any{"text": "x", "kind": "memo"}); code != 400 {
		t.Errorf("an unknown kind: %d, want 400", code)
	}

	code, out = brainDo(t, e, "PATCH", fmt.Sprintf("/v1/brain/nodes/%d", id), map[string]any{"title": "Bloom filter for dedupe", "pinned": true, "kind": "decision"})
	if code != 200 {
		t.Fatalf("patch: %d %v", code, out)
	}
	if n := out["node"].(map[string]any); n["pinned"] != true || n["kind"] != "decision" || n["title"] != "Bloom filter for dedupe" {
		t.Errorf("patched: %v", n)
	}
	code, out = brainDo(t, e, "POST", "/v1/brain/nodes", map[string]any{"title": "dedupe", "kind": "topic"})
	if code != 200 {
		t.Fatal(code, out)
	}
	topic := int64(out["node"].(map[string]any)["id"].(float64))
	if code, _ := brainDo(t, e, "POST", "/v1/brain/links", map[string]any{"from": id, "to": topic}); code != 204 {
		t.Errorf("link: %d", code)
	}
	if code, _ := brainDo(t, e, "POST", "/v1/brain/links", map[string]any{"from": id, "to": id}); code != 400 {
		t.Errorf("a self link: %d, want 400", code)
	}
	var detail struct {
		Node  store.BrainNode   `json:"node"`
		Links []store.BrainLink `json:"links"`
	}
	if code := e.get(t, fmt.Sprintf("/v1/brain/nodes/%d", id), &detail); code != 200 || len(detail.Links) != 1 || detail.Links[0].Kind != "relates" {
		t.Fatalf("detail: %d %+v", code, detail)
	}
	if code, _ := brainDo(t, e, "DELETE", "/v1/brain/links", map[string]any{"from": topic, "to": id}); code != 204 {
		t.Errorf("unlink: %d", code)
	}
	if code, _ := brainDo(t, e, "DELETE", fmt.Sprintf("/v1/brain/nodes/%d", id), nil); code != 204 {
		t.Errorf("delete: %d", code)
	}
	if code, _ := brainDo(t, e, "DELETE", fmt.Sprintf("/v1/brain/nodes/%d", id), nil); code != 404 {
		t.Errorf("delete twice: %d, want 404", code)
	}
	if code, _ := brainDo(t, e, "GET", "/v1/brain/nodes/abc", nil); code != 404 {
		t.Errorf("a bad id: %d, want 404", code)
	}
}

// Without a licence Second Brain keeps a taste: twenty memories dropped by
// hand. The server refuses the twenty-first, so the lock is not a decoration.
func TestBrainFreeAllowanceIsCheckedOnTheServer(t *testing.T) {
	e := newEnv(t)
	for i := 0; i < brainFreeManual; i++ {
		if code, out := brainDo(t, e, "POST", "/v1/brain/nodes", map[string]any{"text": fmt.Sprintf("idea %d", i)}); code != 200 {
			t.Fatalf("drop %d: %d %v", i, code, out)
		}
	}
	var st BrainStatus
	if code := e.get(t, "/v1/brain/status", &st); code != 200 || st.Licensed || st.FreeLeft != 0 || st.Manual != brainFreeManual {
		t.Fatalf("status at the allowance: %d %+v", code, st)
	}
	if code, out := brainDo(t, e, "POST", "/v1/brain/nodes", map[string]any{"text": "one more"}); code != http.StatusPaymentRequired {
		t.Fatalf("past the allowance: %d %v, want 402", code, out)
	}
	licenseEnv(t, e)
	if code, out := brainDo(t, e, "POST", "/v1/brain/nodes", map[string]any{"text": "one more"}); code != 200 {
		t.Fatalf("licensed: %d %v", code, out)
	}
	if code := e.get(t, "/v1/brain/status", &st); code != 200 || !st.Licensed || st.FreeLeft != -1 {
		t.Fatalf("licensed status: %+v", st)
	}
}

func TestBrainTitleSummary(t *testing.T) {
	for _, c := range []struct{ in, title, summary string }{
		{"Short idea", "Short idea", ""},
		{"# Heading\n\n- first point\n- second point", "Heading", "Heading first point second point"},
		{"---\n\n1. `code` step", "code step", ""},
		{"Upgraded to React 19. The only breaking change we hit was ref as a prop in two form components; both fixed.",
			"Upgraded to React 19",
			"Upgraded to React 19. The only breaking change we hit was ref as a prop in two form components; both fixed."},
		{"Should a 410 from the receiver stop retries for good, or should we keep trying for a day?",
			"Should a 410 from the receiver stop retries for good, or should we keep trying…",
			"Should a 410 from the receiver stop retries for good, or should we keep trying for a day?"},
	} {
		title, summary := brainTitleSummary(c.in, "")
		if title != c.title || summary != c.summary {
			t.Errorf("%q → %q / %q, want %q / %q", c.in, title, summary, c.title, c.summary)
		}
	}
}

type fakeBrainAuto struct {
	set      []BrainSettings
	on       bool
	backfill int
}

func (f *fakeBrainAuto) Status(context.Context) any { return map[string]bool{"on": f.on} }
func (f *fakeBrainAuto) Configure(_ context.Context, set BrainSettings) error {
	f.set = append(f.set, set)
	if set.Auto != nil {
		f.on = *set.Auto
	}
	return nil
}
func (f *fakeBrainAuto) Estimate(_ context.Context, days int) (any, error) {
	return map[string]int{"sessions": days}, nil
}
func (f *fakeBrainAuto) Backfill(_ context.Context, days int) error {
	if !f.on {
		return ErrBrainAutoOff
	}
	f.backfill = days
	return nil
}

func TestBrainAutomaticNeedsALicenceAndAYes(t *testing.T) {
	e := newEnv(t)
	if code, _ := brainDo(t, e, "PUT", "/v1/brain/settings", map[string]any{"auto": true}); code != http.StatusServiceUnavailable {
		t.Errorf("without the engine: %d", code)
	}
	f := &fakeBrainAuto{}
	e.api.d.BrainAuto = f

	if code, _ := brainDo(t, e, "PUT", "/v1/brain/settings", map[string]any{"auto": true}); code != http.StatusPaymentRequired {
		t.Fatalf("on without a licence: %d", code)
	}
	if code, _ := brainDo(t, e, "PUT", "/v1/brain/settings", map[string]any{"auto": false}); code != 200 {
		t.Errorf("off never needs a licence: %d", code)
	}
	// The estimate is free to ask for; the read is not.
	if code, out := brainDo(t, e, "POST", "/v1/brain/backfill", map[string]any{"dry_run": true}); code != 200 || out["sessions"].(float64) != 30 {
		t.Errorf("dry run: %d %v; 30 days by default", code, out)
	}
	if code, _ := brainDo(t, e, "POST", "/v1/brain/backfill", map[string]any{"days": 30}); code != http.StatusPaymentRequired {
		t.Errorf("backfill without a licence: %d", code)
	}

	licenseEnv(t, e)
	for _, bad := range []map[string]any{{"daily_tokens": 5}, {"daily_tokens": 900_000_000}, {"model": "opus"}} {
		if code, _ := brainDo(t, e, "PUT", "/v1/brain/settings", bad); code != http.StatusBadRequest {
			t.Errorf("%v: %d", bad, code)
		}
	}
	if code, _ := brainDo(t, e, "POST", "/v1/brain/backfill", map[string]any{"days": 30}); code != http.StatusConflict {
		t.Errorf("backfill before the yes: %d", code)
	}
	if code, out := brainDo(t, e, "PUT", "/v1/brain/settings", map[string]any{"auto": true, "daily_tokens": 100_000, "model": "haiku"}); code != 200 || out["on"] != true {
		t.Fatalf("on: %d %v", code, out)
	}
	if last := f.set[len(f.set)-1]; *last.DailyTokens != 100_000 || *last.Model != "haiku" {
		t.Errorf("settings passed: %+v", last)
	}
	if code, _ := brainDo(t, e, "POST", "/v1/brain/backfill", map[string]any{"days": 91}); code != http.StatusBadRequest {
		t.Errorf("91 days: %d", code)
	}
	if code, _ := brainDo(t, e, "POST", "/v1/brain/backfill", map[string]any{"days": 14}); code != 200 || f.backfill != 14 {
		t.Errorf("backfill: %d, %d days", code, f.backfill)
	}
	var st BrainStatus
	if code := e.get(t, "/v1/brain/status", &st); code != 200 || st.Auto.(map[string]any)["on"] != true {
		t.Errorf("status: %d %+v", code, st)
	}
}
