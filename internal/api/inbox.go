package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/store"
)

// The Inbox (contract in 03-contracts.md § Inbox): a note, a link or a photo
// saved for later — from the phone's Save, from another app's Share on the
// phone, or on the machine — to start a chat from on the Mac. Read by every
// paired device; saved and deleted on the machine and by a controller, since
// saving is what a phone is for here. Nothing in it is typed anywhere until
// the user starts a chat from it.

// Limits on what is kept. A saved item is a thought, a link or a screenshot,
// not an archive.
const (
	inboxMax       = 500
	inboxTextBytes = 16 << 10
	inboxFilesMax  = 4
)

// inboxPreview is what GET …/files/{n} serves: images, for a thumbnail. A
// saved HTML or SVG file served from this origin would run as this page, so
// anything else is the session's to read by path, never the browser's.
var inboxPreview = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
}

// inboxBody is POST /v1/inbox.
type inboxBody struct {
	Text      string `json:"text"`
	ProjectID int64  `json:"project_id"`
	Files     []struct {
		Name string `json:"name"`
		Type string `json:"type"`
		Data string `json:"data"`
	} `json:"files"`
}

func (s *Server) handleInbox(w http.ResponseWriter, r *http.Request) {
	list, err := store.ListInbox(r.Context(), s.d.Store.DB())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list, "max": inboxMax})
}

func (s *Server) handleAddInbox(w http.ResponseWriter, r *http.Request) {
	bad := func(code int, msg string) { writeJSON(w, code, map[string]string{"error": msg}) }
	var b inboxBody
	// Each file is capped at 10 MB, about 13.4 MB as base64 (paste.go).
	if err := json.NewDecoder(io.LimitReader(r.Body, inboxFilesMax*(14<<20)+(64<<10))).Decode(&b); err != nil {
		bad(http.StatusBadRequest, "body is {text, project_id?, files?: [{name, type, data}]}")
		return
	}
	b.Text = strings.TrimSpace(b.Text)
	switch {
	case b.Text == "" && len(b.Files) == 0:
		bad(http.StatusBadRequest, "there is nothing to save")
		return
	case strings.ContainsRune(b.Text, 0) || !utf8.ValidString(b.Text):
		bad(http.StatusBadRequest, "the text holds a character that cannot be typed")
		return
	case len(b.Text) > inboxTextBytes:
		bad(http.StatusBadRequest, fmt.Sprintf("the text is longer than %d KiB", inboxTextBytes>>10))
		return
	case len(b.Files) > inboxFilesMax:
		bad(http.StatusBadRequest, fmt.Sprintf("at most %d files with one item", inboxFilesMax))
		return
	case b.ProjectID < 0:
		bad(http.StatusBadRequest, "project_id is a project's id, or 0 for the Inbox")
		return
	}
	if len(b.Files) > 0 && s.d.DataDir == "" {
		bad(http.StatusNotImplemented, "this daemon has no data directory to keep files in")
		return
	}
	ctx := r.Context()
	if b.ProjectID > 0 {
		if _, err := store.GetProject(ctx, s.d.Store.DB(), b.ProjectID); err != nil {
			if errors.Is(err, store.ErrProjectNotFound) {
				bad(http.StatusBadRequest, "no such project")
			} else {
				s.fail(w, err)
			}
			return
		}
	}
	n, err := store.CountInbox(ctx, s.d.Store.DB())
	if err != nil {
		s.fail(w, err)
		return
	}
	if n >= inboxMax {
		bad(http.StatusConflict, fmt.Sprintf("%d saved items is the most Caprock keeps; delete some first", inboxMax))
		return
	}
	item := store.InboxItem{Text: b.Text, ProjectID: b.ProjectID, Files: []string{}}
	if dev := deviceFrom(r); dev != nil {
		item.FromDevice = dev.Name
	}
	for _, f := range b.Files {
		path, uerr := writeUpload(config.InboxDir(s.d.DataDir), s.d.Now(), f.Name, f.Type, f.Data)
		if uerr != nil {
			s.removeInboxFiles(item.Files)
			writeJSON(w, uerr.code, map[string]string{"error": uerr.msg, "detail": uerr.detail})
			return
		}
		item.Files = append(item.Files, path)
	}
	out, err := store.InsertInboxItem(ctx, s.d.Store.DB(), item, s.d.Now().UnixMilli())
	if err != nil {
		s.removeInboxFiles(item.Files)
		s.fail(w, err)
		return
	}
	s.publishInbox(out.ID, false)
	writeJSON(w, http.StatusOK, map[string]any{"item": out})
}

// inboxID reads {id}; ok is false once it has answered.
func inboxID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": store.ErrInboxNotFound.Error()})
		return 0, false
	}
	return id, true
}

func (s *Server) handleDeleteInbox(w http.ResponseWriter, r *http.Request) {
	id, ok := inboxID(w, r)
	if !ok {
		return
	}
	item, err := store.GetInboxItem(r.Context(), s.d.Store.DB(), id)
	if err == nil {
		err = store.DeleteInboxItem(r.Context(), s.d.Store.DB(), id)
	}
	if err != nil {
		s.inboxErr(w, err)
		return
	}
	s.removeInboxFiles(item.Files)
	s.publishInbox(id, true)
	w.WriteHeader(http.StatusNoContent)
}

// handleInboxFile serves an item's image for its thumbnail; anything else is
// 404, as is a path that is not one of the Inbox's own directories.
func (s *Server) handleInboxFile(w http.ResponseWriter, r *http.Request) {
	id, ok := inboxID(w, r)
	if !ok {
		return
	}
	item, err := store.GetInboxItem(r.Context(), s.d.Store.DB(), id)
	if err != nil {
		s.inboxErr(w, err)
		return
	}
	n, err := strconv.Atoi(r.PathValue("n"))
	if err != nil || n < 0 || n >= len(item.Files) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such file"})
		return
	}
	path := item.Files[n]
	ctype, image := inboxPreview[strings.ToLower(filepath.Ext(path))]
	if !image || !s.ownInboxFile(path) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no preview for this file"})
		return
	}
	f, err := os.Open(path)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "the file is gone"})
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "the file is gone"})
		return
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// A saved file never changes under its path.
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeContent(w, r, "", info.ModTime(), f)
}

// ownInboxFile reports whether path is a file directly inside one of the
// Inbox's own directories, <data_dir>/inbox/<dir>/<name>: the only files an
// item may name, read or delete.
func (s *Server) ownInboxFile(path string) bool {
	if s.d.DataDir == "" || !filepath.IsAbs(path) {
		return false
	}
	root := filepath.Clean(config.InboxDir(s.d.DataDir))
	dir := filepath.Dir(filepath.Clean(path))
	return filepath.Dir(dir) == root && dir != root
}

// removeInboxFiles deletes the directory each file was written into.
func (s *Server) removeInboxFiles(files []string) {
	for _, p := range files {
		if s.ownInboxFile(p) {
			_ = os.RemoveAll(filepath.Dir(filepath.Clean(p)))
		}
	}
}

func (s *Server) publishInbox(id int64, deleted bool) {
	if s.d.Bus != nil {
		s.d.Bus.Publish(bus.Frame{Type: bus.FrameInbox, Data: map[string]any{"id": id, "deleted": deleted}})
	}
}

func (s *Server) inboxErr(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrInboxNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	s.fail(w, err)
}
