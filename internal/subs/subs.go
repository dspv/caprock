// Package subs is Settings → Subscriptions (ADR-048): more than one sign-in to
// Claude Code or Codex on one machine, each in a configuration directory of
// its own, and a session started on the one the user picks.
//
// The owner's request that started it (2026-10-10, translated): "make
// subscription management so several subscriptions can be authorised and you
// can work through them."
//
// It rests on what both agents document, read 2026-10-10:
//
//   - Claude Code: "To stay signed in to multiple accounts at once … give each
//     account its own configuration directory … Each directory has its own
//     settings, session history, and claude.ai login or API key", and with
//     CLAUDE_CONFIG_DIR set it "keys the macOS Keychain entry to that
//     directory too, so a session with a different CLAUDE_CONFIG_DIR reads a
//     different entry" (code.claude.com/docs/en/authentication). The path
//     must be absolute (code.claude.com/docs/en/env-vars).
//   - Codex: "Codex stores its local state under CODEX_HOME" and `file`
//     credentials are "auth.json under CODEX_HOME"
//     (developers.openai.com/codex/config-advanced, /codex/auth). Its keyring
//     entry is keyed by a hash of the CODEX_HOME path
//     (github.com/openai/codex, codex-rs/login/src/auth/storage.rs,
//     compute_store_key).
//
// Caprock never signs anyone in. Adding a subscription makes the directory and
// types the agent's own sign-in command into a shell tab, not run; the user
// presses Enter. Nothing here starts an agent, reads a credential's secret or
// touches the Keychain: whether a directory is signed in is read from files
// the agent wrote (see Status).
package subs

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/hooks"
	"golang.org/x/text/unicode/norm"
)

// Agents that have subscriptions: the two whose sign-in lives in a directory
// an environment variable can move.
const (
	AgentClaude = "claude"
	AgentCodex  = "codex"
)

// DefaultID is how the API names the user's normal sign-in. Sessions on it
// store "" in sessions.subscription, as every session did before this.
const DefaultID = "default"

// DeepSeekID names Claude Code on DeepSeek: a Claude Code session in the
// user's own configuration directory whose model calls go to DeepSeek's
// Anthropic-compatible API on the user's DeepSeek key (Settings →
// Subscriptions). It is offered beside the sign-ins once a key is set, and
// recorded on its sessions like one, so their plan windows, if any arrive,
// are filed under its own prefix and never over the Default sign-in's, and
// the plan-window stop leaves them alone. It is not a directory and not a
// sign-in, so it never counts toward FreePerAgent. NewID's hex ids can never
// spell it.
const DeepSeekID = "deepseek"

// FreePerAgent is how many subscriptions per agent are free, the Default one
// included; a fourth and more need a licence (owner decision, 2026-10-10).
const FreePerAgent = 3

// MaxLabel bounds a label.
const MaxLabel = 40

// Supported reports whether agent has subscriptions.
func Supported(agent string) bool { return agent == AgentClaude || agent == AgentCodex }

// EnvVar is the variable that moves agent's configuration directory.
func EnvVar(agent string) string {
	if agent == AgentCodex {
		return "CODEX_HOME"
	}
	return "CLAUDE_CONFIG_DIR"
}

// CredentialEnv is what, in a session's environment, makes the agent use a
// credential other than the sign-in its configuration directory holds. A
// session Caprock starts on a subscription runs without these, so it runs on
// the sign-in the user picked and not on whatever the login shell exports
// (ADR-048, amended 2026-10-18). A session on the user's own sign-in keeps
// them: that is how their own terminal runs too.
//
//   - Claude Code ranks ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY,
//     CLAUDE_CODE_OAUTH_TOKEN, a named ANTHROPIC_PROFILE, the federation
//     variables and a cloud provider switch above the directory's /login
//     (code.claude.com/docs/en/authentication, "Authentication precedence",
//     read 2026-10-18). CLAUDE_SECURESTORAGE_CONFIG_DIR, which Claude Code
//     sets for the teammates it starts, replaces the directory its Keychain
//     entry and .credentials.json are keyed to (the 2.1.302 bundle: the
//     service is "Claude Code-credentials-" plus the first eight hex digits
//     of SHA-256 of that directory instead of CLAUDE_CONFIG_DIR's).
//   - Codex takes CODEX_API_KEY and CODEX_ACCESS_TOKEN over its stored
//     credentials (github.com/openai/codex codex-rs/login/src/auth/manager.rs,
//     read 2026-10-18). OPENAI_API_KEY is not read there, so it stays: tools a
//     session runs may want it.
func CredentialEnv(agent string) []string {
	if agent == AgentCodex {
		return []string{"CODEX_API_KEY", "CODEX_ACCESS_TOKEN"}
	}
	return []string{
		"CLAUDE_SECURESTORAGE_CONFIG_DIR",
		"ANTHROPIC_AUTH_TOKEN",
		"ANTHROPIC_API_KEY",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"ANTHROPIC_PROFILE",
		"ANTHROPIC_FEDERATION_RULE_ID",
		"CLAUDE_CODE_USE_BEDROCK",
		"CLAUDE_CODE_USE_VERTEX",
		"CLAUDE_CODE_USE_FOUNDRY",
		"CLAUDE_CODE_USE_ANTHROPIC_AWS",
	}
}

