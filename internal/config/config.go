// Package config resolves Caprock's data directory and the small on-disk files
// that live in it: config.json (user settings) and runtime.json (per-run port +
// token, read by the hook shim). See .ai/03-contracts.md and ADR-013.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// EnvDataDir overrides the resolved data directory when set.
const EnvDataDir = "CAPROCK_DATA_DIR"

const (
	// DefaultPort is the single loopback port shared by the API, WS, UI and
	// hook receiver on a fresh install. 22776 spells CAPRO on a phone keypad,
	// is unassigned by IANA, sits below common ephemeral ranges, and avoids
	// Vite Preview's default 4173.
	DefaultPort = 22776
	// LegacyDefaultPort preserves the origin and bookmarks of an existing
	// install that never wrote config.json. A port is part of a browser origin;
	// silently moving it would also strand LAN pairing tokens in localStorage.
	LegacyDefaultPort = 4173
)

// Config is the user-editable configuration stored at <data_dir>/config.json.
// Every field has a default; a missing file means "all defaults".
type Config struct {
	Port int `json:"port"`
	// Loop detector: >= K same-tool similar-input tool.pre events within T minutes.
	LoopK        int `json:"loop_k"`
	LoopTMinutes int `json:"loop_t_minutes"`
	// LANKeepOn turns phone access (LAN access) back on when the daemon
	// starts, as if `caprock up --lan` had been given. Off unless the user
	// ticks *Keep on after Caprock restarts* (ADR-060, amending ADR-029):
	// only paired devices get in either way, so what it keeps open is the
	// pairing page on a named address, not the data. Turning phone access off
	// clears it.
	LANKeepOn bool `json:"lan_keep_on,omitempty"`
	// Brain is Second Brain's automatic extraction (ADR-063): whether it
	// runs, how much of the user's own claude it may spend a day, and how far
	// back it reads. Empty until the user answers the offer to turn it on.
	Brain BrainConfig `json:"brain,omitzero"`
	// AutoPause applies to owned sessions only (Phase 1). Default off.
	AutoPause bool `json:"auto_pause"`
	// Memory decides whether a session opening a folder is told what the last
	// one left there. On by default: 79% of sessions open somewhere work
	// already happened, so it helps more often than it intrudes — and a
	// feature that acts before you type is one nobody discovers if it ships
	// off. Stored, unlike LAN access, because this is a working habit rather
	// than a door left open.
	Memory *bool `json:"memory,omitempty"`
	// MemoryHoldoutPct holds the handoff back from this share of the new
	// sessions that could have had one, so there is something to compare the
	// ones that got it against. 0 — the default — holds nothing back: nobody's
	// sessions get worse unless they asked to measure it.
	MemoryHoldoutPct int `json:"memory_holdout_pct,omitempty"`
	// OpenBrowser controls whether `caprock up` opens the dashboard.
	OpenBrowser bool `json:"open_browser"`
	// RetentionDays prunes events older than this many days (0 = keep forever).
	// The database grows ~1 KB per event; set this if you run Caprock constantly.
	RetentionDays int `json:"retention_days"`
	// Billing describes how the user actually pays for Claude Code, so the
	// dashboard can say something true about what their usage is worth.
	//
	// Caprock cannot detect this and never guesses: Claude Code does not report
	// the plan, and inferring one from usage would be an invented number
	// (engineering rule 6). The user states it; we store it locally.
	//
	// PlanKind is one of:
	//   ""           not stated — no comparison is shown
	//   "flat"       a flat subscription (Pro/Max/Team seat): usage priced at
	//                API list is an equivalent, and comparing it to the fee is
	//                meaningful
	//   "metered"    API key, Bedrock, Vertex, or Enterprise usage billed at
	//                API rates: the API-list figure IS approximately the bill,
	//                so it must never be framed as a saving
	// PlanLabel is the user's own words for the plan ("Max", "Team seat").
	// PlanUSDPerMonth is what they pay per month for one seat; 0 = not stated.
	// UpdateChecks enables the one outbound call Caprock makes: asking GitHub
	// for the latest release tag. Off by default and asked for once — see
	// internal/update for why this is opt-in and why Caprock never installs
	// the update itself.
	UpdateChecks bool `json:"update_checks"`

	PlanKind        string  `json:"plan_kind"`
	PlanLabel       string  `json:"plan_label"`
	PlanUSDPerMonth float64 `json:"plan_usd_per_month"`

	// LicenseKey unlocks the paid features. Checked locally against its own
	// embedded expiry — no network call, no signature (ADR-022). Empty is the
	// normal state: the free product is the whole product for one person.
	LicenseKey string `json:"license_key,omitempty"`
	// CapUSDPerDay is the daily spend ceiling. Zero is off, which is the
	// default: a threshold nobody chose would eventually stop work for a
	// reason its owner could not explain. See internal/cap.
	CapUSDPerDay float64 `json:"cap_usd_per_day,omitempty"`
	// WindowStopPct is the share of a Claude plan window (five-hour or
	// weekly) at which Premium pauses the Claude Code sessions Caprock started,
	// until the window resets. Off until chosen, like the daily cap: a pause
	// nobody asked for would stop work for a reason its owner could not
	// explain. 0 or nil is off. See internal/cap/window.go.
	WindowStopPct *int `json:"window_stop_pct,omitempty"`
	// ReportBotToken and ReportChatID configure the weekly report's delivery to
	// the user's own Telegram bot.
	//
	// The token is never written here (ADR-024 as amended): it lives in the
	// macOS login keychain, or a 0600 file in the data directory where there
	// is none (internal/secret). The field is the daemon's in-memory copy, read
	// from that store at start; ReportBotStored records that one is kept, so a
	// daemon that never stored one never asks the Keychain.
	// LegacyReportBotToken is what releases before the move wrote to
	// config.json: read once at start, moved to the store, then removed.
	ReportBotToken       string `json:"-"`
	ReportBotStored      bool   `json:"report_bot_stored,omitempty"`
	LegacyReportBotToken string `json:"report_bot_token,omitempty"`
	ReportChatID         string `json:"report_chat_id,omitempty"`
	// AlertApproval and AlertFinished switch the phone alerts sent through
	// the same bot: a session waiting for approval, a session that finished
	// (ADR-036). "Never set" means off: a bot set up for the weekly report
	// does not start sending alerts on its own. Free, unlike the weekly
	// report.
	AlertApproval *bool `json:"alert_approval,omitempty"`
	AlertFinished *bool `json:"alert_finished,omitempty"`
	// AlertReply puts the first line of the agent's final reply in a
	// finished alert. On unless switched off, like the two above; Telegram
	// reads it, which the Settings line says.
	AlertReply *bool `json:"alert_reply,omitempty"`
	// TelegramChat lets the paired Telegram chat talk back (ADR-047): a reply
	// types into a session Caprock started, /sessions, /new and /stop work,
	// and Approve and Deny appear under a question. Premium, and off until
	// switched on even with a licence: it is control from outside the
	// machine. TelegramCode sends a reply's code blocks to that chat instead
	// of a one-line note; off unless switched on.
	TelegramChat *bool `json:"telegram_chat,omitempty"`
	TelegramCode *bool `json:"telegram_code,omitempty"`
	// NotifyApproval and NotifyFinished switch the desktop app's OS
	// notifications (WP-09), apart from Telegram's: a notification stays on
	// the machine. Approval is on unless switched off — a blocked agent is
	// what the app exists to report; finished is off unless switched on.
	NotifyApproval *bool `json:"notify_approval,omitempty"`
	NotifyFinished *bool `json:"notify_finished,omitempty"`
	// GeminiAPIKey is the user's Google AI Studio key, entered in the dashboard.
	// GEMINI_API_KEY in the environment takes precedence when both exist, so a
	// machine already configured that way is untouched (ADR-025). Stored under
	// the same 0600/0700 posture as everything else here, and never returned
	// over HTTP.
	GeminiAPIKey string `json:"gemini_api_key,omitempty"`
	// DeepSeekAPIKey is the user's DeepSeek platform key, entered in Settings →
	// Subscriptions. Set, it offers "DeepSeek" beside the Claude Code sign-ins:
	// a session started on it gets the key in its own environment as
	// ANTHROPIC_AUTH_TOKEN and talks to DeepSeek's Anthropic-compatible API
	// (internal/agents/provider.go). Caprock itself sends nothing with it.
	//
	// Never written here: it lives where the GitHub token does — the macOS
	// login keychain, or a 0600 file in the data directory (internal/secret) —
	// and is read from there when a session starts. The field is the daemon's
	// in-memory copy; DeepSeekKeyStored records that one is kept. Never
	// returned over HTTP (only whether one is set and a masked hint), never
	// logged; clearing it deletes it from the store. LegacyDeepSeekAPIKey is
	// what releases before the move wrote to config.json: read once at start,
	// moved to the store, then removed.
	DeepSeekAPIKey       string `json:"-"`
	DeepSeekKeyStored    bool   `json:"deepseek_key_stored,omitempty"`
	LegacyDeepSeekAPIKey string `json:"deepseek_api_key,omitempty"`
	// CustomAgents are coding agents the user added by command (ADR-046), a
	// paid feature: kept whatever the licence says, offered and started only
	// while it is active. Edited through PUT /v1/agents/custom, which
	// validates them; see internal/agentcat.
	CustomAgents []CustomAgent `json:"custom_agents,omitempty"`
	// Subscriptions are the sign-ins added in Settings → Subscriptions
	// (ADR-048), each in its own configuration directory under the data dir.
	// The Default one is the user's normal sign-in and is not listed here.
	Subscriptions []Subscription `json:"subscriptions,omitempty"`
	// DefaultSubscription is, per agent ("claude", "codex"), the subscription
	// a new session starts on when none is picked — Make default in Settings →
	// Subscriptions. Absent means the user's own sign-in, as before. It is
	// Caprock's choice of directory for the sessions it starts: ~/.claude and
	// its credentials are never moved or rewritten.
	DefaultSubscription map[string]string `json:"default_subscription,omitempty"`
	// OwnLabels names the user's own sign-in per agent, when renamed.
	OwnLabels map[string]string `json:"own_labels,omitempty"`
	// Prompts records when each of the dashboard's own offers was last
	// answered — the GitHub star strip, the Premium and Teams nudges, the
	// share prompt — keyed by prompt id, in Unix ms. Kept here rather than in
	// the browser so an answer given in the desktop app holds in a browser
	// tab too, and the other way round. See .ai/04-ui.md, "Product-led
	// surfaces".
	Prompts map[string]int64 `json:"prompts,omitempty"`
	// BrowseRoot is where the folder picker may look. Empty means $HOME.
	BrowseRoot string `json:"browse_root,omitempty"`
	// DefaultFolder is where the Add project sheet starts: its folder field,
	// a new project's parent, a clone's destination and the folder browser.
	// Empty means the home folder. A leading ~ is the home folder.
	DefaultFolder string `json:"default_folder,omitempty"`
	// Terminal is the terminal application "Open in my terminal" uses
	// ("ghostty", "iterm2", ...; internal/nativeterm). Empty means the first
	// one installed.
	Terminal string `json:"terminal,omitempty"`
	// Editor is the editor "Open in editor" uses ("vscode", "zed", ...;
	// internal/editor). Empty means the first one installed.
	Editor string `json:"editor,omitempty"`
	// SpawnPermissionMode is the mode new sessions start in when nothing more
	// specific says one: the new-session dialogs open on it, and a start
	// request with no mode (and no session to carry one from) gets it. In
	// Claude Code's words (agents.PermissionModes); empty means not set.
	SpawnPermissionMode string `json:"spawn_permission_mode,omitempty"`
	// GitHubSource is where the GitHub token comes from (internal/github,
	// ADR-039): "gh" (the GitHub CLI's login), "token" (pasted), "oauth"
	// (device flow), or empty — not connected, and nothing goes to GitHub.
	// The token itself is never in this file.
	GitHubSource string `json:"github_source,omitempty"`
	// GitHubClientID is a GitHub OAuth app's client id; with one, Settings
	// offers "Sign in with GitHub" (the device flow). Public, not a secret.
	GitHubClientID string `json:"github_client_id,omitempty"`
	// GitHubNotify raises an OS notification when a followed pull request's
	// CI starts failing or a review lands. On unless switched off.
	GitHubNotify *bool `json:"github_notify,omitempty"`
	// KeepAwake is when the daemon keeps the computer from idle-sleeping
	// (internal/keepawake, ADR-049): "off", "working" (while an agent
	// works) or "always" (while Caprock runs). Empty means never chosen,
	// which is "working".
	KeepAwake string `json:"keep_awake,omitempty"`
	// WorktreeCleanup is what happens to finished copies — Caprock's
	// worktrees that are merged, pushed, clean and idle: "off", "ask" or
	// "auto"; empty is "ask" (projects/cleanup.go). Written only once
	// chosen.
	WorktreeCleanup string `json:"worktree_cleanup,omitempty"`
	// StatuslineMode is what Caprock's Claude Code status line shows:
	// "full", "short", "hidden" or "off" (StatuslineModes). Empty is
	// "full". The status line command reads it at render time
	// (ReadStatuslineMode); "hidden" prints nothing but still forwards the
	// plan windows to the daemon; "off" also removes Caprock's own statusLine entry from Claude Code's
	// settings, and choosing again puts it back. Written only once chosen.
	StatuslineMode string `json:"statusline_mode,omitempty"`
	// AppUpdate is what the desktop app does when the release check finds a
	// newer version (ADR-042, amended 2026-10-15): "ask" shows the update
	// card, "auto" downloads the signed bundle in the background and installs
	// it once no agent is busy and the user is away. Empty is "ask". Only the
	// app's page acts on it; the daemon never installs anything itself.
	// Written only once chosen.
	AppUpdate string `json:"app_update,omitempty"`
}

