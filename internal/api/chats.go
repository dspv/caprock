package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// Chats (ADR-071, contract in 03-contracts.md § Chats): sessions Caprock
// started in its chats workspace, listed apart from the work sessions,
// archived or deleted from that list, and the files each one wrote in its
// own folder, listed and served for the chat's viewer.

const (
	// chatListMax caps one page of the Chats list.
	chatListMax = 500
	// chatFilesMax caps the files listed for one chat.
	chatFilesMax = 500
	// chatFileMaxBytes is the largest file a chat's viewer is sent.
	chatFileMaxBytes = 50 << 20
)

// ChatList is GET /v1/chats: one page of chats, newest first, with how many
// match and how many there are, archived and not.
type ChatList struct {
	Items    []SessionSummary `json:"items"`
	Total    int              `json:"total"`
	Chats    int              `json:"chats"`
	Archived int              `json:"archived"`
}

func (s *Server) handleChats(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	qv := r.URL.Query()
	limit, _ := strconv.Atoi(qv.Get("limit"))
	if limit <= 0 {
		limit = 100
	}
	if limit > chatListMax {
		limit = chatListMax
	}
	f := store.SessionQuery{Search: qv.Get("q"), Chats: store.ChatsOnly, Archived: qv.Get("archived") == "1"}
	db := s.d.Store.DB()
	list, err := store.ListSessionsQuery(ctx, db, f, limit)
	if err != nil {
		s.fail(w, err)
		return
	}
	out := ChatList{Items: make([]SessionSummary, 0, len(list))}
	for _, sess := range list {
		sum, _, err := s.summarize(ctx, sess)
		if err != nil {
			s.fail(w, err)
			return
		}
		out.Items = append(out.Items, sum)
	}
	if out.Total, err = store.CountSessionsQuery(ctx, db, f); err != nil {
		s.fail(w, err)
		return
	}
	counts, err := store.CountChats(ctx, db)
	if err != nil {
		s.fail(w, err)
		return
	}
	out.Chats, out.Archived = counts.Chats, counts.Archived
	writeJSON(w, http.StatusOK, out)
}

// chatOf is the chat a request names, or false after answering 404 when the
// session is unknown or is not a chat.
func (s *Server) chatOf(w http.ResponseWriter, r *http.Request) (store.Session, bool) {
	sess, err := store.GetSession(r.Context(), s.d.Store.DB(), r.PathValue("id"))
	if err != nil {
		s.notFoundOrFail(w, err)
		return store.Session{}, false
	}
	if !sess.Chat {
		s.failCode(w, http.StatusNotFound, errors.New("that session is not a chat"))
		return store.Session{}, false
	}
	return sess, true
}

// handleChatArchive archives a chat, or brings it back: {archived: bool}.
// A label in Caprock's own database, as a rename is; nothing is deleted.
func (s *Server) handleChatArchive(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Archived *bool `json:"archived"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body); err != nil || body.Archived == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `body is {"archived": true|false}`})
		return
	}
	if _, ok := s.chatOf(w, r); !ok {
		return
	}
	ctx := r.Context()
	id := r.PathValue("id")
	var at int64
	if *body.Archived {
		at = s.d.Now().UnixMilli()
	}
	q := s.d.Store.DB()
	if err := store.SetChatArchived(ctx, q, id, at); err != nil {
		s.notFoundOrFail(w, err)
		return
	}
	sess, err := store.GetSession(ctx, q, id)
	if err != nil {
		s.fail(w, err)
		return
	}
	if s.d.Bus != nil {
		st, _ := store.GetStats(ctx, q, id)
		s.d.Bus.Publish(bus.Frame{Type: bus.FrameSession, Data: rollup.SessionFrame{Session: sess, Stats: st}})
	}
	writeJSON(w, http.StatusOK, map[string]any{"session_id": id, "archived_at": sess.ArchivedAt})
}

// handleChatDelete deletes a chat for good: its session is removed as
// POST /v1/sessions/remove removes one (ADR-037: its events, its turns out of
// each day's totals, a tombstone), and its folder — the files it wrote — goes
// with it, unless another session still works there. A chat Caprock is still
// running is stopped first: it is Caprock's own process (rule 7), and asking
// the user to stop it and come back is a second trip for the same intent.
func (s *Server) handleChatDelete(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.chatOf(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	id := sess.SessionID
	if s.d.Agents != nil && s.d.Agents.Holds(id) {
		_ = s.d.Agents.Signal(id, "kill")
		for deadline := time.Now().Add(4 * time.Second); s.d.Agents.Holds(id) && time.Now().Before(deadline); {
			time.Sleep(50 * time.Millisecond)
		}
	}
	db := s.d.Store.DB()
	found, err := store.FindRemovalCandidates(ctx, db, []string{id}, "")
	if err != nil || len(found) == 0 {
		s.notFoundOrFail(w, sql.ErrNoRows)
		return
	}
	c := found[0]
	// Caprock's own process is gone by now, and a row still saying active is
	// its exit not yet recorded: nothing more will be heard from it. A chat
	// some other process is live in (one carried on in a terminal) is not
	// removed under it, as ADR-037 says.
	if s.d.Agents != nil && s.d.Agents.Holds(id) {
		s.failCode(w, http.StatusConflict, errors.New("the chat did not stop — try again in a moment"))
		return
	}
	if c.Status == store.StatusActive && !c.Owned {
		s.failCode(w, http.StatusConflict, errors.New("this chat is still active somewhere else — delete it once it has ended"))
		return
	}
	var missed float64
	err = s.d.Store.WithTx(ctx, func(q store.Querier) error {
		var err error
		missed, err = store.RemoveSession(ctx, q, c, time.Local, s.d.Now().UnixMilli())
		return err
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	folder := false
	if agents.IsChatDirIn(s.d.DataDir, sess.Cwd) {
		var others int
		if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sessions WHERE cwd = ? AND session_id != ?`, sess.Cwd, id).Scan(&others); err == nil && others == 0 {
			if err := os.RemoveAll(sess.Cwd); err != nil {
				s.d.Log.Warn("chat deleted, its folder not", "component", "api", "session", id, "err", err)
			} else {
				folder = true
			}
		}
	}
	s.d.Log.Info("chat deleted", "component", "api", "session", id, "cost_usd", c.CostUSD, "unmatched_usd", missed, "folder", folder)
	s.forgetAnswers()
	writeJSON(w, http.StatusOK, map[string]any{"session_id": id, "cost_usd": c.CostUSD, "folder_removed": folder})
}

