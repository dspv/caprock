package api

import (
	"testing"

	"github.com/dspv/caprock/internal/store"
)

// The same cases as ui/src/lib/filepaths.test.ts: the two parsers agree.
func TestPathsAsNames(t *testing.T) {
	drop := "/Users/me/Library/Application Support/caprock/paste/drop-1795599021771608000/Some_File_Name.pdf"
	for _, c := range []struct{ in, want string }{
		{`"` + drop + `" how is my CV?`, "Some_File_Name.pdf how is my CV?"},
		{`read '/tmp/a b/notes.md' now`, "read notes.md now"},
		{`"/tmp/the \"final\" cut.pdf" ok`, `the "final" cut.pdf ok`},
		{`"C:\Users\me\Downloads\My CV.pdf" check`, "My CV.pdf check"},
		{`see C:\work\spec.docx and D:/data/rows.csv.`, "see spec.docx and rows.csv."},
		{`compare /Users/me/My\ Report.pdf with the old one.`, "compare My Report.pdf with the old one."},
		{`(see /srv/app/main.go)`, "(see main.go)"},
		{`"/a/1.pdf" "/a/2.md" /b/c/3.csv compare them`, "1.pdf 2.md 3.csv compare them"},
		{`"/x/20.02.57.pdf""/x/20.03.03.pdf"`, "20.02.57.pdf20.03.03.pdf"},
		{`"/tmp/résumé 日本 🙂.pdf" ok`, "résumé 日本 🙂.pdf ok"},
		// Left as they are.
		{"https://example.com/docs/a.pdf", "https://example.com/docs/a.pdf"},
		{"and/or", "and/or"},
		{"src/lib/attach.ts", "src/lib/attach.ts"},
		{"/v1/events/{id}/video", "/v1/events/{id}/video"},
		{"/api/users?id=1.json", "/api/users?id=1.json"},
		{"/b.pdf", "/b.pdf"},
		{"//server/share/a.pdf", "//server/share/a.pdf"},
		{`"/Users/me/project"`, `"/Users/me/project"`},
		{"/usr/lib/libc.so.6", "/usr/lib/libc.so.6"},
		{"/Users/me/.zshrc", "/Users/me/.zshrc"},
		{"μήνυμα 日本 🙂", "μήνυμα 日本 🙂"},
		{"", ""},
	} {
		if got := pathsAsNames(c.in); got != c.want {
			t.Errorf("pathsAsNames(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// A long dropped path no longer eats the 120 runes: the description keeps
// the file's name and the words (the sidebar said "Application
// Support/caprock/paste/drop-179", 2026-11-27).
func TestDescribeCutsADroppedFileToItsName(t *testing.T) {
	long := "/var/folders/7h/xtqjh6hj6q78cdlsbvltkvtw0000gn/T/caprock-e2e-NOYblB/Library/Application Support/caprock/paste/drop-1795599021771608000/Some_File_Name.pdf"
	got, src := describeWith(store.Session{}, func() ([]string, error) {
		return []string{`"` + long + `"`, `"` + long + `" how is my CV?`}, nil
	})
	if got != "Some_File_Name.pdf how is my CV?" || src != DescriptionPrompt {
		t.Fatalf("describe = %q (%s)", got, src)
	}
}
