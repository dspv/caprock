package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/projects"
)

type fileBody struct {
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
	Binary    bool   `json:"binary"`
	Lang      string `json:"lang"`
}

func writeFile(t *testing.T, path string, b []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func getFile(t *testing.T, s *Server, from, token, id, rel string) (int, fileBody) {
	t.Helper()
	w := call(t, s, from, token, "GET", "/v1/projects/"+id+"/file?path="+url.QueryEscape(rel), "")
	var b fileBody
	if w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), &b); err != nil {
			t.Fatalf("%s: %v %s", rel, err, w.Body.String())
		}
	}
	return w.Code, b
}

// A file reads whole, named by its language; a paired viewer may read it too.
func TestAFileReadsAsText(t *testing.T) {
	s, viewer, _, repo, id := changesServer(t)
	writeFile(t, filepath.Join(repo, "README.md"), []byte("# Hello\n\nWorld\n"))
	writeFile(t, filepath.Join(repo, "cmd", "main.go"), []byte("package main\n"))
	code, b := getFile(t, s, machine, "", id, "README.md")
	if code != http.StatusOK || b.Text != "# Hello\n\nWorld\n" || b.Lang != "markdown" || b.Size != 15 || b.Binary || b.Truncated {
		t.Fatalf("README: %d %+v", code, b)
	}
	if code, b := getFile(t, s, testPhone, viewer, id, "cmd/main.go"); code != http.StatusOK || b.Lang != "go" || b.Path != "cmd/main.go" {
		t.Fatalf("a viewer reading main.go: %d %+v", code, b)
	}
}

// Nothing outside the project is read: not by .., not by an absolute path,
// not through a symlink that points out, to a file or to a folder.
func TestAFileReadStaysInsideTheProject(t *testing.T) {
	s, _, _, repo, id := changesServer(t)
	outside := filepath.Join(filepath.Dir(repo), "secret.txt")
	writeFile(t, outside, []byte("secret\n"))
	for _, rel := range []string{"../secret.txt", "a/../../secret.txt", outside, "/etc/passwd", "./README.md", "", "a//b"} {
		if code, b := getFile(t, s, machine, "", id, rel); code != http.StatusBadRequest {
			t.Errorf("%q: %d %+v, want 400", rel, code, b)
		}
	}
	if err := os.Symlink(outside, filepath.Join(repo, "link.txt")); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	if err := os.Symlink(filepath.Dir(repo), filepath.Join(repo, "up")); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"link.txt", "up/secret.txt"} {
		if code, b := getFile(t, s, machine, "", id, rel); code != http.StatusForbidden || strings.Contains(b.Text, "secret") {
			t.Errorf("%q: %d %+v, want 403", rel, code, b)
		}
	}
	// A link that stays inside is followed.
	writeFile(t, filepath.Join(repo, "docs", "a.md"), []byte("a\n"))
	if err := os.Symlink(filepath.Join(repo, "docs", "a.md"), filepath.Join(repo, "b.md")); err != nil {
		t.Fatal(err)
	}
	if code, b := getFile(t, s, machine, "", id, "b.md"); code != http.StatusOK || b.Text != "a\n" {
		t.Errorf("an inside link: %d %+v", code, b)
	}
}

// Only a regular file that exists.
func TestAFileReadRefusesAFolderAndAMissingFile(t *testing.T) {
	s, _, _, repo, id := changesServer(t)
	writeFile(t, filepath.Join(repo, "docs", "a.md"), []byte("a\n"))
	if code, _ := getFile(t, s, machine, "", id, "docs"); code != http.StatusBadRequest {
		t.Errorf("a folder: %d, want 400", code)
	}
	if code, _ := getFile(t, s, machine, "", id, "nope.md"); code != http.StatusNotFound {
		t.Errorf("a missing file: %d, want 404", code)
	}
	if w := call(t, s, machine, "", "GET", "/v1/projects/9999/file?path=a.md", ""); w.Code != http.StatusNotFound {
		t.Errorf("an unknown project: %d, want 404", w.Code)
	}
}

// A file over the cap comes cut on a line, with its whole size.
func TestALargeFileIsCut(t *testing.T) {
	s, _, _, repo, id := changesServer(t)
	line := strings.Repeat("x", 99) + "\n"
	big := strings.Repeat(line, projects.MaxFileBytes/len(line)+50)
	writeFile(t, filepath.Join(repo, "big.txt"), []byte(big))
	code, b := getFile(t, s, machine, "", id, "big.txt")
	if code != http.StatusOK || !b.Truncated || b.Binary || b.Size != int64(len(big)) {
		t.Fatalf("big: %d truncated=%v binary=%v size=%d", code, b.Truncated, b.Binary, b.Size)
	}
	if len(b.Text) > projects.MaxFileBytes || !strings.HasSuffix(b.Text, "\n") || len(b.Text) < projects.MaxFileBytes-4096 {
		t.Fatalf("cut at %d bytes, ending %q", len(b.Text), b.Text[len(b.Text)-5:])
	}
}

// A binary says so and sends nothing: NUL bytes, or bytes that are not UTF-8.
func TestABinaryFileIsNotSent(t *testing.T) {
	s, _, _, repo, id := changesServer(t)
	writeFile(t, filepath.Join(repo, "img.png"), []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"))
	writeFile(t, filepath.Join(repo, "latin1.txt"), []byte("caf\xe9\n"))
	writeFile(t, filepath.Join(repo, "accents.txt"), []byte("café ζ 日本\n"))
	for _, rel := range []string{"img.png", "latin1.txt"} {
		if code, b := getFile(t, s, machine, "", id, rel); code != http.StatusOK || !b.Binary || b.Text != "" {
			t.Errorf("%s: %d %+v, want binary", rel, code, b)
		}
	}
	if code, b := getFile(t, s, machine, "", id, "accents.txt"); code != http.StatusOK || b.Binary || b.Text != "café ζ 日本\n" {
		t.Errorf("UTF-8 text: %d %+v", code, b)
	}
}

// The list is git's: tracked and new files, not ignored ones.
func TestTheFileListIsGits(t *testing.T) {
	s, viewer, _, repo, id := changesServer(t)
	writeFile(t, filepath.Join(repo, ".gitignore"), []byte("build/\n"))
	writeFile(t, filepath.Join(repo, "README.md"), []byte("r\n"))
	writeFile(t, filepath.Join(repo, "internal", "x.go"), []byte("package x\n"))
	writeFile(t, filepath.Join(repo, "build", "out.bin"), []byte("b"))
	w := call(t, s, testPhone, viewer, "GET", "/v1/projects/"+id+"/files", "")
	var got projects.FileList
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &got) != nil {
		t.Fatalf("files: %d %s", w.Code, w.Body.String())
	}
	joined := strings.Join(got.Files, ",")
	if joined != ".gitignore,README.md,internal/x.go" || got.Truncated {
		t.Fatalf("files: %s", joined)
	}
}

func TestCutTextNeverSplitsACharacter(t *testing.T) {
	b := bytes.Repeat([]byte("é"), projects.MaxFileBytes) // two bytes each, no line breaks
	s, _, _, repo, id := changesServer(t)
	writeFile(t, filepath.Join(repo, "wide.txt"), append([]byte("x"), b...))
	code, got := getFile(t, s, machine, "", id, "wide.txt")
	if code != http.StatusOK || got.Binary || !got.Truncated || len(got.Text) > projects.MaxFileBytes {
		t.Fatalf("wide: %d binary=%v truncated=%v len=%d", code, got.Binary, got.Truncated, len(got.Text))
	}
}
