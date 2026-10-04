package api

import (
	"errors"
	"net/http"
)

// handleInstallHooks is POST /v1/hooks/install: the dashboard's "Install
// hooks" button. It runs the same code as `caprock hooks install` (put the shim
// in the data dir, merge Caprock's entries into the settings file, backed up
// first) and answers with what is registered afterwards, so the banner can say
// "installed" from the file rather than from hope.
//
// Loopback only in effect: a paired device may make only the reads listed in
// pairedDeviceRoutes, and the CSRF guard refuses a cross-site POST, so this
// cannot be triggered from a tablet or from a web page. Contract:
// .ai/03-contracts.md.
func (s *Server) handleInstallHooks(w http.ResponseWriter, r *http.Request) {
	if s.d.InstallHooks == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("this daemon cannot install hooks"))
		return
	}
	v, err := s.d.InstallHooks(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}
