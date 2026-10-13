// Package secret keeps the few credentials Caprock itself holds — the GitHub
// token, the DeepSeek API key, the Telegram bot token — out of the database,
// config.json and every log (ADR-039, ADR-024 amendment).
//
// On macOS a secret is a generic password in the user's login keychain,
// written through /usr/bin/security with the value as an argument and the
// keychain file named explicitly, so no call can ever open a dialog.
// Elsewhere, or when the keychain is missing or refuses, it is a 0600 file in
// the data directory, and the store says so.
package secret

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	posix "path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/config"
)

// Store keeps one secret. Never the database, never config.json, never a log.
type Store interface {
	Get(ctx context.Context) (string, error) // "" with no error when nothing is stored
	Set(ctx context.Context, value string) error
	Delete(ctx context.Context) error
	Kind() string // "keychain" or "file"
}

// Item names one secret: where it lives in the keychain and in the data
// directory, and how a note calls it.
type Item struct {
	Service string // the keychain service, e.g. dev.caprock.github
	Label   string // the keychain item's label, e.g. "Caprock GitHub token"
	File    string // the fallback file's name in the data directory
	Noun    string // "token" or "key", for the notes; "" reads as "token"
}

// Account names the item within its service.
const Account = "caprock"

// Runner runs the `security` tool with args and returns its stdout and exit
// status. Tests replace it: no test ever runs the real tool.
type Runner func(ctx context.Context, args ...string) (stdout string, code int, err error)

// Keychain stores a secret as a generic password through the `security`
// tool, with the value as an argument (no shell, no file). Every call names
// the keychain file explicitly (Path, the user's login keychain): without
// one, `security` falls back to the default keychain and, when it cannot
// find that, macOS shows a "Keychain Not Found" dialog — which a daemon must
// never cause. Default only builds one for a Path that exists.
type Keychain struct {
	Service string
	Label   string
	Path    string // the keychain file, e.g. ~/Library/Keychains/login.keychain-db
	Run     Runner // nil runs /usr/bin/security
}

// NotFound is `security`'s exit status for a missing item.
const NotFound = 44

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
	out, code, err := k.run(ctx, "find-generic-password", "-s", k.Service, "-a", Account, "-w")
	if code == NotFound {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

func (k Keychain) Set(ctx context.Context, value string) error {
	_, _, err := k.run(ctx, "add-generic-password", "-U", "-s", k.Service, "-a", Account, "-l", k.Label, "-w", value)
	return err
}

func (k Keychain) Delete(ctx context.Context) error {
	_, code, err := k.run(ctx, "delete-generic-password", "-s", k.Service, "-a", Account)
	if code == NotFound {
		return nil
	}
	return err
}

func (Keychain) Kind() string { return "keychain" }

// File stores a secret in a 0600 file in the data directory, where there is
// no Keychain.
type File struct {
	Path string
}

func (f File) Get(context.Context) (string, error) {
	b, err := os.ReadFile(f.Path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	return strings.TrimSpace(string(b)), err
}

func (f File) Set(_ context.Context, value string) error {
	return config.WriteFileAtomic(f.Path, []byte(value+"\n"), 0o600)
}

func (f File) Delete(context.Context) error {
	err := os.Remove(f.Path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (File) Kind() string { return "file" }

// EnvStore forces the store: "file" uses the 0600 file even on macOS. Tests
// and throwaway daemons set it, so nothing touches a keychain.
const EnvStore = "CAPROCK_SECRET_STORE"

// Fallback is the Keychain with the 0600 file behind it: when the Keychain
// refuses (locked, missing, an error), the secret goes to the file instead
// and Note says so — never a dialog.
type Fallback struct {
	Keychain Keychain
	File     File
	Noun     string // "token" or "key"; "" reads as "token"

	mu   sync.Mutex
	used string // where the secret is: "keychain" or "file"
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

func (f *Fallback) Set(ctx context.Context, value string) error {
	err := f.Keychain.Set(ctx, value)
	if err == nil {
		_ = f.File.Delete(ctx)
		f.setUsed("keychain", "")
		return nil
	}
	if ferr := f.File.Set(ctx, value); ferr != nil {
		return fmt.Errorf("the Keychain refused (%s) and the file could not be written: %w", firstLine(err.Error()), ferr)
	}
	f.setUsed("file", "The Keychain refused it ("+firstLine(err.Error())+"), so the "+noun(f.Noun)+" is in a file in the data directory, readable by you only.")
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

// Note says why the secret is not where it would usually be, "" otherwise.
func (f *Fallback) Note() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.note
}

// Noted is a store with something to say about where it keeps the secret.
type Noted interface{ Note() string }

// FileWithNote is the file store with the reason the Keychain is not used.
type FileWithNote struct {
	File
	Why string
}

func (f FileWithNote) Note() string { return f.Why }

func noun(n string) string {
	if n == "" {
		return "token"
	}
	return n
}

// Default picks where Caprock keeps it: the user's login keychain on macOS
// when that file exists (with the 0600 file behind it), else the 0600 file in
// dataDir. home is the user's real home directory (UserHome), not $HOME.
func Default(dataDir string, it Item, home string) Store {
	file := File{Path: filepath.Join(dataDir, it.File)}
	if os.Getenv(EnvStore) == "file" || runtime.GOOS != "darwin" {
		return file
	}
	n := noun(it.Noun)
	if home == "" {
		return FileWithNote{File: file, Why: "Your home directory could not be read, so the " + n + " is in a file in the data directory, readable by you only."}
	}
	kc := filepath.Join(home, "Library", "Keychains", "login.keychain-db")
	if st, err := os.Stat(kc); err != nil || st.IsDir() {
		return FileWithNote{File: file, Why: "No login keychain at " + kc + ", so the " + n + " is in a file in the data directory, readable by you only."}
	}
	return &Fallback{Keychain: Keychain{Service: it.Service, Label: it.Label, Path: kc}, File: file, Noun: it.Noun}
}

// Where says where a store keeps its secret, for Settings.
type Where struct {
	Kind string `json:"kind"`           // keychain | file
	Path string `json:"path,omitempty"` // the file, when Kind is file
	Note string `json:"note,omitempty"` // why it is not in the Keychain, when it could have been
}

// Locate describes s; a nil store is the zero Where.
func Locate(s Store) Where {
	switch v := s.(type) {
	case nil:
		return Where{}
	case File:
		return Where{Kind: "file", Path: v.Path}
	case FileWithNote:
		return Where{Kind: "file", Path: v.Path, Note: v.Why}
	case *Fallback:
		if v.Kind() == "file" {
			return Where{Kind: "file", Path: v.File.Path, Note: v.Note()}
		}
		return Where{Kind: "keychain"}
	}
	w := Where{Kind: s.Kind()}
	if n, ok := s.(Noted); ok {
		w.Note = n.Note()
	}
	return w
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
	return HomeFromDSCache(string(out))
}

// HomeFromDSCache reads "dir: /Users/name" from dscacheutil's answer.
func HomeFromDSCache(out string) string {
	for _, l := range strings.Split(out, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(l), "dir:"); ok {
			// dscacheutil is macOS's: its paths are POSIX on any OS a test runs.
			if d := strings.TrimSpace(v); posix.IsAbs(d) {
				return d
			}
		}
	}
	return ""
}

func firstLine(s string) string {
	l, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	return l
}
