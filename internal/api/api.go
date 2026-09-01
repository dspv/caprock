// Package api serves the loopback HTTP surface: REST queries under /v1, the
// /v1/live WebSocket, the hook receiver, and the embedded dashboard at /.
// Contract: .ai/03-contracts.md § HTTP API. JSON is snake_case, money is USD
// float, tokens are int64.
package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/gitdiff"
	"github.com/dspv/caprock/internal/license"
	"github.com/dspv/caprock/internal/loop"
	"github.com/dspv/caprock/internal/narrate"
	"github.com/dspv/caprock/internal/premium"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/update"
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
	// AskGemini answers one prompt on the user's own key and records what it
	// cost. nil ⇒ the endpoint returns 501. See ADR-023.
	AskGemini func(ctx context.Context, model, prompt string) (any, error)
	// Agents is the Phase 1 owned-session manager (nil ⇒ endpoints return 501).
	Agents AgentController
	// Tasks is the Phase 2 hive-backed task board (nil ⇒ endpoints return 501).
	Tasks TaskController
	// Settings reads and persists the user-editable settings (the subscription
	// plan and whether release checks are on). nil ⇒ 501.
	Settings SettingsController
	// Update reports whether a newer release exists. nil ⇒ 501. It is only
	// ever consulted when the user enabled checks.
	Update UpdateController
	// DataDir is where Caprock keeps its own state. Needed so a file pasted
	// into the terminal can be written somewhere Claude Code can read it by
	// path. Empty ⇒ POST /v1/paste returns 501.
	DataDir string
}

// UpdateController is the subset of the release checker the API needs.
type UpdateController interface {
	Status(enabled bool, current string) update.Status
	Check(ctx context.Context, force bool) error
}

// SettingsController is the subset of config handling the API needs. Values are
// entered by the user and stored locally; Caprock never fetches them.
type SettingsController interface {
	Get() Settings
	Set(Settings) error
}

// Settings is the user-editable configuration exposed over the API. Caprock
// cannot detect how a user pays for Claude Code and never guesses — these
// values are stated by the user and stored locally.
type Settings struct {
	// UpdateChecks enables the release check — the only outbound call Caprock
	// makes, off unless the user turns it on.
	UpdateChecks bool `json:"update_checks"`
	// PlanKind: "" (not stated), "flat" (Pro/Max/Team seat), or "metered"
	// (API key, Bedrock, Vertex, Enterprise usage at API rates).
	PlanKind        string  `json:"plan_kind"`
	PlanLabel       string  `json:"plan_label"`
	PlanUSDPerMonth float64 `json:"plan_usd_per_month"`
	// LicenseKey unlocks the paid features, checked locally against the expiry
	// it carries (ADR-022). Empty is the ordinary state.
	LicenseKey string `json:"license_key,omitempty"`
	// CapUSDPerDay is the daily spend ceiling; 0 is off. Reaching it pauses the
	// sessions Caprock started and nothing else (rule 7).
	//
	// No omitempty: zero means "the cap is off", which is a state the UI has to
	// be able to read. Omitted, an off cap is indistinguishable from a daemon
	// too old to have the field, and the panel cannot tell "you turned this
	// off" from "this build cannot do it".
	CapUSDPerDay float64 `json:"cap_usd_per_day"`
	// ReportChatID is where the weekly report goes. Not a credential — a chat
	// id identifies a conversation and grants nothing — so it round-trips like
	// any other setting.
	ReportChatID string `json:"report_chat_id"`
	// ReportBotSet reports whether a bot token is stored, WITHOUT the token.
	//
	// The token is the first write-only field in this API: accepted by PUT,
	// never returned by GET. Every other setting round-trips, and the licence
	// key is echoed back plainly — but that key unlocks features on this
	// machine, while a bot token can send messages as somebody's bot. This
	// response is read on every settings render and by `caprock report`, and a
	// credential should not ride along on either. What a screen needs is
	// whether one is set, which is this.
	ReportBotSet bool `json:"report_bot_set"`
	// ReportBotToken is never serialised — the `-` tag is the mechanism that
	// makes "write-only" true rather than merely intended. It is set by the PUT
	// handler and read by the daemon; GET renders ReportBotSet instead.
	ReportBotToken string `json:"-"`
	// GeminiKeySet reports whether a Gemini key is available — from the
	// environment or entered here — without revealing it. Same write-only rule
	// as the bot token (ADR-025).
	GeminiKeySet bool `json:"gemini_key_set"`
	// GeminiKeyFromEnv says the key comes from GEMINI_API_KEY rather than from
	// the field, so the panel can say why editing it changes nothing.
	GeminiKeyFromEnv bool `json:"gemini_key_from_env"`
	// GeminiAPIKey is never serialised, for the same reason as the bot token.
	GeminiAPIKey string `json:"-"`
	// ReportLastError is why the last send failed, empty when it did not.
	//
	// A weekly message that silently stops arriving is the failure mode this
	// feature has: nobody notices an absence. Telegram's own words are kept
	// ("chat not found", "bot was blocked by the user") because both are things
	// only the user can fix.
	ReportLastError string `json:"report_last_error,omitempty"`
	// ReportLastSentMs is when a report last went out, 0 for never.
	ReportLastSentMs int64 `json:"report_last_sent_ms,omitempty"`
	// BrowseRoot is the only directory the folder picker may look inside, and
	// the boundary every path it returns is checked against. Empty means the
	// user's home directory.
	//
	// It is a setting rather than a constant because "where I keep my code" is
	// personal — ~/dev for one person, ~/src or /work for another — and because
	// the narrower it is, the less this endpoint can be asked. See browse.go.
	BrowseRoot string `json:"browse_root,omitempty"`
}

