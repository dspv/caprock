package agents

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/ptyman"
	"github.com/dspv/caprock/internal/termbuf"
)

// Changing the permission mode of a Claude Code session Caprock started,
// while it runs (ADR-054).
//
// What Claude Code allows, read from 2.1.296 itself (`claude --help` and the
// bundled source), not guessed:
//
//   - Shift+Tab (ESC [ Z; `chat:cycleMode`) cycles the mode in a live
//     session: default → acceptEdits → plan → bypassPermissions (only when
//     the process was started with --dangerously-skip-permissions,
//     --allow-dangerously-skip-permissions or --permission-mode
//     bypassPermissions) → auto (only when auto mode is available to the
//     account) → default. From auto or dontAsk it goes to default.
//   - The footer says the mode: "⏸ manual mode on" (default, named "Manual"
//     since 2.1.29x; older builds draw nothing for it), "⏸ plan mode on",
//     "⏵⏵ accept edits on", "⏵⏵ bypass permissions on", "⏵⏵ auto mode on",
//     "⏵⏵ don't ask on".
//   - Every hook payload carries permission_mode, but no hook fires on a mode
//     change, so the screen is what confirms a switch.
//   - Bypass is refused in a session not started with one of those flags:
//     only a new process can have it, which is "Restart in bypass" — the same
//     conversation resumed under its own id (--resume).

// The mode names this file speaks: Claude Code's own, with "default" for the
// ordinary one (what its hooks report). "manual" is accepted as its spelling
// on the command line.
const (
	ModeDefault = "default"
	ModeAccept  = "acceptEdits"
	ModePlan    = "plan"
	ModeBypass  = "bypassPermissions"
	ModeAuto    = "auto"
	ModeDontAsk = "dontAsk"
)

// CanonicalMode is mode in the words above, or "" for a word Claude Code
// does not have.
func CanonicalMode(mode string) string {
	switch mode {
	case ModeDefault, "manual":
		return ModeDefault
	case ModeAccept, ModePlan, ModeBypass, ModeAuto, ModeDontAsk:
		return mode
	}
	return ""
}

// NextMode is where one Shift+Tab takes a session in mode from, as Claude
// Code 2.1.296 cycles: bypass only when the process may enter it, auto only
// when the account has it.
func NextMode(from string, bypass, auto bool) string {
	switch CanonicalMode(from) {
	case ModeDefault:
		return ModeAccept
	case ModeAccept:
		return ModePlan
	case ModePlan:
		if bypass {
			return ModeBypass
		}
		if auto {
			return ModeAuto
		}
		return ModeDefault
	case ModeBypass:
		if auto {
			return ModeAuto
		}
		return ModeDefault
	}
	return ModeDefault
}

// CrossesBypass reports whether going from one mode to another by Shift+Tab
// passes through bypass on the way — whether or not auto mode is in the
// cycle. A session mid-turn must not spend even a moment there that the user
// did not ask for.
func CrossesBypass(from, to string, bypass bool) bool {
	if !bypass || CanonicalMode(to) == ModeBypass {
		return false
	}
	for _, auto := range []bool{false, true} {
		m := CanonicalMode(from)
		for i := 0; i < 6 && m != CanonicalMode(to); i++ {
			m = NextMode(m, bypass, auto)
			if m == ModeBypass && m != CanonicalMode(to) {
				return true
			}
		}
	}
	return false
}

// footerMode is Claude Code's mode indicator: its symbol, the words, " on".
var footerMode = regexp.MustCompile(`(?:⏸|⏵⏵)\s*(manual mode|plan mode|accept edits|bypass permissions|don't ask|auto mode) on\b`)

var indicatorMode = map[string]string{
	"manual mode":        ModeDefault,
	"plan mode":          ModePlan,
	"accept edits":       ModeAccept,
	"bypass permissions": ModeBypass,
	"don't ask":          ModeDontAsk,
	"auto mode":          ModeAuto,
}

// footerRows is how far up from the bottom the indicator is looked for: the
// footer is the last thing drawn, under the prompt box. Higher up it is the
// conversation, which may well quote the words.
const footerRows = 4

// ScreenMode reads the permission mode off the footer of a Claude Code
// screen; false when no indicator is there (an older build in its default
// mode, a dialog over the footer, a screen not drawn yet).
func ScreenMode(screen []string) (string, bool) {
	seen := 0
	for i := len(screen) - 1; i >= 0 && seen < footerRows; i-- {
		row := strings.ReplaceAll(screen[i], "’", "'")
		if strings.TrimSpace(row) == "" {
			continue
		}
		seen++
		if m := footerMode.FindStringSubmatch(row); m != nil {
			return indicatorMode[m[1]], true
		}
	}
	return "", false
}

