// Package nativeterm opens a command in the user's own terminal application —
// Ghostty, iTerm2, Terminal.app, Windows Terminal — rather than in the
// dashboard's web terminal.
//
// The dashboard's xterm is a fine place to glance at a session and an awkward
// place to live in: its own key bindings, its own copy and paste, no tabs of
// the user's own (owner request, 2026-10-04). So a session can be carried on
// in the terminal the user already has, and Caprock goes on watching it the
// way it watches any session somebody started themselves (Phase 0): through
// the hooks and the transcript, not through a PTY it holds.
//
// Every terminal is driven through its own documented interface, read from
// that terminal rather than guessed (see .ai/02-architecture.md § Native
// terminals for which ones were run on a real machine and which are written
// from their documentation):
//
//   - Terminal.app opens a `.command` file in a new window, run by the user's
//     login shell — no AppleScript, so no Automation prompt.
//   - iTerm2 is told over AppleScript to open a window and type the command
//     into the user's own shell there. It also opens `.command` files, but
//     asks "OK to run …?" every time.
//   - Ghostty, WezTerm and kitty take the command as arguments; on macOS
//     through `open -na <app> --args`, which is how their docs start a window
//     from a script.
//   - Warp runs commands only from a launch configuration, so one is written
//     and opened by its URI.
//   - On Linux every terminal takes a command after a flag; on Windows,
//     Windows Terminal takes `-d <dir>` and a command line, and cmd and
//     PowerShell are started in a console of their own.
//
// Nothing here decides whether a session may be opened; that is the caller's
// (internal/api), because it depends on who owns the process.
package nativeterm

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

// Terminal is one terminal application found on this machine.
type Terminal struct {
	// ID is the stable name the API and the setting use ("ghostty").
	ID string `json:"id"`
	// Name is what the button says ("Ghostty").
	Name string `json:"name"`
	// path is the app bundle (macOS) or the executable (Linux, Windows).
	path string
}

// known is one terminal Caprock can drive, in the order it is preferred when
// the user has not chosen. On macOS the terminals people install on purpose
// come before the one that ships with the system; Warp is last because it is
// the one driven through the least direct interface.
type known struct {
	id, name string
	// bundles are app bundle names (macOS); bins are executables (Linux,
	// Windows).
	bundles []string
	bins    []string
}

var darwinKnown = []known{
	{id: "ghostty", name: "Ghostty", bundles: []string{"Ghostty.app"}},
	{id: "iterm2", name: "iTerm2", bundles: []string{"iTerm.app", "iTerm2.app"}},
	{id: "wezterm", name: "WezTerm", bundles: []string{"WezTerm.app"}},
	{id: "kitty", name: "kitty", bundles: []string{"kitty.app"}},
	{id: "terminal", name: "Terminal", bundles: []string{"Terminal.app"}},
	{id: "warp", name: "Warp", bundles: []string{"Warp.app"}},
}

var linuxKnown = []known{
	// "env" is whatever $TERMINAL names: the user's own answer to this exact
	// question, so it comes first. Filled in by Detect.
	{id: "env", name: "$TERMINAL"},
	{id: "ghostty", name: "Ghostty", bins: []string{"ghostty"}},
	{id: "gnome-terminal", name: "GNOME Terminal", bins: []string{"gnome-terminal"}},
	{id: "konsole", name: "Konsole", bins: []string{"konsole"}},
	{id: "kitty", name: "kitty", bins: []string{"kitty"}},
	{id: "wezterm", name: "WezTerm", bins: []string{"wezterm"}},
	{id: "alacritty", name: "Alacritty", bins: []string{"alacritty"}},
	{id: "xterm", name: "xterm", bins: []string{"xterm"}},
}

var windowsKnown = []known{
	{id: "wt", name: "Windows Terminal", bins: []string{"wt.exe"}},
	{id: "powershell", name: "PowerShell", bins: []string{"pwsh.exe", "powershell.exe"}},
	{id: "cmd", name: "Command Prompt", bins: []string{"cmd.exe"}},
}

// IDs lists every terminal id this build knows on goos, installed or not —
// what the setting may be set to.
func IDs(goos string) []string {
	var out []string
	for _, k := range knownFor(goos) {
		out = append(out, k.id)
	}
	return out
}

func knownFor(goos string) []known {
	switch goos {
	case "darwin":
		return darwinKnown
	case "windows":
		return windowsKnown
	default:
		return linuxKnown
	}
}

// Probe is how Detect looks at the machine; swapped by tests.
type Probe struct {
	GOOS string
	// Env is the environment the terminal would be started with — the user's
	// login-shell one, so PATH is the PATH their own terminal has.
	Env []string
	// Home is the user's home directory, for ~/Applications.
	Home string
	// IsDir reports whether a path is a directory (an app bundle).
	IsDir func(string) bool
	// IsExec reports whether a path is an executable file.
	IsExec func(string) bool
}

