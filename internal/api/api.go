// Package api serves the loopback HTTP surface: REST queries under /v1, the
// /v1/live WebSocket, the hook receiver, and the embedded dashboard at /.
// Contract: .ai/03-contracts.md § HTTP API. JSON is snake_case, money is USD
// float, tokens are int64.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/bus"
	capguard "github.com/dspv/caprock/internal/cap"
	"github.com/dspv/caprock/internal/codex"
	"github.com/dspv/caprock/internal/contexttax"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/editor"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/gitdiff"
	"github.com/dspv/caprock/internal/github"
	"github.com/dspv/caprock/internal/gitremote"
	"github.com/dspv/caprock/internal/license"
	"github.com/dspv/caprock/internal/loop"
	"github.com/dspv/caprock/internal/narrate"
	"github.com/dspv/caprock/internal/nativeterm"
	"github.com/dspv/caprock/internal/pairing"
	"github.com/dspv/caprock/internal/premium"
	"github.com/dspv/caprock/internal/projects"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/update"
)

// Deps is everything the API needs from the daemon.
type Deps struct {
	Store *store.Store
	// Pairing decides which devices on the local network may be served. Nil
	// when LAN access is off, which is the default and the usual case — see
	// lanauth.go.
	Pairing *pairing.Store
	// LANURL is the address a second device types in, empty when LAN access is
	// off. Shown on the pairing screen and encoded in its QR code.
	LANURL string
	Bus    *bus.Bus
	Table  *cost.Table
	Log    *slog.Logger
	Hook   http.Handler // POST /v1/hook (hookd)
	// Reporter sends a weekly report on demand, so somebody can find out
	// whether their bot works without waiting for Monday. Nil disables the
	// endpoint rather than crashing it.
	Reporter ReportSender
	// Alerts sends a test phone alert on demand (ADR-036). Nil disables the
	// endpoint.
	Alerts  AlertSender
	UI      fs.FS // embedded dashboard (index.html at root); nil ⇒ placeholder
	Version string
	// Status returns daemon/ingest/hooks status for /v1/status.
	Status func(ctx context.Context) any
	// InstallHooks registers the shim in Claude Code's settings, as
	// `caprock hooks install` does, and returns what is registered after.
	// nil ⇒ 501.
	InstallHooks func(ctx context.Context) (any, error)
	// BypassAccepted reports whether the user accepted Claude Code's one-time
	// bypass warning (hooks.BypassKey in user settings); AcceptBypass records
	// that they accepted Caprock's copy of it (ADR-041). nil ⇒ not checked,
	// and the route answers 501.
	BypassAccepted func() (bool, error)
	AcceptBypass   func() error
	// Storage returns what the data directory holds for /v1/storage. nil ⇒ 501.
	Storage func(ctx context.Context) any
	// WindowStop returns the plan-window stop's state for GET
	// /v1/window-stop: the share, whether a licence is active, the figures it
	// acts on and how fresh they are, and the sessions it has paused. nil ⇒ 501.
	WindowStop func(ctx context.Context) any
	// RateLimitsRecorded is called after POST /v1/statusline stores new plan
	// figures, so the plan-window stop checks them the moment they arrive.
	RateLimitsRecorded func(ctx context.Context)
	// Started is when this daemon came up. The burn tile needs it: in the
	// first minutes there is less history than the window it divides by.
	Started time.Time
	// LAN switches network access on and off while the daemon runs. Nil in
	// builds or tests that do not serve; then the switch reports itself as
	// unavailable rather than pretending.
	LAN interface {
		EnableLAN() (string, error)
		DisableLAN() error
	}
	// ActiveLoops reports whether a session currently has an unexpired loop alert.
	ActiveLoops func(sessionID string) *loop.Alert
	// LoopK and LoopWindow are the loop detector's settings, so the Week
	// card's longest loop is found by the same rule as the live alert. Zero
	// means the detector's defaults.
	LoopK      int
	LoopWindow time.Duration
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
	// Terminals opens a session in the user's own terminal application. nil ⇒
	// the open-terminal endpoints return 501 and no session offers it.
	Terminals TerminalController
	// Editors opens a folder or a file in the user's own editor (F18). nil ⇒
	// the editor endpoints return 501.
	Editors EditorController
	// Projects is the projects list, its git state and clones (nil ⇒ the
	// /v1/projects endpoints return 501).
	Projects *projects.Service
	// GitHub is the GitHub integration (nil ⇒ the /v1/github endpoints
	// return 501).
	GitHub *github.Service
	// Shells starts and lists shell tabs (nil ⇒ /v1/shells returns 501).
	Shells ShellController
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
	// UpdateChecks enables the release check — one of three calls that can
	// leave the machine, all off unless the user turns them on.
	UpdateChecks bool `json:"update_checks"`
	// Memory decides whether a session opening a folder is told what the last
	// one left there. On unless someone turns it off; see ADR-030.
	Memory bool `json:"memory"`
	// MemoryHoldoutPct holds the handoff back from this share of new sessions
	// (0–50), to measure what it is worth. 0 holds nothing back.
	MemoryHoldoutPct int `json:"memory_holdout_pct"`
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
	// WindowStopPct is the share of a Claude plan window at which Premium
	// pauses the Claude Code sessions Caprock started until the window resets;
	// 0 is off. Like the cap it has no omitempty: 0 is a state the control
	// must read. Without a licence it is stored and shown but pauses nothing.
	WindowStopPct int `json:"window_stop_pct"`
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
	// AlertApproval and AlertFinished are the phone alerts' two switches, off
	// unless turned on; they send nothing until a bot is configured
	// (ADR-036). Free, unlike the weekly report that shares the bot.
	AlertApproval bool `json:"alert_approval"`
	AlertFinished bool `json:"alert_finished"`
	// AlertReply puts the first line of the final reply in a finished alert;
	// on unless turned off.
	AlertReply bool `json:"alert_reply"`
	// NotifyApproval and NotifyFinished are the desktop app's OS
	// notifications, apart from Telegram's: approval on unless turned off,
	// finished off unless turned on (WP-09).
	NotifyApproval bool `json:"notify_approval"`
	NotifyFinished bool `json:"notify_finished"`
	// AlertLastError is why the last alert failed to send, empty when it did
	// not; AlertLastSentMs is when one last arrived, 0 for never since the
	// daemon started.
	AlertLastError  string `json:"alert_last_error,omitempty"`
	AlertLastSentMs int64  `json:"alert_last_sent_ms,omitempty"`
	// BrowseRoot is the only directory the folder picker may look inside, and
	// the boundary every path it returns is checked against. Empty means the
	// user's home directory.
	//
	// It is a setting rather than a constant because "where I keep my code" is
	// personal — ~/dev for one person, ~/src or /work for another — and because
	// the narrower it is, the less this endpoint can be asked. See browse.go.
	BrowseRoot string `json:"browse_root,omitempty"`
	// Terminal is the terminal application a session opens in when the user
	// asks for their own terminal: an id from GET /v1/terminals, or empty for
	// the first one installed.
	Terminal string `json:"terminal"`
	// Editor is the editor "Open in editor" uses: an id from GET
	// /v1/editors, or empty for the first one installed.
	Editor string `json:"editor"`
	// SpawnMode is the permission mode new sessions start in: what the
	// new-session dialogs open on, and what POST /v1/agents uses when the
	// request names no mode and has no session to carry one from. One of
	// agents.PermissionModes, or empty for not set.
	SpawnMode string `json:"spawn_permission_mode"`
}