// CredentialEnvSet names the CredentialEnv variables env sets to something
// other than blank, in CredentialEnv's order: what Settings tells the user a
// session on a subscription runs without. Names only; a value never leaves.
func CredentialEnvSet(agent string, env []string) []string {
	var out []string
	for _, name := range CredentialEnv(agent) {
		if name == "CLAUDE_SECURESTORAGE_CONFIG_DIR" {
			// A nesting marker, dropped from every session and shell tab
			// (agents.childEnv), the own sign-in's too: not news to report.
			continue
		}
		for i := len(env) - 1; i >= 0; i-- {
			k, v, ok := strings.Cut(env[i], "=")
			if ok && strings.EqualFold(k, name) {
				if strings.TrimSpace(v) != "" {
					out = append(out, name)
				}
				break
			}
		}
	}
	return out
}

// ProfilesDir is where every subscription's directory lives.
func ProfilesDir(dataDir string) string { return filepath.Join(dataDir, "profiles") }

// Dir is one subscription's configuration directory. Absolute whenever
// dataDir is, which Claude Code requires.
func Dir(dataDir, id string) string { return filepath.Join(ProfilesDir(dataDir), id) }

// NewID makes a subscription id: eight lowercase hex digits.
func NewID() (string, error) {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// ValidID reports whether id could have come from NewID — the check that
// keeps a request from naming a directory outside profiles/.
func ValidID(id string) bool {
	if len(id) == 0 || len(id) > 32 {
		return false
	}
	for _, r := range id {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') {
			return false
		}
	}
	return id != DefaultID
}

// CleanLabel trims a label and refuses an empty or overlong one.
func CleanLabel(s string) (string, error) {
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		return "", errors.New("give the subscription a name")
	}
	if len([]rune(s)) > MaxLabel {
		return "", fmt.Errorf("a name is at most %d characters", MaxLabel)
	}
	return s, nil
}

// Find returns the subscription with id.
func Find(list []config.Subscription, id string) (config.Subscription, bool) {
	for _, s := range list {
		if s.ID == id {
			return s, true
		}
	}
	return config.Subscription{}, false
}

// Count is how many subscriptions agent has, the Default one included.
func Count(list []config.Subscription, agent string) int {
	n := 1
	for _, s := range list {
		if s.Agent == agent {
			n++
		}
	}
	return n
}

// LoginCommand is the agent's own sign-in, pointed at dir, for a shell tab:
// typed, never run. A POSIX shell gets the variable for that one command; on
// Windows Caprock's shell tab is PowerShell, which sets it for the tab.
//
// `claude auth login` and `codex login` are each agent's documented sign-in
// (code.claude.com/docs/en/cli-reference, developers.openai.com/codex/auth,
// read 2026-10-10).
func LoginCommand(agent, dir, goos string) string {
	if agent == AgentCodex {
		return pointedAt(agent, dir, goos, "codex login")
	}
	return pointedAt(agent, dir, goos, "claude auth login")
}

// LogoutCommand is the agent's own sign-out, pointed at dir, typed into a
// shell tab like LoginCommand. It is how a subscription's credential leaves
// the macOS Keychain or the OS keyring, which Caprock never touches itself:
// removing a subscription deletes its folder, and a Keychain entry is not in
// it. `claude auth logout` and `codex logout` are each agent's own
// (`claude auth --help`, `codex logout --help`, read 2026-10-18).
func LogoutCommand(agent, dir, goos string) string {
	if agent == AgentCodex {
		return pointedAt(agent, dir, goos, "codex logout")
	}
	return pointedAt(agent, dir, goos, "claude auth logout")
}

func pointedAt(agent, dir, goos, command string) string {
	if dir == "" {
		return command
	}
	if goos == "windows" {
		return "$env:" + EnvVar(agent) + "=" + psQuote(dir) + "; " + command
	}
	return EnvVar(agent) + "=" + shQuote(dir) + " " + command
}

// LoginCommandHere is LoginCommand for this machine.
func LoginCommandHere(agent, dir string) string { return LoginCommand(agent, dir, runtime.GOOS) }

// LogoutCommandHere is LogoutCommand for this machine.
func LogoutCommandHere(agent, dir string) string { return LogoutCommand(agent, dir, runtime.GOOS) }

