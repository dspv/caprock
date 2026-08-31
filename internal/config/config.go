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

// DefaultPort is the single loopback port shared by the API, WS, UI and hook receiver.
const DefaultPort = 4173

// Config is the user-editable configuration stored at <data_dir>/config.json.
// Every field has a default; a missing file means "all defaults".
type Config struct {
	Port int `json:"port"`
	// Loop detector: >= K same-tool similar-input tool.pre events within T minutes.
	LoopK        int `json:"loop_k"`
	LoopTMinutes int `json:"loop_t_minutes"`
	// AutoPause applies to owned sessions only (Phase 1). Default off.
	AutoPause bool `json:"auto_pause"`
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
	// BrowseRoot is where the folder picker may look. Empty means $HOME.
	BrowseRoot string `json:"browse_root,omitempty"`
}

// Defaults returns the built-in configuration (spec: K=5, T=3, port 4173).
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
func ConfigPath(dir string) string       { return filepath.Join(dir, "config.json") }
func RuntimePath(dir string) string      { return filepath.Join(dir, "runtime.json") }
func DBPath(dir string) string           { return filepath.Join(dir, "caprock.db") }
func PricingPath(dir string) string      { return filepath.Join(dir, "pricing.json") }
func ShimPath(dir string) string         { return filepath.Join(dir, shimBinaryName()) }
func LogPath(dir string) string          { return filepath.Join(dir, "caprock.log") }
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

// Load reads config.json, layering it over Defaults(). Unknown fields are ignored.
func Load(dir string) (Config, error) {
	cfg := Defaults()
	b, err := os.ReadFile(ConfigPath(dir))
	if errors.Is(err, os.ErrNotExist) {
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
	}, nil
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
