package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/hookd"
	"github.com/dspv/caprock/internal/loop"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

type env struct {
	srv *httptest.Server
	rec *rollup.Recorder
	st  *store.Store
	now time.Time
}

func newEnv(t *testing.T) *env {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	tb, _ := cost.Embedded()
	b := bus.New()
	rec := rollup.New(st, tb, b, nil)
	now := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	rec.Now = func() time.Time { return now }
	rec.Location = time.UTC
	hh := &hookd.Handler{Token: "tok", Recorder: rec}
	var loops = map[string]*loop.Alert{}
	s := New(Deps{Store: st, Bus: b, Table: tb, Hook: hh, Version: "test", Token: "tok",
		Now:         func() time.Time { return now.Add(30 * time.Second) },
		ActiveLoops: func(id string) *loop.Alert { return loops[id] },
		Status:      func(context.Context) any { return map[string]string{"ok": "yes"} },
	})
	loops["looper"] = &loop.Alert{Kind: "loop", SessionID: "looper", Tool: "Bash", Count: 5, LastTs: now}
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	return &env{srv: srv, rec: rec, st: st, now: now}
}

func (e *env) get(t *testing.T, path string, out any) int {
	t.Helper()
	resp, err := http.Get(e.srv.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if out != nil && resp.StatusCode == 200 {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
	}
	return resp.StatusCode
}

func (e *env) seed(t *testing.T, cwd string) {
	t.Helper()
	ctx := context.Background()
	c := 0.0
	evs := []*event.Event{
		{SessionID: "s1", Source: event.SourceHook, Kind: event.KindTurnUser, Key: "prompt:p1", Ts: e.now, Payload: json.RawMessage(`{"prompt":"go"}`)},
		{SessionID: "s1", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Edit", Key: "pre:t1", Ts: e.now.Add(time.Second), Payload: json.RawMessage(`{"tool_name":"Edit","tool_input":{"file_path":"` + filepath.ToSlash(cwd) + `/main.go"}}`)},
		{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: "msg:m1", Ts: e.now.Add(2 * time.Second), Model: "claude-opus-5", Tokens: &event.TokenDelta{In: 100, Out: 200, CacheRead: 1000, CacheWrite: 500}, Payload: json.RawMessage(`{"text":"hi"}`)},
	}
	_ = c
	for _, ev := range evs {
		if _, err := e.rec.Record(ctx, ev, rollup.SessionInfo{Cwd: cwd}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSessionsAndDetail(t *testing.T) {
	e := newEnv(t)
	dir := t.TempDir()
	e.seed(t, dir)
	var list []SessionSummary
	if code := e.get(t, "/v1/sessions?active=true", &list); code != 200 || len(list) != 1 {
		t.Fatalf("sessions: %d %+v", code, list)
	}
	s := list[0]
	if s.SessionID != "s1" || s.Stats.Turns != 1 || s.Stats.ToolCalls != 1 || s.Stats.FilesTouched != 1 || s.Activity.Phrase != "responding" || s.Activity.Health != "working" {
		t.Fatalf("summary: %+v", s)
	}
	if s.Context == nil || s.Context.Window != 1_000_000 || s.Context.Tokens != 1600 {
		t.Fatalf("context fill: %+v", s.Context)
	}
	if s.Savings.HitRate <= 0 {
		t.Fatalf("savings: %+v", s.Savings)
	}
	var det SessionDetail
	if code := e.get(t, "/v1/sessions/s1", &det); code != 200 || len(det.Events) != 3 || len(det.Files) != 1 {
		t.Fatalf("detail: %d %+v", code, det)
	}
	if code := e.get(t, "/v1/sessions/nope", nil); code != 404 {
		t.Fatalf("missing session: %d", code)
	}
	var evs []event.Event
	if code := e.get(t, "/v1/sessions/s1/events?after=1&limit=10", &evs); code != 200 || len(evs) != 2 {
		t.Fatalf("events after: %d %d", code, len(evs))
	}
	if code := e.get(t, "/v1/events?after=0", &evs); code != 200 || len(evs) != 3 {
		t.Fatalf("feed: %d %d", code, len(evs))
	}
}

// The History screen's endpoint (GET /v1/history) must return the lifetime
// totals and tool distribution over the range — the store query is tested
// elsewhere; this covers the HTTP handler (range parse + JSON shape).
func TestHistoryEndpoint(t *testing.T) {
	e := newEnv(t)
	e.seed(t, t.TempDir())
	var hist struct {
		Range string `json:"range"`
		Tools []struct {
			Tool  string `json:"tool"`
			Count int    `json:"count"`
		} `json:"tools"`
		Totals struct {
			ToolCalls int `json:"tool_calls"`
			Turns     int `json:"turns"`
		} `json:"totals"`
	}
	if code := e.get(t, "/v1/history?range=all", &hist); code != 200 {
		t.Fatalf("history: %d", code)
	}
	// The seed produced one Edit tool call and one user turn.
	var edits int
	for _, td := range hist.Tools {
		if td.Tool == "Edit" {
			edits = td.Count
		}
	}
	if edits != 1 {
		t.Fatalf("history tool distribution missing Edit: %+v", hist.Tools)
	}
	if hist.Totals.ToolCalls < 1 || hist.Totals.Turns < 1 {
		t.Fatalf("history totals empty: %+v", hist.Totals)
	}
}

func TestDiffEndpoint(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	e := newEnv(t)
	dir := t.TempDir()
	e.seed(t, dir)
	// Not a git repo yet → 409.
	if code := e.get(t, "/v1/sessions/s1/diff", nil); code != 409 {
		t.Fatalf("non-repo diff: %d", code)
	}
	cmd := exec.Command("git", "-C", dir, "init", "-q")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	_ = os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n"), 0o600)
	var res struct {
		Files []struct{ Path, Status string } `json:"files"`
	}
	if code := e.get(t, "/v1/sessions/s1/diff", &res); code != 200 || len(res.Files) != 1 || res.Files[0].Status != "untracked" {
		t.Fatalf("diff: %d %+v", code, res)
	}
}

func TestStatsSummaryAndDaily(t *testing.T) {
	e := newEnv(t)
	e.seed(t, t.TempDir())
	var sum SummaryResponse
	if code := e.get(t, "/v1/stats/summary?range=today", &sum); code != 200 {
		t.Fatalf("summary: %d", code)
	}
	if sum.Turns != 1 || sum.TokensOut != 200 || sum.CostUSD <= 0 || len(sum.Models) != 1 || sum.Models[0].Model != "claude-opus-5" || sum.Pricing == "" {
		t.Fatalf("summary: %+v", sum)
	}
	if sum.Burn.WindowMin != 10 || sum.Burn.USDPerHour <= 0 {
		t.Fatalf("burn: %+v", sum.Burn)
	}
	var daily []store.DailyStat
	if code := e.get(t, "/v1/stats/daily?days=7", &daily); code != 200 || len(daily) != 1 || daily[0].Day != "2026-08-18" {
		t.Fatalf("daily: %d %+v", code, daily)
	}
	if code := e.get(t, "/v1/stats/summary?range=all", &sum); code != 200 || sum.Range != "all" {
		t.Fatalf("all: %d %+v", code, sum.Range)
	}
}

func TestStatusPricingHealthAndUI(t *testing.T) {
	e := newEnv(t)
	var st map[string]string
	if code := e.get(t, "/v1/status", &st); code != 200 || st["ok"] != "yes" {
		t.Fatalf("status: %d %v", code, st)
	}
	var tb cost.Table
	if code := e.get(t, "/v1/pricing", &tb); code != 200 || tb.Version == "" {
		t.Fatalf("pricing: %d", code)
	}
	if code := e.get(t, "/healthz", nil); code != 200 {
		t.Fatalf("healthz: %d", code)
	}
	resp, _ := http.Get(e.srv.URL + "/some/spa/route")
	body := make([]byte, 4096)
	n, _ := resp.Body.Read(body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(string(body[:n]), "<!doctype html>") {
		t.Fatalf("spa fallback: %d %q", resp.StatusCode, body[:n])
	}
	// Cross-site origin refused on the API.
	req, _ := http.NewRequest(http.MethodGet, e.srv.URL+"/v1/sessions", nil)
	req.Header.Set("Origin", "https://evil.example")
	resp, _ = http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("cross-origin: %d", resp.StatusCode)
	}
	// Shutdown gated by token.
	req, _ = http.NewRequest(http.MethodPost, e.srv.URL+"/v1/shutdown", nil)
	resp, _ = http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("shutdown without token: %d", resp.StatusCode)
	}
}

func TestHookRouteAndLoopFlag(t *testing.T) {
	e := newEnv(t)
	body := strings.NewReader(`{"session_id":"looper","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"x"},"tool_use_id":"t9","cwd":"/p"}`)
	req, _ := http.NewRequest(http.MethodPost, e.srv.URL+"/v1/hook", body)
	req.Header.Set("Authorization", "Bearer tok")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 204 {
		t.Fatalf("hook: %d", resp.StatusCode)
	}
	var list []SessionSummary
	e.get(t, "/v1/sessions", &list)
	if len(list) != 1 || list[0].Loop == nil || list[0].Activity.Health != "looping" {
		t.Fatalf("loop flag: %+v", list)
	}
}

func TestLiveWebSocketDeliversEvents(t *testing.T) {
	e := newEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(e.srv.URL, "http") + "/v1/live"
	c, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"http://localhost:5173"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	_, hello, err := c.Read(ctx)
	if err != nil || !strings.Contains(string(hello), `"hello"`) {
		t.Fatalf("hello: %v %s", err, hello)
	}
	e.seed(t, t.TempDir())
	var kinds []string
	for len(kinds) < 2 {
		_, msg, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var f struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(msg, &f)
		kinds = append(kinds, f.Type)
	}
	if kinds[0] != "event" || kinds[1] != "session" {
		t.Fatalf("frames: %v", kinds)
	}
	// Foreign origin refused.
	if _, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"https://evil.example"}}}); err == nil {
		t.Fatal("foreign origin accepted on /v1/live")
	}
}

