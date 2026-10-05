package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// pasteServer is a daemon with a data directory, and a function that posts a
// file to it the way the terminal does.
func pasteServer(t *testing.T) (string, func(name, mime string, data []byte) *httptest.ResponseRecorder) {
	t.Helper()
	e := newEnv(t)
	dir := t.TempDir()
	h := New(Deps{Store: e.st, Version: "t", Token: "tok",
		Now: func() time.Time { return e.now }, DataDir: dir})
	return dir, func(name, mime string, data []byte) *httptest.ResponseRecorder {
		b, _ := json.Marshal(map[string]string{"name": name, "type": mime, "data": base64.StdEncoding.EncodeToString(data)})
		req := httptest.NewRequest("POST", "/v1/paste", bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		return rr
	}
}

func pastedPath(t *testing.T, rr *httptest.ResponseRecorder) string {
	t.Helper()
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rr.Code, rr.Body)
	}
	var got struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	return got.Path
}

// A document dragged from Finder arrives with its name and, for most of what
// people drop, an empty type. Until 2026-10-04 the endpoint read only the
// type, so Markdown, CSV, JSON and every source file came back 415.
func TestPasteAcceptsByExtensionWhenTheTypeIsEmpty(t *testing.T) {
	_, post := pasteServer(t)
	for _, name := range []string{
		"notes.md", "README.markdown", "data.csv", "table.tsv", "conf.json", "events.jsonl",
		"ci.yaml", "ci.yml", "Cargo.toml", "setup.ini", "server.log", "schema.sql",
		"main.go", "app.py", "index.ts", "View.tsx", "a.js", "b.jsx", "c.rb", "lib.rs",
		"Main.java", "App.kt", "App.swift", "x.c", "x.h", "x.cpp", "x.hpp", "x.cs", "x.php",
		"build.sh", "fix.diff", "fix.patch", "page.html", "page.htm", "feed.xml", "doc.rst",
		"letter.rtf", "contract.docx", "budget.xlsx", "deck.pptx", "a.odt", "b.ods",
		"plain.txt", "scan.pdf", "shot.png", "photo.jpg", "photo.jpeg", "anim.gif", "pic.webp",
		"style.css", "REPORT.PDF",
	} {
		rr := post(name, "", []byte("x"))
		if rr.Code != http.StatusOK {
			t.Errorf("%s with no type: %d %s", name, rr.Code, rr.Body)
		}
	}
}

// A clipboard image often has no usable name; its MIME type still decides.
func TestPasteFallsBackToTheMIMEType(t *testing.T) {
	_, post := pasteServer(t)
	cases := map[string]string{
		"image/png":                ".png",
		"image/jpeg":               ".jpg",
		"application/pdf":          ".pdf",
		"text/plain;charset=utf-8": ".txt",
		"text/markdown":            ".md",
		"TEXT/CSV":                 ".csv",
		"application/json":         ".json",
		"image/webp":               ".webp",
		"image/gif; x=1":           ".gif",
	}
	for mime, ext := range cases {
		p := pastedPath(t, post("", mime, []byte("x")))
		if filepath.Base(p) != "file"+ext {
			t.Errorf("%q stored as %q, want file%s", mime, filepath.Base(p), ext)
		}
	}
}

// Unknown is refused by default, and the refusal says what is accepted — the
// terminal prints it, and "unsupported file type" alone left the owner
// guessing.
func TestPasteRefusesTheUnknownAndSaysWhatIsAccepted(t *testing.T) {
	_, post := pasteServer(t)
	for _, c := range []struct{ name, mime string }{
		{"setup.exe", ""},
		{"setup.exe", "application/x-msdownload"},
		{"run.bat", ""},
		{"run.ps1", "text/plain-not-really"},
		{"Makefile", ""},
		{"", ""},
		{"", "application/x-sh"},
		{"photo.heic", "image/heic"},
	} {
		rr := post(c.name, c.mime, []byte("x"))
		if rr.Code != http.StatusUnsupportedMediaType {
			t.Errorf("%q %q: status %d, want 415", c.name, c.mime, rr.Code)
			continue
		}
		var e struct{ Error, Detail string }
		if err := json.Unmarshal(rr.Body.Bytes(), &e); err != nil {
			t.Fatalf("refusal is not JSON: %s", rr.Body)
		}
		if !strings.Contains(e.Detail, "pdf") || !strings.Contains(e.Detail, "md") || !strings.Contains(e.Detail, "csv") {
			t.Errorf("refusal does not say what is accepted: %+v", e)
		}
	}
	rr := post("setup.exe", "", []byte("x"))
	if !strings.Contains(rr.Body.String(), ".exe") {
		t.Errorf("refusal does not name what was refused: %s", rr.Body)
	}
}

