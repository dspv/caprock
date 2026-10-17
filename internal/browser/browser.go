// Package browser lists the web browsers installed on this machine and opens
// a link in the one the user picks: the chooser a ⇧⌘-click (Ctrl+Shift+click
// off macOS) on a link in a terminal opens (.ai/04-ui.md § Session Detail,
// .ai/21-app.md).
//
// Each OS says which apps handle web links in its own way, and the list is
// read from there rather than from a fixed list of names:
//
//   - macOS: LaunchServices, the apps registered for `https`
//     (LSCopyAllHandlersForURLScheme) and the default one, each resolved to
//     its bundle (browser_darwin.go).
//   - Windows: the registry's StartMenuInternet clients, HKCU then HKLM, with
//     the default from the https UserChoice (browser_windows.go).
//   - Linux: the .desktop entries whose MimeType names
//     x-scheme-handler/http or https, with the default from mimeapps.list
//     (desktop.go).
//
// Opening is a process Caprock starts (rule 7 is about processes it did not
// start): an argv handed to exec, never a shell string, and the URL is its own
// word. Only http and https are opened; a URL starts with its scheme, so it
// can never be read as a flag.
//
// Nothing here decides who may ask; the API refuses anything that is not a
// request from this machine (internal/api/browser.go).
package browser

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"runtime"
	"sort"
	"strings"
	"sync"

	"github.com/dspv/caprock/internal/nativeterm"
)

// Browser is one browser found on this machine.
type Browser struct {
	// ID is stable for this machine: the bundle id on macOS
	// ("com.google.chrome"), the StartMenuInternet key on Windows, the
	// desktop file's name on Linux ("firefox.desktop").
	ID string `json:"id"`
	// Name is what the chooser says ("Google Chrome").
	Name string `json:"name"`
	// Default is the system's default browser.
	Default bool `json:"default"`
	// app is the bundle (macOS) or the executable (Windows).
	app string
	// exec is the desktop entry's Exec line, split into words (Linux).
	exec []string
}

// ErrNoBrowser is returned when the browser asked for is not installed.
var ErrNoBrowser = errors.New("no such browser")

// ErrBadURL is returned for anything but an http or https URL Caprock can
// pass on safely.
var ErrBadURL = errors.New("bad url")

// MaxURL bounds a URL: a link longer than this is not one a person clicked.
const MaxURL = 8 << 10

