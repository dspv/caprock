package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/dspv/caprock/internal/github"
)

// ghConfig is config.json's GitHub part, in memory.
type ghConfig struct {
	mu     sync.Mutex
	source string
}

func (c *ghConfig) Source() string { c.mu.Lock(); defer c.mu.Unlock(); return c.source }
func (c *ghConfig) SetSource(s string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.source = s
	return nil
}
func (c *ghConfig) ClientID() string     { return "" }
func (c *ghConfig) Notify() bool         { return true }
func (c *ghConfig) SetNotify(bool) error { return nil }

// ghStore keeps the token in memory.
type ghStore struct {
	mu  sync.Mutex
	tok string
}

func (m *ghStore) Get(context.Context) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.tok, nil
}
func (m *ghStore) Set(_ context.Context, t string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.tok = t
	return nil
}
func (m *ghStore) Delete(context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.tok = ""
	return nil
}
func (m *ghStore) Kind() string { return "file" }

// githubServer is changesServer with the repository's origin named on
// github.com (pushes still go to the local bare remote, through pushurl) and
// the GitHub integration pointed at a fake GitHub that route answers.
func githubServer(t *testing.T, route http.HandlerFunc) (s *Server, viewer, controller, repo, id string, store *ghStore) {
	t.Helper()
	s, viewer, controller, repo, id = changesServer(t)
	bare := filepath.Join(filepath.Dir(filepath.Dir(repo)), "remote.git")
	for _, a := range [][]string{
		{"-C", repo, "remote", "set-url", "origin", "https://github.com/ada/repo.git"},
		{"-C", repo, "remote", "set-url", "--push", "origin", bare},
		{"-C", repo, "checkout", "-q", "-b", "feat/x"},
		{"-C", repo, "commit", "-q", "--allow-empty", "-m", "Add x"},
	} {
		c := exec.Command("git", a...)
		c.Env = s.d.Projects.Env()
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", a, err, out)
		}
	}
	fake := httptest.NewServer(route)
	t.Cleanup(fake.Close)
	store = &ghStore{}
	gh := &github.Service{API: fake.URL, Web: fake.URL, HTTP: fake.Client(), Store: store, Config: &ghConfig{}, Projects: s.d.Projects}
	s.d.GitHub = gh
	return s, viewer, controller, repo, id, store
}

// fakeRoutes answers /user for ghp_good and opens pull request #5.
func fakeRoutes(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer ghp_good" {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"message":"Bad credentials"}`))
		return
	}
	w.Header().Set("X-OAuth-Scopes", "repo")
	switch {
	case r.URL.Path == "/user":
		_, _ = w.Write([]byte(`{"login":"ada"}`))
	case r.Method == http.MethodPost && r.URL.Path == "/repos/ada/repo/pulls":
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"number":5,"html_url":"https://github.com/ada/repo/pull/5","title":"Add x","state":"open","head":{"ref":"feat/x","sha":"s"},"base":{"ref":"main"}}`))
	case r.URL.Path == "/user/repos":
		w.Header().Set("Retry-After", "90")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"You have exceeded a secondary rate limit."}`))
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"Not Found"}`))
	}
}

// errorOf reads {error, kind} from an answer.
func errorOf(t *testing.T, w *httptest.ResponseRecorder) (msg, kind string) {
	t.Helper()
	var b struct {
		Error string `json:"error"`
		Kind  string `json:"kind"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &b); err != nil {
		t.Fatalf("not JSON: %s", w.Body.String())
	}
	return b.Error, b.Kind
}

