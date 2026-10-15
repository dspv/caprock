package templates

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func ptr(s string) *string { return &s }

func TestBriefPathRules(t *testing.T) {
	good := []string{"docs/brief.md", "docs/source-spec.md", "brief.md", "a/b/c/d.txt", ".ai/brief.md", "docs/ταυτότητα.md"}
	for _, p := range good {
		if err := CheckBriefPath(p); err != nil {
			t.Errorf("%q: %v", p, err)
		}
	}
	bad := []string{
		"", "/etc/passwd", `\docs\brief.md`, `docs\brief.md`, "C:/brief.md", "c:brief.md",
		"../brief.md", "docs/../../x.md", "./brief.md", "docs//brief.md", "docs/",
		".git/config", ".GIT/hooks/pre-commit", "docs/.git/x", "CON", "docs/con.md", "docs/LPT1.txt", "aux",
		"docs/brief.", "docs/brief ", "docs/a:b.md", "docs/a*b.md", "docs/a\x01b.md",
		strings.Repeat("a", 257),
	}
	for _, p := range bad {
		if err := CheckBriefPath(p); err == nil {
			t.Errorf("%q passed", p)
		}
	}
}

func TestPromptRules(t *testing.T) {
	if err := CheckPrompt("Read TEMPLATE.md. Build the .ai/ corpus from {brief}."); err != nil {
		t.Error(err)
	}
	for _, p := range []string{"", "   ", "Use {name} here", "x\x00y", strings.Repeat("a", MaxPrompt+1)} {
		if CheckPrompt(p) == nil {
			t.Errorf("%q passed", p)
		}
	}
	// JSON in a prompt is not a variable.
	if err := CheckPrompt(`Write {"a": 1} into {brief}`); err != nil {
		t.Error(err)
	}
}

func TestStoreKeepsTheListInOneFile(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, StateFile)
	st := &Store{File: file, Log: quiet()}
	if got := st.List(); len(got) != 0 {
		t.Fatalf("a new list is not empty: %v", got)
	}
	folder := t.TempDir()
	in := Input{Name: ptr("  Corpus  "), GitHub: ptr("dspv/corpus"), BriefPath: ptr("docs/source-spec.md"), Prompt: ptr("Build from {brief}.")}
	tpl, err := st.Add(in)
	if err != nil {
		t.Fatal(err)
	}
	if tpl.Name != "Corpus" || len(tpl.ID) != 8 || tpl.CreatedAt == 0 {
		t.Fatalf("added %+v", tpl)
	}
	for name, in := range map[string]Input{
		"neither":      {Name: ptr("x"), BriefPath: ptr("b.md"), Prompt: ptr("p")},
		"bad github":   {Name: ptr("x"), GitHub: ptr("https://github.com/a/b"), BriefPath: ptr("b.md"), Prompt: ptr("p")},
		"dot repo":     {Name: ptr("x"), GitHub: ptr("a/.."), BriefPath: ptr("b.md"), Prompt: ptr("p")},
		"no folder":    {Name: ptr("x"), Folder: ptr(filepath.Join(folder, "missing")), BriefPath: ptr("b.md"), Prompt: ptr("p")},
		"relative":     {Name: ptr("x"), Folder: ptr("dev/corpus"), BriefPath: ptr("b.md"), Prompt: ptr("p")},
		"bad brief":    {Name: ptr("x"), GitHub: ptr("a/b"), BriefPath: ptr(".git/x"), Prompt: ptr("p")},
		"bad variable": {Name: ptr("x"), GitHub: ptr("a/b"), BriefPath: ptr("b.md"), Prompt: ptr("{who}")},
		"bad agent":    {Name: ptr("x"), GitHub: ptr("a/b"), BriefPath: ptr("b.md"), Prompt: ptr("p"), Agent: ptr("vim")},
		"long name":    {Name: ptr(strings.Repeat("é", 81)), GitHub: ptr("a/b"), BriefPath: ptr("b.md"), Prompt: ptr("p")},
	} {
		if _, err := st.Add(in); err == nil {
			t.Errorf("%s: added", name)
		}
	}
	up, err := st.Update(tpl.ID, Input{Folder: ptr(folder), GitHub: ptr("")})
	if err != nil || up.Folder != folder || up.GitHub != "" || up.Name != "Corpus" {
		t.Fatalf("update: %+v %v", up, err)
	}
	if _, err := st.Update("deadbeef", Input{}); !errors.Is(err, ErrNotFound) {
		t.Errorf("update of an unknown id: %v", err)
	}
	st.MarkUsed("Corpus")

	// Read back by a fresh store: the file is the list.
	again := &Store{File: file, Log: quiet()}
	got := again.List()
	if len(got) != 1 || got[0].ID != tpl.ID || got[0].UsedAt == 0 || got[0].Folder != folder {
		t.Fatalf("read back %+v", got)
	}
	// A folder moved away since is kept, not forgotten.
	if err := os.Remove(folder); err != nil {
		t.Fatal(err)
	}
	if got := (&Store{File: file, Log: quiet()}).List(); len(got) != 1 {
		t.Fatalf("a template whose folder moved was dropped: %+v", got)
	}
	if err := again.Delete(tpl.ID); err != nil {
		t.Fatal(err)
	}
	if err := again.Delete(tpl.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("second delete: %v", err)
	}
	if got := (&Store{File: file, Log: quiet()}).List(); len(got) != 0 {
		t.Fatalf("after delete %+v", got)
	}
}

