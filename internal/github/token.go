package github

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/config"
)

// Where the token comes from (ADR-039). One source at a time; "" is not
// connected, and then nothing is ever sent to GitHub.
const (
	// SourceGH reuses the GitHub CLI's login: `gh auth token`, read when a
	// call needs it and kept in memory only. Caprock never writes it down.
	SourceGH = "gh"
	// SourceToken is a token the user pasted in Settings, kept in the
	// macOS Keychain (elsewhere a 0600 file in the data directory).
	SourceToken = "token"
	// SourceOAuth is a token from the OAuth device flow, kept like a pasted
	// one. Offered only when a client id is configured.
	SourceOAuth = "oauth"
)

// TokenStore keeps the one token Caprock itself holds. Never the database,
// never config.json, never a log.
type TokenStore interface {
	Get(ctx context.Context) (string, error) // "" with no error when nothing is stored
	Set(ctx context.Context, token string) error
	Delete(ctx context.Context) error
	Kind() string // "keychain" or "file"
}

// KeychainService is the macOS Keychain item Caprock's token lives under.
const KeychainService = "dev.caprock.github"

// keychainAccount names the item within the service.
const keychainAccount = "caprock"

// Runner runs the `security` tool with args and returns its stdout and exit
// status. Tests replace it: no test ever runs the real tool.
type Runner func(ctx context.Context, args ...string) (stdout string, code int, err error)

// Keychain stores the token as a generic password through the `security`
// tool, with the token as an argument (no shell, no file). Every call names
// the keychain file explicitly (Path, the user's login keychain): without
// one, `security` falls back to the default keychain and, when it cannot
// find that, macOS shows a "Keychain Not Found" dialog — which a daemon must
// never cause. DefaultStore only builds one for a Path that exists.
type Keychain struct {
	Service string
	Path    string // the keychain file, e.g. ~/Library/Keychains/login.keychain-db
	Run     Runner // nil runs /usr/bin/security
}

// securityNotFound is `security`'s exit status for a missing item.
const securityNotFound = 44

// runSecurity runs /usr/bin/security with fixed arguments and a timeout.
func runSecurity(ctx context.Context, args ...string) (string, int, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/security", args...) //nolint:gosec // fixed subcommands, an explicit keychain path
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return out.String(), ee.ExitCode(), fmt.Errorf("security %s: %s", args[0], strings.TrimSpace(errb.String()))
	}
	return out.String(), 0, err
}

// run refuses to run without an explicit keychain path, so a missing path
// can never become a dialog.
func (k Keychain) run(ctx context.Context, args ...string) (string, int, error) {
	if k.Path == "" {
		return "", 0, errors.New("no keychain file named; the Keychain is not used")
	}
	run := k.Run
	if run == nil {
		run = runSecurity
	}
	return run(ctx, append(args, k.Path)...)
}