// DefaultProbe looks at this machine.
func DefaultProbe(env []string) Probe {
	home, _ := os.UserHomeDir()
	return Probe{
		GOOS: runtime.GOOS,
		Env:  env,
		Home: home,
		IsDir: func(p string) bool {
			st, err := os.Stat(p)
			return err == nil && st.IsDir()
		},
		IsExec: func(p string) bool {
			st, err := os.Stat(p)
			if err != nil || st.IsDir() {
				return false
			}
			if runtime.GOOS == "windows" {
				return true
			}
			return st.Mode()&0o111 != 0
		},
	}
}

// Detect lists the terminals installed, most preferred first.
func Detect(p Probe) []Terminal {
	var out []Terminal
	for _, k := range knownFor(p.GOOS) {
		switch {
		case p.GOOS == "darwin":
			if path := findBundle(p, k.bundles); path != "" {
				out = append(out, Terminal{ID: k.id, Name: k.name, path: path})
			}
		case k.id == "env":
			// $TERMINAL may be a name on PATH or a path; either way it has to
			// exist, or the button would promise a window that never opens.
			v := getenv(p.Env, "TERMINAL")
			if v == "" || strings.ContainsAny(v, " \t") {
				continue
			}
			path := v
			if !filepath.IsAbs(v) {
				path = lookPath(p, v)
			} else if !p.IsExec(v) {
				path = ""
			}
			if path != "" {
				out = append(out, Terminal{ID: k.id, Name: filepath.Base(v), path: path})
			}
		default:
			for _, b := range k.bins {
				if path := lookPath(p, b); path != "" {
					out = append(out, Terminal{ID: k.id, Name: k.name, path: path})
					break
				}
			}
		}
	}
	if p.GOOS == "windows" && !hasID(out, "cmd") {
		// cmd.exe is on every Windows machine; a PATH that does not reach
		// System32 is the daemon's oddity, not a missing terminal.
		out = append(out, Terminal{ID: "cmd", Name: "Command Prompt", path: "cmd.exe"})
	}
	return out
}

func hasID(ts []Terminal, id string) bool {
	for _, t := range ts {
		if t.ID == id {
			return true
		}
	}
	return false
}

// Pick returns the preferred terminal if it is installed, else the first one
// found. ok is false when there is none.
func Pick(ts []Terminal, preferred string) (Terminal, bool) {
	for _, t := range ts {
		if t.ID == preferred {
			return t, true
		}
	}
	if len(ts) == 0 {
		return Terminal{}, false
	}
	return ts[0], true
}

func findBundle(p Probe, names []string) string {
	dirs := []string{"/Applications", "/Applications/Utilities", "/System/Applications/Utilities"}
	if p.Home != "" {
		dirs = append(dirs, filepath.Join(p.Home, "Applications"))
	}
	for _, d := range dirs {
		for _, n := range names {
			path := filepath.Join(d, n)
			if p.IsDir(path) {
				return path
			}
		}
	}
	return ""
}