// ChatFile is one file a chat wrote in its folder.
type ChatFile struct {
	// Path is relative to the chat's folder, in slash form.
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"` // unix ms
	// Kind is how the viewer shows it: markdown, html, pdf, image, text, or
	// other (offered as a download).
	Kind string `json:"kind"`
}

// chatFileKind names how a file is shown, by its extension.
func chatFileKind(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".md", ".markdown", ".mdx":
		return "markdown"
	case ".html", ".htm":
		return "html"
	case ".pdf":
		return "pdf"
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".bmp", ".ico":
		return "image"
	case ".txt", ".csv", ".tsv", ".json", ".log", ".yaml", ".yml", ".xml", ".toml",
		".py", ".js", ".ts", ".tsx", ".go", ".sh", ".sql", ".css", ".rs", ".java", ".rb":
		return "text"
	}
	return "other"
}

// chatFileType is the Content-Type a chat's file is served under.
func chatFileType(name string) string {
	ext := strings.ToLower(path.Ext(name))
	switch ext {
	case ".md", ".markdown", ".mdx":
		return "text/markdown; charset=utf-8"
	case ".html", ".htm":
		return "text/html; charset=utf-8"
	case ".pdf":
		return "application/pdf"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".avif":
		return "image/avif"
	case ".svg":
		return "image/svg+xml"
	case ".bmp":
		return "image/bmp"
	case ".ico":
		return "image/x-icon"
	case ".csv":
		return "text/csv; charset=utf-8"
	case ".json":
		return "application/json"
	}
	if chatFileKind(name) == "text" {
		return "text/plain; charset=utf-8"
	}
	return "application/octet-stream"
}

// chatFolder is the chat's own folder, or false after answering when the
// session's folder is not one of the chats workspace's (a chat whose folder
// was moved is not served from wherever it now points).
func (s *Server) chatFolder(w http.ResponseWriter, sess store.Session) (string, bool) {
	if !agents.IsChatDirIn(s.d.DataDir, sess.Cwd) {
		s.failCode(w, http.StatusNotFound, errors.New("this chat's folder is not in Caprock's chats workspace"))
		return "", false
	}
	if fi, err := os.Stat(sess.Cwd); err != nil || !fi.IsDir() {
		s.failCode(w, http.StatusNotFound, errors.New("this chat's folder is gone"))
		return "", false
	}
	return sess.Cwd, true
}

