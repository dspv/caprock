package mail

import (
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// Full Disk Access for Apple Mail's account list. macOS never prompts for it:
// the user ticks the program in System Settings › Privacy & Security › Full
// Disk Access, and the program is the daemon's own executable (a launchd
// agent is its own responsible process), which sits in a hidden folder. So
// the import screen's button opens that pane and shows the file in Finder,
// to be dragged into the list. Both are fixed local actions on the user's
// click; nothing is sent anywhere (rule 4).

// fullDiskAccessPane is System Settings' Full Disk Access list.
const fullDiskAccessPane = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"

// daemonProgram is the daemon's executable with symlinks resolved — the
// file macOS checks (Homebrew's bin/caprock is a link into the Cellar).
func daemonProgram() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		return real
	}
	return exe
}

// openGrant opens the pane and reveals program in Finder. Tests replace it:
// they must never raise an OS window.
var openGrant = func(program string) error {
	if err := exec.Command("/usr/bin/open", fullDiskAccessPane).Run(); err != nil {
		return err
	}
	if program != "" {
		_ = exec.Command("/usr/bin/open", "-R", program).Run() //nolint:gosec // the daemon's own executable
	}
	return nil
}

// importGrant answers POST /v1/mail/import/grant with {program}. macOS only.
func (s *Service) importGrant(w http.ResponseWriter, _ *http.Request) {
	if runtime.GOOS != "darwin" {
		fail(w, 404, errors.New("full disk access is a macOS setting"))
		return
	}
	program := daemonProgram()
	if err := openGrant(program); err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, map[string]any{"program": program})
}
