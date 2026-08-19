// Package api serves the loopback HTTP surface: REST queries under /v1, the
// /v1/live WebSocket, the hook receiver, and the embedded dashboard at /.
// Contract: .ai/03-contracts.md § HTTP API. JSON is snake_case, money is USD
// float, tokens are int64.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/gitdiff"
	"github.com/dspv/caprock/internal/loop"
	"github.com/dspv/caprock/internal/narrate"
	"github.com/dspv/caprock/internal/store"
)

// Deps is everything the API needs from the daemon.
type Deps struct {
	Store   *store.Store
	Bus     *bus.Bus
	Table   *cost.Table
	Log     *slog.Logger
	Hook    http.Handler // POST /v1/hook (hookd)
	UI      fs.FS        // embedded dashboard (index.html at root); nil ⇒ placeholder
	Version string
	// Status returns daemon/ingest/hooks status for /v1/status.
	Status func(ctx context.Context) any
	// ActiveLoops reports whether a session currently has an unexpired loop alert.
	ActiveLoops func(sessionID string) *loop.Alert
	// IdleAfter is the silence threshold for the idle badge.
	IdleAfter time.Duration
	Now       func() time.Time
	// Token gates POST /v1/shutdown (same per-run token the shim uses).
	Token string
	// Shutdown is invoked by POST /v1/shutdown (caprock down).
	Shutdown func()
	// Agents is the Phase 1 owned-session manager (nil ⇒ endpoints return 501).
	Agents AgentController
	// Tasks is the Phase 2 hive-backed task board (nil ⇒ endpoints return 501).
	Tasks TaskController
}

// TaskController is the subset of the Phase 2 hive the API needs.
type TaskController interface {
	List(ctx context.Context) (any, error)
	Create(ctx context.Context, req any) (any, error)
	Get(ctx context.Context, id string) (any, error)
	Approve(ctx context.Context, id string, approve bool) error
	Approvals(ctx context.Context) (any, error)
	// StartOrchestrator spawns the orchestrator session (T21). Returns its info.
	StartOrchestrator(ctx context.Context) (any, error)
	// Verify runs a task's done_criteria (T22). Returns the VerifyResult.
	Verify(ctx context.Context, id string) (any, error)
}

// AgentController is the subset of internal/agents the API needs (interface for tests).
type AgentController interface {
	Available() bool
	Spawn(ctx context.Context, req any) (id string, cwd string, err error)
	Input(sessionID string, data []byte) error
	Signal(sessionID, action string) error
	Resize(sessionID string, cols, rows int) error
	Term(sessionID string) (snapshot []byte, sub <-chan []byte, cancel func(), ok bool)
	Write(sessionID string, data []byte) error
}

// Server is the http.Handler.
type Server struct {
	d   Deps
	mux *http.ServeMux
	ws  *wsHub
}

// New builds the router.
func New(d Deps) *Server {
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.IdleAfter <= 0 {
		d.IdleAfter = 5 * time.Minute
	}
	s := &Server{d: d, mux: http.NewServeMux(), ws: newWSHub(d.Bus, d.Log)}
	m := s.mux
	m.HandleFunc("GET /v1/sessions", s.handleSessions)
	m.HandleFunc("GET /v1/sessions/{id}", s.handleSession)
	m.HandleFunc("GET /v1/sessions/{id}/events", s.handleSessionEvents)
	m.HandleFunc("GET /v1/sessions/{id}/diff", s.handleSessionDiff)
	m.HandleFunc("GET /v1/stats/summary", s.handleSummary)
	m.HandleFunc("GET /v1/stats/daily", s.handleDaily)
	m.HandleFunc("GET /v1/events", s.handleEventsFeed)
	m.HandleFunc("GET /v1/history", s.handleHistory)
	m.HandleFunc("GET /v1/status", s.handleStatus)
	m.HandleFunc("GET /v1/pricing", s.handlePricing)
	m.HandleFunc("GET /v1/live", s.ws.ServeHTTP)
	if d.Hook != nil {
		m.Handle("POST /v1/hook", d.Hook)
	}
	m.HandleFunc("GET /v1/tasks", s.handleTasks)
	m.HandleFunc("POST /v1/tasks", s.handleCreateTask)
	m.HandleFunc("GET /v1/tasks/{id}", s.handleGetTask)
	m.HandleFunc("POST /v1/tasks/{id}/approve", s.handleApprove(true))
	m.HandleFunc("POST /v1/tasks/{id}/reject", s.handleApprove(false))
	m.HandleFunc("POST /v1/tasks/{id}/verify", s.handleVerify)
	m.HandleFunc("GET /v1/approvals", s.handleApprovals)
	m.HandleFunc("POST /v1/orchestrator/start", s.handleStartOrchestrator)
	m.HandleFunc("POST /v1/agents", s.handleSpawn)
	m.HandleFunc("POST /v1/agents/{id}/input", s.handleAgentInput)
	m.HandleFunc("POST /v1/agents/{id}/signal", s.handleAgentSignal)
	m.HandleFunc("GET /v1/agents/{id}/term", s.ws.serveTerm(s))
	m.HandleFunc("POST /v1/shutdown", s.handleShutdown)
	m.HandleFunc("POST /v1/statusline", s.handleStatusline)
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": d.Version})
	})
	m.Handle("/", s.uiHandler())
	return s
}

