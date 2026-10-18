package mcp

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/loop"
	"github.com/dspv/caprock/internal/obsidian"
	"github.com/dspv/caprock/internal/store"
)

// fixture is a real daemon API over an in-memory store, seeded with one
// repository's sessions, prose, memories, daily totals and a loop alert.
type fixture struct {
	st      *store.Store
	srv     *httptest.Server
	repo    string // a directory inside the repository
	project string
	tools   map[string]Tool
}

// leakedKey is a credential-shaped string planted in prose; no tool may
// return it.
const leakedKey = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	st, err := store.Open(ctx, ":memory:", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	db := st.DB()

	root := filepath.Join(t.TempDir(), "acme-api")
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(root, "cmd")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(t.TempDir(), "elsewhere")
	if err := os.MkdirAll(other, 0o755); err != nil {
		t.Fatal(err)
	}
	project := store.ProjectFromCwd(root)
	now := time.Now()
	ms := now.UnixMilli()
	mustUpsert := func(id, cwd, title string, at int64) {
		t.Helper()
		if err := store.UpsertSession(ctx, db, id, store.SessionPatch{Cwd: cwd, Title: title, GitBranch: "main", Model: "claude-opus-4-1", LastEventAt: at, StartedAt: at - 60_000, FromHook: true, Agent: "claude"}); err != nil {
			t.Fatal(err)
		}
	}
	mustUpsert("s-old", sub, "Refactor the router", ms-3_600_000)
	mustUpsert("s-new", root, "Fix the login flow", ms)
	mustUpsert("s-other", other, "Unrelated work", ms)

	prose := func(id, key, text string, at int64) {
		t.Helper()
		ev := event.Event{SessionID: id, Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: time.UnixMilli(at), Key: key,
			Payload: []byte(`{"text":` + string(mustJSON(t, text)) + `}`)}
		if _, err := store.InsertEvent(ctx, db, &ev); err != nil {
			t.Fatal(err)
		}
	}
	prose("s-new", "a1", "The login flow now refreshes the SSO token before it expires. The old key "+leakedKey+" was rotated.", ms-1000)
	prose("s-new", "a2", "Let me check that", ms-500)
	prose("s-other", "b1", "Nothing about tokens here, only pagination.", ms-2000)

	mem, _, err := store.InsertBrainNode(ctx, db, store.BrainNode{Kind: store.BrainDecision, Title: "Refresh SSO tokens early", Summary: "Refresh one minute before expiry; the IdP clock drifts.", Source: store.BrainSource{Project: project, SessionID: "s-new"}}, ms-10_000)
	if err != nil {
		t.Fatal(err)
	}
	topic, _, err := store.InsertBrainNode(ctx, db, store.BrainNode{Kind: store.BrainTopic, Title: "sso"}, ms-10_000)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.LinkBrain(ctx, db, mem.ID, topic.ID, store.EdgePartOf, 1, ms); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.InsertBrainNode(ctx, db, store.BrainNode{Kind: store.BrainDecision, Title: "Paginate with cursors", Source: store.BrainSource{Project: "elsewhere"}}, ms-20_000); err != nil {
		t.Fatal(err)
	}

	today := now.Format("2006-01-02")
	for _, d := range []struct {
		project, model string
		tokens         int64
		usd            float64
	}{{project, "claude-opus-4-1", 1000, 1.25}, {project, "claude-haiku-4-5", 500, 0.25}, {"elsewhere", "claude-opus-4-1", 9000, 9}} {
		if err := store.AddDaily(ctx, db, today, d.project, d.model, d.tokens, d.usd, true); err != nil {
			t.Fatal(err)
		}
	}

	tb, _ := cost.Embedded()
	alert := &loop.Alert{Kind: "loop", SessionID: "s-new", Tool: "Bash", Count: 7, WindowMin: 5, Sample: "go test ./... " + leakedKey, FirstTs: now.Add(-4 * time.Minute), LastTs: now, TaxUSD: 0.4242}
	srv := httptest.NewServer(api.New(api.Deps{
		Store: st, Bus: bus.New(), Table: tb, Version: "test", Now: time.Now,
		ActiveLoops: func(id string) *loop.Alert {
			if id == "s-new" {
				return alert
			}
			return nil
		},
	}))
	t.Cleanup(srv.Close)
	c := &Client{Base: func() (string, error) { return srv.URL, nil }}
	f := &fixture{st: st, srv: srv, repo: sub, project: project, tools: map[string]Tool{}}
	for _, tl := range Tools(c, sub) {
		f.tools[tl.Name] = tl
	}
	return f
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// call runs a tool through the server's own result shaping (redaction and
// the size cap), as an agent would see it, and decodes the JSON text.
func (f *fixture) call(t *testing.T, name string, args any) (map[string]any, string) {
	t.Helper()
	tl, ok := f.tools[name]
	if !ok {
		t.Fatalf("no tool %q", name)
	}
	s := &Server{}
	res := s.call(context.Background(), tl, mustJSON(t, args))
	text := res["content"].([]map[string]any)[0]["text"].(string)
	if strings.Contains(text, leakedKey) || strings.Contains(text, "sk-ant-") {
		t.Fatalf("%s returned a credential: %s", name, text)
	}
	if res["isError"] == true {
		return nil, text
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		t.Fatalf("%s: not JSON: %v\n%s", name, err, text)
	}
	return out, ""
}

func TestToolsAreReadOnlyAndDescribed(t *testing.T) {
	f := newFixture(t)
	if len(f.tools) != 11 {
		t.Errorf("%d tools, want 11", len(f.tools))
	}
	for name, tl := range f.tools {
		if tl.Description == "" || tl.Schema["type"] != "object" {
			t.Errorf("%s: missing description or object schema", name)
		}
	}
}

func TestSearchMemories(t *testing.T) {
	f := newFixture(t)
	out, errText := f.call(t, "search_memories", map[string]any{"query": "sso"})
	if errText != "" {
		t.Fatal(errText)
	}
	mems := out["memories"].([]any)
	if len(mems) != 1 {
		t.Fatalf("memories %v", mems)
	}
	m := mems[0].(map[string]any)
	if m["title"] != "Refresh SSO tokens early" || m["project"] != f.project || m["session_id"] != "s-new" {
		t.Errorf("memory %v", m)
	}
	if tp, _ := m["topics"].([]any); len(tp) != 1 || tp[0] != "sso" {
		t.Errorf("topics %v", m["topics"])
	}
	// No query: newest, project-filtered.
	out, _ = f.call(t, "search_memories", map[string]any{"project": "elsewhere"})
	if mems := out["memories"].([]any); len(mems) != 1 || mems[0].(map[string]any)["title"] != "Paginate with cursors" {
		t.Errorf("project filter %v", mems)
	}
}

func TestGetMemoryAndTopics(t *testing.T) {
	f := newFixture(t)
	s, _ := f.call(t, "search_memories", map[string]any{"query": "sso"})
	id := s["memories"].([]any)[0].(map[string]any)["id"]
	out, errText := f.call(t, "get_memory", map[string]any{"id": id})
	if errText != "" {
		t.Fatal(errText)
	}
	links := out["links"].([]any)
	if len(links) != 1 || links[0].(map[string]any)["title"] != "sso" {
		t.Errorf("links %v", links)
	}
	if _, errText := f.call(t, "get_memory", map[string]any{"id": 99999}); !strings.Contains(errText, "not found") {
		t.Errorf("unknown id: %q", errText)
	}
	out, errText = f.call(t, "memory_topics", map[string]any{})
	if errText != "" {
		t.Fatal(errText)
	}
	if tp := out["topics"].([]any); len(tp) != 1 || tp[0].(map[string]any)["title"] != "sso" {
		t.Errorf("topics %v", tp)
	}
	if out["memories"].(float64) != 2 {
		t.Errorf("memories %v", out["memories"])
	}
}

func TestNextSessionHandoff(t *testing.T) {
	f := newFixture(t)
	out, errText := f.call(t, "next_session_handoff", map[string]any{})
	if errText != "" {
		t.Fatal(errText)
	}
	if out["project"] != f.project {
		t.Errorf("project %v, want %v", out["project"], f.project)
	}
	if mems := out["memories"].([]any); len(mems) != 1 {
		t.Errorf("memories %v", mems)
	}
}

func TestRecentSessionsOfThisRepository(t *testing.T) {
	f := newFixture(t)
	out, errText := f.call(t, "recent_sessions", map[string]any{})
	if errText != "" {
		t.Fatal(errText)
	}
	rows := out["sessions"].([]any)
	if len(rows) != 2 {
		t.Fatalf("sessions %v", rows)
	}
	first := rows[0].(map[string]any)
	if first["id"] != "s-new" || first["title"] != "Fix the login flow" || first["branch"] != "main" {
		t.Errorf("first %v", first)
	}
	if first["loop"] == nil {
		t.Errorf("the loop alert is missing on %v", first)
	}
	for _, k := range []string{"transcript_path", "spawn_command", "pid"} {
		if _, ok := first[k]; ok {
			t.Errorf("%s leaked", k)
		}
	}
	out, _ = f.call(t, "recent_sessions", map[string]any{"all_repos": true, "limit": 1})
	if rows := out["sessions"].([]any); len(rows) != 1 {
		t.Errorf("limit: %v", rows)
	}
}

func TestSessionSummaryAndProse(t *testing.T) {
	f := newFixture(t)
	out, errText := f.call(t, "session_summary", map[string]any{"session_id": "s-new"})
	if errText != "" {
		t.Fatal(errText)
	}
	if out["session"].(map[string]any)["title"] != "Fix the login flow" {
		t.Errorf("summary %v", out)
	}
	if _, errText := f.call(t, "session_summary", map[string]any{"session_id": "../settings"}); errText == "" {
		t.Error("a path in session_id was accepted")
	}
	out, errText = f.call(t, "session_prose", map[string]any{"session_id": "s-new"})
	if errText != "" {
		t.Fatal(errText)
	}
	notes := out["notes"].([]any)
	if len(notes) != 2 {
		t.Fatalf("notes %v", notes)
	}
	if n := notes[0].(map[string]any); n["fragment"] != true {
		t.Errorf("newest first, marked fragment: %v", n)
	}
	if txt := notes[1].(map[string]any)["text"].(string); !strings.Contains(txt, "[redacted]") {
		t.Errorf("not redacted: %q", txt)
	}
}

func TestSearchProse(t *testing.T) {
	f := newFixture(t)
	out, errText := f.call(t, "search_prose", map[string]any{"query": "pagination"})
	if errText != "" {
		t.Fatal(errText)
	}
	notes := out["notes"].([]any)
	if len(notes) != 1 || notes[0].(map[string]any)["session_id"] != "s-other" {
		t.Errorf("notes %v", notes)
	}
	if _, errText := f.call(t, "search_prose", map[string]any{}); errText == "" {
		t.Error("an empty query was accepted")
	}
}

func TestCost(t *testing.T) {
	f := newFixture(t)
	out, errText := f.call(t, "cost", map[string]any{"days": 3})
	if errText != "" {
		t.Fatal(errText)
	}
	total := out["total"].(map[string]any)
	if total["cost_usd"].(float64) != 1.5 || total["tokens"].(float64) != 1500 {
		t.Errorf("this repository's total %v", total)
	}
	if bm := out["by_model"].([]any); len(bm) != 2 || bm[0].(map[string]any)["model"] != "claude-opus-4-1" {
		t.Errorf("by model %v", bm)
	}
	out, _ = f.call(t, "cost", map[string]any{"all_repos": true})
	if out["total"].(map[string]any)["cost_usd"].(float64) != 10.5 {
		t.Errorf("all repos %v", out["total"])
	}
	if bp := out["by_project"].([]any); len(bp) != 2 || bp[0].(map[string]any)["project"] != "elsewhere" {
		t.Errorf("by project %v", bp)
	}
}

func TestCIStatusWithoutARemote(t *testing.T) {
	f := newFixture(t)
	_, errText := f.call(t, "ci_status", map[string]any{})
	if !strings.Contains(errText, "no git remote") {
		t.Errorf("want the no-remote answer, got %q", errText)
	}
	_, errText = f.call(t, "ci_status", map[string]any{"repo": t.TempDir()})
	if !strings.Contains(errText, "no session") {
		t.Errorf("want the no-session answer, got %q", errText)
	}
}

func TestLoopAlerts(t *testing.T) {
	f := newFixture(t)
	out, errText := f.call(t, "loop_alerts", map[string]any{})
	if errText != "" {
		t.Fatal(errText)
	}
	alerts := out["alerts"].([]any)
	if len(alerts) != 1 {
		t.Fatalf("alerts %v", alerts)
	}
	a := alerts[0].(map[string]any)
	l := a["loop"].(map[string]any)
	if a["session_id"] != "s-new" || l["tool"] != "Bash" || l["count"].(float64) != 7 || l["reread_tax_usd"].(float64) != 0.42 {
		t.Errorf("alert %v", a)
	}
	if !strings.Contains(l["sample"].(string), "[redacted]") {
		t.Errorf("sample not redacted: %v", l["sample"])
	}
}

func TestDaemonDownIsAToolError(t *testing.T) {
	c := &Client{Base: func() (string, error) { return "", ErrNotRunning }}
	s := &Server{}
	for _, tl := range Tools(c, t.TempDir()) {
		args := `{"session_id":"x","query":"x","id":1}`
		res := s.call(context.Background(), tl, json.RawMessage(args))
		if res["isError"] != true {
			t.Errorf("%s: not an error while the daemon is down", tl.Name)
			continue
		}
		if txt := res["content"].([]map[string]any)[0]["text"].(string); !strings.Contains(txt, "caprock up") {
			t.Errorf("%s: %q does not say how to start it", tl.Name, txt)
		}
	}
}

func TestMCPRespectsVaultConsent(t *testing.T) {
	f := newFixture(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Private journal.md"), []byte("Vaultconfidentialword #private-tag"), 0600); err != nil {
		t.Fatal(err)
	}
	svc := &obsidian.Service{Store: f.st}
	v, _, err := svc.Add(context.Background(), dir, false)
	if err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := f.st.DB().QueryRow(`SELECT id FROM brain_nodes WHERE kind = 'note'`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	out, msg := f.call(t, "search_memories", map[string]any{"query": "Vaultconfidentialword"})
	if msg != "" || len(out["memories"].([]any)) != 0 {
		t.Fatalf("private search: %v %s", out, msg)
	}
	if _, msg := f.call(t, "get_memory", map[string]any{"id": id}); !strings.Contains(msg, "not found") {
		t.Fatalf("private id: %s", msg)
	}
	if _, err := svc.SetAgents(context.Background(), v.ID, true); err != nil {
		t.Fatal(err)
	}
	out, msg = f.call(t, "get_memory", map[string]any{"id": id})
	if msg != "" || !strings.Contains(out["memory"].(map[string]any)["summary"].(string), "Vaultconfidentialword") {
		t.Fatalf("allowed read: %v %s", out, msg)
	}
	if _, err := svc.SetAgents(context.Background(), v.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, msg := f.call(t, "get_memory", map[string]any{"id": id}); !strings.Contains(msg, "not found") {
		t.Fatalf("revoked read: %s", msg)
	}
}
