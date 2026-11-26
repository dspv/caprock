package ptyhost

import (
	"os"
	"path/filepath"
	"runtime"

	"github.com/dspv/caprock/internal/disclaim"
)

// The Caprock Terminal helper (ADR-101), macOS only.
//
// A holder started disclaimed by the daemon answers for itself to macOS's
// privacy prompts, and everything it starts — the shell, claude, a recorder
// — is attributed to it. Running from a signed bundle of its own, with a
// microphone usage string and the audio-input entitlement, it is "Caprock
// Terminal" in the prompt and in System Settings, and a Developer ID
// signature keeps the answer across Caprock's updates and the agents'.
// Without the helper (a Homebrew install, a development build) nothing
// changes: the daemon starts caprock-pty-host plainly and the holder
// disclaims its child, so each program answers for itself (ADR-044).

// HelperBundle is the macOS helper app the desktop app ships the holder in
// and installs beside its daemon: Caprock.app/Contents/Helpers/ in the
// bundle, <data_dir>/bin/ once installed, and holders run from the daemon's
// copy of it (StageHelper). HelperID is its CFBundleIdentifier.
const (
	HelperBundle = "Caprock Terminal.app"
	HelperID     = "dev.caprock.terminal"
)

// HelperExe is where the helper's executable sits when the helper bundle is
// in dir: the holder-only binary, under its own name.
func HelperExe(dir string) string {
	return filepath.Join(dir, HelperBundle, "Contents", "MacOS", BinaryName())
}

// IsHelper reports whether exe is the Caprock Terminal helper's executable,
// by its place in the bundle. Always false off macOS.
func IsHelper(exe string) bool {
	if runtime.GOOS != "darwin" || exe == "" {
		return false
	}
	exe = filepath.Clean(exe)
	bundleDir := filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(exe))))
	return exe == HelperExe(bundleDir)
}

// holderCommand is the command that starts a holder from exe with args: the
// helper through the disclaim trampoline, so it becomes its own responsible
// process, and any other holder as it is. Where the trampoline is not set up
// (disclaim.Enable never called) or this macOS lacks the attribute, the
// helper starts plainly and its children are attributed as before.
func holderCommand(exe string, args []string) (string, []string) {
	if !IsHelper(exe) {
		return exe, args
	}
	return disclaim.Wrap(exe, args)
}

// EnableDisclaim is what a holder binary calls in place of disclaim.Enable:
// its child is started disclaimed, answering for itself, unless this holder
// is the helper and already answers for itself — then the child stays the
// helper's, and so does every prompt from that terminal. A helper that was
// not started disclaimed (an older daemon, a macOS without the attribute)
// disclaims its child as any holder does.
func EnableDisclaim() {
	if answersForItself() {
		return
	}
	disclaim.Enable()
}

func answersForItself() bool {
	exe, err := os.Executable()
	if err != nil || !IsHelper(exe) {
		return false
	}
	return disclaim.ResponsibleFor(os.Getpid()) == os.Getpid()
}
