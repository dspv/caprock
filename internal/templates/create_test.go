package templates

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/projects"
	"github.com/dspv/caprock/internal/store"
)

// fakeGH is testdata/fakegh, built once for the package: no test here ever
// runs the real gh.
var fakeGH string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "fakegh-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fakeGH = filepath.Join(dir, "gh")
	if runtime.GOOS == "windows" {
		fakeGH += ".exe"
	}
	cmd := exec.Command("go", "build", "-o", fakeGH, "./testdata/fakegh")
	cmd.Dir = filepath.Join("..", "..")
	if out, err := cmd.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "building testdata/fakegh: %v\n%s", err, out)
		os.Exit(1)
	}
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

// world is one test's machine: a home, a git identity, gh's repositories
// and the services under test.
type world struct {
	t       *testing.T
	home    string
	ghDir   string
	parent  string
	svc     *Service
	projs   *projects.Service
	mu      sync.Mutex
	env     map[string]string
	gitconf string
}

func newWorld(t *testing.T) *world {
	t.Helper()
	w := &world{t: t, home: t.TempDir(), ghDir: t.TempDir(), env: map[string]string{}}
	// Never the real home, never the person's git config.
	t.Setenv("HOME", w.home)
	t.Setenv("USERPROFILE", w.home)
	w.parent = filepath.Join(w.home, "dev")
	w.gitconf = filepath.Join(w.home, "gitconfig")
	w.identity(true)
	w.env["FAKEGH_DIR"] = w.ghDir
	w.env["FAKEGH_LOGIN"] = "dspv"

	st, err := store.Open(context.Background(), ":memory:", quiet())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	w.projs = projects.New(st, bus.New(), quiet())
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := w.projs.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.projs.Close)
	w.svc = New(&Store{Log: quiet()}, w.projs, quiet())
	w.svc.GHBin = fakeGH
	w.svc.CloneWait = 10 * time.Millisecond
	w.svc.Ctx = ctx
	w.svc.Env = w.environ
	return w
}

// identity writes the git config the test's git reads: a name and email, or
// none at all (useConfigOnly, so git does not guess one from the host).
func (w *world) identity(on bool) {
	conf := "[user]\n\tuseConfigOnly = true\n[init]\n\tdefaultBranch = main\n"
	if on {
		conf = "[user]\n\tname = Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n"
	}
	if err := os.WriteFile(w.gitconf, []byte(conf), 0o600); err != nil {
		w.t.Fatal(err)
	}
}

func (w *world) set(k, v string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if v == "" {
		delete(w.env, k)
	} else {
		w.env[k] = v
	}
}

func (w *world) environ() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	var out []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(k, "GIT_") || strings.HasPrefix(k, "FAKEGH_") || strings.HasPrefix(k, "GH_") || k == "HOME" || k == "USERPROFILE" || k == "XDG_CONFIG_HOME" {
			continue
		}
		out = append(out, kv)
	}
	out = append(out, "HOME="+w.home, "USERPROFILE="+w.home, "XDG_CONFIG_HOME="+filepath.Join(w.home, ".config"),
		"GIT_CONFIG_GLOBAL="+w.gitconf, "GIT_CONFIG_NOSYSTEM=1")
	for k, v := range w.env {
		out = append(out, k+"="+v)
	}
	return out
}