// TaskController is the subset of the Phase 2 hive the API needs.
type TaskController interface {
	// Enabled reports whether the task runner is on. It is asked per request
	// rather than assumed from the controller being non-nil, because the runner
	// can be turned on while the daemon runs (Enable) — the controller outlives
	// the off state.
	Enabled() bool
	// Enable opens a hive directory and starts the board on a running daemon.
	// An empty hiveDir/repoCwd means the daemon's own suggestion. Turning it on
	// twice is an error, not a silent rebuild.
	Enable(ctx context.Context, hiveDir, repoCwd string) (any, error)
	List(ctx context.Context) (any, error)
	Create(ctx context.Context, req any) (any, error)
	Get(ctx context.Context, id string) (any, error)
	Approve(ctx context.Context, id string, approve bool) error
	Approvals(ctx context.Context) (any, error)
	// StartOrchestrator spawns the orchestrator session (T21). Returns its info.
	StartOrchestrator(ctx context.Context) (any, error)
	// StopOrchestrator kills the orchestrator and every worker it spawned, in
	// one call. Returns how many sessions were stopped.
	StopOrchestrator(ctx context.Context) (any, error)
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
	// hist collapses the burst of identical /v1/history requests one open
	// screen produces. See histcache.go.
	hist *historyCache
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
	s := &Server{d: d, mux: http.NewServeMux(), ws: newWSHub(d.Bus, d.Log), hist: newHistoryCache(historyTTL, d.Now)}
	m := s.mux
	m.HandleFunc("GET /v1/sessions", s.handleSessions)
	m.HandleFunc("GET /v1/sessions/{id}", s.handleSession)
	m.HandleFunc("GET /v1/sessions/{id}/events", s.handleSessionEvents)
	m.HandleFunc("GET /v1/sessions/{id}/notes", s.handleSessionNotes)
	m.HandleFunc("GET /v1/notes", s.handleSearchNotes)
	m.HandleFunc("GET /v1/sessions/{id}/diff", s.handleSessionDiff)
	m.HandleFunc("GET /v1/stats/summary", s.handleSummary)
	m.HandleFunc("GET /v1/update", s.handleUpdate)
	m.HandleFunc("POST /v1/update/check", s.handleUpdateCheck)
	m.HandleFunc("GET /v1/settings", s.handleGetSettings)
	m.HandleFunc("PUT /v1/settings", s.handlePutSettings)
	m.HandleFunc("GET /v1/stats/daily", s.handleDaily)
	m.HandleFunc("GET /v1/events", s.handleEventsFeed)
	m.HandleFunc("GET /v1/history", s.handleHistory)
	// Picking a folder without typing its path: see browse.go for what stops
	// this being a filesystem-read API.
	m.HandleFunc("GET /v1/browse", s.handleBrowse)
	m.HandleFunc("GET /v1/recent-dirs", s.handleRecentDirs)
	m.HandleFunc("GET /v1/status", s.handleStatus)
	// What the paid plan costs, so the dashboard can say it without guessing
	// and without an outbound call. Static — it is compiled in — but served
	// rather than duplicated in the UI, so one edit in Go changes every place
	// a price appears.
	m.HandleFunc("GET /v1/premium", s.handlePremium)
	m.HandleFunc("GET /v1/gemini", s.handleGeminiStatus)
	m.HandleFunc("POST /v1/gemini/ask", s.handleGeminiAsk)
	m.HandleFunc("GET /v1/pricing", s.handlePricing)
	m.HandleFunc("GET /v1/live", s.ws.ServeHTTP)
	if d.Hook != nil {
		m.Handle("POST /v1/hook", d.Hook)
	}
	m.HandleFunc("POST /v1/hive", s.handleEnableHive)
	m.HandleFunc("GET /v1/tasks", s.handleTasks)
	m.HandleFunc("POST /v1/tasks", s.handleCreateTask)
	m.HandleFunc("GET /v1/tasks/{id}", s.handleGetTask)
	m.HandleFunc("POST /v1/tasks/{id}/approve", s.handleApprove(true))
	m.HandleFunc("POST /v1/tasks/{id}/reject", s.handleApprove(false))
	m.HandleFunc("POST /v1/tasks/{id}/verify", s.handleVerify)
	m.HandleFunc("GET /v1/approvals", s.handleApprovals)
	m.HandleFunc("POST /v1/orchestrator/start", s.handleStartOrchestrator)
	m.HandleFunc("POST /v1/orchestrator/stop", s.handleStopOrchestrator)
	m.HandleFunc("POST /v1/agents", s.handleSpawn)
	m.HandleFunc("POST /v1/agents/{id}/input", s.handleAgentInput)
	m.HandleFunc("POST /v1/agents/{id}/signal", s.handleAgentSignal)
	m.HandleFunc("POST /v1/paste", s.handlePaste)
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
		// Refuse anything that cannot be shown to come from the dashboard
		// itself or from a real local client. The same-origin policy does NOT
		// protect this API — it stops a page reading the response, not sending
		// the request — and POST /v1/agents runs a command from its body. See
		// csrf.go for the layering and why a missing Origin is not trusted.
		if reason := checkOrigin(r); reason != "" {
			http.Error(w, reason, http.StatusForbidden)
			return
		}
		// The dashboard is mounted at "/" so client-side routes resolve, which
		// means an unmatched path falls through to index.html. For a page that
		// is right; for the API it is a lie — a caller that mistypes an
		// endpoint, or uses one that was removed, gets 200 and HTML, then fails
		// while parsing it as JSON. Answer honestly instead.
		if _, pattern := s.mux.Handler(r); pattern == "/" {
			writeJSON(w, http.StatusNotFound, map[string]string{
				"error": "no such endpoint: " + r.URL.Path,
			})
			return
		}
	}
	s.mux.ServeHTTP(w, r)
}

