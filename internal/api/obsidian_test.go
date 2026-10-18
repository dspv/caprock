package api

import (
	"context"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/obsidian"
	"github.com/dspv/caprock/internal/store"
)

func TestObsidianVaultLifecycleAndAgentConsent(t *testing.T) {
	e := newEnv(t)
	e.api.d.Obsidian = &obsidian.Service{Store: e.st}
	if code, _ := brainDo(t, e, "POST", "/v1/brain/nodes", map[string]string{"kind": "note", "title": "Not an imported source"}); code != 400 {
		t.Fatalf("manual note kind: %d", code)
	}
	dir := t.TempDir()
	note := filepath.Join(dir, "Journal.md")
	original := "A private observation. #personal-topic"
	if err := os.WriteFile(note, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	code, out := brainDo(t, e, "POST", "/v1/brain/vaults", map[string]any{"path": dir})
	if code != 201 {
		t.Fatalf("import: %d %v", code, out)
	}
	v := out["vault"].(map[string]any)
	if v["agents"] != false || v["notes"].(float64) != 1 {
		t.Fatalf("default consent: %v", v)
	}
	id := int64(v["id"].(float64))
	var g store.BrainGraph
	if code := e.get(t, "/v1/brain?summaries=1", &g); code != 200 || g.Total != 1 || g.Nodes[0].Vault == "" {
		t.Fatalf("local graph: %d %+v", code, g)
	}
	nodeID := g.Nodes[0].ID
	if code, _ := brainDo(t, e, "DELETE", fmt.Sprintf("/v1/brain/nodes/%d", nodeID), nil); code != 400 {
		t.Fatalf("individual imported note delete: %d", code)
	}

	var detail struct {
		Node    store.BrainNode             `json:"node"`
		Sources []store.BrainNoteSourceView `json:"sources"`
	}
	if code := e.get(t, fmt.Sprintf("/v1/brain/nodes/%d", nodeID), &detail); code != 200 || len(detail.Sources) != 1 || detail.Sources[0].Path != "Journal.md" {
		t.Fatalf("sources: %d %+v", code, detail)
	}
	assertHidden := func() {
		t.Helper()
		if code := e.get(t, "/v1/brain?agents=1&q=private", &g); code != 200 || g.Total != 0 || len(g.Nodes) != 0 {
			t.Fatalf("private search leaked: %d %+v", code, g)
		}
		if code, _ := brainDo(t, e, "GET", fmt.Sprintf("/v1/brain/nodes/%d?agents=1", nodeID), nil); code != 404 {
			t.Fatalf("private id: %d", code)
		}
		var st BrainStatus
		if code := e.get(t, "/v1/brain/status?agents=1", &st); code != 200 || len(st.Projects) != 0 || st.Notes != 0 {
			t.Fatalf("private stats: %d %+v", code, st)
		}
	}
	assertHidden()
	base := fmt.Sprintf("/v1/brain/vaults/%d", id)
	if code, out := brainDo(t, e, "PATCH", base, map[string]bool{"agents": true}); code != 200 {
		t.Fatalf("consent: %d %v", code, out)
	}
	if code := e.get(t, "/v1/brain?agents=1", &g); code != 200 || g.Total != 1 {
		t.Fatalf("allowed graph: %d %+v", code, g)
	}
	if code, _ := brainDo(t, e, "PATCH", fmt.Sprintf("/v1/brain/nodes/%d", nodeID), map[string]string{"kind": "idea"}); code != 400 {
		t.Fatalf("note converted past consent: %d", code)
	}
	if code, _ := brainDo(t, e, "PATCH", base, map[string]bool{"agents": false}); code != 200 {
		t.Fatal(code)
	}
	assertHidden()
	if code, _ := brainDo(t, e, "POST", "/v1/brain/vaults", map[string]string{"path": dir}); code != 409 {
		t.Fatalf("duplicate: %d", code)
	}
	if err := os.WriteFile(note, []byte("Changed words. [[New note]]"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "New note.md"), []byte("Another note."), 0600); err != nil {
		t.Fatal(err)
	}
	if code, out := brainDo(t, e, "POST", base+"/refresh", map[string]any{}); code != 200 || out["vault"].(map[string]any)["notes"].(float64) != 2 {
		t.Fatalf("refresh: %d %v", code, out)
	}
	if code, _ := brainDo(t, e, "DELETE", base, nil); code != 200 {
		t.Fatalf("remove: %d", code)
	}
	if data, err := os.ReadFile(note); err != nil || string(data) != "Changed words. [[New note]]" {
		t.Fatalf("source was modified: %q %v", data, err)
	}
	if code := e.get(t, "/v1/brain", &g); code != 200 || len(g.Nodes) != 0 {
		t.Fatalf("after removal: %d %+v", code, g)
	}
	if code, _ := brainDo(t, e, "DELETE", base, nil); code != 404 {
		t.Fatalf("unknown vault: %d", code)
	}
	if code, _ := brainDo(t, e, "POST", "/v1/brain/vaults", map[string]string{"path": "relative"}); code != 400 {
		t.Fatalf("relative folder: %d", code)
	}
}

func TestObsidianAgentViewHidesMergedPrivateSourcesAndLinks(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	mem, _, err := store.InsertBrainNode(ctx, e.st.DB(), store.BrainNode{Kind: store.BrainDecision, Title: "Public decision", Summary: "Already known"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	other, _, err := store.InsertBrainNode(ctx, e.st.DB(), store.BrainNode{Kind: store.BrainIdea, Title: "An unrelated idea"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.LinkBrain(ctx, e.st.DB(), other.ID, mem.ID, store.EdgeRelates, 1, 1); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Public decision.md"), []byte("Privateadditionaltext #private-tag"), 0600); err != nil {
		t.Fatal(err)
	}
	svc := &obsidian.Service{Store: e.st}
	v, _, err := svc.Add(ctx, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"Privateadditionaltext", "Public+decision", "private-tag"} {
		var g store.BrainGraph
		if code := e.get(t, "/v1/brain?agents=1&q="+query, &g); code != 200 || g.Total != 0 {
			t.Fatalf("private mixed source matched %s: %d %+v", query, code, g)
		}
	}
	code, out := brainDo(t, e, "GET", fmt.Sprintf("/v1/brain/nodes/%d?agents=1", other.ID), nil)
	if code != 200 || len(out["links"].([]any)) != 0 {
		t.Fatalf("private neighbour: %d %v", code, out)
	}
	if _, err := svc.SetAgents(ctx, v.ID, true); err != nil {
		t.Fatal(err)
	}
	var g store.BrainGraph
	if code := e.get(t, "/v1/brain?agents=1&q=Privateadditionaltext", &g); code != 200 || g.Total != 1 {
		t.Fatalf("allowed mixed source: %d %+v", code, g)
	}
	// The original memory is intact; removing an import never deletes it.
	if err := svc.Remove(ctx, v.ID); err != nil {
		t.Fatal(err)
	}
	got, err := store.GetBrainNode(ctx, e.st.DB(), mem.ID)
	if err != nil || !strings.Contains(got.Summary, "Already known") {
		t.Fatalf("original memory: %+v %v", got, err)
	}
}

func TestVaultConfigurationIsMachineOnly(t *testing.T) {
	for _, role := range []string{"viewer", "controller"} {
		t.Run(role, func(t *testing.T) {
			e := newPairEnv(t)
			code, _ := e.codeAs(t, `{"role":"`+role+`"}`)
			dev := e.redeem(t, code)
			for _, req := range [][2]string{{"GET", "/v1/brain/vaults"}, {"POST", "/v1/brain/vaults"}, {"PATCH", "/v1/brain/vaults/1"}, {"POST", "/v1/brain/vaults/1/refresh"}, {"DELETE", "/v1/brain/vaults/1"}} {
				if w := e.asDevice(req[0], req[1], dev.Token); w.Code != 403 {
					t.Fatalf("%s %s: %d", req[0], req[1], w.Code)
				}
			}
		})
	}
}

func TestVaultBodiesAreSingleBoundedObjects(t *testing.T) {
	for _, suffix := range []string{" {}", strings.Repeat(" ", 9<<10)} {
		e := newEnv(t)
		e.api.d.Obsidian = &obsidian.Service{Store: e.st}
		body := fmt.Sprintf(`{"path":%q}`, t.TempDir()) + suffix
		req := httptest.NewRequest("POST", "/v1/brain/vaults", strings.NewReader(body))
		req.Host = "127.0.0.1"
		req.RemoteAddr = "127.0.0.1:1234"
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		w := httptest.NewRecorder()
		e.api.ServeHTTP(w, req)
		if w.Code != 400 {
			t.Fatalf("invalid body accepted: %d %s", w.Code, w.Body.String())
		}
		vaults, err := store.ListBrainVaults(context.Background(), e.st.DB())
		if err != nil || len(vaults) != 0 {
			t.Fatalf("invalid body changed the vaults: %v %v", vaults, err)
		}
	}
}