// The desktop app's update modes (config.json "app_update").
const (
	AppUpdateAsk  = "ask"
	AppUpdateAuto = "auto"
)

// AppUpdateModes lists the accepted values of AppUpdate.
var AppUpdateModes = []string{AppUpdateAsk, AppUpdateAuto}

// ValidAppUpdate reports whether v is one of AppUpdateModes.
func ValidAppUpdate(v string) bool { return v == AppUpdateAsk || v == AppUpdateAuto }

// NormalizeAppUpdate is the effective mode: anything unknown or unset is
// "ask", what every install did before the choice existed.
func NormalizeAppUpdate(v string) string {
	if ValidAppUpdate(v) {
		return v
	}
	return AppUpdateAsk
}

// The status line modes (config.json "statusline_mode").
const (
	StatuslineFull  = "full"
	StatuslineShort = "short"
	// StatuslineHidden keeps Caprock's entry registered and its plan-window
	// relay running, and prints nothing: Claude Code then draws no status
	// line row (.ai/03-contracts.md § Statusline).
	StatuslineHidden = "hidden"
	StatuslineOff    = "off"
)

// StatuslineModes lists the accepted values of StatuslineMode.
var StatuslineModes = []string{StatuslineFull, StatuslineShort, StatuslineHidden, StatuslineOff}

