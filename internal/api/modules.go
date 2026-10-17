package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/dspv/caprock/internal/modules"
	"github.com/dspv/caprock/internal/store"
)

// --- Private modules (ADR-076) ---
//
// A module is a folder of static files installed on this machine under a
// signed admin key that names it. The slot gives it four things: a key check
// (GET/PUT/DELETE /v1/admin), its pages at /x/<id>/, a small JSON document
// store at /v1/x/<id>/docs/..., and the app's theme, passed by the screen
// that hosts it. Without a valid key nothing here answers anything but
// {admin:false}, 404 or 403, and the dashboard draws nothing for it.
//
// Every module route is the machine's alone. The pages are outside /v1, which
// the pairing gate serves to anyone as the dashboard's own files, so each
// handler checks isLocal itself rather than leaning on the gate.

// moduleDocMaxBytes caps one document: a module keeps records, not files.
const moduleDocMaxBytes = 1 << 20

var moduleNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

func (s *Server) routeModules(m *http.ServeMux) {
	m.HandleFunc("GET /v1/admin", s.handleAdmin)
	m.HandleFunc("PUT /v1/admin", s.handleSetAdmin)
	m.HandleFunc("DELETE /v1/admin", s.handleClearAdmin)
	m.HandleFunc("GET /v1/x/{id}/docs/{collection}", s.handleModuleDocList)
	m.HandleFunc("GET /v1/x/{id}/docs/{collection}/{doc}", s.handleModuleDocGet)
	m.HandleFunc("PUT /v1/x/{id}/docs/{collection}/{doc}", s.handleModuleDocSet)
	m.HandleFunc("PATCH /v1/x/{id}/docs/{collection}/{doc}", s.handleModuleDocUpdate)
	m.HandleFunc("DELETE /v1/x/{id}/docs/{collection}/{doc}", s.handleModuleDocDelete)
	m.HandleFunc("GET /x/{id}", s.handleModulePage)
	m.HandleFunc("GET /x/{id}/{path...}", s.handleModulePage)
}

// adminGrant is what the stored admin key allows, for a request from this
// machine. Anything else — no key, a key that does not verify, a paired
// device — is no grant at all.
func (s *Server) adminGrant(r *http.Request) (modules.Grant, bool) {
	if s.d.Admin == nil || !isLocal(r) {
		return modules.Grant{}, false
	}
	g, err := s.verifyAdmin(s.d.Admin.AdminKey())
	return g, err == nil
}

func (s *Server) verifyAdmin(key string) (modules.Grant, error) {
	if s.d.AdminVerify != nil {
		return s.d.AdminVerify(key)
	}
	return modules.ParseKey(key)
}

// ModuleInfo is one installed module the key names: what a sidebar row needs.
type ModuleInfo struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
	URL     string `json:"url"`
}

// AdminState is GET /v1/admin.
type AdminState struct {
	Admin bool `json:"admin"`
	// KeyError says why a stored key does not verify. Present only when one
	// was stored, so it says nothing to anyone who never pasted one.
	KeyError  string       `json:"key_error,omitempty"`
	Subject   string       `json:"subject,omitempty"`
	Modules   []string     `json:"modules,omitempty"`
	Installed []ModuleInfo `json:"installed,omitempty"`
}

func (s *Server) adminState(r *http.Request) AdminState {
	if s.d.Admin == nil || !isLocal(r) {
		return AdminState{}
	}
	key := s.d.Admin.AdminKey()
	if key == "" {
		return AdminState{}
	}
	g, err := s.verifyAdmin(key)
	if err != nil {
		return AdminState{KeyError: err.Error()}
	}
	st := AdminState{Admin: true, Subject: g.Subject, Modules: g.Modules, Installed: []ModuleInfo{}}
	if s.d.DataDir != "" {
		for _, m := range modules.Installed(modules.Root(s.d.DataDir)) {
			if g.Allows(m.ID) {
				st.Installed = append(st.Installed, ModuleInfo{ID: m.ID, Name: m.Name, Version: m.Version, URL: "/x/" + m.ID + "/"})
			}
		}
	}
	return st
}

func (s *Server) handleAdmin(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.adminState(r))
}

