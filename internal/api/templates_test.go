package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/projects"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/templates"
)

// templatesServer is a daemon's API with two paired phones and a templates
// service whose gh does not exist: nothing here runs gh.
func templatesServer(t *testing.T) (s *Server, home, viewer, controller string) {
	t.Helper()
	home = fakeHome(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := store.Open(context.Background(), ":memory:", log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	projs := projects.New(st, bus.New(), log)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := projs.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(projs.Close)
	tpls := templates.New(&templates.Store{File: filepath.Join(home, "data", templates.StateFile), Log: log}, projs, log)
	tpls.GHBin = filepath.Join(home, "no-gh-here")
	tpls.Ctx = ctx
	s, _, v, c := pairedPhones(t, Deps{Store: st, Projects: projs, Templates: tpls})
	return s, home, v.Token, c.Token
}

// Templates are the machine's: a phone, whatever its role, gets 403 on
// every route, reading the list included.
func TestTemplatesAreTheMachines(t *testing.T) {
	s, _, viewer, controller := templatesServer(t)
	routes := [][2]string{
		{"GET", "/v1/templates"}, {"POST", "/v1/templates"}, {"POST", "/v1/templates/inspect"},
		{"PATCH", "/v1/templates/abcd1234"}, {"DELETE", "/v1/templates/abcd1234"},
		{"POST", "/v1/projects/from-template"}, {"POST", "/v1/projects/ops/x/retry"},
	}
	for _, rt := range routes {
		for _, tok := range []string{viewer, controller} {
			if w := call(t, s, testPhone, tok, rt[0], rt[1], `{}`); w.Code != http.StatusForbidden {
				t.Errorf("%s %s from a phone: %d", rt[0], rt[1], w.Code)
			}
		}
	}
}

func TestTemplatesOnTheMachine(t *testing.T) {
	s, home, _, _ := templatesServer(t)
	w := call(t, s, machine, "", "POST", "/v1/templates", `{"name":"Corpus","github":"dspv/corpus","brief_path":"docs/source-spec.md","prompt":"Read TEMPLATE.md. Build the .ai/ corpus from {brief}."}`)
	if w.Code != http.StatusOK {
		t.Fatalf("add: %d %s", w.Code, w.Body.String())
	}
	var added struct {
		Template templates.Template `json:"template"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &added); err != nil || added.Template.ID == "" {
		t.Fatalf("%s %v", w.Body.String(), err)
	}
	if w := call(t, s, machine, "", "POST", "/v1/templates", `{"name":"x","github":"dspv/corpus","brief_path":".git/x","prompt":"p"}`); w.Code != http.StatusBadRequest {
		t.Errorf("a bad brief path: %d", w.Code)
	}

	w = call(t, s, machine, "", "GET", "/v1/templates", "")
	var list struct {
		Templates []templates.Template `json:"templates"`
		GH        templates.GHStatus   `json:"gh"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil || len(list.Templates) != 1 || list.GH.Installed || list.GH.Error == "" {
		t.Fatalf("list: %s %v", w.Body.String(), err)
	}

	id := added.Template.ID
	if w := call(t, s, machine, "", "PATCH", "/v1/templates/"+id, `{"name":"Corpus (mine)"}`); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "Corpus (mine)") {
		t.Errorf("patch: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, machine, "", "PATCH", "/v1/templates/deadbeef", `{"name":"x"}`); w.Code != http.StatusNotFound {
		t.Errorf("patch unknown: %d", w.Code)
	}

	// gh is not there: the GitHub path is refused with 409, never swapped.
	body, _ := json.Marshal(map[string]any{
		"op_id": "op1", "source": map[string]string{"github": "dspv/corpus"}, "via": "github", "name": "acme",
		"parent": filepath.Join(home, "dev"), "visibility": "private", "brief": "# Acme", "brief_path": "docs/source-spec.md", "template_name": "Corpus",
	})
	if w := call(t, s, machine, "", "POST", "/v1/projects/from-template", string(body)); w.Code != http.StatusConflict {
		t.Errorf("without gh: %d %s", w.Code, w.Body.String())
	}
	// Inspecting without gh says so in error, and still answers defaults.
	w = call(t, s, machine, "", "POST", "/v1/templates/inspect", `{"github":"dspv/corpus"}`)
	var res templates.Inspection
	if err := json.Unmarshal(w.Body.Bytes(), &res); w.Code != http.StatusOK || err != nil || res.Error == "" || res.BriefPath != templates.DefaultBriefPath {
		t.Errorf("inspect: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, machine, "", "POST", "/v1/projects/ops/nope/retry", `{}`); w.Code != http.StatusNotFound {
		t.Errorf("retry unknown: %d", w.Code)
	}

	if w := call(t, s, machine, "", "DELETE", "/v1/templates/"+id, ""); w.Code != http.StatusNoContent {
		t.Errorf("delete: %d", w.Code)
	}
	if w := call(t, s, machine, "", "DELETE", "/v1/templates/"+id, ""); w.Code != http.StatusNotFound {
		t.Errorf("delete again: %d", w.Code)
	}
}

// A request over 2 MiB is refused before it is read in full.
func TestFromTemplateBodyLimit(t *testing.T) {
	s, home, _, _ := templatesServer(t)
	body, _ := json.Marshal(map[string]any{
		"source": map[string]string{"folder": home}, "via": "local", "name": "acme", "parent": home,
		"brief": strings.Repeat("a", 2<<20), "brief_path": "docs/brief.md",
	})
	if w := call(t, s, machine, "", "POST", "/v1/projects/from-template", string(body)); w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("%d %s", w.Code, w.Body.String())
	}
}