// ServeHTTP applies loopback-only + security headers, then routes.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	if strings.HasPrefix(r.URL.Path, "/v1/") {
		// Browser same-origin protects the API; refuse cross-site requests explicitly too.
		if o := r.Header.Get("Origin"); o != "" && !isLoopbackOrigin(o) {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			return
		}
	}
	s.mux.ServeHTTP(w, r)
}

// Close shuts down live connections.
func (s *Server) Close() { s.ws.Close() }

func isLoopbackOrigin(origin string) bool {
	o := strings.ToLower(origin)
	return strings.HasPrefix(o, "http://localhost") || strings.HasPrefix(o, "http://127.0.0.1") || strings.HasPrefix(o, "http://[::1]")
}

// --- DTOs ---

// SessionSummary is one Now-screen card.
type SessionSummary struct {
	store.Session
	Stats    store.Stats      `json:"stats"`
	Activity narrate.Activity `json:"activity"`
	Savings  cost.Savings     `json:"savings"`
	Loop     *loop.Alert      `json:"loop,omitempty"`
	Context  *ContextFill     `json:"context,omitempty"`
}

// ContextFill is the "context fill %" badge input: last turn's prompt size vs the model window.
type ContextFill struct {
	Tokens int64   `json:"tokens"`
	Window int64   `json:"window"`
	Pct    float64 `json:"pct"`
}

// SessionDetail is /v1/sessions/{id}.
type SessionDetail struct {
	SessionSummary
	Files  []string      `json:"files"`
	Events []event.Event `json:"events"`
}

