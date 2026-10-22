package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/modules"
	"github.com/dspv/caprock/internal/store"
)

// --- What waits on the owner in a private module (ADR-076, amended 2026-10-22) ---
//
// A module says how many things wait on the owner in it, and names up to
// eight, each with a route inside its own page. The sidebar's row for the
// module shows the count, small, and lists the items when unfolded; a click
// opens the module at that route. Same callers as the module's store and its
// messages (moduleOutKey): this machine or a controller, for a module the
// stored admin key names.
//
// It is kept in memory and in the module_docs table under the reserved
// collection "_attention" (document "current"), which the module's own store
// routes cannot name (moduleNameRe starts with a letter or digit), so it
// survives a restart without a migration. A report older than a day is not
// shown: a module that stopped reporting does not keep a count up forever.

const (
	moduleAttentionItemsMax = 8
	moduleAttentionLabelMax = 80
	moduleAttentionHrefMax  = 512
	moduleAttentionTTL      = 24 * time.Hour
	// moduleAttentionColl is the reserved module_docs collection; the
	// leading underscore keeps it out of reach of /v1/x/<id>/docs.
	moduleAttentionColl = "_attention"
	moduleAttentionDoc  = "current"
)

// ModuleAttentionItem is one thing waiting in a module: a short line and the
// route inside the module's page that shows it ("#review/42").
type ModuleAttentionItem struct {
	Label string `json:"label"`
	Href  string `json:"href"`
}

// ModuleAttention is what a module last said waits on the owner.
type ModuleAttention struct {
	Count     int                   `json:"count"`
	Items     []ModuleAttentionItem `json:"items"`
	UpdatedAt int64                 `json:"updated_at"`
}

func (s *Server) routeModuleAttention(m *http.ServeMux) {
	m.HandleFunc("PUT /v1/x/{id}/attention", s.handleModuleAttention)
}

// checkModuleAttention trims and checks a report, answering why it is refused.
func checkModuleAttention(a *ModuleAttention) error {
	if a.Count < 0 {
		return errors.New("count must be 0 or more")
	}
	if len(a.Items) > moduleAttentionItemsMax {
		return fmt.Errorf("at most %d items", moduleAttentionItemsMax)
	}
	for i := range a.Items {
		it := &a.Items[i]
		it.Label = strings.TrimSpace(it.Label)
		it.Href = strings.TrimSpace(it.Href)
		if it.Label == "" || utf8.RuneCountInString(it.Label) > moduleAttentionLabelMax || strings.ContainsFunc(it.Label, unicode.IsControl) {
			return fmt.Errorf("item %d: label is 1 to %d characters on one line", i+1, moduleAttentionLabelMax)
		}
		if len(it.Href) < 2 || it.Href[0] != '#' || len(it.Href) > moduleAttentionHrefMax ||
			strings.ContainsFunc(it.Href, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) {
			return fmt.Errorf("item %d: href is a route inside the module, starting with '#' (\"#review/42\"), never a URL", i+1)
		}
	}
	if a.Items == nil {
		a.Items = []ModuleAttentionItem{}
	}
	return nil
}

// handleModuleAttention is PUT /v1/x/{id}/attention {count, items?}: what
// waits on the owner in the module, replacing what it said before; count 0
// clears it. 200 with what is kept; 400 for a bad report; 403 when no admin
// key names the module; 404 when it is not installed.
func (s *Server) handleModuleAttention(w http.ResponseWriter, r *http.Request) {
	id, _, ok := s.moduleOutKey(w, r)
	if !ok {
		return
	}
	if s.d.DataDir == "" {
		s.failCode(w, http.StatusNotFound, errors.New("no such module is installed"))
		return
	}
	if _, _, found := modules.Find(modules.Root(s.d.DataDir), id); !found {
		s.failCode(w, http.StatusNotFound, errors.New("no such module is installed"))
		return
	}
	var a ModuleAttention
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&a); err != nil {
		s.failCode(w, http.StatusBadRequest, errors.New(`body must be {"count": 2, "items": [{"label": "…", "href": "#…"}]}`))
		return
	}
	if err := checkModuleAttention(&a); err != nil {
		s.failCode(w, http.StatusBadRequest, err)
		return
	}
	db := s.d.Store.DB()
	if a.Count == 0 {
		if _, err := store.DeleteModuleDoc(r.Context(), db, id, moduleAttentionColl, moduleAttentionDoc); err != nil {
			s.fail(w, err)
			return
		}
		s.keepAttention(id, nil)
		writeJSON(w, http.StatusOK, ModuleAttention{Items: []ModuleAttentionItem{}})
		return
	}
	a.UpdatedAt = s.d.Now().UnixMilli()
	b, err := json.Marshal(a)
	if err != nil {
		s.fail(w, err)
		return
	}
	if _, err := store.SetModuleDoc(r.Context(), db, id, moduleAttentionColl, moduleAttentionDoc, b, a.UpdatedAt); err != nil {
		s.fail(w, err)
		return
	}
	s.keepAttention(id, &a)
	writeJSON(w, http.StatusOK, a)
}

// keepAttention remembers a module's attention and tells the dashboards to
// read the admin state again. The frame carries nothing (bus.FrameAdmin).
func (s *Server) keepAttention(id string, a *ModuleAttention) {
	s.attnMu.Lock()
	if s.attn == nil {
		s.attn = map[string]*ModuleAttention{}
	}
	s.attn[id] = a
	s.attnMu.Unlock()
	if s.d.Bus != nil {
		s.d.Bus.Publish(bus.Frame{Type: bus.FrameAdmin, Data: struct{}{}})
	}
}

// moduleAttention is the module's attention while it is current: nil when it
// has none, or said nothing for a day. Read from the store once per module
// per daemon, then from memory.
func (s *Server) moduleAttention(r *http.Request, id string) *ModuleAttention {
	s.attnMu.Lock()
	a, known := s.attn[id]
	s.attnMu.Unlock()
	if !known {
		if s.d.Store == nil {
			return nil
		}
		if d, err := store.GetModuleDoc(r.Context(), s.d.Store.DB(), id, moduleAttentionColl, moduleAttentionDoc); err == nil {
			var got ModuleAttention
			if json.Unmarshal(d.Data, &got) == nil && got.Count > 0 {
				a = &got
			}
		} else if !errors.Is(err, store.ErrModuleDocNotFound) {
			return nil // not remembered: asked again next time
		}
		s.attnMu.Lock()
		if s.attn == nil {
			s.attn = map[string]*ModuleAttention{}
		}
		if _, raced := s.attn[id]; !raced {
			s.attn[id] = a
		} else {
			a = s.attn[id]
		}
		s.attnMu.Unlock()
	}
	if a == nil || s.d.Now().Sub(time.UnixMilli(a.UpdatedAt)) > moduleAttentionTTL {
		return nil
	}
	return a
}