// ReportSender sends one weekly report immediately.
//
// An interface rather than the daemon itself, for the same reason as every
// other seam here: the API package must stay testable without building a
// daemon, and a handler that can only be exercised with a live Telegram token
// is a handler nobody tests.
type ReportSender interface {
	SendReportNow(ctx context.Context) error
}

// AlertSender sends one test phone alert through the configured bot.
type AlertSender interface {
	SendAlertCheck(ctx context.Context) error
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
	// Available reports whether any agent can be started here.
	Available() bool
	// Has reports whether one agent ("claude", "codex", …) can be started.
	Has(agent string) bool
	Spawn(ctx context.Context, req any) (id string, cwd string, err error)
	Input(sessionID string, data []byte) error
	Signal(sessionID, action string) error
	Resize(sessionID string, cols, rows int) error
	Term(sessionID string) (snapshot []byte, sub <-chan []byte, cancel func(), ok bool)
	// Holds reports whether this daemon has the session's terminal. A session
	// Caprock started under an older release, or whose pty-host died, does
	// not (ADR-033).
	Holds(sessionID string) bool
	Write(sessionID string, data []byte) error
}

// Server is the http.Handler.
type Server struct {
	d   Deps
	mux *http.ServeMux
	ws  *wsHub
	// LAN access can be switched on while the daemon runs, and every request
	// reads it, so it lives behind a lock rather than in Deps.
	lanMu sync.RWMutex
	// replaced maps a session whose program exited to the shell started in
	// its tab, so a second client asking for the same tab gets the same
	// shell (POST /v1/shells with replaces).
	replMu   sync.Mutex
	replaced map[string]string
	pairing  *pairing.Store
	lanURL   string
	// altURLs are the other addresses network access answers on, beside
	// lanURL: the Tailscale one when lanURL is the LAN one, or the reverse,
	// and the MagicDNS name (WP-15). Empty when off.
	altURLs []string
	// hist collapses the burst of identical /v1/history requests one open
	// screen produces, and summ does the same for the wide ranges of
	// /v1/stats/summary. See answercache.go.
	hist *answerCache
	summ *answerCache
	// week, weekLong and glance hold the Week and Share answers (short and
	// long periods) and Now's at-a-glance, each with its own freshness
	// (weekTTL, weekLongTTL, glanceTTL).
	week     *answerCache
	weekLong *answerCache
	glance   *answerCache
	// drill holds the tool drill-downs (drillTTL).
	drill *answerCache
	// repos answers "which repository, on which host" per directory.
	repos *repoCache
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
	lanHost := ""
	if d.LANURL != "" {
		if u, err := url.Parse(d.LANURL); err == nil {
			lanHost = u.Hostname()
		}
	}
	s := &Server{d: d, replaced: map[string]string{}, mux: http.NewServeMux(), ws: newWSHub(d.Bus, d.Log, lanHost), hist: newAnswerCache(historyTTL, answerMaxStale, time.Now), summ: newAnswerCache(summaryTTL, answerMaxStale, time.Now),
		week: newAnswerCache(weekTTL, answerMaxStale, time.Now), weekLong: newAnswerCache(weekLongTTL, answerMaxStale, time.Now), glance: newAnswerCache(glanceTTL, answerMaxStale, time.Now),
		drill: newAnswerCache(drillTTL, answerMaxStale, time.Now), repos: newRepoCache()}
	// Seeded from Deps so `caprock up --lan` behaves exactly as before; the
	// dashboard's switch goes through SetLAN.
	s.pairing, s.lanURL = d.Pairing, d.LANURL
	m := s.mux
	m.HandleFunc("GET /v1/sessions", s.handleSessions)
	m.HandleFunc("GET /v1/sessions/{id}", s.handleSession)
	m.HandleFunc("GET /v1/sessions/{id}/events", s.handleSessionEvents)
	m.HandleFunc("GET /v1/sessions/{id}/subagents", s.handleSessionSubagents)
	m.HandleFunc("GET /v1/sessions/{id}/calls", s.handleSessionCalls)
	m.HandleFunc("GET /v1/sessions/{id}/notes", s.handleSessionNotes)
	m.HandleFunc("GET /v1/notes", s.handleSearchNotes)
	m.HandleFunc("GET /v1/sessions/{id}/diff", s.handleSessionDiff)
	m.HandleFunc("POST /v1/sessions/{id}/open-terminal", s.handleOpenTerminal)
	m.HandleFunc("POST /v1/sessions/remove", s.handleRemoveSessions)
	m.HandleFunc("GET /v1/terminals", s.handleTerminals)
	m.HandleFunc("GET /v1/editors", s.handleEditors)
	m.HandleFunc("POST /v1/editors/open", s.handleOpenEditor)
	m.HandleFunc("GET /v1/stats/summary", s.handleSummary)
	m.HandleFunc("GET /v1/update", s.handleUpdate)
	// Pairing. Only the redeem endpoint is reachable from the network; the
	// rest are refused off-loopback inside the handlers, so a paired tablet
	// cannot admit a third device or revoke the laptop that let it in.
	m.HandleFunc("GET /v1/pair/state", s.handlePairState)
	m.HandleFunc("POST /v1/pair/code", s.handlePairNewCode)
	m.HandleFunc("DELETE /v1/pair/code", s.handlePairClearCode)
	m.HandleFunc("POST /v1/pair", s.handlePairRedeem)
	m.HandleFunc("DELETE /v1/pair/devices/{id}", s.handlePairRevoke)
	m.HandleFunc("PUT /v1/pair/devices/{id}/role", s.handlePairSetRole)
	m.HandleFunc("GET /v1/pair/me", s.handlePairMe)
	m.HandleFunc("POST /v1/pair/lan", s.handleSetLAN)
	m.HandleFunc("POST /v1/update/check", s.handleUpdateCheck)
	m.HandleFunc("POST /v1/hooks/install", s.handleInstallHooks)
	m.HandleFunc("POST /v1/claude/bypass-consent", s.handleBypassConsent)
	m.HandleFunc("GET /v1/settings", s.handleGetSettings)
	m.HandleFunc("GET /v1/window-stop", s.handleWindowStop)
	m.HandleFunc("PUT /v1/settings", s.handlePutSettings)
	m.HandleFunc("POST /v1/report/test", s.handleTestReport)
	m.HandleFunc("POST /v1/alerts/test", s.handleTestAlert)
	m.HandleFunc("GET /v1/stats/daily", s.handleDaily)
	m.HandleFunc("GET /v1/events", s.handleEventsFeed)
	m.HandleFunc("GET /v1/history", s.handleHistory)
	m.HandleFunc("GET /v1/week", s.handleWeek)
	m.HandleFunc("GET /v1/glance", s.handleGlance)
	m.HandleFunc("GET /v1/tools/drill", s.handleToolDrill)
	// Picking a folder without typing its path: see browse.go for what stops
	// this being a filesystem-read API.
	m.HandleFunc("GET /v1/browse", s.handleBrowse)
	m.HandleFunc("GET /v1/recent-dirs", s.handleRecentDirs)
	m.HandleFunc("GET /v1/status", s.handleStatus)
	m.HandleFunc("GET /v1/storage", s.handleStorage)
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
	m.HandleFunc("GET /v1/sessions/{id}/relay", s.handleRelayBrief)
	m.HandleFunc("GET /v1/agents/models", s.handleAgentModels)
	m.HandleFunc("POST /v1/agents/{id}/input", s.handleAgentInput)
	m.HandleFunc("POST /v1/agents/{id}/signal", s.handleAgentSignal)
	m.HandleFunc("GET /v1/agents/{id}/permission", s.handlePermission)
	m.HandleFunc("POST /v1/agents/{id}/permission", s.handleAnswerPermission)
	m.HandleFunc("POST /v1/paste", s.handlePaste)
	m.HandleFunc("GET /v1/agents/{id}/term", s.ws.serveTerm(s))
	m.HandleFunc("GET /v1/projects", s.handleProjects)
	m.HandleFunc("POST /v1/projects", s.handleAddProject)
	m.HandleFunc("GET /v1/projects/ops", s.handleProjectOps)
	m.HandleFunc("PATCH /v1/projects/{id}", s.handlePatchProject)
	m.HandleFunc("DELETE /v1/projects/{id}", s.handleUnlistProject)
	m.HandleFunc("GET /v1/projects/{id}/worktrees", s.handleWorktrees)
	m.HandleFunc("POST /v1/projects/{id}/worktrees", s.handleAddWorktree)
	m.HandleFunc("DELETE /v1/projects/{id}/worktrees/{name}", s.handleRemoveWorktree)
	// A worktree's changes: review, stage, commit, push (changes.go).
	m.HandleFunc("GET /v1/projects/{id}/changes", s.handleChanges)
	m.HandleFunc("GET /v1/projects/{id}/changes/diff", s.handleChangeDiff)
	m.HandleFunc("POST /v1/projects/{id}/changes/stage", s.handleStage(false))
	m.HandleFunc("POST /v1/projects/{id}/changes/unstage", s.handleStage(true))
	m.HandleFunc("POST /v1/projects/{id}/changes/discard", s.handleDiscard)
	m.HandleFunc("POST /v1/projects/{id}/changes/commit", s.handleCommit)
	m.HandleFunc("POST /v1/projects/{id}/changes/push", s.handleRemote("push"))
	m.HandleFunc("POST /v1/projects/{id}/changes/pull", s.handleRemote("pull"))
	m.HandleFunc("POST /v1/projects/{id}/changes/fetch", s.handleRemote("fetch"))
	// One file, read-only, and the list of them (files.go).
	m.HandleFunc("GET /v1/projects/{id}/file", s.handleProjectFile)
	m.HandleFunc("GET /v1/projects/{id}/files", s.handleProjectFiles)
	m.HandleFunc("GET /v1/github", s.handleGitHubStatus)
	m.HandleFunc("PATCH /v1/github", s.handleGitHubPatch)
	m.HandleFunc("DELETE /v1/github", s.handleGitHubDisconnect)
	m.HandleFunc("POST /v1/github/connect", s.handleGitHubConnect)
	m.HandleFunc("POST /v1/github/device", s.handleGitHubDeviceStart)
	m.HandleFunc("GET /v1/github/device", s.handleGitHubDeviceState)
	m.HandleFunc("DELETE /v1/github/device", s.handleGitHubDeviceCancel)
	m.HandleFunc("GET /v1/github/owners", s.handleGitHubOwners)
	m.HandleFunc("GET /v1/github/repos", s.handleGitHubRepos)
	m.HandleFunc("GET /v1/github/prs", s.handleGitHubPRs)
	m.HandleFunc("GET /v1/projects/{id}/github", s.handleWorktreeGitHub)
	m.HandleFunc("POST /v1/projects/{id}/github/refresh", s.handleWorktreeGitHubRefresh)
	m.HandleFunc("POST /v1/projects/{id}/github/pr", s.handleCreatePR)
	m.HandleFunc("POST /v1/projects/{id}/github/repo", s.handleCreateRepo)
	m.HandleFunc("POST /v1/shells", s.handleStartShell)
	m.HandleFunc("GET /v1/shells", s.handleShells)
	m.HandleFunc("POST /v1/shutdown", s.handleShutdown)
	m.HandleFunc("POST /v1/statusline", s.handleStatusline)
	m.HandleFunc("GET /v1/statusline/{id}", s.handleStatuslineStats)
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
	// Before anything else: a request from the network gets nothing until it
	// has proved which device it is. Loopback is unaffected.
	r, ok := s.pairingGate(w, r)
	if !ok {
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v1/") {
		// Refuse anything that cannot be shown to come from the dashboard
		// itself or from a real local client. The same-origin policy does NOT
		// protect this API — it stops a page reading the response, not sending
		// the request — and POST /v1/agents runs a command from its body. See
		// csrf.go for the layering and why a missing Origin is not trusted.
		if reason := checkOrigin(r, s.lanHosts()...); reason != "" {
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
	// ContextNote says why Context is absent, which the client cannot work out
	// on its own: a model missing from the pricing table and a session that has
	// not answered yet both arrive as "no context", and they call for opposite
	// reactions. Empty whenever Context is present.
	ContextNote string `json:"context_note,omitempty"`
	// Description tells this session from the others on the screen: the
	// agent's own title, else the first prompt that says something. Source is
	// "title" or "prompt", so the card can style a guess differently from a
	// name.
	Description       string `json:"description,omitempty"`
	DescriptionSource string `json:"description_source,omitempty"`
	// Resume is whether this session can be carried on from here. On the list
	// it is filled for ended sessions only, so a card can offer continue
	// without a trip to the detail screen; the detail fills it for any session
	// that is not Caprock's own live one.
	Resume *ResumeInfo `json:"resume,omitempty"`
	// Detached marks a session Caprock started, not ended, whose terminal this
	// daemon does not hold — it was started before a restart. The terminal tab
	// opened an empty screen for it (FB-040); what it can do is continue.
	Detached bool `json:"detached,omitempty"`
	// ModelDisplay is the pricing table's name for the session's model (its
	// main thread's latest), "Opus 5.5" rather than the id. Empty when the
	// table does not know the model.
	ModelDisplay string `json:"model_display,omitempty"`
	// LiveSubagents is how many subagents are working in the session now:
	// heard from within the last 30 minutes and not yet stopped. Zero for an
	// ended session. The main thread is not counted.
	LiveSubagents int `json:"live_subagents,omitempty"`
	// SurvivesRestart marks a live session Caprock started whose terminal is
	// held by a pty-host (ADR-033), so restarting or upgrading Caprock leaves
	// it running. A live owned session without it is in the daemon's own PTY
	// (the fallback) and ends with the daemon; the upgrade notice counts those.
	SurvivesRestart bool `json:"survives_restart,omitempty"`
	// OpenTerminal is how this session can be opened in the user's own
	// terminal application, filled wherever Resume is. Absent for an agent
	// that cannot reopen a session by id, and when the daemon cannot open
	// terminals at all.
	OpenTerminal *OpenTerminalInfo `json:"open_terminal,omitempty"`
}

// survivor is the optional half of AgentController that knows which sessions
// outlive the daemon. Optional so test doubles need not grow a method.
type survivor interface{ Survives(sessionID string) bool }

// ContextFill is the "context fill %" badge input: last turn's prompt size vs the model window.
type ContextFill struct {
	Tokens int64   `json:"tokens"`
	Window int64   `json:"window"`
	Pct    float64 `json:"pct"`
	// NextCallUSD is what the next tool call costs at this context before it
	// does any work, because every call re-reads the whole conversation as a
	// cache read. It is the marginal figure, and the marginal figure is the
	// one that makes a full context legible: a percentage says the window is
	// nearly full, this says what that is charging per call.
	NextCallUSD float64 `json:"next_call_usd"`
}

// SessionDetail is /v1/sessions/{id}.
type SessionDetail struct {
	SessionSummary
	Files  []string      `json:"files"`
	Events []event.Event `json:"events"`
	// Repo is where the session's directory lives on the web, from its git
	// remote; absent when the directory is not in a repository.
	Repo *gitremote.Repo `json:"repo,omitempty"`
	// PRs are the pull requests this session opened or merged, latest first.
	PRs []store.SessionPR `json:"prs"`
	// RelayedFrom is the session this one was started to carry on; RelayedTo
	// the sessions started to carry this one on (ADR-032).
	RelayedFrom *store.RelayLink  `json:"relayed_from,omitempty"`
	RelayedTo   []store.RelayLink `json:"relayed_to"`
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
	opt := narrate.Options{Now: s.d.Now(), IdleAfter: s.d.IdleAfter, Looping: la != nil, SessionEnded: sess.Status == store.StatusEnded}
	if sess.Status != store.StatusEnded {
		// Counted before narrating: a turn that ended with subagents still at
		// work is "working in background", not waiting on anyone.
		n, err := store.LiveSubagents(ctx, q, sess.SessionID, s.d.Now().Add(-liveSubagentWindow).UnixMilli())
		if err != nil {
			return SessionSummary{}, nil, err
		}
		opt.LiveSubagents = n
		if n > 0 && !hasMainEvent(last) {
			// Subagents filled the window; the main thread's newest event
			// decides whether the parent's turn has ended.
			main, err := store.LastEventsFiltered(ctx, q, sess.SessionID, 1, store.EventFilter{MainOnly: true})
			if err != nil {
				return SessionSummary{}, nil, err
			}
			if len(main) > 0 {
				opt.MainLast = &main[0]
			}
		}
	}
	act := narrate.Summarize(last, opt)
	if act.Health == narrate.HealthWorking && act.Background == 0 && sess.Status == store.StatusIdle {
		act.Health = narrate.HealthIdle
		act.Phrase = "was " + act.Phrase
	}
	sum := SessionSummary{Session: sess, Stats: st, Activity: act, Savings: cost.ComputeSavings(st.TokensIn, st.CacheRead, st.CacheWrite), Loop: la}
	sum.Description, sum.DescriptionSource = describe(ctx, q, sess)
	if sess.Owned && sess.Status != store.StatusEnded && s.d.Agents != nil && !s.d.Agents.Holds(sess.SessionID) {
		sum.Detached = true
	}
	if sess.Owned && sess.Status != store.StatusEnded && !sum.Detached {
		if sv, ok := s.d.Agents.(survivor); ok && sv.Survives(sess.SessionID) {
			sum.SurvivesRestart = true
		}
	}
	if sess.Status == store.StatusEnded || sum.Detached {
		sum.Resume = s.resumeInfo(ctx, sess)
		sum.OpenTerminal = s.openTerminalInfo(sess)
	}
	sum.ModelDisplay = s.modelDisplay(sess.Model)
	sum.LiveSubagents = opt.LiveSubagents
	// Context fill: last assistant turn's input+cache tokens vs the model's window.
	// When it cannot be computed, say which of the two reasons applies. The
	// dashboard used to caption every empty Context "unknown model", including
	// on a session whose model it was naming in the neighbouring column — the
	// model is known there, it just has not answered yet.
	//
	// Measured on the main thread's last turn, not a subagent's: a subagent
	// starts from a fresh, small prompt, so a session whose context was nearly
	// full read nearly empty for as long as its subagent ran. Only a session
	// with no main-thread turn at all (an OpenCode child session) is measured
	// by its subagent turns, which are then its own.
	sum.ContextNote = "no turn yet"
	turn, ok := lastContextTurn(last)
	if !ok || turn.Subagent() {
		main, found, err := store.LastMainTurn(ctx, q, sess.SessionID)
		if err != nil {
			return SessionSummary{}, nil, err
		}
		if found {
			turn, ok = main, true
		}
	}
	if ok {
		sum.Context, sum.ContextNote = s.contextFill(turn, sess.Model)
	}
	return sum, last, nil
}

// contextFill measures one turn's prompt against its model's window, or says
// why it cannot.
func (s *Server) contextFill(e event.Event, sessionModel string) (*ContextFill, string) {
	model := firstNonEmpty(e.Model, sessionModel)
	if model == "" {
		return nil, "unknown model"
	}
	if s.d.Table == nil {
		return nil, "no pricing table"
	}
	row, ok := s.d.Table.Lookup(model)
	if !ok || row.ContextWindow == 0 {
		// Naming it matters: an id the table does not carry is the one
		// thing a user can report and we can fix.
		return nil, model + " not in pricing table"
	}
	toks := e.Tokens.In + e.Tokens.CacheRead + e.Tokens.CacheWrite
	return &ContextFill{
		Tokens:      toks,
		Window:      row.ContextWindow,
		Pct:         100 * float64(toks) / float64(row.ContextWindow),
		NextCallUSD: contexttax.NextCall(toks, contexttax.PricesOf(row)),
	}, ""
}

// lastContextTurn is the newest assistant turn with usage in a window of
// events, preferring the main thread's: a subagent's turn is returned only
// when the window holds no main-thread turn, and the caller looks further back
// for one before settling for it.
func lastContextTurn(evs []event.Event) (event.Event, bool) {
	var sub *event.Event
	for i := len(evs) - 1; i >= 0; i-- {
		e := evs[i]
		if e.Kind != event.KindTurnAssistant || e.Tokens == nil {
			continue
		}
		if !e.Subagent() {
			return e, true
		}
		if sub == nil {
			sub = &evs[i]
		}
	}
	if sub != nil {
		return *sub, true
	}
	return event.Event{}, false
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
	search := r.URL.Query().Get("q")
	// ?dir= lists one Projects row's sessions — an exact match on the
	// directory the row is keyed on, not a search (see ListSessionsInDir).
	if dir := r.URL.Query().Get("dir"); dir != "" {
		sessions, err := store.ListSessionsInDir(ctx, s.d.Store.DB(), dir, limit)
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
			// Every row carries whether it can be picked up: the caller is
			// about to offer exactly that, for live sessions as well as ended.
			sum.Resume = s.resumeInfo(ctx, sess)
			sum.OpenTerminal = s.openTerminalInfo(sess)
			out = append(out, sum)
		}
		writeJSON(w, http.StatusOK, out)
		return
	}
	sessions, err := store.ListSessionsMatching(ctx, s.d.Store.DB(), active, search, limit)
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
	// How many exist, beside how many are in this page. The list is capped at
	// 200, and a screen that labels a truncated array "Ended · 200" states a
	// count of what it fetched as though it were a count of what there is —
	// while the lifetime strip on the same screen says otherwise.
	if total, err := store.CountSessionsMatching(ctx, s.d.Store.DB(), active, search); err == nil {
		w.Header().Set("X-Total-Count", strconv.Itoa(total))
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
	sum.Resume = s.resumeInfo(ctx, sess)
	sum.OpenTerminal = s.openTerminalInfo(sess)
	from, to, err := store.RelayLinks(ctx, s.d.Store.DB(), sess)
	if err != nil {
		s.fail(w, err)
		return
	}
	detail := SessionDetail{SessionSummary: sum, Files: files, Events: last, PRs: []store.SessionPR{}, RelayedFrom: from, RelayedTo: to}
	if r, ok := s.repos.get(ctx, sess.Cwd); ok {
		detail.Repo = &r
	}
	if prs, err := store.SessionPRs(ctx, s.d.Store.DB(), id); err == nil && prs != nil {
		detail.PRs = prs
	}
	writeJSON(w, http.StatusOK, detail)
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
		// `main=1` and `kind=a,b` filter before the limit, so a parent whose
		// subagents log hundreds of events an hour still gets its own newest
		// calls rather than a page of theirs.
		f := store.EventFilter{MainOnly: r.URL.Query().Get("main") == "1"}
		for _, k := range strings.Split(r.URL.Query().Get("kind"), ",") {
			if k = strings.TrimSpace(k); k != "" {
				f.Kinds = append(f.Kinds, k)
			}
		}
		evs, err = store.LastEventsFiltered(r.Context(), s.d.Store.DB(), id, limit, f)
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
	// CodexRateLimits is Codex's plan windows as its newest transcript last
	// recorded them: measured, with observed_at, and never a forecast. nil
	// when no Codex transcript has carried one.
	CodexRateLimits *RateLimits `json:"codex_rate_limits,omitempty"`
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
	// LimitAt is when the same pace reaches 100% (unix ms), set exactly when
	// Forecast is, so the dashboard can say "around 19:10" without parsing
	// the sentence.
	LimitAt int64 `json:"limit_at,omitempty"`
	// ObservedAt is when the agent wrote this figure (unix ms). Set for
	// Codex, whose windows are read out of a transcript that may be hours or
	// days old; Claude Code's arrive live and leave it unset.
	ObservedAt int64 `json:"observed_at,omitempty"`
}

// Burn is the recent spend rate ("$/hr equivalent, tokens/min") over a short window.
type Burn struct {
	WindowMin  int     `json:"window_min"`
	USDPerHour float64 `json:"usd_per_hour"`
	TokPerMin  float64 `json:"tokens_per_min"`
	Turns      int64   `json:"turns"`
	// Filling is true while the daemon has been up for less than the window,
	// so the screen can say "still measuring" rather than print a rate
	// extrapolated from a handful of seconds. Honest arithmetic on twenty
	// seconds of history still reads as an alarming number.
	Filling bool `json:"filling,omitempty"`
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
func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	if s.d.Settings == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("settings are not available"))
		return
	}
	st := s.d.Settings.Get()
	if s.fromPairedDevice(r) {
		// A paired device reads figures; it does not get the key that pays for
		// them. Whether the plan is active is GET /v1/premium's answer.
		st.LicenseKey = ""
	}
	writeJSON(w, http.StatusOK, st)
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
		Memory          *bool    `json:"memory"`
		MemoryHoldout   *int     `json:"memory_holdout_pct"`
		PlanKind        *string  `json:"plan_kind"`
		PlanLabel       *string  `json:"plan_label"`
		PlanUSDPerMonth *float64 `json:"plan_usd_per_month"`
		LicenseKey      *string  `json:"license_key"`
		CapUSDPerDay    *float64 `json:"cap_usd_per_day"`
		WindowStopPct   *int     `json:"window_stop_pct"`
		BrowseRoot      *string  `json:"browse_root"`
		Terminal        *string  `json:"terminal"`
		Editor          *string  `json:"editor"`
		SpawnMode       *string  `json:"spawn_permission_mode"`
		// The bot token goes in and never comes back out. An empty string is a
		// deliberate clear, which is why it is a pointer like everything else.
		ReportBotToken *string `json:"report_bot_token"`
		ReportChatID   *string `json:"report_chat_id"`
		GeminiAPIKey   *string `json:"gemini_api_key"`
		AlertApproval  *bool   `json:"alert_approval"`
		AlertFinished  *bool   `json:"alert_finished"`
		AlertReply     *bool   `json:"alert_reply"`
		NotifyApproval *bool   `json:"notify_approval"`
		NotifyFinished *bool   `json:"notify_finished"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&patch); err != nil {
		s.failCode(w, http.StatusBadRequest, fmt.Errorf("parse body: %w", err))
		return
	}
	in := s.d.Settings.Get()
	if patch.UpdateChecks != nil {
		in.UpdateChecks = *patch.UpdateChecks
	}
	if patch.Memory != nil {
		in.Memory = *patch.Memory
	}
	if patch.MemoryHoldout != nil {
		// At most half: past that the handoff is mostly off, and the few
		// sessions still getting it would take weeks to say anything.
		if v := *patch.MemoryHoldout; v < 0 || v > 50 {
			s.failCode(w, http.StatusBadRequest, errors.New("memory_holdout_pct must be between 0 and 50"))
			return
		}
		in.MemoryHoldoutPct = *patch.MemoryHoldout
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
	if patch.WindowStopPct != nil {
		// Off, or a share between half and just under full: below half the
		// stop fires on an ordinary morning, and at 100% Claude Code has
		// already stopped by itself.
		v := *patch.WindowStopPct
		if v != 0 && (v < capguard.MinWindowPct || v > capguard.MaxWindowPct) {
			s.failCode(w, http.StatusBadRequest, fmt.Errorf("window_stop_pct must be 0 (off) or between %d and %d", capguard.MinWindowPct, capguard.MaxWindowPct))
			return
		}
		in.WindowStopPct = v
	}
	if patch.BrowseRoot != nil {
		in.BrowseRoot = *patch.BrowseRoot
	}
	if patch.Terminal != nil {
		v := strings.TrimSpace(*patch.Terminal)
		if v != "" && !contains(nativeterm.IDs(runtime.GOOS), v) {
			s.failCode(w, http.StatusBadRequest, fmt.Errorf("terminal must be empty or one of %s", strings.Join(nativeterm.IDs(runtime.GOOS), ", ")))
			return
		}
		in.Terminal = v
	}
	if patch.Editor != nil {
		v := strings.TrimSpace(*patch.Editor)
		if v != "" && !contains(editor.IDs(), v) {
			s.failCode(w, http.StatusBadRequest, fmt.Errorf("editor must be empty or one of %s", strings.Join(editor.IDs(), ", ")))
			return
		}
		in.Editor = v
	}
	if patch.SpawnMode != nil {
		// Validated, not passed through: a word Claude Code does not accept
		// would stop every new session from starting.
		v := strings.TrimSpace(*patch.SpawnMode)
		if v != "" && !agents.IsPermissionMode(v) {
			s.failCode(w, http.StatusBadRequest, fmt.Errorf("spawn_permission_mode must be empty or one of %s", strings.Join(agents.PermissionModes, ", ")))
			return
		}
		in.SpawnMode = v
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
	if patch.AlertApproval != nil {
		in.AlertApproval = *patch.AlertApproval
	}
	if patch.AlertFinished != nil {
		in.AlertFinished = *patch.AlertFinished
	}
	if patch.AlertReply != nil {
		in.AlertReply = *patch.AlertReply
	}
	if patch.NotifyApproval != nil {
		in.NotifyApproval = *patch.NotifyApproval
	}
	if patch.NotifyFinished != nil {
		in.NotifyFinished = *patch.NotifyFinished
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
	sum, err := s.rangeSummary(ctx, from, label, agent)
	if err != nil {
		s.fail(w, err)
		return
	}
	sum.Range = label
	if sum.Models == nil {
		sum.Models = []store.ModelShare{}
	}
	// The rows are shared with the summary cache (rangeSummary), so links go
	// on a copy: writing them in place would race other readers of the entry.
	sum.Projects = append([]store.ProjectShare{}, sum.Projects...)
	s.linkProjects(ctx, sum.Projects)
	resp := SummaryResponse{Summary: sum, Savings: cost.ComputeSavings(sum.TokensIn, sum.CacheRead, sum.CacheWrite)}
	if s.d.Table != nil {
		resp.Pricing = s.d.Table.Version
	}
	// Burn over the last 10 minutes — through the same agent filter as the
	// figures beside it. It sits in one grid row with "cost today", so an
	// unfiltered burn under a heading that says "opencode" is the mistake the
	// comment above rejects, made one tile to the right.
	const win = 10 * time.Minute
	recent, err := store.SummarizeSparkFor(ctx, s.d.Store.DB(), s.d.Now().Add(-win).UnixMilli(), store.SparkSpec{}, agent)
	if err == nil {
		// Divide by the time actually covered, not by the window's width.
		//
		// A daemon three minutes old has three minutes of history and was
		// dividing it by ten, so a rate read a third of the truth with nothing
		// saying the window was still filling. The spark on the same screen
		// already refuses to extrapolate its last bucket for exactly this
		// reason; this is the same rule, applied to the tile beside it.
		covered, filling := win, false
		if up := s.d.Now().Sub(s.d.Started); !s.d.Started.IsZero() && up < win {
			covered, filling = up, true
		}
		if covered < time.Second {
			covered = time.Second // a daemon that just started divides by nothing
		}
		resp.Burn = Burn{WindowMin: int(win / time.Minute), Turns: recent.Turns, Filling: filling,
			USDPerHour: recent.CostUSD / covered.Hours(),
			TokPerMin:  float64(recent.TokensIn+recent.TokensOut+recent.CacheRead+recent.CacheWrite) / covered.Minutes()}
	}
	if n, err := store.CountThrottles(ctx, s.d.Store.DB(), from, agent); err == nil {
		resp.Throttles = n
	}
	// Live rate-limit windows (not range-scoped — this is current state).
	resp.RateLimits = s.rateLimits(ctx)
	resp.CodexRateLimits = s.codexRateLimits(ctx)
	writeJSON(w, http.StatusOK, resp)
}

// Warm computes the whole-history answers the dashboard asks for first — the
// lifetime strip's /v1/history?range=all and the 7d, 30d and all-time
// summaries the Cost screen and the share dialog open with, and the share
// dialog's all-time and 30-day Weeks — so the first
// screen after a start finds them cached instead of paying for the scans.
// Run in the background; it returns when they are done or ctx ends. Errors are
// dropped: a key that failed to warm is simply computed on first request, as
// it would have been without this.
func (s *Server) Warm(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	from, label := s.rangeFrom("all")
	_, _ = s.hist.get(ctx, label+"|"+strconv.FormatInt(from, 10), func() (any, error) {
		return s.buildHistory(ctx, from, label)
	})
	for _, rng := range []string{"7d", "30d", "all"} {
		if ctx.Err() != nil {
			return
		}
		from, label := s.rangeFrom(rng)
		_, _ = s.rangeSummary(ctx, from, label, "")
	}
	s.warmWeek(ctx)
}

// rangeSummary is the aggregate behind /v1/stats/summary for one range.
//
// Today's is computed on every request: it is ~40ms, and it is the figure
// people watch move. Every wider range goes through the answer cache, because
// a 7d, 30d or all-time summary scans that much more of the events table —
// ~1s for all time on the owner's 1 GB database — for figures that a few
// seconds cannot visibly change. The returned Summary is a copy; its slices
// are shared with the cache and must not be written to.
func (s *Server) rangeSummary(ctx context.Context, from int64, label string, agent store.AgentFilter) (store.Summary, error) {
	spark := s.sparkSpec(label, from)
	compute := func(c context.Context) (store.Summary, error) {
		return store.SummarizeSparkFor(c, s.d.Store.DB(), from, spark, agent)
	}
	if label == "today" {
		return compute(ctx)
	}
	key := "summary|" + label + "|" + strconv.FormatInt(from, 10) + "|" + string(agent)
	v, err := s.summ.get(ctx, key, func() (any, error) {
		return compute(context.WithoutCancel(ctx))
	})
	if err != nil {
		return store.Summary{}, err
	}
	return v.(store.Summary), nil
}

// linkProjects gives each Projects row its repository's web address and the
// latest pull request any session in it opened. Both are local reads: the
// remote from git (cached per directory), the PR from session_prs.
func (s *Server) linkProjects(ctx context.Context, rows []store.ProjectShare) {
	latest, _ := store.LatestPRByDir(ctx, s.d.Store.DB())
	// Directories are looked up side by side: a first, uncached answer is a
	// few git processes per row, and a panel of rows in sequence was most of
	// the summary's first response.
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for i := range rows {
		if rows[i].Dir == "" {
			continue
		}
		if pr, ok := latest[rows[i].Dir]; ok {
			rows[i].LastPR = &pr
		}
		// No git in a folder macOS guards: opening the dashboard must not ask
		// for Documents or Downloads. The row keeps its cost, without a link.
		if protectedDir(rows[i].Dir) {
			continue
		}
		wg.Add(1)
		go func(row *store.ProjectShare) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if r, ok := s.repos.get(ctx, row.Dir); ok {
				row.RepoURL = r.URL
			}
		}(&rows[i])
	}
	wg.Wait()
}

// codexRateLimits is Codex's latest observed windows, or nil. No forecast:
// the figure comes from a transcript, not a live feed, so there is no slope
// measured over the current window to project from.
func (s *Server) codexRateLimits(ctx context.Context) *RateLimits {
	snaps, err := store.RateLimitsWithPrefix(ctx, s.d.Store.DB(), store.CodexRateLimitPrefix)
	if err != nil || len(snaps) == 0 {
		return nil
	}
	var out RateLimits
	for _, snap := range snaps {
		rw := &RateWindow{UsedPercentage: snap.UsedPercentage, ResetsAt: snap.ResetsAt, ObservedAt: snap.Ts}
		switch snap.Window {
		case "five_hour":
			out.FiveHour = rw
		case "seven_day":
			out.SevenDay = rw
		}
	}
	if out.FiveHour == nil && out.SevenDay == nil {
		return nil
	}
	return &out
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
		rw.Forecast, rw.LimitAt = s.paceForecast(ctx, window, snap)
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

// paceForecast returns "~Nh to limit at current pace", and when that is (unix
// ms), only when the observed usage slope is rising and exhaustion is projected
// before the window resets; otherwise "" and 0 (show only the measured fact).
// No invented numbers: every input is measured and the projection is
// explicitly pace-conditional.
func (s *Server) paceForecast(ctx context.Context, window string, snap store.RateLimitSnapshot) (string, int64) {
	if snap.UsedPercentage >= 100 {
		return "", 0
	}
	pctPerHour, ok, err := store.RateLimitPace(ctx, s.d.Store.DB(), window, snap.ResetsAt)
	if err != nil || !ok || pctPerHour <= 0 {
		return "", 0
	}
	hoursToLimit := (100 - snap.UsedPercentage) / pctPerHour
	// Only forecast if the limit would be hit before the window resets. Use the
	// daemon's injectable clock (like the rest of the API) so the forecast is
	// consistent and deterministic in tests, not tied to raw wall-clock.
	resetIn := time.Unix(snap.ResetsAt, 0).Sub(s.d.Now())
	if resetIn <= 0 || hoursToLimit >= resetIn.Hours() {
		return "", 0 // resets before the limit at current pace — no warning
	}
	at := s.d.Now().Add(time.Duration(hoursToLimit * float64(time.Hour))).UnixMilli()
	if hoursToLimit < 1 {
		return fmt.Sprintf("~%dm to limit at current pace", int(hoursToLimit*60)), at
	}
	return fmt.Sprintf("~%.1fh to limit at current pace", hoursToLimit), at
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
	// Tax is what this range paid to re-send its own context: every turn
	// re-reads the whole conversation before it does anything. Absent when
	// there is no pricing table to charge it at, rather than zero -- a zero
	// tax reads as "this workload had none", which no workload does.
	Tax *contexttax.Lifetime `json:"tax,omitempty"`
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	from, label := s.rangeFrom(r.URL.Query().Get("range"))
	// Keyed by the resolved range rather than the raw query string, so
	// "?range=" and "?range=today" — the same question spelled two ways —
	// share one answer; and by its start, so "today" is a new key at midnight.
	key := label + "|" + strconv.FormatInt(from, 10)
	v, err := s.hist.get(r.Context(), key, func() (any, error) {
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
	resp := HistoryResponse{Range: label, Totals: tot, Tools: tools, Daily: daily, Summary: sum, Savings: cost.ComputeSavings(sum.TokensIn, sum.CacheRead, sum.CacheWrite)}
	if s.d.Table != nil {
		models := make([]contexttax.ModelTax, 0, len(sum.Models))
		for _, m := range sum.Models {
			models = append(models, contexttax.ModelTax{Model: m.Model, CacheRead: m.CacheRead, CostUSD: m.CostUSD})
		}
		lt := contexttax.Sum(models, s.d.Table)
		resp.Tax = &lt
	}
	return resp, nil
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	var st any = map[string]any{"version": s.d.Version}
	if s.d.Status != nil {
		st = s.d.Status(r.Context())
	}
	writeJSON(w, http.StatusOK, st)
}

// handleStorage reports what Caprock keeps on disk. The answer is assembled
// from a cache the daemon refreshes in the background, so polling it is cheap.
func (s *Server) handleStorage(w http.ResponseWriter, r *http.Request) {
	if s.d.Storage == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("storage report not available"))
		return
	}
	writeJSON(w, http.StatusOK, s.d.Storage(r.Context()))
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
	if s.d.RateLimitsRecorded != nil && (body.FiveHour != nil || body.SevenDay != nil) {
		// Detached: pausing sessions must not be cancelled because the status
		// line's 300 ms budget ran out first.
		go s.d.RateLimitsRecorded(context.WithoutCancel(ctx))
	}
	w.WriteHeader(http.StatusNoContent)
}

// StatuslineStats is GET /v1/statusline/{id} — the figures the status line puts
// on screen, and nothing else.
//
// The session detail endpoint already carries these, but it also loads sixty
// events, a hundred file paths, narration and a pricing lookup to do it. This
// runs on every assistant message, ahead of a line the user is waiting for, so
// it is deliberately one indexed row and no derived work.
type StatuslineStats struct {
	Turns     int64 `json:"turns"`
	ToolCalls int64 `json:"tool_calls"`
	TokensIn  int64 `json:"tokens_in"`
	TokensOut int64 `json:"tokens_out"`
	// CacheRead and CacheWrite are returned raw rather than as a hit rate:
	// what counts as the denominator is a presentation choice, and the caller
	// that renders it should make it.
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_write"`
}