func (k Keychain) Get(ctx context.Context) (string, error) {
	out, code, err := k.run(ctx, "find-generic-password", "-s", k.Service, "-a", keychainAccount, "-w")
	if code == securityNotFound {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

func (k Keychain) Set(ctx context.Context, token string) error {
	_, _, err := k.run(ctx, "add-generic-password", "-U", "-s", k.Service, "-a", keychainAccount, "-l", "Caprock GitHub token", "-w", token)
	return err
}

func (k Keychain) Delete(ctx context.Context) error {
	_, code, err := k.run(ctx, "delete-generic-password", "-s", k.Service, "-a", keychainAccount)
	if code == securityNotFound {
		return nil
	}
	return err
}

func (Keychain) Kind() string { return "keychain" }

// File stores the token in a 0600 file in the data directory, where there is
// no Keychain (as the report bot's token and the paired devices are kept).
type File struct {
	Path string
}

// TokenFile is the file's name in the data directory.
const TokenFile = "github-token"

func (f File) Get(context.Context) (string, error) {
	b, err := os.ReadFile(f.Path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	return strings.TrimSpace(string(b)), err
}

func (f File) Set(_ context.Context, token string) error {
	return config.WriteFileAtomic(f.Path, []byte(token+"\n"), 0o600)
}

func (f File) Delete(context.Context) error {
	err := os.Remove(f.Path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (File) Kind() string { return "file" }

// EnvSecretStore forces the token store: "file" uses the 0600 file even on
// macOS. Tests and throwaway daemons set it, so nothing touches a keychain.
const EnvSecretStore = "CAPROCK_SECRET_STORE"

// Fallback is the Keychain with the 0600 file behind it: when the Keychain
// refuses (locked, missing, an error), the token goes to the file instead
// and Note says so — never a dialog.
type Fallback struct {
	Keychain Keychain
	File     File

	mu   sync.Mutex
	used string // where the token is: "keychain" or "file"
	note string
}

func (f *Fallback) setUsed(kind, note string) {
	f.mu.Lock()
	f.used, f.note = kind, note
	f.mu.Unlock()
}

func (f *Fallback) Get(ctx context.Context) (string, error) {
	if t, err := f.File.Get(ctx); err == nil && t != "" {
		f.setUsed("file", f.Note())
		return t, nil
	}
	t, err := f.Keychain.Get(ctx)
	if err != nil {
		return "", err
	}
	if t != "" {
		f.setUsed("keychain", "")
	}
	return t, nil
}

func (f *Fallback) Set(ctx context.Context, token string) error {
	err := f.Keychain.Set(ctx, token)
	if err == nil {
		_ = f.File.Delete(ctx)
		f.setUsed("keychain", "")
		return nil
	}
	if ferr := f.File.Set(ctx, token); ferr != nil {
		return fmt.Errorf("the Keychain refused (%v) and the file could not be written: %w", err, ferr)
	}
	f.setUsed("file", "The Keychain refused it ("+firstLine(err.Error())+"), so the token is in a file in the data directory, readable by you only.")
	return nil
}

func (f *Fallback) Delete(ctx context.Context) error {
	ferr := f.File.Delete(ctx)
	kerr := f.Keychain.Delete(ctx)
	f.setUsed("", "")
	if ferr != nil {
		return ferr
	}
	return kerr
}

func (f *Fallback) Kind() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.used == "file" {
		return "file"
	}
	return "keychain"
}

// Note says why the token is not where it would usually be, "" otherwise.
func (f *Fallback) Note() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.note
}

// noted is a store with something to say about where it keeps the token.
type noted interface{ Note() string }

// FileWithNote is the file store with the reason the Keychain is not used.
type FileWithNote struct {
	File
	Why string
}

func (f FileWithNote) Note() string { return f.Why }

// DefaultStore picks where Caprock keeps its token: the user's login
// keychain on macOS when that file exists (with the 0600 file behind it),
// else the 0600 file in dataDir. home is the user's real home directory
// (UserHome), not $HOME.
func DefaultStore(dataDir, service, home string) TokenStore {
	file := File{Path: filepath.Join(dataDir, TokenFile)}
	if os.Getenv(EnvSecretStore) == "file" || runtime.GOOS != "darwin" {
		return file
	}
	if home == "" {
		return FileWithNote{File: file, Why: "Your home directory could not be read, so the token is in a file in the data directory, readable by you only."}
	}
	kc := filepath.Join(home, "Library", "Keychains", "login.keychain-db")
	if st, err := os.Stat(kc); err != nil || st.IsDir() {
		return FileWithNote{File: file, Why: "No login keychain at " + kc + ", so the token is in a file in the data directory, readable by you only."}
	}
	return &Fallback{Keychain: Keychain{Service: service, Path: kc}, File: file}
}

// UserHome is the current user's home directory as the system records it
// (Directory Services on macOS), not $HOME, which a caller may have changed.
// "" when it cannot be read.
func UserHome(ctx context.Context) string {
	if runtime.GOOS != "darwin" {
		h, _ := os.UserHomeDir()
		return h
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/bin/dscacheutil", "-q", "user", "-a", "uid", strconv.Itoa(os.Getuid())).Output() //nolint:gosec // fixed arguments
	if err != nil {
		return ""
	}
	return homeFromDSCache(string(out))
}

// homeFromDSCache reads "dir: /Users/name" from dscacheutil's answer.
func homeFromDSCache(out string) string {
	for _, l := range strings.Split(out, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(l), "dir:"); ok {
			if d := strings.TrimSpace(v); filepath.IsAbs(d) {
				return d
			}
		}
	}
	return ""
}

// GHCLI reads the GitHub CLI's token for github.com. Env is the login
// shell's environment, so `gh` and its keyring are found as in a terminal;
// Bin, when set, is the binary (tests).
type GHCLI struct {
	Env func() []string
	Bin string
}

// ErrGHMissing is `gh` not installed, or not on the login shell's PATH.
var ErrGHMissing = errors.New("the GitHub CLI (gh) is not installed, or not on your login shell's PATH")

// find is gh's path: Bin, else the login PATH, else Homebrew's places.
func (g GHCLI) find(env []string) (string, error) {
	if g.Bin != "" {
		return g.Bin, nil
	}
	for _, kv := range env {
		if p, ok := strings.CutPrefix(kv, "PATH="); ok {
			for _, dir := range filepath.SplitList(p) {
				if c := filepath.Join(dir, ghName()); isExec(c) {
					return c, nil
				}
			}
		}
	}
	for _, c := range []string{"/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"} {
		if isExec(c) {
			return c, nil
		}
	}
	return "", ErrGHMissing
}

func ghName() string {
	if runtime.GOOS == "windows" {
		return "gh.exe"
	}
	return "gh"
}

func isExec(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir() && (runtime.GOOS == "windows" || st.Mode()&0o111 != 0)
}

// Token runs `gh auth token --hostname github.com`. The token is returned and
// nowhere kept by this call.
func (g GHCLI) Token(ctx context.Context) (string, error) {
	env := os.Environ()
	if g.Env != nil {
		env = g.Env()
	}
	bin, err := g.find(env)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "auth", "token", "--hostname", "github.com") //nolint:gosec // fixed arguments
	cmd.Env = append(append([]string{}, env...), "GH_PROMPT_DISABLED=1", "NO_COLOR=1", "GH_NO_UPDATE_NOTIFIER=1")
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", errors.New("gh auth token did not answer within 5 s")
		}
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("the GitHub CLI has no login for github.com (%s); run `gh auth login` in a terminal", firstLine(msg))
	}
	tok := strings.TrimSpace(out.String())
	if tok == "" {
		return "", errors.New("the GitHub CLI gave an empty token; run `gh auth login` in a terminal")
	}
	return tok, nil
}

// Found reports whether gh is installed, without running it.
func (g GHCLI) Found() bool {
	env := os.Environ()
	if g.Env != nil {
		env = g.Env()
	}
	_, err := g.find(env)
	return err == nil
}

func firstLine(s string) string {
	l, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	return l
}

// tokenKind names a token by its documented prefix, never by its value.
func tokenKind(tok string) string {
	switch {
	case strings.HasPrefix(tok, "github_pat_"):
		return "fine-grained"
	case strings.HasPrefix(tok, "ghp_"):
		return "classic"
	case strings.HasPrefix(tok, "gho_"):
		return "oauth"
	case strings.HasPrefix(tok, "ghu_"), strings.HasPrefix(tok, "ghs_"):
		return "app"
	}
	return "unknown"
}

// checkPasted refuses what cannot be a token before it is sent anywhere.
func checkPasted(tok string) error {
	if tok == "" {
		return errors.New("paste a token")
	}
	if len(tok) > 255 || strings.ContainsAny(tok, " \t\r\n") {
		return errors.New("that does not look like a GitHub token: one line, no spaces, at most 255 characters")
	}
	return nil
}
