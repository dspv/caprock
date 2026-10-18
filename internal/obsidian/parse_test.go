package obsidian

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseLinksAliasesTagsFrontmatterHeadings(t *testing.T) {
	src := strings.Join([]string{
		"---",
		"aliases:",
		"  - SQLite WAL",
		"  - \"Write-ahead log\"",
		"tags: [storage, db/sqlite]",
		"created: 2026-10-01",
		"---",
		"# Write ahead logging",
		"",
		"Readers do not block the writer. See [[SQLite]] and [[Checkpoints|the checkpoint]].",
		"A heading link: [[Busy timeout#Why five seconds]], a block: [[Busy timeout^abc123]].",
		"In a folder: [[notes/deep/Vacuum.md]]. Embedded: ![[diagram.png]]. Self: [[WAL]].",
		"Empty: [[#Only a heading]]. Tags inline #perf and #perf again, #Perf, and #2024 is not one.",
		"- [ ] a task with #todo",
		"```go",
		"// [[NotALink]] #notatag",
		"```",
		"Inline `[[Code]] #code` stays out.",
		"%% [[Hidden]] #hidden %%",
		"url https://example.com/page#anchor is not a tag",
	}, "\n")
	n := Parse("storage/WAL.md", []byte(src))
	if n.Title != "WAL" {
		t.Fatalf("title %q", n.Title)
	}
	if want := []string{"SQLite WAL", "Write-ahead log"}; !reflect.DeepEqual(n.Aliases, want) {
		t.Fatalf("aliases %q, want %q", n.Aliases, want)
	}
	if want := []string{"storage", "db/sqlite", "perf", "todo"}; !reflect.DeepEqual(n.Tags, want) {
		t.Fatalf("tags %q, want %q", n.Tags, want)
	}
	if want := []string{"SQLite", "Checkpoints", "Busy timeout", "Vacuum", "diagram.png"}; !reflect.DeepEqual(n.Links, want) {
		t.Fatalf("links %q, want %q", n.Links, want)
	}
	if !strings.HasPrefix(n.Excerpt, "Write ahead logging Readers do not block the writer. See SQLite and the checkpoint.") {
		t.Fatalf("excerpt %q", n.Excerpt)
	}
	for _, bad := range []string{"NotALink", "Hidden", "diagram", "---", "#"} {
		if strings.Contains(n.Excerpt, bad) && bad != "#" {
			t.Fatalf("excerpt keeps %q: %q", bad, n.Excerpt)
		}
	}
}

func TestParseFrontmatterShapes(t *testing.T) {
	cases := []struct {
		name, src       string
		aliases, tags   []string
		excerptContains string
	}{
		{"scalar", "---\nalias: Kyoto trip\ntags: travel, japan\n---\nbody", []string{"Kyoto trip"}, []string{"travel", "japan"}, "body"},
		{"inline list quoted", "---\naliases: ['Ελληνικά', \"a, b\"]\ntag: '#greek'\n---\nκείμενο", []string{"Ελληνικά", "a, b"}, []string{"greek"}, "κείμενο"},
		{"space separated tags", "---\ntags: one two\n---\n", nil, []string{"one", "two"}, ""},
		{"no closing line is body", "---\naliases: X\nno end", nil, nil, "aliases: X no end"},
		{"crlf and bom", "\uFEFF---\r\naliases:\r\n- Café\r\n---\r\nhello #crlf\r\n", []string{"Café"}, []string{"crlf"}, "hello #crlf"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			n := Parse("x.md", []byte(c.src))
			if !reflect.DeepEqual(n.Aliases, c.aliases) {
				t.Fatalf("aliases %q, want %q", n.Aliases, c.aliases)
			}
			if !reflect.DeepEqual(n.Tags, c.tags) {
				t.Fatalf("tags %q, want %q", n.Tags, c.tags)
			}
			if !strings.Contains(n.Excerpt, c.excerptContains) {
				t.Fatalf("excerpt %q lacks %q", n.Excerpt, c.excerptContains)
			}
		})
	}
}

func TestParseExcerptIsClipped(t *testing.T) {
	n := Parse("long.md", []byte(strings.Repeat("word ", 500)))
	if r := []rune(n.Excerpt); len(r) != ExcerptRunes || r[len(r)-1] != '…' {
		t.Fatalf("excerpt %d runes: %q", len(r), n.Excerpt[len(n.Excerpt)-10:])
	}
}

func TestTitleOf(t *testing.T) {
	for in, want := range map[string]string{"a/b/Note.md": "Note", "Note.MD": "Note", "東京タワー.md": "東京タワー", "x/README": "README"} {
		if got := TitleOf(in); got != want {
			t.Fatalf("TitleOf(%q) = %q, want %q", in, got, want)
		}
	}
}
