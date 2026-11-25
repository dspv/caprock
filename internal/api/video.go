package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/dspv/caprock/internal/hidewin"
	"github.com/dspv/caprock/internal/store"
)

// videoTypes is what GET /v1/events/{id}/video serves, by lowercase
// extension: the containers a WebKit or Chromium <video> reads. A .m4v is an
// MP4, so it goes as one.
var videoTypes = map[string]string{
	".mov":  "video/quicktime",
	".mp4":  "video/mp4",
	".m4v":  "video/mp4",
	".webm": "video/webm",
}

// A video a prompt names, for the chat's tile (owner, 2026-11-25,
// translated: "I pasted a video into the session and it shows as a path").
//
// A video dropped on a terminal is typed into the session as its path, the
// file staying where it was: Claude Code cannot watch it, so the path is all
// the agent gets, and the chat used to show nothing else. The tile shows the
// first frame, the name and the length, read through GET, and a click opens
// the file in the system's own player through POST …/open. Both take a path
// only when:
//
//   - it is absolute and has a video extension (videoTypes);
//   - it appears, as written or with each space backslash-escaped as a shell
//     types it, in the words of the prompt `{id}`, a `turn.user` event. The
//     person put the path there themselves, so nothing is served or opened
//     that they did not already hand to a session; any other path is 404, as
//     is an id that is no prompt;
//   - it is a regular file once symlinks are followed.
//
// Neither is on a paired device's list (lanauth.go): a phone keeps the path.

// promptVideo checks a request's path against the rules above and answers
// the refusal itself; ok is false when it did.
func (s *Server) promptVideo(w http.ResponseWriter, r *http.Request, p string) (real, ctype string, ok bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such prompt"})
		return "", "", false
	}
	ctype, known := videoTypes[strings.ToLower(filepath.Ext(p))]
	if !known || !filepath.IsAbs(p) || strings.ContainsRune(p, 0) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path must be the absolute path of a .mov, .mp4, .m4v or .webm file"})
		return "", "", false
	}
	text, err := store.PromptText(r.Context(), s.d.Store.DB(), id)
	if errors.Is(err, store.ErrNotPrompt) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such prompt"})
		return "", "", false
	}
	if err != nil {
		s.fail(w, err)
		return "", "", false
	}
	if !promptNames(text, p) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "that prompt does not name this file"})
		return "", "", false
	}
	real, err = filepath.EvalSymlinks(p)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such file"})
		return "", "", false
	}
	info, err := os.Stat(real)
	if err != nil || !info.Mode().IsRegular() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "not a regular file"})
		return "", "", false
	}
	return real, ctype, true
}

// handleEventVideo serves the file, for the tile's first frame and length.
// http.ServeContent answers Range requests (206), which a WebKit <video>
// asks with before it reads anything, and HEAD.
func (s *Server) handleEventVideo(w http.ResponseWriter, r *http.Request) {
	real, ctype, ok := s.promptVideo(w, r, r.URL.Query().Get("path"))
	if !ok {
		return
	}
	f, err := os.Open(real)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such file"})
		return
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such file"})
		return
	}
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "private, no-cache")
	if rng, ok := capRange(r.Header.Get("Range"), videoChunk); ok {
		r.Header.Set("Range", rng)
	}
	http.ServeContent(w, r, "", info.ModTime(), f)
}

// videoChunk is the most one range answer carries. The tile wants the
// first frame and the length, yet WebKit asks for the whole file at once
// (`bytes=0-<last>`, measured on a 34 MB recording, 2026-11-25) and reads
// all of it. Answered a megabyte at a time — a 206 whose Content-Range says
// what was sent, which a media element follows with the next range it
// needs — it stops once it has the frame.
const videoChunk = 1 << 20

// capRange shortens one `bytes=a-` or `bytes=a-b` range to at most n bytes
// from a; anything else (no range, several, a suffix `bytes=-n`) is left to
// ServeContent as it is.
func capRange(h string, n int64) (string, bool) {
	spec, ok := strings.CutPrefix(h, "bytes=")
	if !ok || strings.Contains(spec, ",") {
		return "", false
	}
	a, b, ok := strings.Cut(strings.TrimSpace(spec), "-")
	if !ok || a == "" {
		return "", false
	}
	start, err := strconv.ParseInt(a, 10, 64)
	if err != nil || start < 0 {
		return "", false
	}
	if b != "" {
		end, err := strconv.ParseInt(b, 10, 64)
		if err != nil || end-start+1 <= n {
			return "", false
		}
	}
	return "bytes=" + strconv.FormatInt(start, 10) + "-" + strconv.FormatInt(start+n-1, 10), true
}

// openWithSystem hands a file to the operating system's default app for its
// type: `open` on macOS, the URL protocol handler on Windows (what
// `caprock up` opens the dashboard with), `xdg-open` elsewhere. It returns
// once the opener has started, not when the player has. A variable so tests
// never start a player.
var openWithSystem = func(path string) error {
	var c *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		c = hidewin.Command("open", path)
	case "windows":
		c = hidewin.Command("rundll32", "url.dll,FileProtocolHandler", path)
	default:
		c = hidewin.Command("xdg-open", path)
	}
	if err := c.Start(); err != nil {
		return err
	}
	go func() { _ = c.Wait() }()
	return nil
}

// handleOpenEventVideo opens the file in the system's own player: the
// tile's click. Body `{path}`. On this machine only, like opening an editor.
func (s *Server) handleOpenEventVideo(w http.ResponseWriter, r *http.Request) {
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errors.New("a video opens on the machine Caprock runs on"))
		return
	}
	var body struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request: want {path}"})
		return
	}
	real, _, ok := s.promptVideo(w, r, body.Path)
	if !ok {
		return
	}
	if err := openWithSystem(real); err != nil {
		s.failCode(w, http.StatusBadGateway, errors.New("no app opened the video: "+err.Error()))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// promptNames reports whether a prompt's words carry path, as written or
// shell-escaped (`My\ Movie.mov`).
func promptNames(text, path string) bool {
	if strings.Contains(text, path) {
		return true
	}
	return strings.Contains(path, " ") && strings.Contains(text, strings.ReplaceAll(path, " ", `\ `))
}