// ValidStatuslineMode reports whether v is one of StatuslineModes.
func ValidStatuslineMode(v string) bool {
	return v == StatuslineFull || v == StatuslineShort || v == StatuslineHidden || v == StatuslineOff
}

// NormalizeStatusline is the effective mode: anything unknown or unset is
// "full", the line everyone had before the setting existed.
func NormalizeStatusline(v string) string {
	if ValidStatuslineMode(v) {
		return v
	}
	return StatuslineFull
}

// StatuslineRegistered reports whether Caprock's statusLine entry belongs in
// Claude Code's settings under mode v: every mode but Off. Hidden keeps it —
// the entry is what relays the plan windows, even when it prints nothing.
func StatuslineRegistered(v string) bool {
	return NormalizeStatusline(v) != StatuslineOff
}

// ReadStatuslineMode is the status line command's read of its one setting,
// made on every render: a small file read and a decode of a single field.
// Every failure — no data dir, no config.json, a file that does not parse —
// is "full", so the line a session sees never depends on this succeeding.
func ReadStatuslineMode(dir string) string {
	b, err := os.ReadFile(ConfigPath(dir))
	if err != nil {
		return StatuslineFull
	}
	var v struct {
		Mode string `json:"statusline_mode"`
	}
	if json.Unmarshal(b, &v) != nil {
		return StatuslineFull
	}
	return NormalizeStatusline(v.Mode)
}

