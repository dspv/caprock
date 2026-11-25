package api

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/dspv/caprock/internal/store"
)

// videoTypes is what GET /v1/events/{id}/video serves, by lowercase
// extension: the containers a WebKit or Chromium <video> plays. A .m4v is an
// MP4, so it goes as one.
var videoTypes = map[string]string{
	".mov":  "video/quicktime",
	".mp4":  "video/mp4",
	".m4v":  "video/mp4",
	".webm": "video/webm",
}

// handleEventVideo serves a video a prompt names, so the chat can show it
// as a video rather than as its path (owner, 2026-11-25, translated: "I
// pasted a video into the session and it shows as a path").
//
// A video dropped on a terminal is typed into the session as its path, the
// file staying where it was: Claude Code cannot watch it, so the path is all
// the agent gets, and the chat used to show nothing else. This hands the
// chat's <video> the bytes, and only these:
//
//   - the path is absolute and has a video extension (videoTypes);
//   - it appears, as written or with each space backslash-escaped as a shell
//     types it, in the words of the prompt `{id}`, a `turn.user` event. The
//     person put the path there themselves, so nothing is served that they
//     did not already hand to a session; any other path is 404, as is an id
//     that is no prompt;
//   - it is a regular file once symlinks are followed.
//
// http.ServeContent answers Range requests (206), which a WebKit <video>
// needs before it plays anything, and HEAD. Not on a paired device's list
// (lanauth.go): a phone keeps the path, as before.
func (s *Server) handleEventVideo(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such prompt"})
		return
	}
	p := r.URL.Query().Get("path")
	ctype, ok := videoTypes[strings.ToLower(filepath.Ext(p))]
	if !ok || !filepath.IsAbs(p) || strings.ContainsRune(p, 0) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path must be the absolute path of a .mov, .mp4, .m4v or .webm file"})
		return
	}
	text, err := store.PromptText(r.Context(), s.d.Store.DB(), id)
	if errors.Is(err, store.ErrNotPrompt) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such prompt"})
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	if !promptNames(text, p) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "that prompt does not name this file"})
		return
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such file"})
		return
	}
	f, err := os.Open(real)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such file"})
		return
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "not a regular file"})
		return
	}
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "private, no-cache")
	http.ServeContent(w, r, "", info.ModTime(), f)
}

// promptNames reports whether a prompt's words carry path, as written or
// shell-escaped (`My\ Movie.mov`).
func promptNames(text, path string) bool {
	if strings.Contains(text, path) {
		return true
	}
	return strings.Contains(path, " ") && strings.Contains(text, strings.ReplaceAll(path, " ", `\ `))
}