func (s *Server) handleStatuslineStats(w http.ResponseWriter, r *http.Request) {
	if s.d.Token == "" || r.Header.Get("Authorization") != "Bearer "+s.d.Token {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	st, err := store.GetStats(r.Context(), s.d.Store.DB(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	// An unknown session is zeros, not a 404: the first call of a session races
	// the first turn being recorded, and the caller renders "no numbers yet"
	// identically either way.
	writeJSON(w, http.StatusOK, StatuslineStats{
		Turns: st.Turns, ToolCalls: st.ToolCalls,
		TokensIn: st.TokensIn, TokensOut: st.TokensOut,
		CacheRead: st.CacheRead, CacheWrite: st.CacheWrite,
	})
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
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "the task runner is off", "detail": "turn it on from the Tasks screen, or start the daemon with `caprock up --hive <dir>`"})
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
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "can't start sessions", "detail": "No coding agent Caprock can start is on your PATH — install Claude Code, Codex, OpenCode or Gemini CLI, or add it. Caprock still watches sessions you start yourself."})
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
	// A resume the detail screen would refuse is refused here too, with the
	// same reason: otherwise a stale button opens a terminal that prints "No
	// conversation found" and dies. An id the store has never seen is let
	// through — the store not knowing a session is not evidence it is gone.
	if resume, _ := req["resume"].(string); resume != "" {
		if sess, err := store.GetSession(r.Context(), s.d.Store.DB(), resume); err == nil {
			if info := s.resumeState(sess); info != nil && !info.OK {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": info.Reason})
				return
			}
		}
	}
	if msg := s.checkRelay(r.Context(), req); msg != "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
		return
	}
	dev := deviceFrom(r)
	if dev != nil {
		if msg := s.controllerSpawnRefusal(req); msg != "" {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": msg})
			return
		}
	}
	// A continue picks up in the mode the session was last in; a new session
	// starts in the stated preference.
	s.defaultSpawnMode(r.Context(), req)
	if s.needsBypassConsent(req) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": bypassConsentMsg, "code": "bypass_consent"})
		return
	}
	// Spawn with a background context: the process must outlive this HTTP request.
	id, cwd, err := s.d.Agents.Spawn(context.WithoutCancel(r.Context()), req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if dev != nil {
		// Said in the log, because a session the owner did not start at the
		// machine should be traceable to the device that did.
		s.d.Log.Info("session started from a paired device", "component", "api", "session", id, "device", dev.ID, "device_name", dev.Name)
	}
	writeJSON(w, http.StatusOK, map[string]string{"session_id": id, "cwd": cwd})
}