// GitHubNotifyOn reports whether CI and review notifications are on.
func (c Config) GitHubNotifyOn() bool {
	return c.GitHubNotify == nil || *c.GitHubNotify
}

// Defaults returns the built-in configuration for a fresh install.
func Defaults() Config {
	return Config{Port: DefaultPort, LoopK: 5, LoopTMinutes: 3, AutoPause: false, OpenBrowser: true}
}

// DataDir resolves the data directory: $CAPROCK_DATA_DIR, else os.UserConfigDir()/caprock.
func DataDir() (string, error) {
	if v := os.Getenv(EnvDataDir); v != "" {
		return filepath.Clean(v), nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve user config dir: %w", err)
	}
	return filepath.Join(base, "caprock"), nil
}

// EnsureDataDir resolves and creates the data directory (0700).
func EnsureDataDir() (string, error) {
	dir, err := DataDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create data dir %s: %w", dir, err)
	}
	return dir, nil
}

// Paths inside the data dir.
func ConfigPath(dir string) string  { return filepath.Join(dir, "config.json") }
func RuntimePath(dir string) string { return filepath.Join(dir, "runtime.json") }
func DBPath(dir string) string      { return filepath.Join(dir, "caprock.db") }
func PricingPath(dir string) string { return filepath.Join(dir, "pricing.json") }
func ShimPath(dir string) string    { return filepath.Join(dir, shimBinaryName()) }
func LogPath(dir string) string     { return filepath.Join(dir, "caprock.log") }

