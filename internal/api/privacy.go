package api

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"

	"github.com/dspv/caprock/internal/hidewin"
	"github.com/dspv/caprock/internal/ptyhost"
	"github.com/dspv/caprock/internal/tcc"
)

// A session refused a guarded folder (ADR-106).
//
// macOS refuses a program Desktop, Documents, Downloads, iCloud Drive or a
// volume until the user allows its *responsible* program, and it does not
// always ask: on 0.197.0 sessions were refused ~/Downloads with no prompt.
// When a terminal shows that refusal the page offers one line saying which
// entry in System Settings to switch on, named as System Settings lists it,
// and a button that opens the pane. These two routes are that line's: one
// names the program, the other opens the pane on the user's click. Nothing
// is read from the guarded folder, nothing is changed in the privacy
// database (no tccutil), and nothing is sent anywhere (rule 4). Owner only:
// in none of the paired-device lists (lanauth.go), since the pane opens on
// this Mac's screen.

// Privacy panes the open route accepts.
const (
	paneFullDisk = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
	paneFiles    = "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"
)

// privacyGOOS is runtime.GOOS; tests set it.
var privacyGOOS = runtime.GOOS

// sessionPIDer is the part of the agent manager that knows a held session's
// pid (agents.Manager.SessionPID).
type sessionPIDer interface {
	SessionPID(sessionID string) int
}

// openPrivacy opens a System Settings pane and, when reveal is set, shows
// that file in Finder, so it can be dragged into the list if it is not there.
// Tests replace it: they must never raise an OS window.
var openPrivacy = func(pane, reveal string) error {
	if err := hidewin.Command("/usr/bin/open", pane).Run(); err != nil {
		return err
	}
	if reveal != "" {
		_ = hidewin.Command("/usr/bin/open", "-R", reveal).Run() //nolint:gosec // a program path the kernel reported, or the helper beside the daemon
	}
	return nil
}

// privacyAnswer is what both routes answer.
type privacyAnswer struct {
	// Name is the entry System Settings lists: "Caprock Terminal", a Claude
	// Code version such as "2.1.332", "zsh", "caprock". Empty when unknown.
	Name string `json:"name"`
	// Program is the executable macOS checks; Reveal is what Finder shows
	// (the .app for a bundle). Both may be empty.
	Program string `json:"program,omitempty"`
	Reveal  string `json:"reveal,omitempty"`
	// Live is true when the name was read from the session's running
	// process, false when it is the helper beside this daemon, a guess.
	Live bool `json:"live"`
}

// sessionResponsible names who macOS asks about for session id: the
// responsible program of its running process, or, for a session this daemon
// does not hold, Caprock Terminal when the helper is installed beside it.
func (s *Server) sessionResponsible(id string) privacyAnswer {
	if p, ok := s.d.Agents.(sessionPIDer); ok {
		if pid := p.SessionPID(id); pid > 0 {
			if prog, name := tcc.Responsible(pid); name != "" {
				reveal := tcc.BundleOf(prog)
				if reveal == "" {
					reveal = prog
				}
				return privacyAnswer{Name: name, Program: prog, Reveal: reveal, Live: true}
			}
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return privacyAnswer{}
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	h := ptyhost.HelperExe(filepath.Dir(exe))
	if fi, err := os.Stat(h); err == nil && fi.Mode().IsRegular() {
		return privacyAnswer{Name: tcc.ListedName(h), Program: h, Reveal: tcc.BundleOf(h)}
	}
	return privacyAnswer{}
}

// handleSessionPrivacy answers GET /v1/sessions/{id}/privacy: the program
// macOS asks about for this session, as System Settings lists it. macOS only.
func (s *Server) handleSessionPrivacy(w http.ResponseWriter, r *http.Request) {
	if privacyGOOS != "darwin" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "privacy settings are a macOS matter"})
		return
	}
	writeJSON(w, http.StatusOK, s.sessionResponsible(r.PathValue("id")))
}

// handleSessionPrivacyOpen answers POST /v1/sessions/{id}/privacy/open
// {pane: "full_disk" | "files"}: opens that System Settings pane and shows
// the session's responsible program in Finder, on the user's click. macOS
// only.
func (s *Server) handleSessionPrivacyOpen(w http.ResponseWriter, r *http.Request) {
	if privacyGOOS != "darwin" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "privacy settings are a macOS matter"})
		return
	}
	var req struct {
		Pane string `json:"pane"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&req); err != nil && err != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `body is {pane: "full_disk" | "files"}`})
		return
	}
	pane := paneFullDisk
	switch req.Pane {
	case "", "full_disk":
	case "files":
		pane = paneFiles
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `pane is "full_disk" or "files"`})
		return
	}
	who := s.sessionResponsible(r.PathValue("id"))
	if err := openPrivacy(pane, who.Reveal); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, who)
}
