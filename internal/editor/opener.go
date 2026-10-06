package editor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"sync"

	"github.com/dspv/caprock/internal/nativeterm"
)

// ErrNoEditor is returned when no editor Caprock can drive is installed, or
// the one asked for is not.
var ErrNoEditor = errors.New("no editor")

// Opener is what the daemon hands the API: it finds the editors once, against
// the user's own environment, and opens a path in one.
type Opener struct {
	// Env is the user's login-shell environment (internal/userenv).
	Env func() []string
	// Preferred is the editor the user picked in Settings, "" for none.
	Preferred func() string
	// Run carries a plan out; nativeterm.Run when nil. Swapped by tests, so
	// no test ever opens an editor on someone's screen.
	Run func(ctx context.Context, p nativeterm.Plan, env []string) error

	once  sync.Once
	found []Editor
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

// detected is the editors found, looked for once per daemon run: an editor
// installed later is found after a restart. Asking the disk on every menu
// would stat a dozen bundles each time the sidebar is right-clicked.
func (o *Opener) detected() []Editor {
	o.once.Do(func() { o.found = Detect(nativeterm.DefaultProbe(o.env())) })
	return o.found
}

// List is the installed editors and the id of the one used when none is
// named: the user's choice if it is installed, else the first found.
func (o *Opener) List() ([]Editor, string) {
	es := o.detected()
	e, ok := Pick(es, o.preferred())
	if !ok {
		return es, ""
	}
	return es, e.ID
}

// Open opens path, at line when it is above zero, in the editor with this
// id, or the preferred one.
func (o *Opener) Open(ctx context.Context, id, path string, line int) (Editor, error) {
	if err := CheckPath(path, line, os.Stat); err != nil {
		return Editor{}, err
	}
	es := o.detected()
	if id == "" {
		id = o.preferred()
	}
	e, ok := Pick(es, id)
	if !ok {
		return Editor{}, fmt.Errorf("%w: Caprock found none of VS Code, Cursor, Zed or a JetBrains IDE", ErrNoEditor)
	}
	if id != "" && e.ID != id && id != o.preferred() {
		// Named and not here: say so rather than open one the user did not pick.
		return Editor{}, fmt.Errorf("%w: %q is not installed", ErrNoEditor, id)
	}
	plan, err := Build(runtime.GOOS, e, path, line)
	if err != nil {
		return e, err
	}
	run := o.Run
	if run == nil {
		run = nativeterm.Run
	}
	return e, run(ctx, plan, nativeterm.Env(o.env()))
}
