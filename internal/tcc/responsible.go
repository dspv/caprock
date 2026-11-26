package tcc

import (
	"path/filepath"
	"strings"
)

// Who macOS asks about a session (ADR-106).
//
// macOS's privacy check names the process's *responsible* program: the app
// or launchd job up its tree, unless a parent disclaimed it on the way down.
// For a Caprock terminal that is Caprock Terminal when the holder runs in the
// helper (ADR-101), the agent's own binary when the holder disclaimed it
// (ADR-044: Claude Code's per-version file, `~/.local/share/claude/versions/
// 2.1.330`, which System Settings lists as "2.1.330"), or the shell. Knowing
// which is what lets a notice say exactly which entry to switch on.

// Responsible is the program macOS holds responsible for pid in its privacy
// prompts and System Settings, and the name System Settings lists it under.
// It reads two kernel facts and raises nothing: no prompt, no dialog. Both
// are empty off macOS, for a pid that is gone, or when this macOS does not
// have the call.
func Responsible(pid int) (program, name string) {
	if pid <= 0 {
		return "", ""
	}
	program = responsibleExe(pid)
	if program == "" {
		return "", ""
	}
	if real, err := filepath.EvalSymlinks(program); err == nil {
		program = real
	}
	return program, ListedName(program)
}

// ListedName is the name System Settings shows for program: an app bundle's
// folder name without `.app` when program is the executable inside one
// (`…/Caprock Terminal.app/Contents/MacOS/caprock-pty-host` is "Caprock
// Terminal"), the file name otherwise. "" for "".
func ListedName(program string) string {
	if program == "" {
		return ""
	}
	if b := BundleOf(program); b != "" {
		return strings.TrimSuffix(filepath.Base(b), ".app")
	}
	return filepath.Base(program)
}

// BundleOf is the `.app` directory program's executable sits in
// (`X.app/Contents/MacOS/exe`), or "" when it is not in one.
func BundleOf(program string) string {
	macos := filepath.Dir(program)
	contents := filepath.Dir(macos)
	bundle := filepath.Dir(contents)
	if filepath.Base(macos) != "MacOS" || filepath.Base(contents) != "Contents" || !strings.HasSuffix(bundle, ".app") {
		return ""
	}
	return bundle
}