// ServiceLogPath is where launchd and systemd send the daemon's output.
func ServiceLogPath(dir string) string   { return filepath.Join(dir, "service.log") }
func HookDebugLogPath(dir string) string { return filepath.Join(dir, "hook-debug.log") }

// ChatsDir is where quick chats live — sessions started to ask something
// rather than to work on a repository.
//
// Under the data directory rather than a second `~/.caprock`: one place that
// holds Caprock's state is one place to back up, clean out and explain. A chat
// is state, not a user's project, and it has no business being somewhere the
// user has to discover separately.
func ChatsDir(dir string) string { return filepath.Join(dir, "chats") }

// PasteDir is where a file pasted or dropped into the terminal is written.
//
// A browser hands over an image's *bytes*, never its path — there is no path
// to hand over for something copied from a screenshot tool. Claude Code reads
// files by path, so the bytes have to become a file somewhere before its path
// can be typed into the session.
//
// Under the data directory for the same reason chats are: it is Caprock's
// state, it is one place to back up and clear out, and it is not somewhere the
// user has to go looking for.
func PasteDir(dir string) string { return filepath.Join(dir, "paste") }

// InboxDir is where the Inbox keeps the photos and files saved with an item
// (03-contracts.md § Inbox): `inbox/<stamp>-<random>/<name>`, one directory
// per file. Apart from paste/ because it is kept until its item is deleted,
// while a pasted file goes after 30 days.
func InboxDir(dir string) string { return filepath.Join(dir, "inbox") }