func (s *Server) summarize(ctx context.Context, sess store.Session) (SessionSummary, []event.Event, error) {
	q := s.d.Store.DB()
	st, err := store.GetStats(ctx, q, sess.SessionID)
	if err != nil {
		return SessionSummary{}, nil, err
	}
	last, err := store.LastEvents(ctx, q, sess.SessionID, 60)
	if err != nil {
		return SessionSummary{}, nil, err
	}
	var la *loop.Alert
	if s.d.ActiveLoops != nil {
		la = s.d.ActiveLoops(sess.SessionID)
	}
	act := narrate.Summarize(last, narrate.Options{Now: s.d.Now(), IdleAfter: s.d.IdleAfter, Looping: la != nil, SessionEnded: sess.Status == store.StatusEnded})
	if act.Health == narrate.HealthWorking && sess.Status == store.StatusIdle {
		act.Health = narrate.HealthIdle
		act.Phrase = "was " + act.Phrase
	}
	sum := SessionSummary{Session: sess, Stats: st, Activity: act, Savings: cost.ComputeSavings(st.TokensIn, st.CacheRead, st.CacheWrite), Loop: la}
	// Context fill: last assistant turn's input+cache tokens vs the model's window.
	for i := len(last) - 1; i >= 0; i-- {
		e := last[i]
		if e.Kind == event.KindTurnAssistant && e.Tokens != nil {
			if s.d.Table != nil {
				if row, ok := s.d.Table.Lookup(firstNonEmpty(e.Model, sess.Model)); ok && row.ContextWindow > 0 {
					toks := e.Tokens.In + e.Tokens.CacheRead + e.Tokens.CacheWrite
					sum.Context = &ContextFill{Tokens: toks, Window: row.ContextWindow, Pct: 100 * float64(toks) / float64(row.ContextWindow)}
				}
			}
			break
		}
	}
	return sum, last, nil
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// --- handlers ---

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	active := r.URL.Query().Get("active") == "true"
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	sessions, err := store.ListSessions(ctx, s.d.Store.DB(), active, limit)
	if err != nil {
		s.fail(w, err)
		return
	}
	out := make([]SessionSummary, 0, len(sessions))
	for _, sess := range sessions {
		sum, _, err := s.summarize(ctx, sess)
		if err != nil {
			s.fail(w, err)
			return
		}
		out = append(out, sum)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	sess, err := store.GetSession(ctx, s.d.Store.DB(), id)
	if err != nil {
		s.notFoundOrFail(w, err)
		return
	}
	sum, last, err := s.summarize(ctx, sess)
	if err != nil {
		s.fail(w, err)
		return
	}
	files, err := store.SessionFiles(ctx, s.d.Store.DB(), id, 100)
	if err != nil {
		s.fail(w, err)
		return
	}
	if files == nil {
		files = []string{}
	}
	if last == nil {
		last = []event.Event{}
	}
	writeJSON(w, http.StatusOK, SessionDetail{SessionSummary: sum, Files: files, Events: last})
}

func (s *Server) handleSessionEvents(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	evs, err := store.ListEvents(r.Context(), s.d.Store.DB(), id, after, limit)
	if err != nil {
		s.fail(w, err)
		return
	}
	if evs == nil {
		evs = []event.Event{}
	}
	writeJSON(w, http.StatusOK, evs)
}

func (s *Server) handleEventsFeed(w http.ResponseWriter, r *http.Request) {
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	evs, err := store.EventsAfter(r.Context(), s.d.Store.DB(), after, limit)
	if err != nil {
		s.fail(w, err)
		return
	}
	if evs == nil {
		evs = []event.Event{}
	}
	writeJSON(w, http.StatusOK, evs)
}

func (s *Server) handleSessionDiff(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	sess, err := store.GetSession(ctx, s.d.Store.DB(), r.PathValue("id"))
	if err != nil {
		s.notFoundOrFail(w, err)
		return
	}
	if sess.Cwd == "" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "session has no known working directory"})
		return
	}
	res, err := gitdiff.Diff(ctx, sess.Cwd)
	if errors.Is(err, gitdiff.ErrNotARepo) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "not a git repository", "cwd": sess.Cwd})
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// rangeFrom maps ?range= to a start time. Ranges are calendar-aware in the
// daemon's local time zone (the user's "today").
func (s *Server) rangeFrom(rng string) (int64, string) {
	now := s.d.Now()
	y, m, d := now.Date()
	midnight := time.Date(y, m, d, 0, 0, 0, 0, now.Location())
	switch rng {
	case "", "today":
		return midnight.UnixMilli(), "today"
	case "7d":
		return midnight.AddDate(0, 0, -6).UnixMilli(), "7d"
	case "30d":
		return midnight.AddDate(0, 0, -29).UnixMilli(), "30d"
	case "all":
		return 0, "all"
	}
	if d, err := time.ParseDuration(rng); err == nil && d > 0 {
		return now.Add(-d).UnixMilli(), rng
	}
	return midnight.UnixMilli(), "today"
}

// SummaryResponse extends the store summary with burn rate and savings.
type SummaryResponse struct {
	store.Summary
	Savings    cost.Savings `json:"savings"`
	Burn       Burn         `json:"burn"`
	Pricing    string       `json:"pricing_version"`
	Throttles  int64        `json:"throttles"`             // rate-limit/overloaded events in range (honest signal, not a forecast)
	RateLimits *RateLimits  `json:"rate_limits,omitempty"` // live window state from Claude Code's statusline (Pro/Max only); nil when unknown
}

// RateLimits is the current plan-limit window state (from the statusline feed).
type RateLimits struct {
	FiveHour *RateWindow `json:"five_hour,omitempty"`
	SevenDay *RateWindow `json:"seven_day,omitempty"`
}

