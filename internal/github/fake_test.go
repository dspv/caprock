package github

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/projects"
)

// fakeGitHub is a small GitHub: the routes Caprock calls, answered from
// state the test sets, with ETags and 304s like the real one, and any route
// replaceable by a handler that fails the way the test needs.
type fakeGitHub struct {
	t   *testing.T
	srv *httptest.Server

	mu       sync.Mutex
	tokens   map[string]string // token -> login
	scopes   string            // X-OAuth-Scopes; "-" for none sent (fine-grained)
	orgs     []string
	repos    []map[string]any
	pulls    map[string][]map[string]any // "o/r" -> pulls
	runs     map[string][]map[string]any // sha -> check runs
	statuses map[string][]map[string]any // sha -> statuses
	reviews  map[int][]map[string]any    // number -> reviews
	created  []map[string]any            // POST bodies
	fail     map[string]http.HandlerFunc // "METHOD /path" -> handler
	log      []string                    // "METHOD /path?query [If-None-Match]"
	device   []map[string]any            // answers to successive token polls
}

func newFakeGitHub(t *testing.T) *fakeGitHub {
	f := &fakeGitHub{t: t, tokens: map[string]string{"ghp_good": "ada"}, scopes: "repo, read:org",
		pulls: map[string][]map[string]any{}, runs: map[string][]map[string]any{}, statuses: map[string][]map[string]any{},
		reviews: map[int][]map[string]any{}, fail: map[string]http.HandlerFunc{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeGitHub) failWith(route string, h http.HandlerFunc) {
	f.mu.Lock()
	f.fail[route] = h
	f.mu.Unlock()
}

func (f *fakeGitHub) requests() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.log...)
}