// Load reads config.json, layering it over Defaults(). Unknown fields are ignored.
func Load(dir string) (Config, error) {
	cfg := Defaults()
	b, err := os.ReadFile(ConfigPath(dir))
	if errors.Is(err, os.ErrNotExist) {
		// Releases before the port change did not need to write config.json for
		// a user who kept every default. The database is the durable evidence
		// that this is such an install; keep its old origin instead of treating
		// an absent config file as a fresh profile.
		if _, statErr := os.Stat(DBPath(dir)); statErr == nil {
			cfg.Port = LegacyDefaultPort
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return cfg, fmt.Errorf("inspect existing data: %w", statErr)
		}
		return cfg, nil
	}
	if err != nil {
		return cfg, fmt.Errorf("read config: %w", err)
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return cfg, fmt.Errorf("parse config: %w", err)
	}
	if cfg.Port <= 0 || cfg.Port > 65535 {
		cfg.Port = DefaultPort
	}
	if cfg.LoopK <= 0 {
		cfg.LoopK = 5
	}
	if cfg.LoopTMinutes <= 0 {
		cfg.LoopTMinutes = 3
	}
	return cfg, nil
}

// Save writes config.json atomically.
func Save(dir string, cfg Config) error {
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return WriteFileAtomic(ConfigPath(dir), append(b, '\n'), 0o600)
}

// Runtime is <data_dir>/runtime.json — written by the daemon on start, read by
// the shim on every invocation, removed on clean shutdown.
type Runtime struct {
	Port      int    `json:"port"`
	Token     string `json:"token"`
	PID       int    `json:"pid"`
	StartedAt int64  `json:"started_at"` // unix ms
	Version   string `json:"version"`
	// APILevel is the daemon's API level (version.APILevel), so a client that
	// reads this file knows before any request whether the daemon is new
	// enough for it. Zero means a daemon from before the field existed.
	APILevel int `json:"api_level"`
	// Exe is the absolute path of the running daemon binary. The desktop app
	// uses it to tell a daemon it installed (and may update) from one a
	// package manager owns (which it must not touch). Empty when unknown.
	Exe string `json:"exe,omitempty"`
}

// NewSessionID returns a random RFC-4122-ish v4 UUID for `claude --session-id`.
func NewSessionID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// NewRuntime creates a runtime record with a fresh random token.
func NewRuntime(port int, version string) (Runtime, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return Runtime{}, fmt.Errorf("generate token: %w", err)
	}
	return Runtime{
		Port:      port,
		Token:     hex.EncodeToString(buf),
		PID:       os.Getpid(),
		StartedAt: time.Now().UnixMilli(),
		Version:   version,
		Exe:       executable(),
	}, nil
}

// executable is this process's binary with symlinks resolved, or "" when the
// OS will not say.
func executable() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		return resolved
	}
	return exe
}

// WriteRuntime persists runtime.json with 0600 permissions, atomically.
func WriteRuntime(dir string, rt Runtime) error {
	b, err := json.Marshal(rt)
	if err != nil {
		return err
	}
	return WriteFileAtomic(RuntimePath(dir), b, 0o600)
}

// ReadRuntime loads runtime.json. os.ErrNotExist means the daemon is not running.
func ReadRuntime(dir string) (Runtime, error) {
	var rt Runtime
	b, err := os.ReadFile(RuntimePath(dir))
	if err != nil {
		return rt, err
	}
	if err := json.Unmarshal(b, &rt); err != nil {
		return rt, fmt.Errorf("parse runtime.json: %w", err)
	}
	return rt, nil
}