// git runs git in dir with the world's environment.
func (w *world) git(dir string, args ...string) string {
	w.t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = w.environ()
	out, err := cmd.CombinedOutput()
	if err != nil {
		w.t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

const corpusTemplateMD = "<!-- caprock-template\nbrief: docs/source-spec.md\nprompt: Read TEMPLATE.md. Build the .ai/ corpus from {brief}.\n-->\n# How to build the corpus\n"

// sourceRepo is a template repository on disk with one commit.
func (w *world) sourceRepo(files map[string]string) string {
	w.t.Helper()
	dir := filepath.Join(w.t.TempDir(), "corpus")
	for p, text := range files {
		write(w.t, filepath.Join(dir, filepath.FromSlash(p)), text)
	}
	w.git(filepath.Dir(dir), "init", "-q", dir)
	w.git(dir, "add", "-A")
	w.git(dir, "commit", "-q", "-m", "Template")
	return dir
}

// publish makes repo (owner/name) known to fake gh from the source repo:
// cloneable, viewable, its TEMPLATE.md and README readable.
func (w *world) publish(repo, canonical, src string, files map[string]string) {
	w.t.Helper()
	d := filepath.Join(w.ghDir, strings.Replace(repo, "/", "__", 1))
	if src != "" {
		w.git(w.ghDir, "clone", "-q", "--bare", src, filepath.Join(d, "bare.git"))
	}
	view, _ := json.Marshal(map[string]any{"isTemplate": true, "visibility": "PUBLIC", "nameWithOwner": canonical})
	write(w.t, filepath.Join(d, "view.json"), string(view))
	for p, text := range files {
		write(w.t, filepath.Join(d, "contents", filepath.FromSlash(p)), text)
	}
}

// corpus is the dspv/corpus template, reachable as cybrixcc/corpus too.
func (w *world) corpus() string {
	files := map[string]string{"TEMPLATE.md": corpusTemplateMD, "README.md": "# Corpus\n", ".ai/00-index.md": "# Index\n"}
	src := w.sourceRepo(files)
	w.publish("dspv/corpus", "dspv/corpus", src, files)
	w.publish("cybrixcc/corpus", "dspv/corpus", "", files)
	return src
}

func (w *world) calls() string {
	b, _ := os.ReadFile(filepath.Join(w.ghDir, "calls.log"))
	return string(b)
}

// wait waits for an operation to end.
func (w *world) wait(id string) projects.Op {
	w.t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if op, ok := w.projs.GetOp(id); ok && op.State != projects.OpRunning {
			return op
		}
		time.Sleep(20 * time.Millisecond)
	}
	w.t.Fatalf("operation %s did not end", id)
	return projects.Op{}
}

func (w *world) request(opID, name string) CreateRequest {
	return CreateRequest{
		OpID: opID, Source: Source{GitHub: "dspv/corpus"}, Via: ViaGitHub, Name: name, Parent: w.parent,
		Visibility: "private", Brief: "# Acme\n\nA tool that does one thing.\n", BriefPath: "docs/source-spec.md", TemplateName: "Corpus",
	}
}

func status(err error) int {
	var e *Error
	if errors.As(err, &e) {
		return e.Status
	}
	return 0
}

func TestFromGitHub(t *testing.T) {
	w := newWorld(t)
	w.corpus()
	tpl, err := w.svc.Store.Add(Input{Name: ptr("Corpus"), GitHub: ptr("dspv/corpus"), BriefPath: ptr("docs/source-spec.md"), Prompt: ptr("Go {brief}")})
	if err != nil {
		t.Fatal(err)
	}
	op, existing, err := w.svc.FromTemplate(context.Background(), w.request("op1", "acme"))
	if err != nil || existing || op.Kind != OpKind || op.Repo != "dspv/acme" {
		t.Fatalf("%+v %v %v", op, existing, err)
	}
	// The same op_id again is the same operation; nothing new starts.
	again, existing, err := w.svc.FromTemplate(context.Background(), w.request("op1", "acme"))
	if err != nil || !existing || again.ID != "op1" {
		t.Fatalf("again: %+v %v %v", again, existing, err)
	}
	op = w.wait("op1")
	if op.State != projects.OpDone || op.ProjectID == 0 || op.RepoURL != "https://github.com/dspv/acme" || op.Step != StepAdd {
		t.Fatalf("%+v", op)
	}
	dest := filepath.Join(w.parent, "acme")
	b, err := os.ReadFile(filepath.Join(dest, "docs", "source-spec.md"))
	if err != nil || !strings.Contains(string(b), "A tool that does one thing.") {
		t.Fatalf("brief: %q %v", b, err)
	}
	if got := w.git(dest, "log", "-1", "--format=%s", "--", "docs/source-spec.md"); got != "Add the project brief" {
		t.Errorf("brief commit: %q", got)
	}
	if got := w.git(dest, "status", "--porcelain"); got != "" {
		t.Errorf("left uncommitted: %q", got)
	}
	// Never pushed: the repository on "GitHub" still has only the template's commit.
	if got := w.git(filepath.Join(w.ghDir, "dspv__acme", "bare.git"), "rev-list", "--count", "HEAD"); got != "1" {
		t.Errorf("the remote has %s commits", got)
	}
	calls := w.calls()
	if strings.Count(calls, "repo create dspv/acme --template dspv/corpus --private") != 1 || strings.Count(calls, "repo clone dspv/acme") != 1 {
		t.Errorf("calls:\n%s", calls)
	}
	v, err := w.projs.Get(context.Background(), op.ProjectID)
	if err != nil || v.Source != store.ProjectSourceClone || v.Kind != store.ProjectKindRepo {
		t.Errorf("listed as %+v %v", v, err)
	}
	if got, _ := w.svc.Store.Get(tpl.ID); got.UsedAt == 0 {
		t.Errorf("used_at not stamped")
	}
}

func TestRefusalsBeforeAnythingStarts(t *testing.T) {
	w := newWorld(t)
	w.corpus()
	taken := filepath.Join(w.parent, "taken")
	write(t, filepath.Join(taken, "keep.txt"), "mine")

	cases := []struct {
		name string
		edit func(*CreateRequest)
		want int
	}{
		{"name taken", func(r *CreateRequest) { r.Name = "taken" }, http.StatusConflict},
		{"bad name", func(r *CreateRequest) { r.Name = "a/b" }, http.StatusBadRequest},
		{"dot name", func(r *CreateRequest) { r.Name = ".." }, http.StatusBadRequest},
		{"no brief", func(r *CreateRequest) { r.Brief = "  \n" }, http.StatusBadRequest},
		{"big brief", func(r *CreateRequest) { r.Brief = strings.Repeat("a", MaxBrief+1) }, http.StatusBadRequest},
		{"bad brief path", func(r *CreateRequest) { r.BriefPath = "../x.md" }, http.StatusBadRequest},
		{"relative parent", func(r *CreateRequest) { r.Parent = "dev" }, http.StatusBadRequest},
		{"bad via", func(r *CreateRequest) { r.Via = "auto" }, http.StatusBadRequest},
		{"bad visibility", func(r *CreateRequest) { r.Visibility = "internal" }, http.StatusBadRequest},
		{"bad op id", func(r *CreateRequest) { r.OpID = "a b" }, http.StatusBadRequest},
		{"local without a folder", func(r *CreateRequest) { r.Via = ViaLocal }, http.StatusBadRequest},
	}
	for i, tc := range cases {
		req := w.request(fmt.Sprintf("r%d", i), "fresh")
		tc.edit(&req)
		if _, _, err := w.svc.FromTemplate(context.Background(), req); status(err) != tc.want {
			t.Errorf("%s: %v, want %d", tc.name, err, tc.want)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(taken, "keep.txt")); string(b) != "mine" {
		t.Errorf("a folder that was there was touched")
	}
	// gh signed out: the GitHub path is refused, never swapped for the local one.
	w.set("FAKEGH_LOGIN", "")
	_, _, err := w.svc.FromTemplate(context.Background(), w.request("signedout", "fresh"))
	if status(err) != http.StatusConflict || !strings.Contains(err.Error(), "gh auth login") {
		t.Errorf("signed out: %v", err)
	}
	if strings.Contains(w.calls(), "repo create") {
		t.Errorf("gh was asked to create:\n%s", w.calls())
	}
	if _, err := os.Stat(filepath.Join(w.parent, "fresh")); err == nil {
		t.Errorf("a refused request made its folder")
	}
}

// A clone that fails after the repository was made: the folder Caprock made
// goes, the repository stays, and Retry clones without making it again.
func TestCloneFailsAfterCreateThenRetry(t *testing.T) {
	w := newWorld(t)
	w.corpus()
	w.set("FAKEGH_CLONE_FAIL", "1")
	if _, _, err := w.svc.FromTemplate(context.Background(), w.request("op", "acme")); err != nil {
		t.Fatal(err)
	}
	op := w.wait("op")
	dest := filepath.Join(w.parent, "acme")
	if op.State != projects.OpFailed || !op.Retryable || op.Step != StepClone || !strings.Contains(op.Error, "Could not resolve host") {
		t.Fatalf("%+v", op)
	}
	if _, err := os.Stat(dest); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the folder is still there: %v", err)
	}
	if !strings.Contains(strings.Join(op.Notes, "\n"), "github.com/dspv/acme was made and is kept") {
		t.Errorf("notes: %q", op.Notes)
	}
	if _, err := os.Stat(filepath.Join(w.ghDir, "dspv__acme", "bare.git")); err != nil {
		t.Errorf("the repository on GitHub was touched: %v", err)
	}
	if c := w.calls(); strings.Contains(c, "delete") || strings.Count(c, "repo clone") != cloneTries {
		t.Errorf("calls:\n%s", c)
	}

	w.set("FAKEGH_CLONE_FAIL", "")
	op, err := w.svc.Retry(context.Background(), "op")
	if err != nil || op.State != projects.OpRunning || op.Step != StepClone {
		t.Fatalf("retry: %+v %v", op, err)
	}
	op = w.wait("op")
	if op.State != projects.OpDone || op.ProjectID == 0 || len(op.Notes) != 0 {
		t.Fatalf("after retry %+v", op)
	}
	if strings.Count(w.calls(), "repo create") != 1 {
		t.Errorf("made twice:\n%s", w.calls())
	}
	if _, err := w.svc.Retry(context.Background(), "op"); status(err) != http.StatusConflict {
		t.Errorf("retrying a done op: %v", err)
	}
	if _, err := w.svc.Retry(context.Background(), "nope"); status(err) != http.StatusNotFound {
		t.Errorf("retrying an unknown op: %v", err)
	}
}

// GitHub fills a new repository a moment after making it; an empty clone is
// tried again.
func TestAnEmptyFirstCloneIsTriedAgain(t *testing.T) {
	w := newWorld(t)
	w.corpus()
	w.set("FAKEGH_EMPTY_CLONES", "2")
	if _, _, err := w.svc.FromTemplate(context.Background(), w.request("op", "acme")); err != nil {
		t.Fatal(err)
	}
	op := w.wait("op")
	if op.State != projects.OpDone {
		t.Fatalf("%+v", op)
	}
	if c := w.calls(); strings.Count(c, "repo clone") != 3 {
		t.Errorf("calls:\n%s", c)
	}
	if _, err := os.Stat(filepath.Join(w.parent, "acme", ".ai", "00-index.md")); err != nil {
		t.Errorf("the template's files: %v", err)
	}
}

// A folder the person made empty is emptied again on failure, never removed;
// a name GitHub already has is not retryable.
func TestAnEmptyFolderIsEmptiedNotRemoved(t *testing.T) {
	w := newWorld(t)
	w.corpus()
	dest := filepath.Join(w.parent, "acme")
	if err := os.MkdirAll(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	w.set("FAKEGH_EMPTY_CLONES", "100")
	if _, _, err := w.svc.FromTemplate(context.Background(), w.request("op", "acme")); err != nil {
		t.Fatal(err)
	}
	op := w.wait("op")
	if op.State != projects.OpFailed || !op.Retryable || !op.Removed {
		t.Fatalf("%+v", op)
	}
	if fi, err := os.Stat(dest); err != nil || !fi.IsDir() || !projects.EmptyDir(dest) {
		t.Errorf("the person's folder: %v", err)
	}

	// Another project of the same name on GitHub: final, nothing to retry.
	w.set("FAKEGH_EMPTY_CLONES", "")
	if _, _, err := w.svc.FromTemplate(context.Background(), w.request("op2", "acme")); err != nil {
		t.Fatal(err)
	}
	op = w.wait("op2")
	if op.State != projects.OpFailed || op.Retryable || !strings.Contains(op.Error, "already exists") || op.Step != StepCreate {
		t.Fatalf("%+v", op)
	}
	if _, err := w.svc.Retry(context.Background(), "op2"); status(err) != http.StatusConflict {
		t.Errorf("retry of a final failure: %v", err)
	}
}

// A template whose docs folder is a link out of the project never gets the
// brief written through it.
func TestTheBriefNeverLeavesTheProject(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("git checks links out as files on Windows by default")
	}
	w := newWorld(t)
	outside := t.TempDir()
	src := filepath.Join(t.TempDir(), "evil")
	write(t, filepath.Join(src, "README.md"), "hi")
	if err := os.Symlink(outside, filepath.Join(src, "docs")); err != nil {
		t.Fatal(err)
	}
	w.git(filepath.Dir(src), "init", "-q", src)
	w.git(src, "add", "-A")
	w.git(src, "commit", "-q", "-m", "x")
	w.publish("dspv/evil", "dspv/evil", src, nil)
	req := w.request("op", "acme")
	req.Source.GitHub = "dspv/evil"
	if _, _, err := w.svc.FromTemplate(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	op := w.wait("op")
	if op.State != projects.OpFailed || op.Retryable || op.Step != StepBrief || !strings.Contains(op.Error, "outside the project") {
		t.Fatalf("%+v", op)
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Errorf("written outside: %v", entries)
	}
}

func TestFromAFolderRepository(t *testing.T) {
	w := newWorld(t)
	src := w.corpus()
	write(t, filepath.Join(src, "uncommitted.txt"), "not in the last commit")
	req := w.request("op", "acme")
	req.Via, req.Source = ViaLocal, Source{Folder: src}
	if _, _, err := w.svc.FromTemplate(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	op := w.wait("op")
	if op.State != projects.OpDone || op.Repo != "" {
		t.Fatalf("%+v", op)
	}
	dest := filepath.Join(w.parent, "acme")
	if _, err := os.Stat(filepath.Join(dest, "uncommitted.txt")); err == nil {
		t.Errorf("copied what was not committed")
	}
	if got := w.git(dest, "log", "--format=%s"); got != "Add the project brief\nStart from the Corpus template" {
		t.Errorf("log: %q", got)
	}
	if got := w.git(dest, "remote"); got != "" {
		t.Errorf("remotes: %q", got)
	}
	if strings.Contains(w.calls(), "repo") {
		t.Errorf("gh was used:\n%s", w.calls())
	}
	v, _ := w.projs.Get(context.Background(), op.ProjectID)
	if v.Source != store.ProjectSourceNew {
		t.Errorf("source %q", v.Source)
	}
}

func TestFromAPlainFolder(t *testing.T) {
	w := newWorld(t)
	src := t.TempDir()
	write(t, filepath.Join(src, "TEMPLATE.md"), "x")
	write(t, filepath.Join(src, "node_modules", "big", "index.js"), "x")
	write(t, filepath.Join(src, "sub", "node_modules", "x.js"), "x")
	write(t, filepath.Join(src, "sub", "keep.md"), "x")
	write(t, filepath.Join(src, ".git", "config"), "[core]\n")
	if runtime.GOOS != "windows" {
		if err := os.Symlink("sub/keep.md", filepath.Join(src, "inside")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("../../etc", filepath.Join(src, "outside")); err != nil {
			t.Fatal(err)
		}
	}
	req := w.request("op", "plain")
	req.Via, req.Source = ViaLocal, Source{Folder: src}
	if _, _, err := w.svc.FromTemplate(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	op := w.wait("op")
	if op.State != projects.OpDone {
		t.Fatalf("%+v", op)
	}
	dest := filepath.Join(w.parent, "plain")
	for _, p := range []string{"node_modules", filepath.Join("sub", "node_modules"), "outside"} {
		if _, err := os.Lstat(filepath.Join(dest, p)); err == nil {
			t.Errorf("%s was copied", p)
		}
	}
	if _, err := os.Stat(filepath.Join(dest, "sub", "keep.md")); err != nil {
		t.Error(err)
	}
	if runtime.GOOS != "windows" {
		if to, err := os.Readlink(filepath.Join(dest, "inside")); err != nil || to != "sub/keep.md" {
			t.Errorf("inside link: %q %v", to, err)
		}
		if !strings.Contains(strings.Join(op.Notes, " "), "1 links or special files") {
			t.Errorf("notes %q", op.Notes)
		}
	}

	// Past the limits, nothing is made.
	old := copyFiles
	copyFiles = 1
	t.Cleanup(func() { copyFiles = old })
	req = w.request("op2", "toobig")
	req.Via, req.Source = ViaLocal, Source{Folder: src}
	if _, _, err := w.svc.FromTemplate(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	op = w.wait("op2")
	if op.State != projects.OpFailed || op.Retryable || !op.Removed {
		t.Fatalf("%+v", op)
	}
	if _, err := os.Stat(filepath.Join(w.parent, "toobig")); err == nil {
		t.Errorf("a half copy was left")
	}
	// Into itself: refused.
	req = w.request("op3", "inner")
	req.Via, req.Source, req.Parent = ViaLocal, Source{Folder: src}, src
	if _, _, err := w.svc.FromTemplate(context.Background(), req); status(err) != http.StatusBadRequest {
		t.Errorf("into itself: %v", err)
	}
}

// Without a git identity the project is still made; the brief waits
// uncommitted, and the note says why.
func TestNoGitIdentity(t *testing.T) {
	w := newWorld(t)
	src := w.corpus()
	w.identity(false)
	req := w.request("op", "acme")
	req.Via, req.Source = ViaLocal, Source{Folder: src}
	if _, _, err := w.svc.FromTemplate(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	op := w.wait("op")
	if op.State != projects.OpDone || !strings.Contains(strings.Join(op.Notes, " "), "git has no name and email") {
		t.Fatalf("%+v", op)
	}
	if _, err := os.Stat(filepath.Join(w.parent, "acme", "docs", "source-spec.md")); err != nil {
		t.Error(err)
	}
}

func TestInspect(t *testing.T) {
	w := newWorld(t)
	w.corpus()
	// A clone of it already in the default folder, found by its origin.
	local := filepath.Join(w.parent, "corpus")
	write(t, filepath.Join(local, ".git", "config"), "[remote \"origin\"]\n\turl = git@github.com:dspv/corpus.git\n")
	write(t, filepath.Join(local, "TEMPLATE.md"), "Put it in `docs/local.md`.")

	res, err := w.svc.Inspect(context.Background(), "cybrixcc/corpus", "", w.parent)
	if err != nil {
		t.Fatal(err)
	}
	if res.GitHub != "dspv/corpus" || res.IsTemplate == nil || !*res.IsTemplate || res.Visibility != "public" ||
		res.BriefPath != "docs/source-spec.md" || res.BriefFrom != FromMarker || res.PromptFrom != FromMarker ||
		res.LocalFolder != local || res.SuggestedName != "new-corpus" || res.Error != "" || !strings.Contains(res.TemplateMD, "caprock-template") {
		t.Fatalf("%+v", res)
	}

	// Signed out: says so, and reads the local clone instead.
	w.set("FAKEGH_LOGIN", "")
	res, err = w.svc.Inspect(context.Background(), "dspv/corpus", "", w.parent)
	if err != nil || res.Error == "" || res.BriefPath != "docs/local.md" || res.BriefFrom != FromMention || res.IsTemplate != nil {
		t.Fatalf("signed out: %+v %v", res, err)
	}

	// A folder.
	res, err = w.svc.Inspect(context.Background(), "", local, w.parent)
	if err != nil || res.Folder != local || res.GitHub != "dspv/corpus" || res.BriefPath != "docs/local.md" || res.SuggestedName != "new-corpus" {
		t.Fatalf("folder: %+v %v", res, err)
	}
	for _, bad := range [][2]string{{"", ""}, {"a/b", "/x"}, {"not a repo", ""}, {"", "relative"}} {
		if _, err := w.svc.Inspect(context.Background(), bad[0], bad[1], w.parent); err == nil {
			t.Errorf("%q passed", bad)
		}
	}
}

func TestGHStatus(t *testing.T) {
	w := newWorld(t)
	if st := w.svc.GH(context.Background()); !st.Ready() || st.Login != "dspv" {
		t.Fatalf("%+v", st)
	}
	w.set("FAKEGH_LOGIN", "")
	if st := w.svc.GH(context.Background()); !st.Installed || st.LoggedIn || st.Error == "" {
		t.Fatalf("%+v", st)
	}
	w.svc.GHBin = filepath.Join(t.TempDir(), "gh")
	if st := w.svc.GH(context.Background()); st.Installed {
		t.Fatalf("%+v", st)
	}
}