// handleAgentModels lists the models an agent's own CLI offers, for the
// new-session dialog. Codex keeps its catalog on disk; for the other agents
// the dialog has its own checked list (Claude Code, Gemini CLI) or takes the
// user's provider/model as typed (OpenCode), and this answers an empty list.
// No network I/O: it reads files the CLI already wrote.
func (s *Server) handleAgentModels(w http.ResponseWriter, r *http.Request) {
	type resp struct {
		Agent   string        `json:"agent"`
		Default string        `json:"default,omitempty"`
		Models  []codex.Model `json:"models"`
	}
	agent := r.URL.Query().Get("agent")
	out := resp{Agent: agent, Models: []codex.Model{}}
	switch agent {
	case "codex":
		if m := codex.ListedModels(); len(m) > 0 {
			out.Models = m
		}
		out.Default = codex.ConfiguredModel()
	case "claude", "gemini", "opencode":
	default:
		http.Error(w, `agent must be one of claude, codex, opencode, gemini`, http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, out)
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
	if s.refuseShellToDevice(w, r, r.PathValue("id")) {
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
		// Name the field, not just the values: the old message ("action must be
		// pause|resume|kill") left a caller who sent the wrong key guessing.
		http.Error(w, `body must be {"action": "pause"|"resume"|"kill"}`, http.StatusBadRequest)
		return
	}
	if s.refuseShellToDevice(w, r, r.PathValue("id")) {
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

// handleTestReport sends this week's report now.
//
// The failure mode of the weekly report is silence, so the only way to tell a
// working setup from a typo used to be waiting a week and then finding nothing
// — which looks exactly like a week where nothing moved.
func (s *Server) handleTestReport(w http.ResponseWriter, r *http.Request) {
	if s.d.Reporter == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("reporting is unavailable"))
		return
	}
	if err := s.d.Reporter.SendReportNow(r.Context()); err != nil {
		// Telegram's own words reach the screen: "chat not found" and "bot was
		// blocked by the user" are both things only the user can fix.
		s.failCode(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"sent": "ok"})
}

// handleTestAlert sends one phone alert now, so a bot can be checked without
// waiting for a session to need someone.
func (s *Server) handleTestAlert(w http.ResponseWriter, r *http.Request) {
	if s.d.Alerts == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("alerts are unavailable"))
		return
	}
	if err := s.d.Alerts.SendAlertCheck(r.Context()); err != nil {
		s.failCode(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"sent": "ok"})
}

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
	case "claude", "opencode", "gemini", "codex", "deepseek":
		return store.AgentFilter(v), nil
	default:
		return "", fmt.Errorf("unknown agent %q: use claude, opencode, gemini, codex, deepseek, or omit for all", v)
	}
}

