// Package editor opens a folder, or a file at a line, in the user's own
// editor — VS Code, Cursor, Zed or a JetBrains IDE (F18, .ai/21-app.md).
//
// Only editors on a fixed list are driven, each through the interface its own
// documentation gives a script: `open -a <bundle>` on macOS, the editor's CLI
// with a line (`code -g <file>:<line>`, `zed <file>:<line>`, `idea --line N
// <file>`), and on Linux the editor's executable on PATH. Every command is an
// argv handed to exec — never a shell string — so no folder name can become
// a command. The path is the last word and is absolute, so it can never be
// read as a flag either.
//
// Nothing here decides who may ask; the API refuses anything that is not a
// request from this machine (internal/api/editor.go).
package editor

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/dspv/caprock/internal/nativeterm"
)

// Editor is one editor found on this machine.
type Editor struct {
	// ID is the stable name the API and the setting use ("vscode").
	ID string `json:"id"`
	// Name is what a menu says ("VS Code").
	Name string `json:"name"`
	// app is the bundle (macOS) or the executable (Linux).
	app string
	// cli is the command-line tool inside the bundle that takes a line
	// (macOS), "" when the bundle has none.
	cli string
}

// lineStyle is how an editor is told the line to open a file at.
type lineStyle int

const (
	// lineGoto is VS Code's and Cursor's `-g <file>:<line>`.
	lineGoto lineStyle = iota
	// lineSuffix is Zed's `<file>:<line>`.
	lineSuffix
	// lineFlag is the JetBrains launchers' `--line <n> <file>`.
	lineFlag
)

// known is one editor Caprock can drive, in the order it is offered when the
// user has not chosen one.
type known struct {
	id, name string
	// bundles are app bundle names (macOS), in /Applications or
	// ~/Applications (where JetBrains Toolbox puts its IDEs).
	bundles []string
	// cli is the line-taking tool's path inside the bundle (macOS).
	cli string
	// bins are executables on PATH (Linux).
	bins []string
	line lineStyle
}

var editors = []known{
	{id: "vscode", name: "VS Code", bundles: []string{"Visual Studio Code.app"}, cli: "Contents/Resources/app/bin/code", bins: []string{"code"}, line: lineGoto},
	{id: "cursor", name: "Cursor", bundles: []string{"Cursor.app"}, cli: "Contents/Resources/app/bin/cursor", bins: []string{"cursor"}, line: lineGoto},
	{id: "zed", name: "Zed", bundles: []string{"Zed.app"}, cli: "Contents/MacOS/cli", bins: []string{"zed", "zeditor"}, line: lineSuffix},
	{id: "idea", name: "IntelliJ IDEA", bundles: []string{"IntelliJ IDEA.app", "IntelliJ IDEA Ultimate.app", "IntelliJ IDEA CE.app", "IntelliJ IDEA Community Edition.app"}, bins: []string{"idea", "intellij-idea-ultimate", "intellij-idea-community"}, line: lineFlag},
	{id: "goland", name: "GoLand", bundles: []string{"GoLand.app"}, bins: []string{"goland"}, line: lineFlag},
	{id: "webstorm", name: "WebStorm", bundles: []string{"WebStorm.app"}, bins: []string{"webstorm"}, line: lineFlag},
	{id: "pycharm", name: "PyCharm", bundles: []string{"PyCharm.app", "PyCharm Professional Edition.app", "PyCharm CE.app", "PyCharm Community Edition.app"}, bins: []string{"pycharm", "pycharm-professional", "pycharm-community"}, line: lineFlag},
	{id: "rustrover", name: "RustRover", bundles: []string{"RustRover.app"}, bins: []string{"rustrover"}, line: lineFlag},
	{id: "phpstorm", name: "PhpStorm", bundles: []string{"PhpStorm.app"}, bins: []string{"phpstorm"}, line: lineFlag},
	{id: "clion", name: "CLion", bundles: []string{"CLion.app"}, bins: []string{"clion"}, line: lineFlag},
	{id: "rider", name: "Rider", bundles: []string{"Rider.app"}, bins: []string{"rider"}, line: lineFlag},
	{id: "rubymine", name: "RubyMine", bundles: []string{"RubyMine.app"}, bins: []string{"rubymine"}, line: lineFlag},
}

// IDs lists every editor id this build knows, installed or not — what the
// setting may be set to.
func IDs() []string {
	out := make([]string, 0, len(editors))
	for _, k := range editors {
		out = append(out, k.id)
	}
	return out
}

func knownByID(id string) (known, bool) {
	for _, k := range editors {
		if k.id == id {
			return k, true
		}
	}
	return known{}, false
}