func (s *Server) handleSetAdmin(w http.ResponseWriter, r *http.Request) {
	if s.d.Admin == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("not available"))
		return
	}
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errors.New("the admin key is set on the machine Caprock runs on"))
		return
	}
	var req struct {
		Key string `json:"key"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		s.failCode(w, http.StatusBadRequest, errors.New("body must be {\"key\": \"...\"}"))
		return
	}
	key := strings.TrimSpace(req.Key)
	if key != "" {
		// Refused rather than stored: a key that does not verify would sit in
		// the config doing nothing, and the person who pasted it would not
		// know why.
		if _, err := s.verifyAdmin(key); err != nil {
			s.failCode(w, http.StatusBadRequest, fmt.Errorf("that admin key is not valid: %w", err))
			return
		}
	}
	if err := s.d.Admin.SetAdminKey(key); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.adminState(r))
}

func (s *Server) handleClearAdmin(w http.ResponseWriter, r *http.Request) {
	if s.d.Admin == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("not available"))
		return
	}
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errors.New("the admin key is set on the machine Caprock runs on"))
		return
	}
	if err := s.d.Admin.SetAdminKey(""); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, AdminState{})
}

// handleModulePage serves an installed, keyed module's files. Anything else is
// the same plain 404 a path that never existed gets.
func (s *Server) handleModulePage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	g, ok := s.adminGrant(r)
	if !ok || !g.Allows(id) || s.d.DataDir == "" {
		http.NotFound(w, r)
		return
	}
	_, dir, ok := modules.Find(modules.Root(s.d.DataDir), id)
	if !ok {
		http.NotFound(w, r)
		return
	}
	// /x/<id> becomes /x/<id>/, so the page's relative links resolve inside it.
	if !strings.HasPrefix(r.URL.Path, "/x/"+id+"/") {
		http.Redirect(w, r, "/x/"+id+"/", http.StatusMovedPermanently)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.PathValue("path")), "/")
	if name == "" {
		name = "."
	}
	if !fs.ValidPath(name) {
		http.NotFound(w, r)
		return
	}
	// os.Root keeps every open inside the module's folder, links included.
	root, err := os.OpenRoot(dir)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer root.Close()
	fsys := root.FS()
	if st, err := fs.Stat(fsys, name); err != nil {
		http.NotFound(w, r)
		return
	} else if st.IsDir() {
		// A folder is its index page or nothing: no listings.
		name = path.Join(name, modules.Entry)
		if st, err := fs.Stat(fsys, name); err != nil || st.IsDir() {
			http.NotFound(w, r)
			return
		}
	}
	f, err := fsys.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	rs, ok := f.(io.ReadSeeker)
	if !ok {
		http.NotFound(w, r)
		return
	}
	http.ServeContent(w, r, path.Base(name), st.ModTime(), rs)
}

// moduleDocKey checks the key and names in a document request, answering the
// refusal itself.
func (s *Server) moduleDocKey(w http.ResponseWriter, r *http.Request, withDoc bool) (id, coll, doc string, ok bool) {
	id, coll, doc = r.PathValue("id"), r.PathValue("collection"), r.PathValue("doc")
	g, granted := s.adminGrant(r)
	if !granted || !g.Allows(id) {
		s.failCode(w, http.StatusForbidden, errors.New("refused: no admin key names this module"))
		return "", "", "", false
	}
	if !moduleNameRe.MatchString(coll) || (withDoc && !moduleNameRe.MatchString(doc)) {
		s.failCode(w, http.StatusBadRequest, errors.New("a collection or document id is 1 to 128 letters, digits, '.', '_' or '-', starting with a letter or digit"))
		return "", "", "", false
	}
	return id, coll, doc, true
}

func (s *Server) handleModuleDocList(w http.ResponseWriter, r *http.Request) {
	id, coll, _, ok := s.moduleDocKey(w, r, false)
	if !ok {
		return
	}
	limit := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 1000 {
			s.failCode(w, http.StatusBadRequest, errors.New("limit must be 1 to 1000"))
			return
		}
		limit = n
	}
	docs, err := store.ListModuleDocs(r.Context(), s.d.Store.DB(), id, coll, r.URL.Query().Get("after"), limit)
	if err != nil {
		s.fail(w, err)
		return
	}
	out := map[string]any{"docs": docs}
	if len(docs) == limit {
		out["next"] = docs[len(docs)-1].ID
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleModuleDocGet(w http.ResponseWriter, r *http.Request) {
	id, coll, doc, ok := s.moduleDocKey(w, r, true)
	if !ok {
		return
	}
	d, err := store.GetModuleDoc(r.Context(), s.d.Store.DB(), id, coll, doc)
	if errors.Is(err, store.ErrModuleDocNotFound) {
		s.failCode(w, http.StatusNotFound, err)
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// readModuleDoc reads a request body that must be one JSON object.
func (s *Server) readModuleDoc(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, bool) {
	var fields map[string]json.RawMessage
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, moduleDocMaxBytes))
	if err != nil {
		s.failCode(w, http.StatusRequestEntityTooLarge, fmt.Errorf("a document is at most %d KB", moduleDocMaxBytes>>10))
		return nil, false
	}
	if err := json.Unmarshal(b, &fields); err != nil || fields == nil {
		s.failCode(w, http.StatusBadRequest, errors.New("the body must be a JSON object"))
		return nil, false
	}
	return fields, true
}

func (s *Server) handleModuleDocSet(w http.ResponseWriter, r *http.Request) {
	id, coll, doc, ok := s.moduleDocKey(w, r, true)
	if !ok {
		return
	}
	fields, ok := s.readModuleDoc(w, r)
	if !ok {
		return
	}
	b, err := json.Marshal(fields)
	if err != nil {
		s.fail(w, err)
		return
	}
	d, err := store.SetModuleDoc(r.Context(), s.d.Store.DB(), id, coll, doc, b, s.d.Now().UnixMilli())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (s *Server) handleModuleDocUpdate(w http.ResponseWriter, r *http.Request) {
	id, coll, doc, ok := s.moduleDocKey(w, r, true)
	if !ok {
		return
	}
	patch, ok := s.readModuleDoc(w, r)
	if !ok {
		return
	}
	var d store.ModuleDoc
	err := s.d.Store.WithTx(r.Context(), func(q store.Querier) error {
		var err error
		d, err = store.UpdateModuleDoc(r.Context(), q, id, coll, doc, patch, s.d.Now().UnixMilli())
		return err
	})
	if errors.Is(err, store.ErrModuleDocNotFound) {
		s.failCode(w, http.StatusNotFound, err)
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (s *Server) handleModuleDocDelete(w http.ResponseWriter, r *http.Request) {
	id, coll, doc, ok := s.moduleDocKey(w, r, true)
	if !ok {
		return
	}
	found, err := store.DeleteModuleDoc(r.Context(), s.d.Store.DB(), id, coll, doc)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": found})
}