// CheckURL validates what a browser is asked to open: http or https, with a
// host, no control characters or spaces, at most MaxURL bytes. It returns the
// URL as it will be passed on.
func CheckURL(raw string) (string, error) {
	if raw == "" || len(raw) > MaxURL {
		return "", fmt.Errorf("%w: empty or too long", ErrBadURL)
	}
	for _, r := range raw {
		if r <= 0x20 || r == 0x7f {
			return "", fmt.Errorf("%w: control character or space", ErrBadURL)
		}
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("%w: %w", ErrBadURL, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("%w: only http and https open in a browser", ErrBadURL)
	}
	if u.Host == "" {
		return "", fmt.Errorf("%w: no host", ErrBadURL)
	}
	return u.String(), nil
}

// Sorted puts the default browser first and the rest by name, which is the
// order the chooser shows. It drops a second entry with an id already seen.
func Sorted(bs []Browser) []Browser {
	seen := map[string]bool{}
	var def, rest []Browser
	for _, b := range bs {
		if b.ID == "" || seen[b.ID] {
			continue
		}
		seen[b.ID] = true
		if b.Default {
			def = append(def, b)
		} else {
			rest = append(rest, b)
		}
	}
	sort.SliceStable(rest, func(i, j int) bool { return strings.ToLower(rest[i].Name) < strings.ToLower(rest[j].Name) })
	return append(def, rest...)
}

// Build turns a request into the process that opens u in b, on goos. u has
// already passed CheckURL; env is the user's environment, for PATH (Linux).
func Build(goos string, b Browser, u string, env []string) (nativeterm.Plan, error) {
	switch goos {
	case "darwin":
		if b.app == "" {
			return nativeterm.Plan{}, fmt.Errorf("%w: %s has no app bundle", ErrNoBrowser, b.Name)
		}
		// LaunchServices opens it in the app, starting it if need be.
		return nativeterm.Plan{Command: "/usr/bin/open", Args: []string{"-a", b.app, u}, Wait: true}, nil
	case "windows":
		if b.app == "" {
			return nativeterm.Plan{}, fmt.Errorf("%w: %s has no executable", ErrNoBrowser, b.Name)
		}
		return nativeterm.Plan{Command: b.app, Args: []string{u}}, nil
	case "linux":
		argv, err := ExpandExec(b.exec, u)
		if err != nil {
			return nativeterm.Plan{}, err
		}
		cmd := argv[0]
		if !strings.HasPrefix(cmd, "/") {
			full := lookPath(env, cmd)
			if full == "" {
				return nativeterm.Plan{}, fmt.Errorf("%w: %s is not on PATH", ErrNoBrowser, cmd)
			}
			cmd = full
		}
		return nativeterm.Plan{Command: cmd, Args: argv[1:]}, nil
	}
	return nativeterm.Plan{}, fmt.Errorf("choosing a browser is not supported on %s", goos)
}

// Opener is what the daemon hands the API: it finds the browsers once per
// daemon run, against the user's own environment, and opens a link in one.
type Opener struct {
	// Env is the user's login-shell environment (internal/userenv).
	Env func() []string
	// Detect finds the browsers; DetectHere when nil. Swapped by tests.
	Detect func(env []string) []Browser
	// Run carries a plan out; nativeterm.Run when nil. Swapped by tests, so
	// no test ever opens a browser on someone's screen.
	Run func(ctx context.Context, p nativeterm.Plan, env []string) error

	once  sync.Once
	found []Browser
}

func (o *Opener) env() []string {
	if o.Env == nil {
		return os.Environ()
	}
	return o.Env()
}

// detected is looked for once per daemon run: the chooser is opened often
// and the answer rarely changes; a browser installed later is found after a
// restart.
func (o *Opener) detected() []Browser {
	o.once.Do(func() {
		d := o.Detect
		if d == nil {
			d = DetectHere
		}
		o.found = Sorted(d(o.env()))
	})
	return o.found
}

// List is the installed browsers, the default first.
func (o *Opener) List() []Browser { return o.detected() }

// Open opens u in the browser with this id.
func (o *Opener) Open(ctx context.Context, id, u string) (Browser, error) {
	safe, err := CheckURL(u)
	if err != nil {
		return Browser{}, err
	}
	var b Browser
	for _, x := range o.detected() {
		if x.ID == id {
			b = x
			break
		}
	}
	if b.ID == "" {
		return Browser{}, fmt.Errorf("%w: %q", ErrNoBrowser, id)
	}
	env := nativeterm.Env(o.env())
	plan, err := Build(runtime.GOOS, b, safe, env)
	if err != nil {
		return b, err
	}
	run := o.Run
	if run == nil {
		run = nativeterm.Run
	}
	return b, run(ctx, plan, env)
}

// lookPath is exec.LookPath against the PATH in env — the user's login
// shell's — rather than the daemon's own, which under a service is minimal.
func lookPath(env []string, name string) string {
	if strings.Contains(name, "/") {
		return ""
	}
	for _, dir := range strings.Split(getenv(env, "PATH"), ":") {
		if dir == "" || !strings.HasPrefix(dir, "/") {
			continue
		}
		full := strings.TrimSuffix(dir, "/") + "/" + name
		if st, err := os.Stat(full); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return full
		}
	}
	return ""
}

func getenv(env []string, key string) string {
	for i := len(env) - 1; i >= 0; i-- {
		if k, v, ok := strings.Cut(env[i], "="); ok && k == key {
			return v
		}
	}
	return ""
}