// RateWindow is one window's measured state plus an optional honest forecast.
type RateWindow struct {
	UsedPercentage float64 `json:"used_percentage"` // 0..100, measured
	ResetsAt       int64   `json:"resets_at"`       // unix seconds, from Claude Code
	// Forecast is a conditional "~Nh to limit at current pace" — present only when
	// the measured slope is rising and exhaustion is projected before the reset.
	// nil ⇒ show only the measured fact (no guess).
	Forecast string `json:"forecast,omitempty"`
}

// Burn is the recent spend rate ("$/hr equivalent, tokens/min") over a short window.
type Burn struct {
	WindowMin  int     `json:"window_min"`
	USDPerHour float64 `json:"usd_per_hour"`
	TokPerMin  float64 `json:"tokens_per_min"`
	Turns      int64   `json:"turns"`
}

func (s *Server) handleSummary(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	from, label := s.rangeFrom(r.URL.Query().Get("range"))
	sum, err := store.Summarize(ctx, s.d.Store.DB(), from)
	if err != nil {
		s.fail(w, err)
		return
	}
	sum.Range = label
	if sum.Models == nil {
		sum.Models = []store.ModelShare{}
	}
	if sum.Projects == nil {
		sum.Projects = []store.ProjectShare{}
	}
	resp := SummaryResponse{Summary: sum, Savings: cost.ComputeSavings(sum.TokensIn, sum.CacheRead, sum.CacheWrite)}
	if s.d.Table != nil {
		resp.Pricing = s.d.Table.Version
	}
	// Burn over the last 10 minutes.
	const win = 10 * time.Minute
	recent, err := store.Summarize(ctx, s.d.Store.DB(), s.d.Now().Add(-win).UnixMilli())
	if err == nil {
		resp.Burn = Burn{WindowMin: int(win / time.Minute), Turns: recent.Turns,
			USDPerHour: recent.CostUSD / win.Hours(),
			TokPerMin:  float64(recent.TokensIn+recent.TokensOut+recent.CacheRead+recent.CacheWrite) / win.Minutes()}
	}
	if n, err := store.CountThrottles(ctx, s.d.Store.DB(), from); err == nil {
		resp.Throttles = n
	}
	// Live rate-limit windows (not range-scoped — this is current state).
	resp.RateLimits = s.rateLimits(ctx)
	writeJSON(w, http.StatusOK, resp)
}

// rateLimits builds the current plan-limit window state from the latest snapshots,
// attaching an honest "at current pace" forecast only when the measured slope
// supports it. Returns nil when no windows are known (non-Pro/Max, or no data yet).
func (s *Server) rateLimits(ctx context.Context) *RateLimits {
	q := s.d.Store.DB()
	var out RateLimits
	any := false
	for _, window := range []string{"five_hour", "seven_day"} {
		snap, ok, err := store.LatestRateLimit(ctx, q, window)
		if err != nil || !ok {
			continue
		}
		rw := &RateWindow{UsedPercentage: snap.UsedPercentage, ResetsAt: snap.ResetsAt}
		rw.Forecast = s.paceForecast(ctx, window, snap)
		if window == "five_hour" {
			out.FiveHour = rw
		} else {
			out.SevenDay = rw
		}
		any = true
	}
	if !any {
		return nil
	}
	return &out
}

// paceForecast returns "~Nh to limit at current pace" only when the observed
// usage slope is rising and exhaustion is projected before the window resets;
// otherwise "" (show only the measured fact). No invented numbers: every input is
// measured and the projection is explicitly pace-conditional.
func (s *Server) paceForecast(ctx context.Context, window string, snap store.RateLimitSnapshot) string {
	if snap.UsedPercentage >= 100 {
		return ""
	}
	pctPerHour, ok, err := store.RateLimitPace(ctx, s.d.Store.DB(), window, snap.ResetsAt)
	if err != nil || !ok || pctPerHour <= 0 {
		return ""
	}
	hoursToLimit := (100 - snap.UsedPercentage) / pctPerHour
	// Only forecast if the limit would be hit before the window resets. Use the
	// daemon's injectable clock (like the rest of the API) so the forecast is
	// consistent and deterministic in tests, not tied to raw wall-clock.
	resetIn := time.Unix(snap.ResetsAt, 0).Sub(s.d.Now())
	if resetIn <= 0 || hoursToLimit >= resetIn.Hours() {
		return "" // resets before the limit at current pace — no warning
	}
	if hoursToLimit < 1 {
		return fmt.Sprintf("~%dm to limit at current pace", int(hoursToLimit*60))
	}
	return fmt.Sprintf("~%.1fh to limit at current pace", hoursToLimit)
}

