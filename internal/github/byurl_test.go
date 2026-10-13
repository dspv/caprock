package github

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestParsePullURL(t *testing.T) {
	r, n, ok := ParsePullURL("https://github.com/dspv/caprock/pull/404")
	if !ok || r.FullName() != "dspv/caprock" || n != 404 {
		t.Fatalf("%v %d %v", r, n, ok)
	}
	for _, bad := range []string{"", "https://gitlab.com/a/b/pull/1", "https://github.com/a/b/issues/1", "https://github.com/a/b/pull/x"} {
		if _, _, ok := ParsePullURL(bad); ok {
			t.Fatalf("%q parsed", bad)
		}
	}
}

// A session's pull request is read with its checks and kept: a deck asking
// every few seconds sends nothing until the entry ages out, and the age
// depends on whether its checks are still running.
func TestPullByURLKeepsWhatItRead(t *testing.T) {
	x := newFixture(t)
	link := "https://github.com/ada/caprock/pull/3"
	if _, e := x.s.PullByURL(context.Background(), link); e == nil || e.Kind != KindNotConnected {
		t.Fatalf("want not connected, got %v", e)
	}
	if n := len(x.f.requests()); n != 0 {
		t.Fatalf("%d requests while not connected", n)
	}
	x.connect(t)
	x.f.mu.Lock()
	x.f.pulls["ada/caprock"] = []map[string]any{pull("ada/caprock", 3, "feat/x", "sha1")}
	x.f.runs["sha1"] = []map[string]any{{"name": "build", "status": "in_progress"}}
	x.f.mu.Unlock()
	pr, e := x.s.PullByURL(context.Background(), link)
	if e != nil || pr.Number != 3 || pr.State != "open" || pr.Checks.State != "pending" || pr.Branch != "feat/x" {
		t.Fatalf("%+v %v", pr, e)
	}
	before := len(x.f.requests())
	x.advance(10 * time.Second)
	if _, e := x.s.PullByURL(context.Background(), link); e != nil || len(x.f.requests()) != before {
		t.Fatalf("asked again within %s", byURLPending)
	}
	x.f.mu.Lock()
	x.f.runs["sha1"][0] = map[string]any{"name": "build", "status": "completed", "conclusion": "success"}
	x.f.mu.Unlock()
	x.advance(byURLPending)
	pr, _ = x.s.PullByURL(context.Background(), link)
	if pr.Checks.State != "pass" || len(x.f.requests()) == before {
		t.Fatalf("%+v", pr.Checks)
	}
	got := strings.Join(x.f.requests(), "\n")
	if !strings.Contains(got, "/repos/ada/caprock/pulls/3") {
		t.Fatalf("requests:\n%s", got)
	}
}

// GitHub's auto-merge rides on the pull request object already read: no
// call of its own, and absent (false) when GitHub sends null.
func TestPullByURLSaysAutoMerge(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	on := pull("ada/caprock", 4, "feat/y", "sha4")
	on["auto_merge"] = map[string]any{"merge_method": "squash"}
	off := pull("ada/caprock", 5, "feat/z", "sha5")
	off["auto_merge"] = nil
	x.f.mu.Lock()
	x.f.pulls["ada/caprock"] = []map[string]any{on, off}
	x.f.mu.Unlock()
	pr, e := x.s.PullByURL(context.Background(), "https://github.com/ada/caprock/pull/4")
	if e != nil || !pr.AutoMerge {
		t.Fatalf("want auto-merge on: %+v %v", pr, e)
	}
	pr, e = x.s.PullByURL(context.Background(), "https://github.com/ada/caprock/pull/5")
	if e != nil || pr.AutoMerge {
		t.Fatalf("want auto-merge off: %+v %v", pr, e)
	}
}
