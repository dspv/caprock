package brain

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/gitremote"
	"github.com/dspv/caprock/internal/store"
)

// stubRepo makes lookupRepo answer url for every directory, for one test.
func stubRepo(t *testing.T, url string) {
	t.Helper()
	was := lookupRepo
	lookupRepo = func(_ context.Context, dir string) (gitremote.Repo, bool) {
		return gitremote.Repo{Root: dir, URL: url}, true
	}
	t.Cleanup(func() { lookupRepo = was })
}

// inDir moves a session written by env.session to a working directory, as
// the hook would have reported it, and returns the project it was labelled.
func (e *env) inDir(t *testing.T, id, dir string, ago time.Duration) string {
	t.Helper()
	ctx := context.Background()
	if err := store.UpsertSession(ctx, e.st.DB(), id, store.SessionPatch{Cwd: dir, LastEventAt: e.now.Add(-ago).UnixMilli(), FromHook: true}); err != nil {
		t.Fatal(err)
	}
	s, err := store.GetSession(ctx, e.st.DB(), id)
	if err != nil {
		t.Fatal(err)
	}
	return s.Project
}

// A session in an archive extracted to the temp directory is labelled after
// the throwaway folder; its memories are kept, but in no project.
func TestATempDirSessionMakesNoThrowawayProject(t *testing.T) {
	e := newEnv(t, twoMemories)
	dir := filepath.Join(t.TempDir(), "ops-seo-site-m143z5ko")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	e.session(t, "s1", "", 20*time.Minute, [2]string{"Why is the cache test flaky?", long}, [2]string{"And the store?", long})
	if p := e.inDir(t, "s1", dir, 20*time.Minute); p != "ops-seo-site-m143z5ko" {
		t.Fatalf("the session's own label is the folder's name, got %q", p)
	}
	if n, err := e.eng.Wake(context.Background()); err != nil || n != 1 {
		t.Fatalf("wake: read %d, err %v", n, err)
	}
	if got := e.reqs[0].Prompt; strings.Contains(got, "Project:") {
		t.Errorf("a throwaway folder is no project to tell claude about:\n%s", got)
	}
	g, err := store.ReadBrainGraph(context.Background(), e.st.DB(), store.BrainFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if g.Total != 2 {
		t.Fatalf("memories kept: %d, want 2", g.Total)
	}
	for _, n := range g.Nodes {
		if n.Kind == store.BrainProject || n.Source.Project != "" {
			t.Errorf("node %q (%s) carries project %q", n.Title, n.Kind, n.Source.Project)
		}
	}
}

// A checkout in the temp directory with a remote is the remote's repository.
func TestATempDirCheckoutIsNamedFromItsRemote(t *testing.T) {
	stubRepo(t, "https://github.com/acme/widgets")
	e := newEnv(t, twoMemories)
	dir := filepath.Join(t.TempDir(), "tmp.Xa81k")
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	e.session(t, "s1", "", 20*time.Minute, [2]string{"Why is the cache test flaky?", long}, [2]string{"And the store?", long})
	e.inDir(t, "s1", dir, 20*time.Minute)
	if n, err := e.eng.Wake(context.Background()); err != nil || n != 1 {
		t.Fatalf("wake: read %d, err %v", n, err)
	}
	g, err := store.ReadBrainGraph(context.Background(), e.st.DB(), store.BrainFilter{Project: "widgets"})
	if err != nil {
		t.Fatal(err)
	}
	if g.Total != 2 {
		t.Fatalf("memories in widgets: %d, want 2", g.Total)
	}
}

func TestMemoryProject(t *testing.T) {
	tmp := filepath.Join(os.TempDir(), "caprock-brain-x")
	for _, tc := range []struct {
		name, url string
		c         store.BrainCandidate
		want      string
	}{
		{"no cwd keeps the label", "", store.BrainCandidate{Project: "acme-api"}, "acme-api"},
		{"outside temp keeps the label", "https://github.com/a/b", store.BrainCandidate{Project: "caprock", Cwd: "/Users/me/dev/caprock", RepoRoot: "/Users/me/dev/caprock"}, "caprock"},
		{"temp, not a checkout", "", store.BrainCandidate{Project: "caprock-brain-x", Cwd: tmp}, ""},
		{"temp checkout without a web remote", "", store.BrainCandidate{Project: "caprock-brain-x", Cwd: tmp, RepoRoot: tmp}, ""},
		{"temp checkout with a remote", "https://gitlab.com/group/sub/site/", store.BrainCandidate{Project: "caprock-brain-x", Cwd: tmp, RepoRoot: tmp}, "site"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stubRepo(t, tc.url)
			if got := memoryProject(context.Background(), tc.c); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}
