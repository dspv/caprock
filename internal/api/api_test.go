package api

import (
	"bytes"
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
	"github.com/dspv/caprock/internal/update"
)

type env struct {
	srv *httptest.Server
	rec *rollup.Recorder
	st  *store.Store
	now time.Time
	// settings backs /v1/settings and the folder picker's root.
	settings *fakeSettings
}

// setBrowseRoot points the folder picker at a directory the test controls.
func (e *env) setBrowseRoot(t *testing.T, dir string) {
	t.Helper()
	cur := e.settings.Get()
	cur.BrowseRoot = dir
	if err := e.settings.Set(cur); err != nil {
		t.Fatal(err)
	}
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
	// A settings controller, so tests that need one (the folder picker's root)
	// do not have to build a second server.
	settings := &fakeSettings{}
	s := New(Deps{Store: st, Bus: b, Table: tb, Hook: hh, Version: "test", Token: "tok", Settings: settings,
		Now:         func() time.Time { return now.Add(30 * time.Second) },
		ActiveLoops: func(id string) *loop.Alert { return loops[id] },
		Status:      func(context.Context) any { return map[string]string{"ok": "yes"} },
	})
	loops["looper"] = &loop.Alert{Kind: "loop", SessionID: "looper", Tool: "Bash", Count: 5, LastTs: now}
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	return &env{srv: srv, rec: rec, st: st, now: now, settings: settings}
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

// put sends a JSON body, which the forgery guard requires a content type for.
func (e *env) put(t *testing.T, path string, body any) int {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPut, e.srv.URL+path, bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
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
	req.Header.Set("Content-Type", "application/json")
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
	// A reset three hours out, on the env's fixed clock. This fixture used to
	// carry 1900000000 — the year 2030 — which is exactly the implausible
	// sample the endpoint now rejects.
	body := `{"session_id":"s1","five_hour":{"used_percentage":23.5,"resets_at":1787227200}}`
	req, _ := http.NewRequest(http.MethodPost, e.srv.URL+"/v1/statusline", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
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
	if sum.RateLimits.FiveHour.UsedPercentage != 23.5 || sum.RateLimits.FiveHour.ResetsAt != 1787227200 {
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

// fakeSettings is an in-memory SettingsController for the endpoint tests.
type fakeSettings struct{ cur Settings }

// Get mirrors what the daemon's adapter does with the write-only token: it
// reports that one is set and does not hand it back. A fake that returned the
// token would let a leak pass its own test.
func (f *fakeSettings) Get() Settings {
	out := f.cur
	out.ReportBotSet = f.cur.ReportBotToken != ""
	out.GeminiKeySet = f.cur.GeminiAPIKey != ""
	return out
}
func (f *fakeSettings) Set(s Settings) error { f.cur = s; return nil }

// The cap is a number that stops work, so it has to survive a save and it has
// to refuse nonsense.
func TestSettingsCapRoundTripsAndValidates(t *testing.T) {
	e := newEnv(t)
	// Shipped broken once: the field existed on the struct and in the UI but
	// was missing from the PUT decoder, so the panel said "saved" and the
	// daemon kept a cap of zero. The button worked, the feature did not.
	if code := e.put(t, "/v1/settings", map[string]any{"cap_usd_per_day": 280}); code != 200 {
		t.Fatalf("PUT cap: %d", code)
	}
	var got Settings
	if code := e.get(t, "/v1/settings", &got); code != 200 || got.CapUSDPerDay != 280 {
		t.Errorf("cap came back as %v, want 280", got.CapUSDPerDay)
	}

	// Zero is off, and must be settable — otherwise a cap cannot be turned off
	// once it is on.
	if code := e.put(t, "/v1/settings", map[string]any{"cap_usd_per_day": 0}); code != 200 {
		t.Fatalf("PUT zero: %d", code)
	}
	if code := e.get(t, "/v1/settings", &got); code != 200 || got.CapUSDPerDay != 0 {
		t.Errorf("cap came back as %v, want 0", got.CapUSDPerDay)
	}

	// A negative ceiling is a 400, not a silently clamped zero: coercing it
	// would disable the cap while answering 200.
	if code := e.put(t, "/v1/settings", map[string]any{"cap_usd_per_day": -5}); code != 400 {
		t.Errorf("negative cap: %d, want 400", code)
	}
}

// The settings endpoint must validate rather than coerce: a wrong plan kind or
// a nonsense price would otherwise drive a wrong headline number on the value
// screen, which is exactly the class of invented figure rule 6 forbids.
func TestSettingsValidation(t *testing.T) {
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	tb, _ := cost.Embedded()
	fs := &fakeSettings{}
	s := New(Deps{Store: st, Bus: bus.New(), Table: tb, Version: "test",
		Now:      time.Now,
		Status:   func(context.Context) any { return map[string]string{} },
		Settings: fs,
	})
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)

	put := func(body string) int {
		req, _ := http.NewRequest(http.MethodPut, srv.URL+"/v1/settings", strings.NewReader(body))
		// What ui/src/lib/api.ts actually sends; the origin guard requires it.
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}

	if code := put(`{"plan_kind":"flat","plan_label":"Max","plan_usd_per_month":200}`); code != 200 {
		t.Fatalf("valid flat plan: got %d", code)
	}
	if fs.cur.PlanUSDPerMonth != 200 || fs.cur.PlanKind != "flat" {
		t.Fatalf("not persisted: %+v", fs.cur)
	}
	if code := put(`{"plan_kind":"metered"}`); code != 200 {
		t.Fatalf("metered plan: got %d", code)
	}
	for _, bad := range []string{
		`{"plan_kind":"enterprise-ish"}`,
		`{"plan_kind":"flat","plan_usd_per_month":-5}`,
		`{"plan_kind":`,
	} {
		if code := put(bad); code != http.StatusBadRequest {
			t.Fatalf("expected 400 for %s, got %d", bad, code)
		}
	}

	// A daemon without settings support answers 501, not a panic.
	s2 := New(Deps{Store: st, Bus: bus.New(), Table: tb, Version: "test",
		Now: time.Now, Status: func(context.Context) any { return map[string]string{} }})
	srv2 := httptest.NewServer(s2)
	t.Cleanup(srv2.Close)
	resp, err := http.Get(srv2.URL + "/v1/settings")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotImplemented {
		t.Fatalf("no settings controller: got %d", resp.StatusCode)
	}
}

// fakeUpdate records whether the checker was consulted.
type fakeUpdate struct {
	checks int
	st     update.Status
}

func (f *fakeUpdate) Status(enabled bool, current string) update.Status {
	f.st.Enabled, f.st.Current = enabled, current
	return f.st
}
func (f *fakeUpdate) Check(context.Context, bool) error { f.checks++; return nil }

// The opt-in for the one outbound call Caprock makes must be enforced by the
// server, not merely hidden in the UI: no page and no local script may cause a
// network call the user did not enable.
func TestUpdateCheckRequiresOptIn(t *testing.T) {
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	tb, _ := cost.Embedded()
	set := &fakeSettings{}
	upd := &fakeUpdate{}
	s := New(Deps{Store: st, Bus: bus.New(), Table: tb, Version: "v0.8.0",
		Now: time.Now, Status: func(context.Context) any { return map[string]string{} },
		Settings: set, Update: upd,
	})
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)

	// Checks are off by default: the request is refused and nothing is fetched.
	resp, err := http.Post(srv.URL+"/v1/update/check", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 while checks are off, got %d", resp.StatusCode)
	}
	if upd.checks != 0 {
		t.Fatalf("a disabled checker was consulted %d times", upd.checks)
	}

	// Reading status never performs I/O, even once enabled.
	set.cur.UpdateChecks = true
	r2, err := http.Get(srv.URL + "/v1/update")
	if err != nil {
		t.Fatal(err)
	}
	_ = r2.Body.Close()
	if r2.StatusCode != http.StatusOK {
		t.Fatalf("GET /v1/update: %d", r2.StatusCode)
	}
	if upd.checks != 0 {
		t.Fatal("reading status must not trigger a network call")
	}

	// With the user's consent, an explicit check runs.
	r3, err := http.Post(srv.URL+"/v1/update/check", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = r3.Body.Close()
	if r3.StatusCode != http.StatusOK || upd.checks != 1 {
		t.Fatalf("enabled check: status=%d checks=%d", r3.StatusCode, upd.checks)
	}
}

// Statusline values are relayed from Claude Code and were stored on trust,
// which is how a five-hour window came to claim it resets in 2030 — a figure
// the dashboard then presented as a fact beside a percentage.
func TestPlausibleRateWindow(t *testing.T) {
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC).UnixMilli()
	sec := func(hours int) int64 { return now/1000 + int64(hours)*3600 }

	cases := []struct {
		name string
		in   rateWindowIn
		want bool
	}{
		{"a normal five-hour window", rateWindowIn{UsedPercentage: 23.5, ResetsAt: sec(3)}, true},
		{"a seven-day window", rateWindowIn{UsedPercentage: 27, ResetsAt: sec(24 * 6)}, true},
		{"already reset — stale but real, the UI labels it", rateWindowIn{UsedPercentage: 27, ResetsAt: sec(-9)}, true},
		{"no reset time at all", rateWindowIn{UsedPercentage: 10}, true},
		{"the year-2030 reset that motivated this", rateWindowIn{UsedPercentage: 23.5, ResetsAt: 1_900_000_000}, false},
		{"a percentage above 100", rateWindowIn{UsedPercentage: 140, ResetsAt: sec(1)}, false},
		{"a negative percentage", rateWindowIn{UsedPercentage: -1, ResetsAt: sec(1)}, false},
	}
	for _, c := range cases {
		if got := plausibleRateWindow(c.in, now); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

// writeJSON used to write 200 and then encode, discarding the error — so one
// unserializable value produced HTTP 200 with an empty body. The dashboard
// threw parsing that, and nothing appeared in the logs.
func TestWriteJSONFailsHonestly(t *testing.T) {
	rec := httptest.NewRecorder()
	// A channel cannot be marshalled; any encoder failure has the same shape.
	writeJSON(rec, http.StatusOK, map[string]any{"bad": make(chan int)})
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 rather than a lying 200", rec.Code)
	}
	if rec.Body.Len() == 0 {
		t.Fatal("an error response must still have a body")
	}

	rec2 := httptest.NewRecorder()
	writeJSON(rec2, http.StatusOK, map[string]string{"ok": "yes"})
	if rec2.Code != http.StatusOK || !strings.Contains(rec2.Body.String(), "yes") {
		t.Fatalf("normal responses must be unaffected: %d %q", rec2.Code, rec2.Body.String())
	}
}

// `range=90d` used to fall through to "today", so a longer range reported
// FEWER sessions than a shorter one — the kind of wrong answer that looks
// like a real one.
func TestRangeFromDaySuffix(t *testing.T) {
	e := newEnv(t)
	srv := &Server{d: Deps{Now: func() time.Time { return e.now }}}

	for _, c := range []struct {
		in    string
		label string
	}{
		{"90d", "90d"},
		{"1d", "1d"},
		{"365D", "365D"},
		{"today", "today"},
		{"7d", "7d"},
		{"abc", "today"},    // unreadable: today is the honest fallback
		{"0d", "today"},     // a zero-day range is meaningless
		{"-5d", "today"},    // negative likewise
		{"99999d", "today"}, // beyond the bound
	} {
		from, label := srv.rangeFrom(c.in)
		if label != c.label {
			t.Errorf("rangeFrom(%q) label = %q, want %q", c.in, label, c.label)
		}
		if from > e.now.UnixMilli() {
			t.Errorf("rangeFrom(%q) starts in the future", c.in)
		}
	}

	// The ordering that was broken: a longer range must start earlier.
	d30, _ := srv.rangeFrom("30d")
	d90, _ := srv.rangeFrom("90d")
	if d90 >= d30 {
		t.Fatalf("90d must start before 30d, got %d vs %d", d90, d30)
	}
}

// Every figure in the Today panel must answer for the same agent.
//
// "Burn now" sits in one grid row with "cost today", under one header carrying
// the agent chips. It was computed without the filter, so choosing `opencode`
// narrowed the cost beside it and left the burn showing every agent's money —
// the mistake the comment on handleSummary rejects, made one tile to the right.
func TestBurnNarrowsWithTheAgentFilter(t *testing.T) {
	e := newEnv(t)
	dir := t.TempDir()
	e.seed(t, dir) // s1: claude, 100 in / 200 out, priced

	ctx := context.Background()
	cost := 4.0
	if _, err := e.rec.Record(ctx, &event.Event{
		SessionID: "oc1", Source: event.SourceOpenCode, Kind: event.KindTurnAssistant,
		// Inside the burn window, which is measured against the wall clock the
		// daemon runs on rather than the recorder's fixed test time.
		Key: "msg:oc1", Ts: time.Now().Add(-time.Minute), Model: "claude-sonnet-5",
		Tokens: &event.TokenDelta{In: 10, Out: 20}, CostUSD: &cost,
	}, rollup.SessionInfo{Cwd: dir}); err != nil {
		t.Fatal(err)
	}
	// After Record: recording upserts the session itself and would otherwise
	// put the agent back to the default.
	if err := store.UpsertSession(ctx, e.st.DB(), "oc1", store.SessionPatch{Agent: "opencode"}); err != nil {
		t.Fatal(err)
	}

	var all, oc SummaryResponse
	if code := e.get(t, "/v1/stats/summary?range=today", &all); code != 200 {
		t.Fatalf("summary: %d", code)
	}
	if code := e.get(t, "/v1/stats/summary?range=today&agent=opencode", &oc); code != 200 {
		t.Fatalf("summary filtered: %d", code)
	}

	if oc.Burn.USDPerHour >= all.Burn.USDPerHour {
		t.Errorf("burn did not narrow: opencode %.4f/h against everything %.4f/h",
			oc.Burn.USDPerHour, all.Burn.USDPerHour)
	}
	// The filtered burn must be OpenCode's own money, not a share of the whole.
	if want := cost / (10.0 / 60.0); oc.Burn.USDPerHour != want {
		t.Errorf("burn = %.4f/h, want %.4f/h — the one session's own cost", oc.Burn.USDPerHour, want)
	}
	if oc.Burn.Turns != 1 {
		t.Errorf("turns = %d, want 1 — only the opencode turn is in scope", oc.Burn.Turns)
	}
}

// The burn rate divides by the time it actually covers.
//
// A daemon three minutes old has three minutes of history, and dividing that
// by the window's full ten made the rate read a third of the truth with
// nothing saying the window was still filling. The spark on the same screen
// already refuses to extrapolate its last bucket; this is the same rule for
// the tile beside it.
func TestBurnDividesByTheTimeItCovers(t *testing.T) {
	now := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	cost := 1.0

	for _, tc := range []struct {
		name    string
		started time.Time
		wantUSD float64
	}{
		{"a mature daemon divides by the whole window", now.Add(-time.Hour), 6.0},
		{"a two-minute-old daemon divides by two minutes", now.Add(-2 * time.Minute), 30.0},
		{"an unknown start falls back to the window", time.Time{}, 6.0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			ctx := context.Background()
			if _, err := e.rec.Record(ctx, &event.Event{
				SessionID: "s-burn", Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
				Key: "burn-1", Ts: now.Add(-time.Minute), Model: "claude-opus-5",
				Tokens: &event.TokenDelta{In: 100, Out: 100}, CostUSD: &cost,
			}, rollup.SessionInfo{Cwd: t.TempDir()}); err != nil {
				t.Fatal(err)
			}

			// A server whose clock and start time this case controls. The
			// shared env fixes `now` 30s ahead, which is inside the window.
			srv := New(Deps{
				Store: e.st, Version: "test", Token: "tok",
				Now:     func() time.Time { return now },
				Started: tc.started,
			})
			ts := httptest.NewServer(srv)
			defer ts.Close()

			res, err := http.Get(ts.URL + "/v1/stats/summary?range=today")
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			var sum SummaryResponse
			if err := json.NewDecoder(res.Body).Decode(&sum); err != nil {
				t.Fatal(err)
			}
			if got := sum.Burn.USDPerHour; got < tc.wantUSD*0.99 || got > tc.wantUSD*1.01 {
				t.Fatalf("burn = %.2f/h, want about %.2f/h", got, tc.wantUSD)
			}
		})
	}
}
