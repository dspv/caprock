package api

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/dspv/caprock/internal/projects"
)

// The Add project sheet's two answers to a folder of repositories (ADR-055):
// scan, then one project of the chosen ones, or each on its own; and the
// editor's split and merge. Scan, split and merge are the machine's.
func TestAFolderOfRepositories(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	s, home, _, controller, _ := projectsServer(t)
	base := filepath.Join(home, "work")
	var repos []string
	for _, n := range []string{"api", "web", "infra"} {
		d := filepath.Join(base, n)
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		if out, err := exec.Command("git", "-C", d, "init", "-q").CombinedOutput(); err != nil {
			t.Fatalf("git init: %v %s", err, out)
		}
		repos = append(repos, d)
	}
	j := func(v any) string { b, _ := json.Marshal(v); return string(b) }

	w := call(t, s, machine, "", "GET", "/v1/projects/scan?path="+filepath.ToSlash(base), "")
	var scan projects.ScanResult
	if err := json.Unmarshal(w.Body.Bytes(), &scan); err != nil || w.Code != 200 || len(scan.Repos) != 3 {
		t.Fatalf("scan: %d %s", w.Code, w.Body)
	}
	if w := call(t, s, testPhone, controller, "GET", "/v1/projects/scan?path="+filepath.ToSlash(base), ""); w.Code != 403 {
		t.Fatalf("a phone scanned: %d", w.Code)
	}
	if w := call(t, s, machine, "", "POST", "/v1/projects", j(map[string]any{"repos": repos})); w.Code != 400 {
		t.Fatalf("repos without path: %d", w.Code)
	}
	w = call(t, s, machine, "", "POST", "/v1/projects", j(map[string]any{"path": base, "repos": repos[:2]}))
	var added struct {
		Project projects.View `json:"project"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &added); err != nil || w.Code != 200 || len(added.Project.Repos) != 2 {
		t.Fatalf("add multi: %d %s", w.Code, w.Body)
	}
	id := strconv.FormatInt(added.Project.ID, 10)
	if w := call(t, s, testPhone, controller, "PATCH", "/v1/projects/"+id, j(map[string]any{"repos": []string{t.TempDir()}})); w.Code != 403 {
		t.Fatalf("a phone added a repository outside home: %d", w.Code)
	}
	if w := call(t, s, machine, "", "PATCH", "/v1/projects/"+id, j(map[string]any{"repos": repos})); w.Code != 200 {
		t.Fatalf("patch repos: %d %s", w.Code, w.Body)
	}
	w = call(t, s, machine, "", "GET", "/v1/projects/"+id+"/repos", "")
	var rs struct {
		Repos []projects.RepoView `json:"repos"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &rs); err != nil || w.Code != 200 || len(rs.Repos) != 3 {
		t.Fatalf("repos: %d %s", w.Code, w.Body)
	}
	w = call(t, s, machine, "", "POST", "/v1/projects/"+id+"/split", "")
	var split struct {
		Projects []projects.View `json:"projects"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &split); err != nil || w.Code != 200 || len(split.Projects) != 3 {
		t.Fatalf("split: %d %s", w.Code, w.Body)
	}
	ids := []int64{split.Projects[0].ID, split.Projects[1].ID}
	if w := call(t, s, testPhone, controller, "POST", "/v1/projects/merge", j(map[string]any{"ids": ids})); w.Code != 403 {
		t.Fatalf("a phone merged: %d", w.Code)
	}
	if w := call(t, s, machine, "", "POST", "/v1/projects/merge", j(map[string]any{"ids": ids})); w.Code != 200 {
		t.Fatalf("merge: %d %s", w.Code, w.Body)
	}
	if w := call(t, s, machine, "", "POST", "/v1/projects/merge", `{"ids":[1]}`); w.Code != 400 {
		t.Fatalf("merge of one: %d", w.Code)
	}
}