func (s *Server) handleDaily(w http.ResponseWriter, r *http.Request) {
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	if days <= 0 || days > 3650 {
		days = 30
	}
	from := s.d.Now().AddDate(0, 0, -(days - 1)).Format("2006-01-02")
	rows, err := store.Daily(r.Context(), s.d.Store.DB(), from)
	if err != nil {
		s.fail(w, err)
		return
	}
	if rows == nil {
		rows = []store.DailyStat{}
	}
	writeJSON(w, http.StatusOK, rows)
}

// HistoryResponse is /v1/history.
type HistoryResponse struct {
	Range   string              `json:"range"`
	Totals  store.HistoryTotals `json:"totals"`
	Tools   []store.ToolCount   `json:"tools"`
	Daily   []store.DailyStat   `json:"daily"`
	Savings cost.Savings        `json:"savings"`
	Summary store.Summary       `json:"summary"`
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	from, label := s.rangeFrom(r.URL.Query().Get("range"))
	q := s.d.Store.DB()
	tot, err := store.History(ctx, q, from)
	if err != nil {
		s.fail(w, err)
		return
	}
	tools, err := store.ToolDistribution(ctx, q, from, 40)
	if err != nil {
		s.fail(w, err)
		return
	}
	sum, err := store.Summarize(ctx, q, from)
	if err != nil {
		s.fail(w, err)
		return
	}
	if sum.Models == nil {
		sum.Models = []store.ModelShare{}
	}
	if sum.Projects == nil {
		sum.Projects = []store.ProjectShare{}
	}
	fromDay := time.UnixMilli(from).In(s.d.Now().Location()).Format("2006-01-02")
	if from == 0 {
		fromDay = "0000-00-00"
	}
	daily, err := store.Daily(ctx, q, fromDay)
	if err != nil {
		s.fail(w, err)
		return
	}
	if tools == nil {
		tools = []store.ToolCount{}
	}
	if daily == nil {
		daily = []store.DailyStat{}
	}
	writeJSON(w, http.StatusOK, HistoryResponse{Range: label, Totals: tot, Tools: tools, Daily: daily, Summary: sum, Savings: cost.ComputeSavings(sum.TokensIn, sum.CacheRead, sum.CacheWrite)})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	var st any = map[string]any{"version": s.d.Version}
	if s.d.Status != nil {
		st = s.d.Status(r.Context())
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handlePricing(w http.ResponseWriter, _ *http.Request) {
	if s.d.Table == nil {
		writeJSON(w, http.StatusOK, map[string]any{})
		return
	}
	writeJSON(w, http.StatusOK, s.d.Table)
}

func (s *Server) handleShutdown(w http.ResponseWriter, r *http.Request) {
	if s.d.Token == "" || r.Header.Get("Authorization") != "Bearer "+s.d.Token {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "shutting down"})
	if s.d.Shutdown != nil {
		go s.d.Shutdown()
	}
}

// handleStatusline records the rate-limit windows the `caprock statusline` command
// forwards from Claude Code's status JSON. Bearer-gated, 204 on success. The body
// carries only rate-limit numbers + session id (no prompts, no cwd/repo).
func (s *Server) handleStatusline(w http.ResponseWriter, r *http.Request) {
	if s.d.Token == "" || r.Header.Get("Authorization") != "Bearer "+s.d.Token {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var body struct {
		SessionID string `json:"session_id"`
		FiveHour  *struct {
			UsedPercentage float64 `json:"used_percentage"`
			ResetsAt       int64   `json:"resets_at"`
		} `json:"five_hour"`
		SevenDay *struct {
			UsedPercentage float64 `json:"used_percentage"`
			ResetsAt       int64   `json:"resets_at"`
		} `json:"seven_day"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	now := s.d.Now().UnixMilli()
	ctx := r.Context()
	if body.FiveHour != nil {
		_ = store.RecordRateLimit(ctx, s.d.Store.DB(), store.RateLimitSnapshot{
			Window: "five_hour", Ts: now, UsedPercentage: body.FiveHour.UsedPercentage, ResetsAt: body.FiveHour.ResetsAt}, body.SessionID)
	}
	if body.SevenDay != nil {
		_ = store.RecordRateLimit(ctx, s.d.Store.DB(), store.RateLimitSnapshot{
			Window: "seven_day", Ts: now, UsedPercentage: body.SevenDay.UsedPercentage, ResetsAt: body.SevenDay.ResetsAt}, body.SessionID)
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Phase 2: tasks ---

func (s *Server) requireTasks(w http.ResponseWriter) bool {
	if s.d.Tasks == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "orchestration is not enabled", "detail": "Phase 2 (tasks/orchestrator) is off in this build/config"})
		return false
	}
	return true
}

func (s *Server) handleTasks(w http.ResponseWriter, r *http.Request) {
	if !s.requireTasks(w) {
		return
	}
	out, err := s.d.Tasks.List(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleCreateTask(w http.ResponseWriter, r *http.Request) {
	if !s.requireTasks(w) {
		return
	}
	var req map[string]any
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	out, err := s.d.Tasks.Create(r.Context(), req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleGetTask(w http.ResponseWriter, r *http.Request) {
	if !s.requireTasks(w) {
		return
	}
	out, err := s.d.Tasks.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		s.notFoundOrFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleVerify(w http.ResponseWriter, r *http.Request) {
	if !s.requireTasks(w) {
		return
	}
	out, err := s.d.Tasks.Verify(r.Context(), r.PathValue("id"))
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleApprove(approve bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.requireTasks(w) {
			return
		}
		if err := s.d.Tasks.Approve(r.Context(), r.PathValue("id"), approve); err != nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func (s *Server) handleStartOrchestrator(w http.ResponseWriter, r *http.Request) {
	if !s.requireTasks(w) {
		return
	}
	out, err := s.d.Tasks.StartOrchestrator(r.Context())
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleApprovals(w http.ResponseWriter, r *http.Request) {
	if !s.requireTasks(w) {
		return
	}
	out, err := s.d.Tasks.Approvals(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// --- Phase 1: owned sessions ---

func (s *Server) requireAgents(w http.ResponseWriter) bool {
	if s.d.Agents == nil || !s.d.Agents.Available() {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "spawning is unavailable", "detail": "the `claude` binary was not found on PATH; Caprock runs in observe-only mode"})
		return false
	}
	return true
}

func (s *Server) handleSpawn(w http.ResponseWriter, r *http.Request) {
	if !s.requireAgents(w) {
		return
	}
	var req map[string]any
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// Spawn with a background context: the process must outlive this HTTP request.
	id, cwd, err := s.d.Agents.Spawn(context.WithoutCancel(r.Context()), req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"session_id": id, "cwd": cwd})
}

func (s *Server) handleAgentInput(w http.ResponseWriter, r *http.Request) {
	if !s.requireAgents(w) {
		return
	}
	var body struct {
		Data string `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.d.Agents.Input(r.PathValue("id"), []byte(body.Data)); err != nil {
		s.agentErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleAgentSignal(w http.ResponseWriter, r *http.Request) {
	if !s.requireAgents(w) {
		return
	}
	var body struct {
		Action string `json:"action"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	switch body.Action {
	case "pause", "resume", "kill":
	default:
		http.Error(w, "action must be pause|resume|kill", http.StatusBadRequest)
		return
	}
	if err := s.d.Agents.Signal(r.PathValue("id"), body.Action); err != nil {
		s.agentErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) agentErr(w http.ResponseWriter, err error) {
	writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
}

// --- helpers ---

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func (s *Server) fail(w http.ResponseWriter, err error) {
	s.d.Log.Error("api error", "component", "api", "err", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
}

func (s *Server) notFoundOrFail(w http.ResponseWriter, err error) {
	if strings.Contains(err.Error(), "no rows") {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	s.fail(w, err)
}