// answer writes v as JSON with an ETag, or 304 when the client has it.
func answer(w http.ResponseWriter, r *http.Request, status int, v any) {
	b, _ := json.Marshal(v)
	sum := sha256.Sum256(b)
	et := `"` + hex.EncodeToString(sum[:8]) + `"`
	w.Header().Set("ETag", et)
	w.Header().Set("X-RateLimit-Limit", "5000")
	w.Header().Set("X-RateLimit-Remaining", "4990")
	w.Header().Set("X-RateLimit-Reset", fmt.Sprint(time.Now().Add(time.Hour).Unix()))
	w.Header().Set("X-RateLimit-Resource", "core")
	if r.Method == http.MethodGet && r.Header.Get("If-None-Match") == et {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

func (f *fakeGitHub) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	entry := r.Method + " " + r.URL.Path
	if r.URL.RawQuery != "" {
		entry += "?" + r.URL.RawQuery
	}
	if inm := r.Header.Get("If-None-Match"); inm != "" {
		entry += " [conditional]"
	}
	f.log = append(f.log, entry)
	h := f.fail[r.Method+" "+r.URL.Path]
	f.mu.Unlock()
	if h != nil {
		h(w, r)
		return
	}
	// Device flow lives on the web host; the fake is both.
	switch r.URL.Path {
	case "/login/device/code":
		answer(w, r, 200, map[string]any{"device_code": "dev-123", "user_code": "ABCD-1234", "verification_uri": f.srv.URL + "/login/device", "expires_in": 900, "interval": 5})
		return
	case "/login/oauth/access_token":
		f.mu.Lock()
		var a map[string]any
		if len(f.device) > 0 {
			a, f.device = f.device[0], f.device[1:]
		} else {
			a = map[string]any{"error": "authorization_pending"}
		}
		f.mu.Unlock()
		answer(w, r, 200, a)
		return
	}
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	f.mu.Lock()
	login, ok := f.tokens[tok]
	scopes := f.scopes
	f.mu.Unlock()
	if !ok {
		answer(w, r, 401, map[string]any{"message": "Bad credentials"})
		return
	}
	if scopes != "-" {
		w.Header().Set("X-OAuth-Scopes", scopes)
	}
	f.route(w, r, login)
}

func (f *fakeGitHub) route(w http.ResponseWriter, r *http.Request, login string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p := r.URL.Path
	switch {
	case p == "/user":
		answer(w, r, 200, map[string]any{"login": login, "name": "Ada L", "avatar_url": "https://avatars.example/ada", "html_url": "https://github.com/" + login})
	case p == "/user/orgs":
		out := []map[string]any{}
		for _, o := range f.orgs {
			out = append(out, map[string]any{"login": o})
		}
		answer(w, r, 200, out)
	case p == "/user/repos" && r.Method == http.MethodGet:
		if r.URL.Query().Get("page") == "1" {
			w.Header().Set("Link", `<`+f.srv.URL+`/user/repos?page=2>; rel="next"`)
		}
		answer(w, r, 200, f.repos)
	case p == "/search/repositories":
		answer(w, r, 200, map[string]any{"total_count": len(f.repos), "items": f.repos})
	case (p == "/user/repos" || strings.HasPrefix(p, "/orgs/")) && r.Method == http.MethodPost:
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.created = append(f.created, body)
		name, _ := body["name"].(string)
		answer(w, r, 201, map[string]any{"full_name": login + "/" + name, "name": name, "owner": map[string]any{"login": login}, "private": body["private"],
			"clone_url": "https://github.com/" + login + "/" + name + ".git", "ssh_url": "git@github.com:" + login + "/" + name + ".git", "html_url": "https://github.com/" + login + "/" + name})
	case strings.HasPrefix(p, "/repos/"):
		f.repoRoute(w, r, strings.Split(strings.TrimPrefix(p, "/repos/"), "/"))
	default:
		answer(w, r, 404, map[string]any{"message": "Not Found"})
	}
}

func (f *fakeGitHub) repoRoute(w http.ResponseWriter, r *http.Request, seg []string) {
	full := seg[0] + "/" + seg[1]
	rest := seg[2:]
	switch {
	case len(rest) == 1 && rest[0] == "pulls" && r.Method == http.MethodGet:
		state := r.URL.Query().Get("state")
		head := r.URL.Query().Get("head")
		out := []map[string]any{}
		for _, pr := range f.pulls[full] {
			if state == "open" && pr["state"] != "open" {
				continue
			}
			if head != "" && seg[0]+":"+pr["head"].(map[string]any)["ref"].(string) != head {
				continue
			}
			out = append(out, pr)
		}
		answer(w, r, 200, out)
	case len(rest) == 1 && rest[0] == "pulls" && r.Method == http.MethodPost:
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.created = append(f.created, body)
		n := len(f.pulls[full]) + 1
		pr := pull(full, n, body["head"].(string), "sha-new")
		pr["title"], pr["draft"] = body["title"], body["draft"]
		f.pulls[full] = append(f.pulls[full], pr)
		answer(w, r, 201, pr)
	case len(rest) == 2 && rest[0] == "pulls":
		for _, pr := range f.pulls[full] {
			if fmt.Sprint(pr["number"]) == rest[1] {
				answer(w, r, 200, pr)
				return
			}
		}
		answer(w, r, 404, map[string]any{"message": "Not Found"})
	case len(rest) == 3 && rest[0] == "pulls" && rest[2] == "reviews":
		var n int
		_, _ = fmt.Sscan(rest[1], &n)
		rs := f.reviews[n]
		if rs == nil {
			rs = []map[string]any{}
		}
		answer(w, r, 200, rs)
	case len(rest) == 3 && rest[0] == "commits" && rest[2] == "check-runs":
		runs := f.runs[rest[1]]
		if runs == nil {
			runs = []map[string]any{}
		}
		answer(w, r, 200, map[string]any{"total_count": len(runs), "check_runs": runs})
	case len(rest) == 3 && rest[0] == "commits" && rest[2] == "status":
		st := f.statuses[rest[1]]
		if st == nil {
			st = []map[string]any{}
		}
		answer(w, r, 200, map[string]any{"state": "pending", "statuses": st})
	default:
		answer(w, r, 404, map[string]any{"message": "Not Found"})
	}
}

// pull is a pull request object as GitHub returns it.
func pull(full string, n int, branch, sha string) map[string]any {
	return map[string]any{"number": n, "html_url": fmt.Sprintf("https://github.com/%s/pull/%d", full, n), "title": "Add the thing", "state": "open",
		"draft": false, "mergeable": true, "mergeable_state": "clean",
		"head": map[string]any{"ref": branch, "sha": sha, "repo": map[string]any{"full_name": full}},
		"base": map[string]any{"ref": "main"}, "requested_reviewers": []any{}}
}

// memStore is a TokenStore in memory.
type memStore struct {
	mu      sync.Mutex
	tok     string
	deletes int
	failSet error
}

func (m *memStore) Get(context.Context) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.tok, nil
}
func (m *memStore) Set(_ context.Context, t string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.failSet != nil {
		return m.failSet
	}
	m.tok = t
	return nil
}
func (m *memStore) Delete(context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.tok = ""
	m.deletes++
	return nil
}
func (m *memStore) Kind() string { return "keychain" }

// fakeGH is the GitHub CLI.
type fakeGH struct {
	mu    sync.Mutex
	toks  []string // successive answers; the last repeats
	err   error
	calls int
}

func (g *fakeGH) Token(context.Context) (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.calls++
	if g.err != nil {
		return "", g.err
	}
	t := g.toks[0]
	if len(g.toks) > 1 {
		g.toks = g.toks[1:]
	}
	return t, nil
}
func (g *fakeGH) Found() bool { return true }