// Detect lists the editors installed, in the order they are offered. Windows
// is not supported yet: its editors' launchers are batch files, which cannot
// be started without a command interpreter parsing the path.
func Detect(p nativeterm.Probe) []Editor {
	var out []Editor
	for _, k := range editors {
		switch p.GOOS {
		case "darwin":
			app := findBundle(p, k.bundles)
			if app == "" {
				continue
			}
			e := Editor{ID: k.id, Name: k.name, app: app}
			if k.cli != "" && p.IsExec(filepath.Join(app, k.cli)) {
				e.cli = filepath.Join(app, k.cli)
			}
			out = append(out, e)
		case "linux":
			for _, b := range k.bins {
				if path := lookPath(p, b); path != "" {
					out = append(out, Editor{ID: k.id, Name: k.name, app: path})
					break
				}
			}
		}
	}
	return out
}

// Pick returns the preferred editor if it is installed, else the first one
// found. ok is false when there is none.
func Pick(es []Editor, preferred string) (Editor, bool) {
	for _, e := range es {
		if e.ID == preferred {
			return e, true
		}
	}
	if len(es) == 0 {
		return Editor{}, false
	}
	return es[0], true
}

// ErrBadPath is returned for a path that is not an absolute, existing folder
// or file Caprock can pass on safely.
var ErrBadPath = errors.New("bad path")

// MaxLine bounds the line number: nothing real is longer, and a number that
// does not fit is a mistake, not a file.
const MaxLine = 10_000_000

// CheckPath validates what an editor is asked to open: absolute, clean, no
// control characters, and present on disk. stat is os.Stat in production.
func CheckPath(path string, line int, stat func(string) (os.FileInfo, error)) error {
	if path == "" || !filepath.IsAbs(path) {
		return fmt.Errorf("%w: %q is not an absolute path", ErrBadPath, path)
	}
	if filepath.Clean(path) != path {
		return fmt.Errorf("%w: %q is not a clean path", ErrBadPath, path)
	}
	for _, r := range path {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("%w: control character in path", ErrBadPath)
		}
	}
	if line < 0 || line > MaxLine {
		return fmt.Errorf("%w: line %d is out of range", ErrBadPath, line)
	}
	st, err := stat(path)
	if err != nil {
		return fmt.Errorf("%w: %s does not exist", ErrBadPath, path)
	}
	if line > 0 && st.IsDir() {
		return fmt.Errorf("%w: a line was given for a folder", ErrBadPath)
	}
	return nil
}

// Build turns a request into the process that opens path (at line, when it
// is above zero) in e, on goos. path has already passed CheckPath.
func Build(goos string, e Editor, path string, line int) (nativeterm.Plan, error) {
	k, ok := knownByID(e.ID)
	if !ok {
		return nativeterm.Plan{}, fmt.Errorf("unknown editor %q", e.ID)
	}
	switch goos {
	case "darwin":
		return buildDarwin(k, e, path, line), nil
	case "linux":
		return nativeterm.Plan{Command: e.app, Args: lineArgs(k.line, path, line)}, nil
	}
	return nativeterm.Plan{}, fmt.Errorf("opening an editor is not supported on %s yet", goos)
}

func buildDarwin(k known, e Editor, path string, line int) nativeterm.Plan {
	switch {
	case line > 0 && k.line == lineFlag:
		// A JetBrains IDE takes the line as a launcher flag; `open --args`
		// hands it over, and a running IDE takes the file itself.
		args := append([]string{"-na", e.app, "--args"}, lineArgs(k.line, path, line)...)
		return nativeterm.Plan{Command: "/usr/bin/open", Args: args, Wait: true}
	case line > 0 && e.cli != "":
		return nativeterm.Plan{Command: e.cli, Args: lineArgs(k.line, path, line), Wait: true}
	}
	// A folder, or a file with no line (or an editor whose bundle has no
	// CLI): LaunchServices opens it in the app, starting it if need be.
	return nativeterm.Plan{Command: "/usr/bin/open", Args: []string{"-a", e.app, path}, Wait: true}
}

// lineArgs is the editor's own way of naming a file and a line.
func lineArgs(style lineStyle, path string, line int) []string {
	if line <= 0 {
		return []string{path}
	}
	n := strconv.Itoa(line)
	switch style {
	case lineGoto:
		return []string{"-g", path + ":" + n}
	case lineSuffix:
		return []string{path + ":" + n}
	default:
		return []string{"--line", n, path}
	}
}

func findBundle(p nativeterm.Probe, names []string) string {
	dirs := []string{"/Applications"}
	if p.Home != "" {
		dirs = append(dirs, filepath.Join(p.Home, "Applications"), filepath.Join(p.Home, "Applications", "JetBrains Toolbox"))
	}
	for _, d := range dirs {
		for _, n := range names {
			if path := filepath.Join(d, n); p.IsDir(path) {
				return path
			}
		}
	}
	return ""
}

// lookPath is exec.LookPath against the PATH in p.Env — the user's login
// shell's — rather than the daemon's own, which under a service is minimal.
func lookPath(p nativeterm.Probe, name string) string {
	for _, dir := range strings.Split(getenv(p.Env, "PATH"), ":") {
		if dir == "" || !filepath.IsAbs(dir) {
			continue
		}
		if full := filepath.Join(dir, name); p.IsExec(full) {
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