// LaunchFacts is what a Claude Code session's command line says about its
// permission mode: the mode it started in ("default" when no flag named
// one), whether bypass is reachable by Shift+Tab, and the model it was given.
type LaunchFacts struct {
	Mode   string `json:"mode"`
	Bypass bool   `json:"bypass"`
	Model  string `json:"model,omitempty"`
}

// ReadLaunch reads LaunchFacts from the command an owned session was started
// with (Agent.Command: the binary and its arguments, space-joined). It stops
// at --append-system-prompt, whose text is the project's and may contain
// anything, flags included.
func ReadLaunch(command string) LaunchFacts {
	f := LaunchFacts{Mode: ModeDefault}
	args := strings.Fields(command)
	for i := 0; i < len(args); i++ {
		next := ""
		if i+1 < len(args) {
			next = args[i+1]
		}
		switch args[i] {
		case "--append-system-prompt":
			return f
		case "--dangerously-skip-permissions":
			f.Mode, f.Bypass = ModeBypass, true
		case "--allow-dangerously-skip-permissions":
			f.Bypass = true
		case "--permission-mode":
			if m := CanonicalMode(next); m != "" {
				f.Mode = m
				if m == ModeBypass {
					f.Bypass = true
				}
			}
			i++
		case "--model":
			f.Model = next
			i++
		}
	}
	return f
}

// ModeSource says where a mode was learned.
type ModeSource string

const (
	SourceScreen ModeSource = "screen" // the footer, read now
	SourceHook   ModeSource = "hook"   // the session's own hook payload
	SourceSwitch ModeSource = "switch" // a switch Caprock made and saw take
	SourceLaunch ModeSource = "launch" // the command line it started with
)

type seenMode struct {
	mode   string
	source ModeSource
	at     time.Time
}

// noteMode records the mode an owned session is in.
func (m *Manager) noteMode(sessionID, mode string, source ModeSource) {
	mode = CanonicalMode(mode)
	if mode == "" {
		return
	}
	m.modeMu.Lock()
	defer m.modeMu.Unlock()
	if m.modes == nil {
		m.modes = map[string]seenMode{}
	}
	m.modes[sessionID] = seenMode{mode: mode, source: source, at: time.Now()}
}

// forgetMode drops what was seen of a session that exited.
func (m *Manager) forgetMode(sessionID string) {
	m.modeMu.Lock()
	defer m.modeMu.Unlock()
	delete(m.modes, sessionID)
}

// SessionMode is an owned Claude Code session's permission mode, as best
// known now: its footer, else the newest of its hooks and Caprock's own
// switches, else its command line. ok is false for a session this manager
// did not start.
func (m *Manager) SessionMode(sessionID string) (mode string, source ModeSource, facts LaunchFacts, ok bool) {
	a, held := m.Get(sessionID)
	if !held || a.Kind == KindShell {
		return "", "", LaunchFacts{}, false
	}
	facts = ReadLaunch(a.Command)
	if mode, ok := m.screenMode(a); ok {
		return mode, SourceScreen, facts, true
	}
	m.modeMu.Lock()
	seen, have := m.modes[sessionID]
	m.modeMu.Unlock()
	if have {
		return seen.mode, seen.source, facts, true
	}
	return facts.Mode, SourceLaunch, facts, true
}

func (m *Manager) screen(a *Agent) []string {
	cols, rows := a.size()
	return termbuf.Screen(a.ring.snapshot(), cols, rows)
}

func (m *Manager) screenMode(a *Agent) (string, bool) { return ScreenMode(m.screen(a)) }

// Errors a switch reports; nothing more was typed after any of them.
var (
	// ErrModeMenu: a dialog or menu is on the screen, and Shift+Tab would
	// act on it.
	ErrModeMenu = errors.New("the session is showing a prompt; answer it first")
	// ErrModeStuck: Shift+Tab was pressed and the footer did not change.
	ErrModeStuck = errors.New("Shift+Tab did not change the mode: the session may have Shift+Tab bound to something else, or its footer is hidden")
	// ErrModeUnreachable: the cycle came round without passing the mode.
	ErrModeUnreachable = errors.New("that mode is not in this session's Shift+Tab cycle")
)

// modeKey is Shift+Tab as a terminal sends it.
const modeKey = "\x1b[Z"

// MaxModePresses bounds a switch: the longest cycle Claude Code has is five
// modes long.
const MaxModePresses = 5

// modeWait is how long one press may take to show on the footer.
var modeWait = 2 * time.Second

