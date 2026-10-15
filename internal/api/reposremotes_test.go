package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"testing"

	"github.com/dspv/caprock/internal/gitremote"
)

// The Pipeline's picker asks which folders are git repositories with a
// GitHub remote: a repository on GitHub names owner/name, one with no remote
// or another host has only its root, a plain folder has neither. Each folder
// is answered once, in the order asked.
func TestReposRemotes(t *testing.T) {
	s, _, _, _, _, _ := githubServer(t, repoCIRoutes)
	s.repos.lookup = func(_ context.Context, dir string) (gitremote.Repo, bool) {
		switch dir {
		case "/w/app", "/w/app/sub":
			return gitremote.Repo{Root: "/w/app", URL: "https://github.com/ada/app"}, true
		case "/w/local":
			return gitremote.Repo{Root: dir}, true
		case "/w/lab":
			return gitremote.Repo{Root: dir, URL: "https://gitlab.com/ada/lab"}, true
		}
		return gitremote.Repo{Root: dir}, false
	}
	q := url.Values{"dir": {"/w/app", "/w/local", "/w/lab", "/w/plain", "/w/app", "/w/app/sub", ""}}
	w := call(t, s, machine, "", "GET", "/v1/repos/remotes?"+q.Encode(), "")
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	var got ReposRemotes
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	want := []RepoRemote{
		{Dir: "/w/app", Root: "/w/app", Repo: "ada/app"},
		{Dir: "/w/local", Root: "/w/local"},
		{Dir: "/w/lab", Root: "/w/lab"},
		{Dir: "/w/plain"},
		{Dir: "/w/app/sub", Root: "/w/app", Repo: "ada/app"},
	}
	if len(got.Repos) != len(want) {
		t.Fatalf("got %+v", got.Repos)
	}
	for i := range want {
		if got.Repos[i] != want[i] {
			t.Fatalf("row %d: got %+v, want %+v", i, got.Repos[i], want[i])
		}
	}
	// Nothing asked, nothing answered — never null.
	w = call(t, s, machine, "", "GET", "/v1/repos/remotes", "")
	if w.Code != http.StatusOK || w.Body.String() != "{\"repos\":[]}\n" {
		t.Fatalf("empty: %d %q", w.Code, w.Body.String())
	}
}