// lookPath is exec.LookPath against the PATH in p.Env rather than the
// daemon's own, which under launchd is /usr/bin:/bin:/usr/sbin:/sbin.
func lookPath(p Probe, name string) string {
	sep := ":"
	if p.GOOS == "windows" {
		sep = ";"
	}
	path := getenv(p.Env, "PATH")
	if p.GOOS == "windows" && path == "" {
		path = getenv(p.Env, "Path")
	}
	for _, dir := range strings.Split(path, sep) {
		if dir == "" {
			continue
		}
		full := filepath.Join(dir, name)
		if p.GOOS == "windows" {
			full = dir + `\` + name
		}
		if p.IsExec(full) {
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

// Request is what to open.
type Request struct {
	// Cwd is the directory the command runs in. Empty means the home
	// directory, for a command that does not need one.
	Cwd string
	// Argv is the command, already split: ["claude", "--resume", "<id>"].
	// Every word must be plain (see safeWord): it is typed into shells and
	// command lines on three operating systems, and an id with a quote in it
	// is not an id.
	Argv []string
	// Shell is the user's login shell (POSIX), used where a terminal is given
	// a command rather than a shell to type it into.
	Shell string
	// Scratch is a private directory for the files some terminals are opened
	// with (Terminal.app's .command, Warp's launch configuration's twin).
	Scratch string
	// Name is a unique stem for those files.
	Name string
}

// Plan is the process that opens the window, and the file it needs first.
type Plan struct {
	Command string
	Args    []string
	// Dir is the working directory of Command itself (Windows consoles and
	// Linux terminals that have no directory flag of their own).
	Dir string
	// File is written, 0700, before Command runs.
	File *File
	// NewConsole starts Command in a console window of its own (Windows).
	NewConsole bool
	// Wait says Command returns once the window is open (open, osascript),
	// so its exit status is the answer. Otherwise Command is the terminal
	// itself and keeps running; it is started and let go.
	Wait bool
}

// File is written before the plan runs.
type File struct {
	Path    string
	Content string
}

// safeWord is what an argv word may contain: ids, flags, command names.
var safeWord = regexp.MustCompile(`^[A-Za-z0-9-][A-Za-z0-9._:=/-]*$`)

// ErrUnsafe is returned for a command word or directory that cannot be
// passed on safely.
var ErrUnsafe = errors.New("unsafe")

func validate(goos string, req Request) error {
	if len(req.Argv) == 0 {
		return errors.New("nothing to run")
	}
	for _, w := range req.Argv {
		if !safeWord.MatchString(w) {
			return fmt.Errorf("%w: command word %q", ErrUnsafe, w)
		}
	}
	for _, r := range req.Cwd {
		// A newline would end the line iTerm2 types; nothing legitimate puts
		// a control character in a folder name.
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("%w: control character in folder name", ErrUnsafe)
		}
	}
	if goos == "windows" && strings.ContainsAny(req.Cwd, `"`) {
		return fmt.Errorf("%w: quote in folder name", ErrUnsafe)
	}
	return nil
}

// Build turns a request into the process that opens it in t, on goos.
func Build(goos string, t Terminal, req Request) (Plan, error) {
	if err := validate(goos, req); err != nil {
		return Plan{}, err
	}
	switch goos {
	case "darwin":
		return buildDarwin(t, req)
	case "windows":
		return buildWindows(t, req)
	default:
		return buildLinux(t, req)
	}
}

var bareWord = regexp.MustCompile(`^[A-Za-z0-9@%+=:,./_-]+$`)

// ShellQuote quotes s for a POSIX shell. Plain words are left bare so the
// command reads the way a person would type it; anything else is put in
// single quotes, inside which nothing is special but the quote itself.
func ShellQuote(s string) string {
	if s != "" && bareWord.MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// Line is the command as one POSIX shell line: `cd <dir> && <argv>`.
func Line(cwd string, argv []string) string {
	words := make([]string, len(argv))
	for i, w := range argv {
		words[i] = ShellQuote(w)
	}
	cmd := strings.Join(words, " ")
	if cwd == "" {
		return cmd
	}
	return "cd " + ShellQuote(cwd) + " && " + cmd
}

// shellOr returns the user's shell, or a sane default when it is unknown or
// not an absolute POSIX path (a relative one would be looked up who knows
// where). A string check, not filepath.IsAbs: the plan is for a POSIX
// machine whatever the OS building it.
func shellOr(shell, def string) string {
	if strings.HasPrefix(shell, "/") && !strings.ContainsAny(shell, "'\"\n") {
		return shell
	}
	return def
}

// shellArgv runs line in an interactive login shell and leaves that shell
// open when the agent exits, so the window is a terminal and not a dead pane.
func shellArgv(shell, line string) []string {
	return []string{shell, "-l", "-i", "-c", line + "; exec " + ShellQuote(shell) + " -l"}
}

func buildDarwin(t Terminal, req Request) (Plan, error) {
	shell := shellOr(req.Shell, "/bin/zsh")
	line := Line(req.Cwd, req.Argv)
	switch t.ID {
	case "terminal":
		// Terminal.app runs a .command file in a new window, through the
		// user's login shell: the environment is theirs, not the daemon's.
		// The file removes itself first, and leaves a shell in the folder
		// when the agent exits.
		if req.Scratch == "" {
			return Plan{}, errors.New("no scratch directory for the .command file")
		}
		path := filepath.Join(req.Scratch, req.Name+".command")
		var b strings.Builder
		b.WriteString("#!/bin/sh\nrm -f \"$0\"\n")
		if req.Cwd != "" {
			b.WriteString("cd " + ShellQuote(req.Cwd) + " || exit 1\n")
		}
		b.WriteString(Line("", req.Argv) + "\n")
		b.WriteString("exec \"${SHELL:-/bin/zsh}\" -l\n")
		return Plan{Command: "/usr/bin/open", Args: []string{"-a", t.path, path}, File: &File{Path: path, Content: b.String()}, Wait: true}, nil
	case "iterm2":
		// A new window with the user's default profile, and the line typed
		// into its shell — the same as typing it themselves, so the
		// environment and the shell left afterwards are theirs.
		script := "tell application id \"com.googlecode.iterm2\"\n" +
			"\tactivate\n" +
			"\tset w to (create window with default profile)\n" +
			"\ttell current session of w to write text " + AppleScriptString(line) + "\n" +
			"end tell"
		return Plan{Command: "/usr/bin/osascript", Args: []string{"-e", script}, Wait: true}, nil
	case "ghostty":
		// Ghostty's -e takes the command as words and disables shell
		// expansion, so the line goes to the user's shell as one argument.
		args := []string{"-na", t.path, "--args"}
		if req.Cwd != "" {
			args = append(args, "--working-directory="+req.Cwd)
		}
		args = append(args, "-e")
		args = append(args, shellArgv(shell, line)...)
		return Plan{Command: "/usr/bin/open", Args: args, Wait: true}, nil
	case "wezterm":
		args := []string{"-na", t.path, "--args", "start"}
		if req.Cwd != "" {
			args = append(args, "--cwd", req.Cwd)
		}
		args = append(args, "--")
		args = append(args, shellArgv(shell, line)...)
		return Plan{Command: "/usr/bin/open", Args: args, Wait: true}, nil
	case "kitty":
		args := []string{"-na", t.path, "--args"}
		if req.Cwd != "" {
			args = append(args, "--directory", req.Cwd)
		}
		args = append(args, shellArgv(shell, line)...)
		return Plan{Command: "/usr/bin/open", Args: args, Wait: true}, nil
	case "warp":
		// Warp runs a command only from a launch configuration, which it
		// reads from ~/.warp/launch_configurations and opens by URI.
		if req.Scratch == "" {
			return Plan{}, errors.New("no launch configuration directory for Warp")
		}
		path := filepath.Join(req.Scratch, req.Name+".yaml")
		cwd := req.Cwd
		var b strings.Builder
		b.WriteString("---\nname: " + YAMLString("Caprock "+req.Name) + "\nwindows:\n  - tabs:\n      - layout:\n")
		if cwd != "" {
			b.WriteString("          cwd: " + YAMLString(cwd) + "\n")
		}
		b.WriteString("          commands:\n            - exec: " + YAMLString(Line("", req.Argv)) + "\n")
		u := "warp://launch/" + url.PathEscape(path)
		return Plan{Command: "/usr/bin/open", Args: []string{u}, File: &File{Path: path, Content: b.String()}, Wait: true}, nil
	}
	return Plan{}, fmt.Errorf("unknown terminal %q", t.ID)
}

func buildLinux(t Terminal, req Request) (Plan, error) {
	shell := shellOr(req.Shell, "/bin/sh")
	line := Line(req.Cwd, req.Argv)
	run := shellArgv(shell, line)
	p := Plan{Command: t.path, Dir: req.Cwd}
	switch t.ID {
	case "env", "xterm", "alacritty", "konsole", "ghostty":
		// `-e` is the convention every one of these honours (it is what
		// $TERMINAL is expected to take); the directory is the process's own
		// and the `cd` in the line, for the ones with no flag for it.
		p.Args = append([]string{"-e"}, run...)
	case "gnome-terminal":
		// gnome-terminal deprecated -e in favour of `--`.
		p.Args = []string{"--"}
		p.Args = append(p.Args, run...)
	case "kitty":
		p.Args = run
	case "wezterm":
		p.Args = []string{"start", "--"}
		p.Args = append(p.Args, run...)
	default:
		return Plan{}, fmt.Errorf("unknown terminal %q", t.ID)
	}
	return p, nil
}

func buildWindows(t Terminal, req Request) (Plan, error) {
	switch t.ID {
	case "wt":
		// Windows Terminal reads `;` as "and then another tab", even inside
		// a directory, unless it is escaped. cmd /k keeps the window open
		// after the agent exits, and finds a .cmd shim the way a prompt does.
		args := []string{"-w", "new"}
		if req.Cwd != "" {
			args = append(args, "-d", strings.ReplaceAll(req.Cwd, ";", `\;`))
		}
		args = append(args, "cmd.exe", "/k")
		args = append(args, req.Argv...)
		return Plan{Command: t.path, Args: args, Dir: req.Cwd}, nil
	case "powershell":
		return Plan{Command: t.path, Args: []string{"-NoExit", "-Command", strings.Join(req.Argv, " ")}, Dir: req.Cwd, NewConsole: true}, nil
	case "cmd":
		args := append([]string{"/k"}, req.Argv...)
		return Plan{Command: t.path, Args: args, Dir: req.Cwd, NewConsole: true}, nil
	}
	return Plan{}, fmt.Errorf("unknown terminal %q", t.ID)
}

// AppleScriptString quotes s as an AppleScript string literal.
func AppleScriptString(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}

// YAMLString quotes s as a YAML double-quoted scalar.
func YAMLString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r < 0x20 || r == 0x7f:
			fmt.Fprintf(&b, `\x%02x`, r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// Display is the command as the user would type it, for the response and the
// button's tooltip.
func Display(goos, cwd string, argv []string) string {
	if goos == "windows" {
		cmd := strings.Join(argv, " ")
		if cwd == "" {
			return cmd
		}
		return `cd /d "` + cwd + `" && ` + cmd
	}
	return Line(cwd, argv)
}
