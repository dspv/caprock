package nativeterm

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

// ErrNoTerminal is returned when no terminal Caprock can drive is installed,
// or the one asked for is not.
var ErrNoTerminal = errors.New("no terminal")

// Opener is what the daemon hands the API: it detects terminals against the
// user's environment and opens a command in one.
type Opener struct {
	// DataDir holds the short-lived files some terminals are opened with.
	DataDir string
	// Env is the user's login-shell environment (internal/userenv).
	Env func() []string
	// Preferred is the terminal the user picked in settings, "" for none.
	Preferred func() string
}

func (o *Opener) env() []string {
	if o.Env == nil {
		return os.Environ()
	}
	return o.Env()
}

func (o *Opener) preferred() string {
	if o.Preferred == nil {
		return ""
	}
	return o.Preferred()
}

// List is the installed terminals, most preferred first, and the id of the
// one used when none is named: the user's choice if it is installed, else
// the first found.
func (o *Opener) List() ([]Terminal, string) {
	ts := Detect(DefaultProbe(o.env()))
	t, ok := Pick(ts, o.preferred())
	if !ok {
		return ts, ""
	}
	return ts, t.ID
}

// Open runs argv in cwd in the terminal with this id, or the preferred one.
// before runs after the launch is planned and before it starts. The string
// returned is the command as the user would type it, also on failure, so the
// screen can offer it to copy.
func (o *Opener) Open(ctx context.Context, id, cwd string, argv []string, before func() error) (Terminal, string, error) {
	env := Env(o.env())
	display := Display(runtime.GOOS, cwd, argv)
	ts := Detect(DefaultProbe(env))
	if id == "" {
		id = o.preferred()
	}
	t, ok := Pick(ts, id)
	if !ok {
		return Terminal{}, display, fmt.Errorf("%w: Caprock found no terminal application it can open", ErrNoTerminal)
	}
	if id != "" && t.ID != id && id != o.preferred() {
		// Asked for one by name and it is not here: say so rather than open
		// a different one the user did not pick.
		return Terminal{}, display, fmt.Errorf("%w: %q is not installed", ErrNoTerminal, id)
	}
	scratch := filepath.Join(o.DataDir, "open")
	sweep(scratch, time.Now().Add(-time.Hour))
	req := Request{Cwd: cwd, Argv: argv, Shell: Shell(env), Scratch: scratch, Name: "caprock-" + randHex()}
	if t.ID == "warp" {
		// Warp reads launch configurations from this one place. One fixed
		// name, overwritten each time, so its list gains one entry rather
		// than one per click.
		home, err := os.UserHomeDir()
		if err != nil {
			return t, display, err
		}
		req.Scratch, req.Name = filepath.Join(home, ".warp", "launch_configurations"), "caprock-open"
	}
	plan, err := Build(runtime.GOOS, t, req)
	if err != nil {
		return t, display, err
	}
	if before != nil {
		if err := before(); err != nil {
			return t, display, err
		}
	}
	if err := Run(ctx, plan, env); err != nil {
		return t, display, err
	}
	return t, display, nil
}

// sweep removes .command files a terminal never ran (each one deletes itself
// when it does), so a failed open does not leave them behind for good.
func sweep(dir string, before time.Time) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if filepath.Ext(e.Name()) != ".command" {
			continue
		}
		if info, err := e.Info(); err == nil && info.ModTime().Before(before) {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

func randHex() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