// The name the user gave the file survives, so Claude reads `contract.pdf`
// rather than `20261004-101112-ab12cd34.pdf` — in a directory of its own, so
// two pastes of one name never collide.
func TestPasteKeepsTheNameInADirectoryOfItsOwn(t *testing.T) {
	dir, post := pasteServer(t)
	a := pastedPath(t, post("Contract Notes.md", "", []byte("one")))
	b := pastedPath(t, post("Contract Notes.md", "", []byte("two")))
	if filepath.Base(a) != "Contract Notes.md" {
		t.Errorf("name = %q, want the original", filepath.Base(a))
	}
	if a == b {
		t.Fatalf("two pastes of one name share a path: %q", a)
	}
	for _, p := range []string{a, b} {
		// paste/<timestamp>-<random>/<name>, exactly one level down.
		if filepath.Dir(filepath.Dir(p)) != filepath.Join(dir, "paste") {
			t.Errorf("%q is not paste/<dir>/<name>", p)
		}
	}
	if got, _ := os.ReadFile(a); string(got) != "one" {
		t.Errorf("first paste overwritten: %q", got)
	}
	if runtime.GOOS != "windows" {
		// Mode bits mean nothing on Windows; elsewhere they are the guarantee
		// that nothing written here is executable.
		st, err := os.Stat(b)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != 0o600 {
			t.Errorf("mode %v, want 0600", st.Mode().Perm())
		}
		st, _ = os.Stat(filepath.Dir(b))
		if st.Mode().Perm() != 0o700 {
			t.Errorf("dir mode %v, want 0700", st.Mode().Perm())
		}
	}
}

// Nothing the caller sends can leave the paste directory or choose an
// extension the table does not hold.
func TestPasteNameIsSanitised(t *testing.T) {
	long := strings.Repeat("a", 300) + ".md"
	cases := []struct {
		name, mime, want string
	}{
		{"../../../../etc/passwd", "image/png", "passwd.png"},
		{`..\..\Windows\System32\evil.md`, "", "evil.md"},
		{"/tmp/evil.sh", "", "evil.sh"},
		{"C:/Users/x/Desktop/report.pdf", "", "report.pdf"},
		{"..", "text/plain", "file.txt"},
		{"...md", "", "file.md"},
		{".md", "", "file.md"},
		{".bashrc", "text/plain", "bashrc.txt"},
		{"", "image/png", "file.png"},
		{"   ", "image/png", "file.png"},
		{"a\x00b\nc\x1b[31m.md", "", "a_b_c_31m.md"},
		{`he said "hi".md`, "", "he said _hi_.md"},
		// The point of this case is non-ASCII text: a Greek name collapses
		// to one underscore, keeping the extension.
		{"Σύμβαση μίσθωσης.pdf", "", "_ _.pdf"},
		{"日本語.csv", "", "_.csv"},
		{"résumé.docx", "", "r_sum_.docx"},
		// A wrong extension stays in the stem and an allowed one is appended;
		// a missing one comes from the type.
		{"scan.heic", "image/png", "scan.heic.png"},
		{"tool.exe", "application/pdf", "tool.exe.pdf"},
		{"notes", "text/markdown", "notes.md"},
		{"NOTES.MD", "", "NOTES.md"},
		// Windows device names would open the device there.
		{"CON.txt", "", "_CON.txt"},
		{"nul.md", "", "_nul.md"},
		{"com1.json", "", "_com1.json"},
		{"console.txt", "", "console.txt"},
		{"trailing. .md", "", "trailing.md"},
	}
	for _, c := range cases {
		got, ok := pasteName(c.name, c.mime)
		if !ok || got != c.want {
			t.Errorf("pasteName(%q, %q) = %q, %v; want %q", c.name, c.mime, got, ok, c.want)
		}
	}
	got, ok := pasteName(long, "")
	if !ok || len(got) != pasteNameMax+len(".md") || !strings.HasSuffix(got, ".md") {
		t.Errorf("long name = %q (%d), want %d a's and .md", got, len(got), pasteNameMax)
	}

	// And end to end: the stored path is always paste/<dir>/<clean name>.
	dir, post := pasteServer(t)
	p := pastedPath(t, post("../../../../etc/passwd", "image/png", []byte("x")))
	if filepath.Dir(filepath.Dir(p)) != filepath.Join(dir, "paste") || filepath.Base(p) != "passwd.png" {
		t.Errorf("path escaped the paste directory: %q", p)
	}
}

// Over the cap is refused rather than truncated, and an empty file is not a
// file.
func TestPasteSizeLimits(t *testing.T) {
	_, post := pasteServer(t)
	if rr := post("big.md", "", bytes.Repeat([]byte("x"), pasteLimit+1)); rr.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("an oversized file: %d", rr.Code)
	}
	if rr := post("exact.md", "", bytes.Repeat([]byte("x"), pasteLimit)); rr.Code != http.StatusOK {
		t.Errorf("a file at the cap: %d", rr.Code)
	}
	if rr := post("empty.md", "", nil); rr.Code != http.StatusBadRequest {
		t.Errorf("an empty file: %d", rr.Code)
	}
}
