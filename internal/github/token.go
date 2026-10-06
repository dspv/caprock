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
	"strings"
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

// Keychain stores the token as a generic password through the `security`
// tool, with the token as an argument (no shell, no file). The tool, not
// Caprock, is on the item's access list, so reading it back asks nothing.
type Keychain struct {
	Service string
	Bin     string // "/usr/bin/security" unless a test says otherwise
}

func (k Keychain) bin() string {
	if k.Bin != "" {
		return k.Bin
	}
	return "/usr/bin/security"
}

// errNotFound is `security`'s exit status for a missing item.
const securityNotFound = 44

func (k Keychain) run(ctx context.Context, args ...string) (string, int, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, k.bin(), args...) //nolint:gosec // fixed subcommands of /usr/bin/security
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return out.String(), ee.ExitCode(), fmt.Errorf("security %s: %s", args[0], strings.TrimSpace(errb.String()))
	}
	return out.String(), 0, err
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

// DefaultStore is the Keychain on macOS when `security` is there, else the
// file in dataDir.
func DefaultStore(dataDir, service string) TokenStore {
	if runtime.GOOS == "darwin" {
		if _, err := os.Stat("/usr/bin/security"); err == nil {
			return Keychain{Service: service}
		}
	}
	return File{Path: filepath.Join(dataDir, TokenFile)}
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