// KeychainService is the macOS Keychain item Claude Code keeps a sign-in in
// when it runs with CLAUDE_CONFIG_DIR=dir ("" is the user's own sign-in):
// "Claude Code-credentials", and with the variable set, "-" and the first
// eight hex digits of SHA-256 of the directory, normalised to NFC, after it.
// Read from the Claude Code 2.1.302 bundle on 2026-10-18; the docs say only
// that the entry is keyed to the directory (code.claude.com/docs/en/
// authentication). Caprock names it so the user can find it in Keychain
// Access; it never reads, writes or deletes it.
func KeychainService(dir string) string {
	if dir == "" {
		return "Claude Code-credentials"
	}
	sum := sha256.Sum256([]byte(norm.NFC.String(dir)))
	return "Claude Code-credentials-" + hex.EncodeToString(sum[:])[:8]
}

// shQuote quotes s for a POSIX shell: single quotes, each embedded one closed,
// escaped and reopened. The data dir on macOS has a space in it.
func shQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// psQuote quotes s for PowerShell: single quotes, an embedded one doubled.
func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// Prepare makes a subscription's directory and, for Claude Code, gives it
// what Caprock needs to see the sessions run on it.
//
// A new CLAUDE_CONFIG_DIR is a new ~/.claude: "All settings, session history,
// and plugins are stored under this path" (env-vars, read 2026-10-10). So its
// settings.json would carry none of Caprock's hooks and no status line, and a
// session on it would be invisible to the dashboard and its plan windows
// unknown. Prepare writes them — the same entries `caprock hooks install`
// writes into ~/.claude/settings.json — and, when the user has already
// accepted Claude Code's bypass warning in their own settings, that answer
// too (ADR-041): it is the user's consent, not an account's. Nothing else of
// the user's settings is copied; the directory is Caprock's, and so is every
// file in it Caprock wrote. Safe to call again: each write is idempotent.
func Prepare(agent, dir, shimCmd, statuslineCmd, defaultSettings string) error {
	if !filepath.IsAbs(dir) {
		return fmt.Errorf("subscription directory %q is not absolute", dir)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if agent != AgentClaude {
		return nil
	}
	sp := filepath.Join(dir, "settings.json")
	if shimCmd != "" {
		if _, err := hooks.Install(sp, shimCmd); err != nil {
			return fmt.Errorf("hooks: %w", err)
		}
	}
	if statuslineCmd != "" {
		if _, present, err := hooks.StatuslineInstalled(sp, statuslineCmd); err == nil && !present {
			if _, err := hooks.InstallStatusline(sp, statuslineCmd); err != nil {
				return fmt.Errorf("status line: %w", err)
			}
		}
	}
	if defaultSettings != "" {
		if ok, _ := hooks.BypassAccepted(defaultSettings); ok {
			if _, err := hooks.AcceptBypass(sp); err != nil {
				return fmt.Errorf("bypass consent: %w", err)
			}
		}
	}
	return nil
}

// Remove deletes a subscription's directory — and only a directory directly
// under profiles/, whatever id says.
func Remove(dataDir, id string) error {
	if !ValidID(id) {
		return fmt.Errorf("not a subscription id: %q", id)
	}
	dir := Dir(dataDir, id)
	if filepath.Dir(dir) != ProfilesDir(dataDir) {
		return fmt.Errorf("refusing to remove %q", dir)
	}
	return os.RemoveAll(dir)
}

// SignIn is what Caprock can tell about a directory's sign-in from the files
// in it.
type SignIn struct {
	// SignedIn is true when the agent left a sign-in there.
	SignedIn bool `json:"signed_in"`
	// Account is the account's e-mail address, when the agent wrote it down
	// in a file that is not the credential itself; "" otherwise.
	Account string `json:"account,omitempty"`
}

// Paths is where an agent keeps what Status reads, for one directory.
type Paths struct {
	Agent string
	// Dir is the configuration directory: ~/.claude, ~/.codex or a profile.
	Dir string
	// GlobalConfig is Claude Code's .claude.json for that directory:
	// ~/.claude.json for the default, <dir>/.claude.json for a profile.
	GlobalConfig string
}

// DefaultPaths is the user's normal sign-in, honouring a CLAUDE_CONFIG_DIR or
// CODEX_HOME their login shell already sets.
func DefaultPaths(agent, home string, getenv func(string) string) Paths {
	if v := strings.TrimSpace(getenv(EnvVar(agent))); v != "" {
		p := Paths{Agent: agent, Dir: v}
		if agent == AgentClaude {
			p.GlobalConfig = filepath.Join(v, ".claude.json")
		}
		return p
	}
	if agent == AgentCodex {
		return Paths{Agent: agent, Dir: filepath.Join(home, ".codex")}
	}
	return Paths{Agent: agent, Dir: filepath.Join(home, ".claude"), GlobalConfig: filepath.Join(home, ".claude.json")}
}

// ProfilePaths is a subscription's.
func ProfilePaths(agent, dir string) Paths {
	p := Paths{Agent: agent, Dir: dir}
	if agent == AgentClaude {
		p.GlobalConfig = filepath.Join(dir, ".claude.json")
	}
	return p
}

// Status reads a directory's sign-in. Nothing is run and no secret is kept:
//
//   - Claude Code writes the account it signed in to as `oauthAccount` in
//     .claude.json (beside trust decisions and MCP servers), and keeps the
//     credential itself in the Keychain on macOS or in .credentials.json
//     elsewhere (authentication, read 2026-10-10). Either counts.
//   - Codex keeps `file` credentials in auth.json; its id token names the
//     account's e-mail address, which is decoded here and nothing else of the
//     file is kept. A Codex set to the OS keyring leaves no auth.json and
//     reads as not signed in until a session on it reports plan windows.
func Status(p Paths) SignIn {
	switch p.Agent {
	case AgentClaude:
		var out SignIn
		if p.GlobalConfig != "" {
			if email, ok := claudeAccount(p.GlobalConfig); ok {
				out = SignIn{SignedIn: true, Account: email}
			}
		}
		if !out.SignedIn {
			if _, err := os.Stat(filepath.Join(p.Dir, ".credentials.json")); err == nil {
				out.SignedIn = true
			}
		}
		return out
	case AgentCodex:
		b, err := os.ReadFile(filepath.Join(p.Dir, "auth.json"))
		if err != nil {
			return SignIn{}
		}
		return SignIn{SignedIn: true, Account: codexAccount(b)}
	}
	return SignIn{}
}

// claudeCache keeps .claude.json's answer by path, size and time: the file
// holds every project's state and is read on each Settings poll otherwise.
var claudeCache sync.Map // path → claudeEntry

type claudeEntry struct {
	mod   time.Time
	size  int64
	email string
	ok    bool
}

func claudeAccount(path string) (string, bool) {
	fi, err := os.Stat(path)
	if err != nil {
		return "", false
	}
	if v, ok := claudeCache.Load(path); ok {
		e := v.(claudeEntry)
		if e.mod.Equal(fi.ModTime()) && e.size == fi.Size() {
			return e.email, e.ok
		}
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	var doc struct {
		OAuthAccount *struct {
			EmailAddress string `json:"emailAddress"`
		} `json:"oauthAccount"`
	}
	e := claudeEntry{mod: fi.ModTime(), size: fi.Size()}
	if json.Unmarshal(b, &doc) == nil && doc.OAuthAccount != nil {
		e.ok, e.email = true, doc.OAuthAccount.EmailAddress
	}
	claudeCache.Store(path, e)
	return e.email, e.ok
}

// codexAccount is the e-mail in auth.json's id token, or "" — an API-key
// sign-in has none, and a token this cannot read is not an error.
func codexAccount(b []byte) string {
	var doc struct {
		Tokens *struct {
			IDToken string `json:"id_token"`
		} `json:"tokens"`
	}
	if json.Unmarshal(b, &doc) != nil || doc.Tokens == nil {
		return ""
	}
	parts := strings.Split(doc.Tokens.IDToken, ".")
	if len(parts) < 2 {
		return ""
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return ""
	}
	var claims struct {
		Email string `json:"email"`
	}
	if json.Unmarshal(raw, &claims) != nil {
		return ""
	}
	return claims.Email
}

// Of names the subscription a transcript belongs to, from its path: a file
// under profiles/<id>/ is that subscription's, anything else is "" (the
// Default one, or a directory Caprock does not manage).
func Of(dataDir, path string) string {
	if dataDir == "" || path == "" {
		return ""
	}
	rel, err := filepath.Rel(ProfilesDir(dataDir), path)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return ""
	}
	id := strings.SplitN(filepath.ToSlash(rel), "/", 2)[0]
	if !ValidID(id) {
		return ""
	}
	return id
}

// OfDir names the subscription whose directory dir is, or "" when it is none
// of Caprock's (the status line forwards the CLAUDE_CONFIG_DIR it ran under).
func OfDir(dataDir, dir string) string {
	if dataDir == "" || dir == "" {
		return ""
	}
	clean := filepath.Clean(dir)
	if filepath.Dir(clean) != ProfilesDir(dataDir) {
		return ""
	}
	id := filepath.Base(clean)
	if !ValidID(id) {
		return ""
	}
	return id
}

// LimitPrefix is the rate_limit_latest key prefix for a subscription's plan
// windows: `sub:<id>:five_hour`. The Default one keeps the keys it always
// had — `five_hour` for Claude Code, `codex_five_hour` for Codex — so nothing
// already stored moves.
func LimitPrefix(id string) string { return "sub:" + id + ":" }