// RemoveRuntime deletes runtime.json; a missing file is not an error.
func RemoveRuntime(dir string) error {
	err := os.Remove(RuntimePath(dir))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// WriteFileAtomic writes to a temp file in the same directory and renames it into
// place, so readers never observe a partial file (the shim reads runtime.json
// while the daemon may be rewriting it).
func WriteFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Chmod(perm); err != nil && !isWindows() {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		// Windows cannot rename over an open/existing file in some cases; fall back
		// to remove + rename, which is not atomic but is the best available.
		if isWindows() {
			_ = os.Remove(path)
			if err2 := os.Rename(tmpName, path); err2 == nil {
				return nil
			}
		}
		cleanup()
		return err
	}
	return nil
}

// MemoryOn reports whether a session should be told what the last one left in
// the same folder.
//
// A pointer in the struct so that "never set" is distinguishable from "set to
// false": a config written before this existed must get the feature, and a
// config where someone turned it off must keep it off. Reading a bare bool
// would have silently re-enabled it for everyone who had said no.
func (c Config) MemoryOn() bool {
	return c.Memory == nil || *c.Memory
}

// WindowStop is the plan-window stop's share in percent, 0 when off; never
// chosen (nil) is off.
func (c Config) WindowStop() int {
	if c.WindowStopPct == nil {
		return 0
	}
	return *c.WindowStopPct
}

// AlertApprovalOn reports whether a session waiting for approval is sent to
// the phone. Off unless switched on: a bot set up for the weekly report must
// not start sending alerts nobody asked for (owner, 2026-10-05).
func (c Config) AlertApprovalOn() bool {
	return c.AlertApproval != nil && *c.AlertApproval
}

// AlertFinishedOn reports whether a finished session is sent to the phone.
// Off unless switched on, like AlertApprovalOn.
func (c Config) AlertFinishedOn() bool {
	return c.AlertFinished != nil && *c.AlertFinished
}

// NotifyApprovalOn reports whether a session waiting for approval raises an
// OS notification in the desktop app. On unless switched off.
func (c Config) NotifyApprovalOn() bool {
	return c.NotifyApproval == nil || *c.NotifyApproval
}

// NotifyFinishedOn reports whether a finished session raises an OS
// notification. Off unless switched on.
func (c Config) NotifyFinishedOn() bool {
	return c.NotifyFinished != nil && *c.NotifyFinished
}

// TelegramChatOn reports whether the two-way Telegram chat is switched on.
// It works only with an active licence as well, which the bridge checks.
func (c Config) TelegramChatOn() bool { return c.TelegramChat != nil && *c.TelegramChat }

// TelegramCodeOn reports whether replies sent to Telegram keep their code.
func (c Config) TelegramCodeOn() bool { return c.TelegramCode != nil && *c.TelegramCode }

// AlertReplyOn reports whether a finished alert carries the first line of the
// final reply. On unless switched off.
func (c Config) AlertReplyOn() bool {
	return c.AlertReply == nil || *c.AlertReply
}

// BrainConfig is Second Brain's automatic extraction (ADR-063).
type BrainConfig struct {
	// Auto is whether finished sessions are read into the brain. nil until
	// the user answers; it never runs before a yes, because each read sends
	// a session's prose through the user's own claude login.
	Auto *bool `json:"auto,omitempty"`
	// Since is when Auto was last turned on, unix ms: sessions active before
	// it are read only through a backfill.
	Since int64 `json:"since,omitempty"`
	// BackfillSince, unix ms, widens what is read back to then (the "Build
	// from my last 30 days" button). 0 is no backfill.
	BackfillSince int64 `json:"backfill_since,omitempty"`
	// DailyTokens caps what the extraction spends in a rolling day, input and
	// output as claude reports them. 0 is the default (brain.DefaultDailyTokens).
	DailyTokens int `json:"daily_tokens,omitempty"`
	// Model is passed to claude --model; "" is brain.DefaultModel.
	Model string `json:"model,omitempty"`
}