// Close shuts down live connections.
func (s *Server) Close() { s.ws.Close() }

// isLoopbackOrigin reports whether an Origin header names this machine.
//
// It parses rather than prefix-matches. The prefix form accepted
// "http://localhost.evil.example" and "http://127.0.0.1.evil.example" — both
// have the right prefix and neither is loopback — so an attacker only had to
// register a hostname starting with "localhost." to be treated as the
// dashboard. Host parsing makes the label boundary explicit.
func isLoopbackOrigin(origin string) bool {
	u, err := url.Parse(strings.TrimSpace(origin))
	if err != nil || u.Host == "" {
		return false // includes the literal "null" origin (sandboxed iframe, file://)
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https":
	default:
		return false
	}
	return isLoopbackHost(u.Host)
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

// handleSessionNotes returns what Claude said in a session, in prose, newest
// first. Subagent sidechains are excluded — they are about half of all
// assistant turns, and presenting a subagent's words as the main thread's is
// worse than showing nothing.
func (s *Server) handleSessionNotes(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	notes, err := store.SessionNotes(r.Context(), s.d.Store.DB(), r.PathValue("id"), limit)
	if err != nil {
		s.fail(w, err)
		return
	}
	if notes == nil {
		notes = []store.AssistantNote{}
	}
	writeJSON(w, http.StatusOK, notes)
}

// handleSearchNotes searches Claude's prose across every session, because the
// question people actually have is "which session was it where Claude explained
// the SSO thing?" rather than "show me session 17". Everything stays local.
func (s *Server) handleSearchNotes(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	notes, err := store.SearchNotes(r.Context(), s.d.Store.DB(), r.URL.Query().Get("q"), limit, before)
	if err != nil {
		s.fail(w, err)
		return
	}
	if notes == nil {
		notes = []store.AssistantNote{}
	}
	writeJSON(w, http.StatusOK, notes)
}

func (s *Server) handleSessionEvents(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	// `newest=1` returns the tail rather than the head. Paging from the start is
	// right for a timeline being read forwards, and wrong for anything showing
	// recent activity: on a session with thousands of events, `after=0` hands
	// back the first few hundred — hours old — and a caller that asked for "what
	// just happened" renders an empty window without knowing why.
	var evs []event.Event
	var err error
	if before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64); before > 0 {
		// Paging backwards from a known point — what the timeline does when the
		// reader asks for more history.
		evs, err = store.EventsBefore(r.Context(), s.d.Store.DB(), id, before, limit)
	} else if r.URL.Query().Get("newest") == "1" {
		evs, err = store.LastEvents(r.Context(), s.d.Store.DB(), id, limit)
	} else {
		evs, err = store.ListEvents(r.Context(), s.d.Store.DB(), id, after, limit)
	}
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
// parseDays reads a plain "<n>d" range. Bounded at ten years so a typo cannot
// ask for an unbounded scan.
func parseDays(rng string) (int, bool) {
	if len(rng) < 2 || (rng[len(rng)-1] != 'd' && rng[len(rng)-1] != 'D') {
		return 0, false
	}
	n, err := strconv.Atoi(rng[:len(rng)-1])
	if err != nil || n <= 0 || n > 3650 {
		return 0, false
	}
	return n, true
}

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
	// A day-suffixed range Go's ParseDuration cannot read ("90d" — durations
	// stop at hours) used to fall through to today, so `range=90d` quietly
	// reported FEWER sessions than `30d`. Handle the form people actually type.
	if n, ok := parseDays(rng); ok {
		return midnight.AddDate(0, 0, -(n - 1)).UnixMilli(), rng
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

// handleUpdate reports the cached release status. It performs no network I/O:
// a page load must never trigger an outbound call, even with checks enabled.
func (s *Server) handleUpdate(w http.ResponseWriter, _ *http.Request) {
	if s.d.Update == nil || s.d.Settings == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("update checks are not available"))
		return
	}
	writeJSON(w, http.StatusOK, s.d.Update.Status(s.d.Settings.Get().UpdateChecks, s.d.Version))
}

