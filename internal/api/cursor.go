package api

import (
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/dspv/caprock/internal/modelclass"
	"github.com/dspv/caprock/internal/store"
)

// handleCursorHooks reports Caprock's entries in ~/.cursor/hooks.json, and on
// POST {"action": "install" | "uninstall"} changes them (ADR-095). Nothing
// is installed without that click.
func (s *Server) handleCursorHooks(w http.ResponseWriter, r *http.Request) {
	if s.d.CursorHooks == nil {
		http.Error(w, "cursor hooks are not available", http.StatusNotImplemented)
		return
	}
	action := ""
	if r.Method == http.MethodPost {
		var body struct {
			Action string `json:"action"`
		}
		b, _ := io.ReadAll(io.LimitReader(r.Body, 4<<10))
		if err := json.Unmarshal(b, &body); err != nil || (body.Action != "install" && body.Action != "uninstall") {
			http.Error(w, `action must be "install" or "uninstall"`, http.StatusBadRequest)
			return
		}
		action = body.Action
	}
	st, err := s.d.CursorHooks(r.Context(), action)
	if err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// OverheadRate is a family's list rate, per million tokens, from the pricing
// table: what a request's overhead costs uncached and read from cache.
type OverheadRate struct {
	Family    string  `json:"family"`
	Model     string  `json:"model"`
	Input     float64 `json:"input"`
	CacheRead float64 `json:"cache_read"`
}

// cursorOverheadResponse is GET /v1/cursor/overhead.
type cursorOverheadResponse struct {
	Range string `json:"range"`
	*store.OverheadReport
	// Rates are the families the pricing table knows, so the page can put a
	// price on a request's overhead: list prices, labelled as such.
	Rates []OverheadRate `json:"rates"`
	// Method says in a sentence how both figures were read.
	Method string `json:"method"`
}

const overheadMethod = "Cursor: the first request Cursor measured in each chat, minus everything readable before it in that turn (prompt, replies, tool calls and results) at 4 bytes a token; a chat counts when that conversation was at most a quarter of the request. Claude Code: the first priced request of each session (input, cache read and cache write, exact), minus the prompt typed, at 4 bytes a token. Both are estimates of what the agent sent that the person did not write."

// cursorFamilyIDs maps a family (modelclass.Family of a Cursor model id) to
// the pricing table's id where the two differ. Models whose figure is
// Cursor's own are listed under cursor- (pricing.json); a name Cursor spells
// differently from the vendor maps to the vendor's row. Family drops -fast,
// so a Fast variant is valued at its base model's rate, as Composer's is.
// scripts/pricing-watch.py keeps a copy (CURSOR_FAMILY_ID), held equal by
// its tests.
var cursorFamilyIDs = map[string]string{
	"composer-2.5":    "cursor-composer-2.5",
	"grok-4.7":        "cursor-grok-4.7",
	"grok-4.7-500k":   "cursor-grok-4.7-500k",
	"grok-4.6":        "cursor-grok-4.6",
	"grok-4.5":        "cursor-grok-4.5",
	"muse-wonder":     "cursor-muse-wonder",
	"muse-wonder-1.0": "cursor-muse-wonder",
	"gemini-3.1-pro":  "gemini-3.1-pro-preview",
	"sonnet-4":        "claude-sonnet-4",
}

func cursorFamilyID(family string) string {
	if id, ok := cursorFamilyIDs[family]; ok {
		return id
	}
	return family
}

func (s *Server) handleCursorOverhead(w http.ResponseWriter, r *http.Request) {
	from, label := s.rangeFrom(r.URL.Query().Get("range"))
	rep, err := store.ContextOverhead(r.Context(), s.d.Store.DB(), from)
	if err != nil {
		s.fail(w, err)
		return
	}
	out := cursorOverheadResponse{Range: label, OverheadReport: rep, Rates: []OverheadRate{}, Method: overheadMethod}
	seen := map[string]bool{}
	if s.d.Table != nil {
		for _, rows := range [][]store.OverheadRow{rep.Cursor, rep.Claude} {
			for _, row := range rows {
				if seen[row.Family] {
					continue
				}
				seen[row.Family] = true
				if m, ok := s.d.Table.LookupAt(cursorFamilyID(row.Family), time.Now()); ok {
					out.Rates = append(out.Rates, OverheadRate{Family: row.Family, Model: m.ID, Input: m.Input, CacheRead: m.CacheRead})
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// sessionOverheadResponse is GET /v1/sessions/{id}/overhead: the chat's own
// estimate and the median for its model family across the last 90 days, so
// one chat reads against the rest.
type sessionOverheadResponse struct {
	*store.SessionOverhead
	Family string             `json:"family,omitempty"`
	Cursor *store.OverheadRow `json:"cursor_family,omitempty"`
	Claude *store.OverheadRow `json:"claude_family,omitempty"`
	Method string             `json:"method"`
}

func (s *Server) handleSessionOverhead(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	o, err := store.SessionOverheadFor(ctx, s.d.Store.DB(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	if o == nil {
		writeJSON(w, http.StatusOK, nil)
		return
	}
	out := sessionOverheadResponse{SessionOverhead: o, Family: modelclass.Family(o.Model), Method: overheadMethod}
	if rep, err := store.ContextOverhead(ctx, s.d.Store.DB(), time.Now().Add(-90*24*time.Hour).UnixMilli()); err == nil {
		for i := range rep.Cursor {
			if rep.Cursor[i].Family == out.Family {
				out.Cursor = &rep.Cursor[i]
			}
		}
		for i := range rep.Claude {
			if rep.Claude[i].Family == out.Family {
				out.Claude = &rep.Claude[i]
			}
		}
	}
	writeJSON(w, http.StatusOK, out)
}
