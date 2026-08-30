package api

import (
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// The folder picker asks the daemon to list directories on behalf of a web
// page, so what is tested is the boundary — not that a listing comes back.

func TestResolveInRootRefusesEverythingOutside(t *testing.T) {
	root := t.TempDir()
	// EvalSymlinks because macOS puts temp dirs under /var, which is a symlink
	// to /private/var: without this the root itself fails its own check.
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	inside := filepath.Join(root, "dev", "project")
	if err := os.MkdirAll(inside, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	outside, _ = filepath.EvalSymlinks(outside)
	if err := os.MkdirAll(filepath.Join(outside, "secrets"), 0o755); err != nil {
		t.Fatal(err)
	}

	// A symlink inside the root pointing out of it. This is the case a literal
	// string prefix check gets wrong: the path *looks* contained and the
	// listing would come from somewhere else entirely.
	link := filepath.Join(root, "escape")
	if runtime.GOOS != "windows" {
		if err := os.Symlink(outside, link); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("allows a directory inside", func(t *testing.T) {
		got, err := resolveInRoot(root, inside)
		if err != nil {
			t.Fatalf("refused a path inside the root: %v", err)
		}
		if got != inside {
			t.Errorf("got %q, want %q", got, inside)
		}
	})

	t.Run("empty means the root itself", func(t *testing.T) {
		got, err := resolveInRoot(root, "")
		if err != nil || got != root {
			t.Errorf("got (%q, %v), want the root", got, err)
		}
	})

	for _, tc := range []struct {
		name string
		path string
	}{
		{"an absolute path elsewhere", outside},
		{"a traversal out of the root", filepath.Join(root, "..")},
		{"a traversal disguised by a real segment", filepath.Join(inside, "..", "..", "..")},
		{"the filesystem root", string(filepath.Separator)},
		// Windows: a leading separator with no volume is *relative* to the
		// current drive, so IsAbs is false and this used to be joined onto the
		// root instead of refused. Listed on every OS, but only Windows CI can
		// actually fail on it — on Unix these are plain absolute paths caught
		// by the containment check, so removing the guard leaves this green
		// here and red there. The Windows job is the test.
		{"a drive-relative path", `\Windows\System32`},
		{"a drive-relative path, forward slashes", "/Windows/System32"},
		{"a path that does not exist", filepath.Join(root, "nope", "deeper")},
	} {
		t.Run("refuses "+tc.name, func(t *testing.T) {
			if got, err := resolveInRoot(root, tc.path); err == nil {
				t.Errorf("allowed %q → %q", tc.path, got)
			}
		})
	}

	t.Run("refuses a symlink that points out of the root", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("symlinks need elevation on Windows")
		}
		// The literal path is under root and the resolved one is not. Resolving
		// after the check would let this through.
		if got, err := resolveInRoot(root, link); err == nil {
			t.Errorf("followed a symlink out of the root → %q", got)
		}
	})
}

// Two different failures must be indistinguishable to the caller: "outside the
// root" and "does not exist" are the same answer, or the endpoint becomes a way
// to test whether a file exists somewhere the caller may not look.
func TestBrowseDoesNotConfirmWhatExistsOutside(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	outside, _ := filepath.EvalSymlinks(t.TempDir())
	real := filepath.Join(outside, "definitely-here")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}

	_, errReal := resolveInRoot(root, real)
	_, errFake := resolveInRoot(root, filepath.Join(outside, "definitely-not-here"))
	if errReal == nil {
		t.Fatal("a real directory outside the root was allowed")
	}
	if errReal.Error() != errFake.Error() {
		t.Errorf("existing and missing paths give different errors (%v vs %v) — that is an existence oracle", errReal, errFake)
	}
}

// A repository is the thing being looked for, so it is marked; a dotfile
// directory is not, and is exactly what someone probing would want.
func TestBrowseListsRepositoriesAndHidesDotfiles(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{
		filepath.Join(root, "zzz-plain"),
		filepath.Join(root, "project-a", ".git"),
		filepath.Join(root, ".ssh"),
	} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "a-file.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	e := newEnv(t)
	e.setBrowseRoot(t, root)

	var got browseResponse
	if code := e.get(t, "/v1/browse", &got); code != 200 {
		t.Fatalf("GET /v1/browse: %d", code)
	}

	names := map[string]browseEntry{}
	for _, en := range got.Entries {
		names[en.Name] = en
	}
	if _, ok := names[".ssh"]; ok {
		t.Error(".ssh was listed — hidden directories are the ones a prober wants")
	}
	if _, ok := names["a-file.txt"]; ok {
		t.Error("a file was listed; this offers directories only")
	}
	if e, ok := names["project-a"]; !ok || !e.Repo {
		t.Errorf("project-a should be listed and marked as a repository, got %+v", e)
	}
	if e, ok := names["zzz-plain"]; !ok || e.Repo {
		t.Errorf("zzz-plain should be listed and not marked, got %+v", e)
	}
	// Repositories first: the reader is looking for one, and everything else is
	// the route to it. "zzz-plain" sorts last alphabetically, so if ordering
	// were alphabetical alone it would still trail — it leads only if the repo
	// rule is applied.
	if len(got.Entries) > 0 && got.Entries[0].Name != "project-a" {
		t.Errorf("repositories should sort first, got %q", got.Entries[0].Name)
	}
	if got.Parent != "" {
		t.Errorf("at the root, parent must be empty so the UI offers no refused 'up', got %q", got.Parent)
	}
}

// The endpoint must refuse to walk outside the root over HTTP too, not only in
// the resolver — and it must answer the same way for a real path and a made-up
// one.
func TestBrowseEndpointRefusesOutsideTheRoot(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	outside, _ := filepath.EvalSymlinks(t.TempDir())
	if err := os.MkdirAll(filepath.Join(outside, "secrets"), 0o755); err != nil {
		t.Fatal(err)
	}

	e := newEnv(t)
	e.setBrowseRoot(t, root)

	for _, tc := range []struct{ name, dir string }{
		{"a real directory outside", filepath.Join(outside, "secrets")},
		{"a made-up directory outside", filepath.Join(outside, "not-here")},
		{"a traversal", filepath.Join(root, "..", "..")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if code := e.get(t, "/v1/browse?dir="+url.QueryEscape(tc.dir), nil); code != 404 {
				t.Errorf("got %d, want 404 — and the same 404 for every case, or this is an existence oracle", code)
			}
		})
	}
}