// handleUpdateCheck performs the check on demand. Refused outright when the
// user has not enabled checks — the opt-in is enforced here, not just in the
// UI, so no page and no script can make Caprock reach the network uninvited.
func (s *Server) handleUpdateCheck(w http.ResponseWriter, r *http.Request) {
	if s.d.Update == nil || s.d.Settings == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("update checks are not available"))
		return
	}
	if !s.d.Settings.Get().UpdateChecks {
		s.failCode(w, http.StatusForbidden, errors.New("release checks are off; enable them in settings"))
		return
	}
	// A failed check is reported in the payload, not as an error status: not
	// knowing about a release must not read as a broken dashboard.
	_ = s.d.Update.Check(r.Context(), true)
	writeJSON(w, http.StatusOK, s.d.Update.Status(true, s.d.Version))
}

// handleGetSettings returns the user-stated settings. Absent settings are not
// an error — they mean "not stated", and the UI simply omits the comparison.
func (s *Server) handleGetSettings(w http.ResponseWriter, _ *http.Request) {
	if s.d.Settings == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("settings are not available"))
		return
	}
	writeJSON(w, http.StatusOK, s.d.Settings.Get())
}

// handlePutSettings stores the user's stated billing. It validates rather than
// coercing: a plan kind we do not understand, or a negative price, is rejected
// so a typo cannot silently produce a wrong headline number.
func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	if s.d.Settings == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("settings are not available"))
		return
	}
	// Decoded into pointers so an absent field can be told from one the caller
	// deliberately cleared. Without that, `PUT {}` decoded to the zero Settings
	// and wiped everything: a stated plan silently reverted to "not stated" and
	// the release-check opt-in switched itself off, both answering 200. A
	// client sending a partial body — or a retry that lost fields — should
	// change what it named and nothing else.
	var patch struct {
		UpdateChecks    *bool    `json:"update_checks"`
		PlanKind        *string  `json:"plan_kind"`
		PlanLabel       *string  `json:"plan_label"`
		PlanUSDPerMonth *float64 `json:"plan_usd_per_month"`
		LicenseKey      *string  `json:"license_key"`
		CapUSDPerDay    *float64 `json:"cap_usd_per_day"`
		BrowseRoot      *string  `json:"browse_root"`
		// The bot token goes in and never comes back out. An empty string is a
		// deliberate clear, which is why it is a pointer like everything else.
		ReportBotToken *string `json:"report_bot_token"`
		ReportChatID   *string `json:"report_chat_id"`
		GeminiAPIKey   *string `json:"gemini_api_key"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&patch); err != nil {
		s.failCode(w, http.StatusBadRequest, fmt.Errorf("parse body: %w", err))
		return
	}
	in := s.d.Settings.Get()
	if patch.UpdateChecks != nil {
		in.UpdateChecks = *patch.UpdateChecks
	}
	if patch.PlanKind != nil {
		in.PlanKind = *patch.PlanKind
	}
	if patch.CapUSDPerDay != nil {
		v := *patch.CapUSDPerDay
		// Validated rather than coerced, like every other field here: this
		// number stops work, so a negative or non-finite one is a 400 and not
		// a silently clamped zero that quietly disables the cap.
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
			s.failCode(w, http.StatusBadRequest, errors.New("cap_usd_per_day must be zero (off) or a positive number of dollars"))
			return
		}
		in.CapUSDPerDay = v
	}
	if patch.BrowseRoot != nil {
		in.BrowseRoot = *patch.BrowseRoot
	}
	// Only touched when the caller named it. GET never returns the token, so a
	// UI that reads settings and writes them back always omits it — treating
	// absence as "clear it" would delete the token on the next unrelated save.
	if patch.ReportBotToken != nil {
		in.ReportBotToken = strings.TrimSpace(*patch.ReportBotToken)
	}
	if patch.ReportChatID != nil {
		in.ReportChatID = strings.TrimSpace(*patch.ReportChatID)
	}
	if patch.GeminiAPIKey != nil {
		in.GeminiAPIKey = strings.TrimSpace(*patch.GeminiAPIKey)
	}
	if patch.LicenseKey != nil {
		in.LicenseKey = *patch.LicenseKey
	}
	if patch.PlanLabel != nil {
		in.PlanLabel = *patch.PlanLabel
	}
	if patch.PlanUSDPerMonth != nil {
		in.PlanUSDPerMonth = *patch.PlanUSDPerMonth
	}
	switch in.PlanKind {
	case "", "flat", "metered":
	default:
		s.failCode(w, http.StatusBadRequest, fmt.Errorf("unknown plan_kind %q (want \"flat\", \"metered\", or empty)", in.PlanKind))
		return
	}
	if in.PlanUSDPerMonth < 0 || math.IsNaN(in.PlanUSDPerMonth) || math.IsInf(in.PlanUSDPerMonth, 0) {
		s.failCode(w, http.StatusBadRequest, errors.New("plan_usd_per_month must be a non-negative number"))
		return
	}
	if len(in.PlanLabel) > 64 {
		in.PlanLabel = in.PlanLabel[:64]
	}
	if err := s.d.Settings.Set(in); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.d.Settings.Get())
}

// sparkSpec maps a range label to the bucket grid the Projects sparkline draws.
//
// The grid is derived from the SAME calendar-aligned start rangeFrom returns, so
// a column is a real local day (or hour) rather than a rolling 24h window offset
// from whenever the page happened to load. "today" is hourly because 24 columns
// of a day is the only division that shows *when* in the day the work happened;
// the multi-day ranges are daily for the same reason.
//
// "all" gets no sparkline: its start is the first event ever captured, so a
// fixed bucket count would make one column mean a different span on every
// machine — and a picture whose x-axis nobody can state is decoration, not data.
func (s *Server) sparkSpec(label string, from int64) store.SparkSpec {
	const hourMs = int64(time.Hour / time.Millisecond)
	dayMs := 24 * hourMs
	switch label {
	case "today":
		return store.SparkSpec{Buckets: 24, WidthMs: hourMs, FromMs: from}
	case "7d":
		return store.SparkSpec{Buckets: 7, WidthMs: dayMs, FromMs: from}
	case "30d":
		return store.SparkSpec{Buckets: 30, WidthMs: dayMs, FromMs: from}
	}
	// A "<n>d" range the user typed gets daily columns too, capped so the
	// payload stays bounded on a polled endpoint.
	if n, ok := parseDays(label); ok && n <= 90 {
		return store.SparkSpec{Buckets: n, WidthMs: dayMs, FromMs: from}
	}
	return store.SparkSpec{}
}

func (s *Server) handleSummary(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	from, label := s.rangeFrom(r.URL.Query().Get("range"))
	// An unknown agent is rejected rather than silently ignored: returning
	// everything under a heading that says "opencode" is worse than an error.
	agent, err := agentFilter(r.URL.Query().Get("agent"))
	if err != nil {
		s.failCode(w, http.StatusBadRequest, err)
		return
	}
	sum, err := store.SummarizeSparkFor(ctx, s.d.Store.DB(), from, s.sparkSpec(label, from), agent)
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

// maxDailyDays bounds the daily query: ten years is far past any real history
// and keeps one request from scanning an unbounded range.
const maxDailyDays = 3650

func (s *Server) handleDaily(w http.ResponseWriter, r *http.Request) {
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	switch {
	case days <= 0:
		days = 30 // unset or nonsense: the dashboard's own window
	case days > maxDailyDays:
		// Clamp to the ceiling rather than falling back to the default. Asking
		// for 5000 days and silently receiving 30 returns a total that is
		// simply wrong — a caller summing the result gets a fraction of the
		// real spend with nothing to say it was truncated.
		days = maxDailyDays
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
	from, label := s.rangeFrom(r.URL.Query().Get("range"))
	// Keyed by the resolved range rather than the raw query string, so
	// "?range=" and "?range=today" — the same question spelled two ways —
	// share one answer.
	v, err := s.hist.get(r.Context(), label, func() (any, error) {
		return s.buildHistory(context.WithoutCancel(r.Context()), from, label)
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// buildHistory computes one history response. Split out of the handler so the
// cache above has something to call, and so the queries are testable without
// an HTTP round trip.
func (s *Server) buildHistory(ctx context.Context, from int64, label string) (HistoryResponse, error) {
	q := s.d.Store.DB()
	tot, err := store.History(ctx, q, from)
	if err != nil {
		return HistoryResponse{}, err
	}
	tools, err := store.ToolDistribution(ctx, q, from, 40)
	if err != nil {
		return HistoryResponse{}, err
	}
	sum, err := store.Summarize(ctx, q, from)
	if err != nil {
		return HistoryResponse{}, err
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
		return HistoryResponse{}, err
	}
	if tools == nil {
		tools = []store.ToolCount{}
	}
	if daily == nil {
		daily = []store.DailyStat{}
	}
	return HistoryResponse{Range: label, Totals: tot, Tools: tools, Daily: daily, Summary: sum, Savings: cost.ComputeSavings(sum.TokensIn, sum.CacheRead, sum.CacheWrite)}, nil
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	var st any = map[string]any{"version": s.d.Version}
	if s.d.Status != nil {
		st = s.d.Status(r.Context())
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handlePremium(w http.ResponseWriter, _ *http.Request) {
	// Pricing and licence state in one response: every surface that mentions
	// the paid version needs both, and two requests to draw one banner is two
	// chances for them to disagree about what the user has.
	type resp struct {
		premium.Pricing
		License license.State `json:"license"`
	}
	key := ""
	if s.d.Settings != nil {
		key = s.d.Settings.Get().LicenseKey
	}
	writeJSON(w, http.StatusOK, resp{
		Pricing: premium.Current(),
		License: license.Parse(key, s.d.Now()),
	})
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
		SessionID string        `json:"session_id"`
		FiveHour  *rateWindowIn `json:"five_hour"`
		SevenDay  *rateWindowIn `json:"seven_day"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	now := s.d.Now().UnixMilli()
	ctx := r.Context()
	// Validate before storing. These values are relayed from Claude Code and
	// were taken on trust, which is how a five-hour window came to claim it
	// resets in 2030 — a figure the dashboard then presented as a fact.
	record := func(window string, w *rateWindowIn) {
		if w == nil || !plausibleRateWindow(*w, now) {
			return
		}
		if err := store.RecordRateLimit(ctx, s.d.Store.DB(), store.RateLimitSnapshot{
			Window: window, Ts: now, UsedPercentage: w.UsedPercentage, ResetsAt: w.ResetsAt}, body.SessionID); err != nil {
			s.d.Log.Debug("record rate limit", "component", "api", "window", window, "err", err)
		}
	}
	record("five_hour", body.FiveHour)
	record("seven_day", body.SevenDay)
	w.WriteHeader(http.StatusNoContent)
}