func TestStoreHoldsFifty(t *testing.T) {
	st := &Store{Log: quiet()}
	in := Input{Name: ptr("t"), GitHub: ptr("a/b"), BriefPath: ptr("b.md"), Prompt: ptr("p")}
	for i := 0; i < MaxTemplates; i++ {
		if _, err := st.Add(in); err != nil {
			t.Fatal(i, err)
		}
	}
	if _, err := st.Add(in); !errors.Is(err, ErrFull) {
		t.Fatalf("the 51st: %v", err)
	}
}

// A file that is not the list is set aside, never overwritten, and the list
// starts empty.
func TestACorruptFileIsSetAside(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, StateFile)
	if err := os.WriteFile(file, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	st := &Store{File: file, Log: quiet()}
	if got := st.List(); len(got) != 0 {
		t.Fatalf("%+v", got)
	}
	matches, _ := filepath.Glob(file + ".bad-*")
	if len(matches) != 1 {
		t.Fatalf("set aside: %v", matches)
	}
	if b, _ := os.ReadFile(matches[0]); string(b) != "{not json" {
		t.Fatalf("the bad file changed: %q", b)
	}
	if _, err := st.Add(Input{Name: ptr("t"), GitHub: ptr("a/b"), BriefPath: ptr("b.md"), Prompt: ptr("p")}); err != nil {
		t.Fatal(err)
	}
	var f fileShape
	b, _ := os.ReadFile(file)
	if err := json.Unmarshal(b, &f); err != nil || len(f.Templates) != 1 {
		t.Fatalf("new file %s %v", b, err)
	}
}

func TestMarker(t *testing.T) {
	md := "\ufeff\r\n<!-- caprock-template\r\nbrief: docs/source-spec.md\r\nprompt: Read TEMPLATE.md.\r\nBuild the .ai/ corpus from {brief}.\r\n-->\r\n# How to build the corpus\r\n"
	m, ok := ParseMarker(md)
	if !ok || m.Brief != "docs/source-spec.md" || m.Prompt != "Read TEMPLATE.md.\nBuild the .ai/ corpus from {brief}." {
		t.Fatalf("%v %+v", ok, m)
	}
	for _, md := range []string{
		"# Title\n<!-- caprock-template\nbrief: a.md\n-->", // not at the top
		"<!-- caprock-templates\nbrief: a.md\n-->",         // another comment
		"<!-- caprock-template\nbrief: a.md\n",             // never closed
	} {
		if _, ok := ParseMarker(md); ok {
			t.Errorf("%q read as a marker", md)
		}
	}
	// A brief that would escape, and a prompt with an unknown variable, are
	// left for the defaults.
	m, ok = ParseMarker("<!-- caprock-template\nbrief: ../x.md\nprompt: Hi {name}\n-->")
	if !ok || m.Brief != "" || m.Prompt != "" {
		t.Fatalf("%+v", m)
	}
}

func TestDefaults(t *testing.T) {
	cases := []struct {
		name, tmd, readme                    string
		brief, briefFrom, prompt, promptFrom string
	}{
		{"marker", "<!-- caprock-template\nbrief: docs/spec.md\nprompt: Go {brief}\n-->", "", "docs/spec.md", FromMarker, "Go {brief}", FromMarker},
		{"mention in TEMPLATE.md", "Drop it in `docs/source-spec.md`.", "Use `docs/other.md`", "docs/source-spec.md", FromMention, DefaultPromptWithTemplateMD, FromDefault},
		{"mention in README", "", "2. Drop your spec in as `docs/source-spec.md`. Any format", "docs/source-spec.md", FromMention, DefaultPrompt, FromDefault},
		{"nothing", "", "# Hello", DefaultBriefPath, FromDefault, DefaultPrompt, FromDefault},
		{"marker brief only", "<!-- caprock-template\nbrief: docs/x.md\n-->\nSee `docs/y.md`", "", "docs/x.md", FromMarker, DefaultPromptWithTemplateMD, FromDefault},
	}
	for _, tc := range cases {
		b, bf, p, pf := Defaults(tc.tmd, tc.readme)
		if b != tc.brief || bf != tc.briefFrom || p != tc.prompt || pf != tc.promptFrom {
			t.Errorf("%s: %q %q %q %q", tc.name, b, bf, p, pf)
		}
	}
}