// The statusline endpoint records rate-limit windows (bearer-gated), and the
// summary endpoint then surfaces them as current window state.
func TestStatuslineEndpointAndSummary(t *testing.T) {
	e := newEnv(t)
	// Unauthorized without the bearer token.
	body := `{"session_id":"s1","five_hour":{"used_percentage":23.5,"resets_at":1900000000}}`
	req, _ := http.NewRequest(http.MethodPost, e.srv.URL+"/v1/statusline", strings.NewReader(body))
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != 401 {
		t.Fatalf("statusline without token: %d", resp.StatusCode)
	}
	resp.Body.Close()
	// With the token → 204.
	req, _ = http.NewRequest(http.MethodPost, e.srv.URL+"/v1/statusline", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 204 {
		t.Fatalf("statusline: %v %d", err, resp.StatusCode)
	}
	resp.Body.Close()
	// Summary now carries the five_hour window (current state, not a forecast).
	var sum struct {
		RateLimits *struct {
			FiveHour *struct {
				UsedPercentage float64 `json:"used_percentage"`
				ResetsAt       int64   `json:"resets_at"`
				Forecast       string  `json:"forecast"`
			} `json:"five_hour"`
		} `json:"rate_limits"`
	}
	if code := e.get(t, "/v1/stats/summary", &sum); code != 200 {
		t.Fatalf("summary: %d", code)
	}
	if sum.RateLimits == nil || sum.RateLimits.FiveHour == nil {
		t.Fatalf("summary missing rate_limits: %+v", sum)
	}
	if sum.RateLimits.FiveHour.UsedPercentage != 23.5 || sum.RateLimits.FiveHour.ResetsAt != 1900000000 {
		t.Fatalf("wrong window: %+v", sum.RateLimits.FiveHour)
	}
	// One snapshot → no forecast (honest: needs ≥2 rising samples).
	if sum.RateLimits.FiveHour.Forecast != "" {
		t.Fatalf("forecast from a single snapshot: %q", sum.RateLimits.FiveHour.Forecast)
	}
}

// paceForecast is the honest "at current pace" gate for plan limits (Rule 6: no
// invented numbers). It forecasts only when the measured slope would reach the
// limit before the window resets — and stays silent otherwise. Uses the
// injectable clock, so this is deterministic.
func TestPaceForecastHonesty(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	// A fixed "now"; the window resets 4 hours later.
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	reset := now.Add(4 * time.Hour).Unix()
	s := New(Deps{Store: st, Version: "test", Token: "tok", Now: func() time.Time { return now }})

	// Seed a rising slope: 40% → 50% over 2 minutes = 300 %/hour (steep). From 50%
	// that hits 100% in ~10 minutes — well before the 4h reset → a forecast.
	base := now.Add(-2 * time.Minute).UnixMilli()
	_ = store.RecordRateLimit(ctx, st.DB(), store.RateLimitSnapshot{Window: "five_hour", Ts: base, UsedPercentage: 40, ResetsAt: reset}, "s1")
	_ = store.RecordRateLimit(ctx, st.DB(), store.RateLimitSnapshot{Window: "five_hour", Ts: now.UnixMilli(), UsedPercentage: 50, ResetsAt: reset}, "s1")
	snap := store.RateLimitSnapshot{Window: "five_hour", UsedPercentage: 50, ResetsAt: reset}
	if f := s.paceForecast(ctx, "five_hour", snap); f == "" || !strings.Contains(f, "limit at current pace") {
		t.Fatalf("expected a forecast for a steep rising slope, got %q", f)
	}

	// At 100% used → never a forecast.
	if f := s.paceForecast(ctx, "five_hour", store.RateLimitSnapshot{Window: "five_hour", UsedPercentage: 100, ResetsAt: reset}); f != "" {
		t.Fatalf("forecast at 100%%: %q", f)
	}

	// A gentle slope that resets before the limit → no forecast. 50% → 50.1% over
	// 2 min = 3 %/hour; from 50% that's ~16h to limit, past the 4h reset.
	base2 := now.Add(-2 * time.Minute).UnixMilli()
	_ = store.RecordRateLimit(ctx, st.DB(), store.RateLimitSnapshot{Window: "seven_day", Ts: base2, UsedPercentage: 50, ResetsAt: reset}, "s1")
	_ = store.RecordRateLimit(ctx, st.DB(), store.RateLimitSnapshot{Window: "seven_day", Ts: now.UnixMilli(), UsedPercentage: 50.1, ResetsAt: reset}, "s1")
	if f := s.paceForecast(ctx, "seven_day", store.RateLimitSnapshot{Window: "seven_day", UsedPercentage: 50.1, ResetsAt: reset}); f != "" {
		t.Fatalf("gentle slope that resets first should not forecast, got %q", f)
	}
}