// rateWindowIn is one plan-limit window as relayed by `caprock statusline`.
type rateWindowIn struct {
	UsedPercentage float64 `json:"used_percentage"`
	ResetsAt       int64   `json:"resets_at"`
}

// plausibleRateWindow rejects a sample that cannot describe a real window: a
// percentage outside 0-100, or a reset more than eight days out (the longest
// window Anthropic publishes is seven days). A reset already in the past is
// kept — it is a legitimately stale sample, and the UI labels it as such.
func plausibleRateWindow(w rateWindowIn, now int64) bool {
	if w.UsedPercentage < 0 || w.UsedPercentage > 100 {
		return false
	}
	if w.ResetsAt != 0 {
		const maxAhead = 8 * 24 * 3600 // seconds
		if w.ResetsAt*1000 > now+maxAhead*1000 {
			return false
		}
	}
	return true
}

// --- Phase 2: tasks ---

func (s *Server) requireTasks(w http.ResponseWriter) bool {
	if s.d.Tasks == nil || !s.d.Tasks.Enabled() {
		// "Phase 2" is our internal build order and means nothing to a user;
		// the detail says what to do instead. It no longer sends anyone to a
		// terminal first: POST /v1/hive turns the runner on where they are.
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "the task runner is off", "detail": "turn it on with POST /v1/hive, or start the daemon with `caprock up --hive <dir>`"})
		return false
	}
	return true
}