// Connecting is the machine's; reading is every device's; the token is in
// no answer.
func TestGitHubConnectIsTheMachines(t *testing.T) {
	s, viewer, controller, _, _, store := githubServer(t, fakeRoutes)
	for _, tok := range []string{viewer, controller} {
		if w := call(t, s, testPhone, tok, "POST", "/v1/github/connect", `{"source":"token","token":"ghp_good"}`); w.Code != http.StatusForbidden {
			t.Fatalf("a device connected GitHub: %d %s", w.Code, w.Body.String())
		}
		if w := call(t, s, testPhone, tok, "DELETE", "/v1/github", ``); w.Code != http.StatusForbidden {
			t.Fatalf("a device disconnected GitHub: %d", w.Code)
		}
	}
	w := call(t, s, machine, "", "POST", "/v1/github/connect", `{"source":"token","token":"ghp_bad"}`)
	if msg, kind := errorOf(t, w); w.Code != http.StatusBadGateway || kind != "auth" || !strings.Contains(msg, "GitHub rejected the token (401") {
		t.Fatalf("a bad token: %d %s", w.Code, w.Body.String())
	}
	if store.tok != "" {
		t.Fatal("a refused token was stored")
	}
	if w := call(t, s, machine, "", "POST", "/v1/github/connect", `{"source":"token","token":"ghp_good"}`); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"login":"ada"`) {
		t.Fatalf("connect: %d %s", w.Code, w.Body.String())
	}
	for _, tok := range []string{"", viewer} {
		from := machine
		if tok != "" {
			from = testPhone
		}
		w := call(t, s, from, tok, "GET", "/v1/github", "")
		if w.Code != http.StatusOK || strings.Contains(w.Body.String(), "ghp_good") || !strings.Contains(w.Body.String(), `"connected":true`) {
			t.Fatalf("status from %q: %d %s", from, w.Code, w.Body.String())
		}
	}
}

// A viewer may not open a pull request; a controller may, and the branch is
// pushed first. Creating a repository stays on the machine.
func TestAControllerOpensAPullRequest(t *testing.T) {
	s, viewer, controller, repo, id, _ := githubServer(t, fakeRoutes)
	if w := call(t, s, machine, "", "POST", "/v1/github/connect", `{"source":"token","token":"ghp_good"}`); w.Code != http.StatusOK {
		t.Fatal(w.Body.String())
	}
	base := "/v1/projects/" + id + "/github"
	if w := call(t, s, testPhone, viewer, "GET", base, ""); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"full_name":"ada/repo"`) {
		t.Fatalf("viewer read: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, testPhone, viewer, "POST", base+"/pr", `{"title":"Add x"}`); w.Code != http.StatusForbidden {
		t.Fatalf("viewer opened a PR: %d", w.Code)
	}
	if w := call(t, s, testPhone, controller, "POST", base+"/repo", `{"name":"x"}`); w.Code != http.StatusForbidden {
		t.Fatalf("a device created a repository: %d", w.Code)
	}
	w := call(t, s, testPhone, controller, "POST", base+"/pr", `{"title":"Add x","body":"b"}`)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"url":"https://github.com/ada/repo/pull/5"`) || !strings.Contains(w.Body.String(), `"pushed":true`) {
		t.Fatalf("controller PR: %d %s", w.Code, w.Body.String())
	}
	if out, _ := exec.Command("git", "-C", repo, "rev-parse", "--abbrev-ref", "feat/x@{upstream}").Output(); strings.TrimSpace(string(out)) != "origin/feat/x" {
		t.Fatalf("not pushed first: %q", out)
	}
}

// Every failure answers with the sentence the interface shows: not
// connected is 409, a rate limit 429 with Retry-After.
func TestGitHubFailuresAreVisible(t *testing.T) {
	s, _, _, _, id, _ := githubServer(t, fakeRoutes)
	w := call(t, s, machine, "", "GET", "/v1/github/repos", "")
	if msg, kind := errorOf(t, w); w.Code != http.StatusConflict || kind != "not_connected" || !strings.Contains(msg, "Connect it in Settings → GitHub") {
		t.Fatalf("not connected: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, machine, "", "POST", "/v1/projects/"+id+"/github/pr", `{"title":"x"}`); w.Code != http.StatusConflict {
		t.Fatalf("a PR while not connected: %d %s", w.Code, w.Body.String())
	}
	call(t, s, machine, "", "POST", "/v1/github/connect", `{"source":"token","token":"ghp_good"}`)
	w = call(t, s, machine, "", "GET", "/v1/github/repos", "")
	if msg, kind := errorOf(t, w); w.Code != http.StatusTooManyRequests || kind != "rate_limit" || w.Header().Get("Retry-After") == "" || !strings.Contains(msg, "Listing your repositories: GitHub's rate limit") {
		t.Fatalf("rate limit: %d %v %s", w.Code, w.Header(), w.Body.String())
	}
	if w := call(t, s, machine, "", "POST", "/v1/projects/"+id+"/github/pr", `{"title":""}`); w.Code != http.StatusBadRequest {
		t.Fatalf("an empty title: %d", w.Code)
	}
}