// handleChatFiles lists the files a chat wrote in its folder, newest first.
// Dot-files and dot-folders are left out (an agent's own state), and no
// symlink is followed, so nothing outside the folder is listed.
func (s *Server) handleChatFiles(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.chatOf(w, r)
	if !ok {
		return
	}
	dir, ok := s.chatFolder(w, sess)
	if !ok {
		return
	}
	files := []ChatFile{}
	truncated := false
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil //nolint:nilerr // an unreadable entry is left out, never fails the list
		}
		if p == dir {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") || d.Name() == "node_modules" {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		if len(files) >= chatFilesMax {
			truncated = true
			return filepath.SkipAll
		}
		info, err := d.Info()
		if err != nil {
			return nil //nolint:nilerr // a file gone since the walk read it is left out
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return nil //nolint:nilerr // cannot happen under dir; skip rather than fail
		}
		rel = filepath.ToSlash(rel)
		files = append(files, ChatFile{Path: rel, Size: info.Size(), Modified: info.ModTime().UnixMilli(), Kind: chatFileKind(rel)})
		return nil
	})
	sort.SliceStable(files, func(i, j int) bool {
		if files[i].Modified != files[j].Modified {
			return files[i].Modified > files[j].Modified
		}
		return files[i].Path < files[j].Path
	})
	writeJSON(w, http.StatusOK, map[string]any{"files": files, "truncated": truncated})
}

// chatRelPath checks a path from a request: relative, clean, slash-separated,
// no `..`, no empty or dot-led segment (the list never offers one).
func chatRelPath(rel string) bool {
	if rel == "" || !fs.ValidPath(rel) || strings.ContainsRune(rel, 0) {
		return false
	}
	if runtime.GOOS == "windows" && (strings.ContainsAny(rel, `\:`)) {
		return false
	}
	for _, seg := range strings.Split(rel, "/") {
		if strings.HasPrefix(seg, ".") {
			return false
		}
	}
	return true
}

// handleChatFile sends one file of a chat's folder, as bytes under its own
// type, for the chat's viewer (?download=1 asks the browser to save it).
//
// Nothing a file holds may run with the dashboard's rights or reach the
// network (rule 4): HTML and SVG are sent under a sandboxing policy — no
// script, no same origin, nothing fetched but what is inline — and every
// file with nosniff, so a file is never read as a type it was not sent as.
// A PDF is left to the browser's own viewer, which a sandbox policy would
// block, and which runs no script of the document's.
func (s *Server) handleChatFile(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.chatOf(w, r)
	if !ok {
		return
	}
	dir, ok := s.chatFolder(w, sess)
	if !ok {
		return
	}
	rel := r.URL.Query().Get("path")
	if !chatRelPath(rel) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path must be a file of the chat's folder, relative to it"})
		return
	}
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		s.failCode(w, http.StatusNotFound, errors.New("this chat's folder is gone"))
		return
	}
	real, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		s.failCode(w, http.StatusNotFound, errors.New("no such file"))
		return
	}
	if back, err := filepath.Rel(root, real); err != nil || !filepath.IsLocal(back) {
		s.failCode(w, http.StatusForbidden, errors.New("that path leads outside the chat's folder"))
		return
	}
	fi, err := os.Stat(real)
	if err != nil {
		s.failCode(w, http.StatusNotFound, errors.New("no such file"))
		return
	}
	if !fi.Mode().IsRegular() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "not a regular file"})
		return
	}
	if fi.Size() > chatFileMaxBytes {
		s.failCode(w, http.StatusRequestEntityTooLarge, errors.New("the file is larger than 50 MB; open it on the computer"))
		return
	}
	f, err := os.Open(real) //nolint:gosec // resolved inside the chat's folder above
	if err != nil {
		s.fail(w, err)
		return
	}
	defer func() { _ = f.Close() }()
	h := w.Header()
	typ := chatFileType(rel)
	h.Set("Content-Type", typ)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Length", strconv.FormatInt(fi.Size(), 10))
	if typ != "application/pdf" {
		h.Set("Content-Security-Policy", "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline' data:; font-src data:; media-src data: blob:; sandbox")
	}
	name := path.Base(rel)
	if r.URL.Query().Get("download") == "1" || typ == "application/octet-stream" {
		h.Set("Content-Disposition", `attachment; filename="`+asciiName(name)+`"; filename*=UTF-8''`+urlPathEscape(name))
	} else {
		h.Set("Content-Disposition", `inline; filename="`+asciiName(name)+`"`)
	}
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, f)
}

// asciiName is a file name safe inside a quoted header value.
func asciiName(name string) string {
	var b strings.Builder
	for _, r := range name {
		if r < 0x20 || r > 0x7e || r == '"' || r == '\\' {
			b.WriteByte('_')
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// urlPathEscape percent-encodes a name for filename*=UTF-8”.
func urlPathEscape(name string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(name); i++ {
		c := name[i]
		if ('a' <= c && c <= 'z') || ('A' <= c && c <= 'Z') || ('0' <= c && c <= '9') || strings.IndexByte("-._~", c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&15])
	}
	return b.String()
}