// handleEnableHive turns the task runner on over a running daemon: it opens (and
// creates) the queue directory, seeds it, starts the board, and wires the
// orchestrator — no restart. Before this the only way in was a command-line
// flag, so the dashboard could offer a line to copy into a terminal and nothing
// more, which is not a control.
//
// It is deliberately a POST with an explicit body rather than a toggle: enabling
// this is what makes Caprock able to spawn Claude sessions with permission
// prompts skipped, so the caller states the directory and the repository it
// means. Nothing is spawned here — the orchestrator is still a separate,
// explicit start.
func (s *Server) handleEnableHive(w http.ResponseWriter, r *http.Request) {
	if s.d.Tasks == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "the task runner is not available in this build"})
		return
	}
	var req struct {
		Hive string `json:"hive"`
		Repo string `json:"repo"`
	}
	// An empty body is legitimate: it means "use the suggestion /v1/status gave".
	if r.Body != nil {
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req)
	}
	// Opening a hive touches the filesystem and rescans; a client that hangs up
	// must not leave the board half-built.
	out, err := s.d.Tasks.Enable(context.WithoutCancel(r.Context()), strings.TrimSpace(req.Hive), strings.TrimSpace(req.Repo))
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, out)
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
	// done_criteria commands run up to five minutes. On the request context a
	// disconnect killed them mid-run and then failed the bookkeeping that
	// follows, stranding the task in `verifying` with an open cost window.
	out, err := s.d.Tasks.Verify(context.WithoutCancel(r.Context()), r.PathValue("id"))
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
	// Spawning outlives the request: the PTY is already detached, but the
	// ownership write and the worktree creation were not, so a client
	// disconnect could leave a real claude process running with no owned row
	// recording it — precisely the state rule 7 exists to prevent.
	out, err := s.d.Tasks.StartOrchestrator(context.WithoutCancel(r.Context()))
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// handleStopOrchestrator is the emergency stop: it kills the orchestrator and
// every worker it spawned in one call. Before it existed the only way to halt an
// unattended fleet was POST /v1/agents/{id}/signal per session, which required
// knowing every session id — no single control stopped the thing.
func (s *Server) handleStopOrchestrator(w http.ResponseWriter, r *http.Request) {
	if !s.requireTasks(w) {
		return
	}
	// Killing must not be abandoned halfway because the client hung up.
	out, err := s.d.Tasks.StopOrchestrator(context.WithoutCancel(r.Context()))
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

// pasteLimit caps a pasted file. Ten megabytes is far past any screenshot and
// well short of anything that would fill a disk by accident.
const pasteLimit = 10 << 20

// pasteTypes is what may be written, keyed by the MIME type the caller
// declares, with the extension the file gets.
//
// An allow-list rather than a sanitiser: this endpoint writes a file to disk on
// the say-so of a web page, so the safe design names what is permitted rather
// than guessing what is dangerous. The extension comes from this table and
// never from the request, so a name cannot smuggle in a path or an executable
// suffix.
var pasteTypes = map[string]string{
	"image/png":       ".png",
	"image/jpeg":      ".jpg",
	"image/gif":       ".gif",
	"image/webp":      ".webp",
	"application/pdf": ".pdf",
	"text/plain":      ".txt",
}

// handlePaste writes a pasted or dropped file and returns the path to it.
//
// A browser hands over bytes, never a path — there is no path for something
// copied out of a screenshot tool. Claude Code reads files by path, so the
// bytes become a file here and the dashboard types its path into the session.
//
// **The bytes arrive base64 inside JSON, not as a raw body**, and that is the
// security design rather than an inconvenience. The forgery guard turns a
// state-changing request away unless it is `application/json`, because a
// cross-site *simple* request cannot set that header — it would force a
// preflight this server never answers. `image/png` is a simple type, so a raw
// upload would have been an endpoint any web page could use to write files
// into the user's data directory. Base64 costs a third more bytes and keeps
// the endpoint behind the same guard as everything else.
func (s *Server) handlePaste(w http.ResponseWriter, r *http.Request) {
	if s.d.DataDir == "" {
		http.Error(w, "paste unavailable", http.StatusNotImplemented)
		return
	}
	var body struct {
		// Type is the MIME type, matched against the allow-list.
		Type string `json:"type"`
		// Data is the file, base64-encoded.
		Data string `json:"data"`
	}
	// The limit is on the encoded form, which is about a third larger than
	// the file — so the 10 MB cap on the file is a ~13.4 MB cap here, plus
	// room for the JSON around it.
	if err := json.NewDecoder(io.LimitReader(r.Body, 14<<20)).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	ext, ok := pasteTypes[body.Type]
	if !ok {
		http.Error(w, "unsupported file type", http.StatusUnsupportedMediaType)
		return
	}
	raw, err := base64.StdEncoding.DecodeString(body.Data)
	if err != nil {
		http.Error(w, "data is not valid base64", http.StatusBadRequest)
		return
	}
	if len(raw) == 0 {
		http.Error(w, "empty file", http.StatusBadRequest)
		return
	}
	if len(raw) > pasteLimit {
		http.Error(w, "file is larger than 10 MB", http.StatusRequestEntityTooLarge)
		return
	}

	dir := config.PasteDir(s.d.DataDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		http.Error(w, "cannot write", http.StatusInternalServerError)
		return
	}
	// The name is ours entirely: a timestamp and random bytes, with the
	// extension from the allow-list. Nothing the caller sent reaches the
	// filesystem, so there is no path to traverse and no name to collide.
	var suffix [4]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		http.Error(w, "cannot write", http.StatusInternalServerError)
		return
	}
	name := fmt.Sprintf("%s-%s%s", s.d.Now().UTC().Format("20060102-150405"), hex.EncodeToString(suffix[:]), ext)
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		http.Error(w, "cannot write", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": path})
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
		// Name the field, not just the values: the old message ("action must be
		// pause|resume|kill") left a caller who sent the wrong key guessing.
		http.Error(w, `body must be {"action": "pause"|"resume"|"kill"}`, http.StatusBadRequest)
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

// writeJSON serializes into a buffer BEFORE writing the status line. It used
// to encode straight to the ResponseWriter after writing 200 and discard the
// error — so a single unserializable value (one event whose timestamp rolled
// past year 9999 is enough, because json aborts the whole array) produced
// HTTP 200 with an empty body. The dashboard then threw parsing it, and the
// failure was invisible in the logs. A failure here is now an honest 500.
func writeJSON(w http.ResponseWriter, code int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"response could not be serialized"}` + "\n"))
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_, _ = w.Write(buf.Bytes())
}

func (s *Server) fail(w http.ResponseWriter, err error) {
	s.d.Log.Error("api error", "component", "api", "err", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
}

// failCode returns a specific status with the reason visible to the caller.
// Unlike fail (which hides internal errors), these are the caller's own fault
// or a capability that is off, so saying why is useful rather than leaky.
func (s *Server) failCode(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]string{"error": err.Error()})
}

func (s *Server) notFoundOrFail(w http.ResponseWriter, err error) {
	if strings.Contains(err.Error(), "no rows") {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	s.fail(w, err)
}

// agentFilter validates the ?agent= parameter. Empty means every agent.
func agentFilter(v string) (store.AgentFilter, error) {
	switch v {
	case "", "all":
		return "", nil
	case "claude", "opencode", "gemini":
		return store.AgentFilter(v), nil
	default:
		return "", fmt.Errorf("unknown agent %q: use claude, opencode, gemini, or omit for all", v)
	}
}
