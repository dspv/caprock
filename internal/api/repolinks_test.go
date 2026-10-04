package api

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
)

// A session's page carries its repository's web address and the pull requests
// it opened, and its Projects row the latest of them — all from local data:
// the git remote, and Claude Code's own record of each `gh pr` command.
func TestSessionAndProjectLinkTheRepoAndPRs(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	e := newEnv(t)
	ctx := context.Background()
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q", "-b", "master"},
		{"remote", "add", "origin", "git@github.com:dspv/caprock.git"},
	} {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = os.Environ()
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	e.seed(t, dir)
	post := func(key string, at time.Duration, payload string) {
		ev := &event.Event{SessionID: "s1", Source: event.SourceHook, Kind: event.KindToolPost, Tool: "Bash", Key: key,
			Ts: e.now.Add(at), Payload: json.RawMessage(payload)}
		if _, err := e.rec.Record(ctx, ev, rollup.SessionInfo{Cwd: dir}); err != nil {
			t.Fatal(err)
		}
	}
	post("post:a", 3*time.Second, `{"tool_name":"Bash","tool_input":{"command":"gh pr create --title \"fix: one\""},
		"tool_response":{"gitOperation":{"pr":{"number":7,"url":"https://github.com/dspv/caprock/pull/7","action":"created"}}}}`)
	post("post:b", 4*time.Second, `{"tool_name":"Bash","tool_input":{"command":"gh pr create -t 'feat: two'"},
		"tool_response":{"gitOperation":{"pr":{"number":8,"url":"https://github.com/dspv/caprock/pull/8","action":"created"}}}}`)
	post("post:c", 5*time.Second, `{"tool_name":"Bash","tool_input":{"command":"gh pr merge 7 --squash"},
		"tool_response":{"gitOperation":{"pr":{"number":7,"url":"https://github.com/dspv/caprock/pull/7","action":"merged"}}}}`)
	// An edit is not a PR this session opened.
	post("post:d", 6*time.Second, `{"tool_name":"Bash","tool_input":{"command":"gh pr edit 9"},
		"tool_response":{"gitOperation":{"pr":{"number":9,"url":"https://github.com/dspv/caprock/pull/9","action":"edited"}}}}`)

	var det SessionDetail
	if code := e.get(t, "/v1/sessions/s1", &det); code != 200 {
		t.Fatalf("detail: %d", code)
	}
	if det.Repo == nil || det.Repo.URL != "https://github.com/dspv/caprock" {
		t.Fatalf("repo = %+v", det.Repo)
	}
	if len(det.PRs) != 2 {
		t.Fatalf("prs = %+v, want #7 and #8", det.PRs)
	}
	// Latest first: #7's merge is the last command on either.
	if det.PRs[0].Number != 7 || det.PRs[0].MergedAt == 0 || det.PRs[0].Title != "fix: one" {
		t.Fatalf("first PR = %+v, want #7 merged, titled", det.PRs[0])
	}
	if det.PRs[1].Number != 8 || det.PRs[1].MergedAt != 0 || det.PRs[1].Title != "feat: two" {
		t.Fatalf("second PR = %+v, want #8, not merged", det.PRs[1])
	}

	var sum SummaryResponse
	if code := e.get(t, "/v1/stats/summary?range=all", &sum); code != 200 {
		t.Fatalf("summary: %d", code)
	}
	var found bool
	for _, p := range sum.Projects {
		if p.Dir == "" {
			continue
		}
		found = true
		if p.RepoURL != "https://github.com/dspv/caprock" || p.LastPR == nil || p.LastPR.Number != 7 {
			t.Fatalf("project row = repo %q, last PR %+v", p.RepoURL, p.LastPR)
		}
	}
	if !found {
		t.Fatalf("no project row with a directory: %+v", sum.Projects)
	}
}

// A directory that is not a repository has no link, and the page says where it
// is instead; the session still lists no PRs rather than null.
func TestSessionOutsideARepoHasNoRepoLink(t *testing.T) {
	e := newEnv(t)
	dir := filepath.Join(t.TempDir(), "plain")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	e.seed(t, dir)
	var raw map[string]json.RawMessage
	if code := e.get(t, "/v1/sessions/s1", &raw); code != 200 {
		t.Fatalf("detail: %d", code)
	}
	if _, has := raw["repo"]; has {
		t.Fatalf("repo present for a plain directory: %s", raw["repo"])
	}
	if string(raw["prs"]) != "[]" {
		t.Fatalf("prs = %s, want []", raw["prs"])
	}
}