// SwitchMode presses Shift+Tab in an owned Claude Code session until its
// footer shows target, one press at a time, reading the footer after each.
// It returns the mode the session is left in. Nothing is typed into a
// session showing a permission menu; a press that changes nothing stops it
// (ErrModeStuck), and so does coming back round to a mode already passed
// (ErrModeUnreachable).
func (m *Manager) SwitchMode(ctx context.Context, sessionID, target string) (string, error) {
	a, ok := m.Get(sessionID)
	if !ok {
		return "", errNotOwned(sessionID)
	}
	if a.Kind != "" && a.Kind != AgentClaude {
		return "", fmt.Errorf("caprock switches the mode of Claude Code sessions only")
	}
	want := CanonicalMode(target)
	if want == "" {
		return "", fmt.Errorf("unknown permission mode %q", target)
	}
	if _, waiting := m.PendingPermission(sessionID); waiting {
		return "", ErrModeMenu
	}
	screen := m.screen(a)
	if _, menu := readMenu(screen); menu {
		return "", ErrModeMenu
	}
	cur, shown := ScreenMode(screen)
	if !shown {
		cur, _, _, _ = m.SessionMode(sessionID)
	}
	seen := map[string]bool{cur: true}
	for i := 0; cur != want; i++ {
		if i >= MaxModePresses {
			return cur, ErrModeUnreachable
		}
		next, err := m.pressModeKey(ctx, a, cur, shown)
		if err != nil {
			m.noteMode(sessionID, cur, SourceSwitch)
			return cur, err
		}
		cur, shown = next, true
		if seen[cur] && cur != want {
			m.noteMode(sessionID, cur, SourceSwitch)
			return cur, ErrModeUnreachable
		}
		seen[cur] = true
	}
	m.noteMode(sessionID, cur, SourceSwitch)
	return cur, nil
}

// pressModeKey types one Shift+Tab and waits for the footer to show a mode
// other than from. An older Claude Code draws nothing in its default mode,
// so a footer that had an indicator and lost it is read as default.
func (m *Manager) pressModeKey(ctx context.Context, a *Agent, from string, hadIndicator bool) (string, error) {
	before := a.ring.r.Total()
	pressed := time.Now()
	if _, err := a.sess.Write([]byte(modeKey)); err != nil {
		return from, err
	}
	deadline := time.Now().Add(modeWait)
	t := time.NewTicker(40 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return from, ctx.Err()
		case <-a.done:
			return from, errors.New("the session ended")
		case <-t.C:
		}
		if a.ring.r.Total() > before {
			screen := m.screen(a)
			if _, menu := readMenu(screen); menu {
				return from, ErrModeMenu
			}
			mode, ok := ScreenMode(screen)
			switch {
			case ok && mode != from:
				return mode, nil
			case !ok && hadIndicator && from != ModeDefault && time.Since(pressed) > 300*time.Millisecond:
				return ModeDefault, nil
			}
		}
		if time.Now().After(deadline) {
			return from, ErrModeStuck
		}
	}
}

// Restarting reports whether an owned session is being stopped to be
// resumed in another mode: its terminals reconnect to the new process rather
// than closing.
func (m *Manager) Restarting(sessionID string) bool {
	m.modeMu.Lock()
	defer m.modeMu.Unlock()
	return m.restarting[sessionID]
}

// SetRestarting marks or clears a session as being restarted.
func (m *Manager) SetRestarting(sessionID string, on bool) {
	m.modeMu.Lock()
	defer m.modeMu.Unlock()
	if m.restarting == nil {
		m.restarting = map[string]bool{}
	}
	if on {
		m.restarting[sessionID] = true
	} else {
		delete(m.restarting, sessionID)
	}
}

// restartGrace is how long a session gets to exit on its own after it is
// asked to stop for a restart, before it is killed.
const restartGrace = 5 * time.Second

// StopForRestart ends an owned session's process and waits for it to be
// gone, so the same conversation can be resumed under its own id with no
// second writer on its transcript. The session is asked first (SIGTERM;
// Claude Code writes its transcript on the way out) and killed after
// restartGrace. Rule 7: only a session this manager started.
func (m *Manager) StopForRestart(ctx context.Context, sessionID string) (cols, rows int, err error) {
	a, ok := m.Get(sessionID)
	if !ok {
		return 0, 0, errNotOwned(sessionID)
	}
	cols, rows = a.size()
	a.stopped.Store(true)
	_ = a.sess.Signal(ptyman.SignalTerm)
	select {
	case <-a.done:
		return cols, rows, nil
	case <-ctx.Done():
		return cols, rows, ctx.Err()
	case <-time.After(restartGrace):
	}
	_ = a.sess.Signal(ptyman.SignalKill)
	select {
	case <-a.done:
		return cols, rows, nil
	case <-time.After(restartGrace):
		return cols, rows, errors.New("the session did not stop")
	}
}