// lanHosts are the bare names of every network address this daemon answers
// on, empty when there is none. Used by the origin check, which must admit
// those addresses and no other.
func (s *Server) lanHosts() []string {
	s.lanMu.RLock()
	defer s.lanMu.RUnlock()
	return s.lanHostsLocked()
}

func (s *Server) lanHostsLocked() []string {
	var out []string
	for _, u := range append([]string{s.lanURL}, s.altURLs...) {
		if h := hostOf(u); h != "" {
			out = append(out, h)
		}
	}
	return out
}

// SetLAN switches network access on or off while the daemon is running. A nil
// store means off: from then on nothing off-loopback is served, and the other
// addresses (SetLANAlternates) are forgotten too.
func (s *Server) SetLAN(p *pairing.Store, url string) {
	s.lanMu.Lock()
	s.pairing, s.lanURL = p, url
	if p == nil || url == "" {
		s.altURLs = nil
	}
	hosts := s.lanHostsLocked()
	s.lanMu.Unlock()
	s.ws.setLANHosts(hosts)
}

// SetLANAlternates names the addresses network access answers on besides
// the one SetLAN gave: the second listener's, and the MagicDNS name of the
// Tailscale one. Ignored while network access is off.
func (s *Server) SetLANAlternates(urls []string) {
	s.lanMu.Lock()
	if s.lanURL == "" {
		urls = nil
	}
	s.altURLs = append([]string(nil), urls...)
	hosts := s.lanHostsLocked()
	s.lanMu.Unlock()
	s.ws.setLANHosts(hosts)
}

// lanAlternates reads what SetLANAlternates wrote.
func (s *Server) lanAlternates() []string {
	s.lanMu.RLock()
	defer s.lanMu.RUnlock()
	return append([]string(nil), s.altURLs...)
}

// lanState reads what SetLAN wrote. Every request calls it, so it takes the
// read side of the lock and copies out.
func (s *Server) lanState() (*pairing.Store, string) {
	s.lanMu.RLock()
	defer s.lanMu.RUnlock()
	return s.pairing, s.lanURL
}

// hostOf is the bare hostname of a URL, or "" when there is none.
func hostOf(raw string) string {
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

// handleWindowStop is GET /v1/window-stop: what the plan-window stop would act
// on and what it has done (internal/cap/window.go, .ai/03-contracts.md).
func (s *Server) handleWindowStop(w http.ResponseWriter, r *http.Request) {
	if s.d.WindowStop == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("the plan-window stop is not available"))
		return
	}
	writeJSON(w, http.StatusOK, s.d.WindowStop(r.Context()))
}

// hasMainEvent reports whether any of events is the main thread's own.
func hasMainEvent(events []event.Event) bool {
	for _, e := range events {
		if !e.Subagent() {
			return true
		}
	}
	return false
}
