package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/dspv/caprock/internal/agentcat"
	"github.com/dspv/caprock/internal/config"
)

type fakeCatalog struct{ list []config.CustomAgent }

func (f *fakeCatalog) Catalog() CatalogResponse {
	return CatalogResponse{Agents: agentcat.CustomEntries(f.list, func(string) string { return "/bin/x" })}
}
func (f *fakeCatalog) Custom() []config.CustomAgent { return f.list }
func (f *fakeCatalog) SetCustom(l []config.CustomAgent) error {
	f.list = l
	return nil
}

func (e *env) putCustom(t *testing.T, body string) (int, customAgentsBody) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPut, e.srv.URL+"/v1/agents/custom", bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out customAgentsBody
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// Custom agents are free, with no licence (owner decision, 2026-11-27:
// parity with Orca): the server stores one without a key.
func TestCustomAgentsNeedNoLicence(t *testing.T) {
	e := newEnv(t)
	cat := &fakeCatalog{}
	e.api.d.Catalog = cat
	var got customAgentsBody
	if code := e.get(t, "/v1/agents/custom", &got); code != 200 || len(got.Agents) != 0 {
		t.Fatalf("GET empty: %d %+v", code, got)
	}
	body := `{"agents": [{"name": "Aider", "command": "aider", "args": ["--yes", "{prompt}"]}]}`
	code, saved := e.putCustom(t, body)
	if code != 200 || len(saved.Agents) != 1 || saved.Agents[0].ID != "aider" {
		t.Fatalf("without a licence: %d %+v", code, saved)
	}
	if code, _ := e.putCustom(t, `{"agents": [{"name": "x", "command": "aider --yes"}]}`); code != http.StatusBadRequest {
		t.Errorf("a shell string as the command: %d, want 400", code)
	}
	var cat2 CatalogResponse
	if code := e.get(t, "/v1/agents/catalog", &cat2); code != 200 || len(cat2.Agents) != 1 || cat2.Agents[0].ID != "custom:aider" {
		t.Fatalf("catalog: %d %+v", code, cat2)
	}
}

func TestAgentCatalogWithoutTheDaemonPart(t *testing.T) {
	e := newEnv(t)
	if code := e.get(t, "/v1/agents/catalog", nil); code != http.StatusNotImplemented {
		t.Errorf("catalog: %d, want 501", code)
	}
}