// memConfig is config.json's GitHub part.
type memConfig struct {
	mu       sync.Mutex
	source   string
	clientID string
	notify   bool
}

func (c *memConfig) Source() string { c.mu.Lock(); defer c.mu.Unlock(); return c.source }
func (c *memConfig) SetSource(s string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.source = s
	return nil
}
func (c *memConfig) ClientID() string { c.mu.Lock(); defer c.mu.Unlock(); return c.clientID }
func (c *memConfig) Notify() bool     { c.mu.Lock(); defer c.mu.Unlock(); return c.notify }
func (c *memConfig) SetNotify(on bool) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.notify = on
	return nil
}

// fakeWorktrees is the projects list: one project, its worktrees, what a
// push and a remote do.
type fakeWorktrees struct {
	mu       sync.Mutex
	views    []projects.View
	changes  map[string]projects.Changes // worktree name -> status
	pushes   int
	pushErr  error
	remotes  []string
	subjects []string
}

func (w *fakeWorktrees) List(context.Context) ([]projects.View, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]projects.View(nil), w.views...), nil
}

func (w *fakeWorktrees) Changes(_ context.Context, _ int64, wt string) (projects.Changes, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	c, ok := w.changes[wt]
	if !ok {
		return projects.Changes{}, projects.ErrNoWorktree
	}
	return c, nil
}

func (w *fakeWorktrees) Push(_ context.Context, _ int64, wt string) (projects.RemoteResult, projects.Changes, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.pushes++
	if w.pushErr != nil {
		return projects.RemoteResult{}, projects.Changes{}, w.pushErr
	}
	c := w.changes[wt]
	c.Published, c.Ahead = true, 0
	w.changes[wt] = c
	return projects.RemoteResult{Remote: "origin", Branch: c.Branch, UpstreamSet: true}, c, nil
}

func (w *fakeWorktrees) AddRemote(_ context.Context, _ int64, name, url string) (projects.Changes, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.remotes = append(w.remotes, name+" "+url)
	c := w.changes[""]
	c.Remote, c.RemoteURL = name, url
	w.changes[""] = c
	return c, nil
}

func (w *fakeWorktrees) Subjects(context.Context, int64, string, string) ([]string, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]string(nil), w.subjects...), nil
}

// fixture is a Service against the fake, with a clock the test moves.
type fixture struct {
	f     *fakeGitHub
	s     *Service
	store *memStore
	gh    *fakeGH
	cfg   *memConfig
	wt    *fakeWorktrees
	bus   *bus.Bus
	now   time.Time
	nowMu sync.Mutex
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	x := &fixture{f: newFakeGitHub(t), store: &memStore{}, gh: &fakeGH{toks: []string{"ghp_good"}}, cfg: &memConfig{notify: true},
		bus: bus.New(), now: time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)}
	x.wt = &fakeWorktrees{changes: map[string]projects.Changes{
		"": {ProjectID: 1, Branch: "main", DefaultBranch: "main", Remote: "origin", RemoteURL: "git@github.com:ada/caprock.git", Published: true, Head: "abc"},
		"feat-x": {ProjectID: 1, Worktree: "feat-x", Branch: "feat/x", DefaultBranch: "main", Remote: "origin",
			RemoteURL: "git@github.com:ada/caprock.git", Published: false, Ahead: 2, Head: "def"},
	}}
	x.wt.views = []projects.View{{ID: 1, Name: "caprock", Kind: "repo", Git: &projects.GitStatus{Branch: "main", DefaultBranch: "main", RemoteURL: "git@github.com:ada/caprock.git"},
		Worktrees: []projects.WorktreeView{{Name: "feat-x", Branch: "feat/x"}}}}
	x.s = &Service{API: x.f.srv.URL, Web: x.f.srv.URL, HTTP: x.f.srv.Client(), Store: x.store, GH: x.gh, Config: x.cfg, Projects: x.wt, Bus: x.bus,
		Now: x.clock, Sleep: func(ctx context.Context, _ time.Duration) bool { return ctx.Err() == nil }}
	x.s.init()
	return x
}

func (x *fixture) clock() time.Time {
	x.nowMu.Lock()
	defer x.nowMu.Unlock()
	return x.now
}

func (x *fixture) advance(d time.Duration) {
	x.nowMu.Lock()
	x.now = x.now.Add(d)
	x.nowMu.Unlock()
}

// connect connects with the pasted good token.
func (x *fixture) connect(t *testing.T) {
	t.Helper()
	if _, e := x.s.Connect(context.Background(), SourceToken, "ghp_good"); e != nil {
		t.Fatalf("connect: %v", e)
	}
}

// asError is err as an *Error, failing the test otherwise.
func asError(t *testing.T, err error) *Error {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("want *Error, got %T %v", err, err)
	}
	return e
}
