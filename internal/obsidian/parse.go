// Package obsidian imports an Obsidian vault into Second Brain (ADR-079;
// 03-contracts.md § Obsidian vaults). It reads Markdown files on this
// machine and never writes into the vault: a note becomes a node, its
// [[links]] edges, its #tags topics. The importer makes no network or model
// calls; sharing imported content with agents is a separate opt-in.
package obsidian

import (
	"bytes"
	"path"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/redact"
)

// Note is what one Markdown file says, as the import uses it.
type Note struct {
	// Title is the file's name without .md, as Obsidian names a note.
	Title string
	// Aliases are the frontmatter's aliases (or alias), in order, without
	// duplicates.
	Aliases []string
	// Tags are the frontmatter's tags and the inline #tags, without the
	// '#', in order of first appearance, without duplicates (compared in
	// lower case).
	Tags []string
	// Links are the targets of [[links]], the note's name only: no heading
	// (#…), block (^…), display text (|…), folder or .md. Self-links and
	// empty targets ([[#Heading]]) are left out.
	Links []string
	// Excerpt is the body, frontmatter and Markdown dropped, flattened to
	// one paragraph and clipped (ExcerptRunes): what Second Brain shows as
	// the note's summary.
	Excerpt string
}

// ExcerptRunes is how much of a note's body is kept: Second Brain's summary
// length (store.BrainSummaryRunes).
const ExcerptRunes = 400

// TitleOf is a note's title from its path in the vault: the file name
// without the .md extension.
func TitleOf(rel string) string {
	base := path.Base(strings.ReplaceAll(rel, "\\", "/"))
	if strings.EqualFold(path.Ext(base), ".md") {
		base = base[:len(base)-3]
	}
	return strings.TrimSpace(base)
}

// Parse reads one note. rel is its path in the vault, slash-separated.
func Parse(rel string, data []byte) Note {
	n := Note{Title: TitleOf(rel)}
	if !utf8.Valid(data) {
		data = bytes.ToValidUTF8(data, []byte("\uFFFD"))
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	text = strings.TrimPrefix(text, "\uFEFF")
	fm, body := splitFrontmatter(text)
	tags := newSet()
	aliases := newSet()
	if fm != "" {
		props := frontmatter(fm)
		for _, k := range []string{"aliases", "alias"} {
			for _, a := range props[k] {
				aliases.add(strings.ToLower(a), a)
			}
		}
		for _, k := range []string{"tags", "tag"} {
			for _, t := range props[k] {
				for _, w := range strings.FieldsFunc(t, func(r rune) bool { return r == ',' || unicode.IsSpace(r) }) {
					if t := cleanTag(w); t != "" {
						tags.add(strings.ToLower(t), t)
					}
				}
			}
		}
	}
	links := newSet()
	self := strings.ToLower(n.Title)
	var prose strings.Builder
	eachProseLine(body, func(line string) {
		line = stripInlineCode(line)
		for _, m := range linkRe.FindAllStringSubmatch(line, -1) {
			if t := linkTarget(m[1]); t != "" && strings.ToLower(t) != self {
				links.add(strings.ToLower(t), t)
			}
		}
		// A link's heading ([[#Heading]], [[Note#Part]]) is not a tag.
		for _, m := range tagRe.FindAllStringSubmatch(linkRe.ReplaceAllString(line, " "), -1) {
			if t := cleanTag(m[1]); t != "" {
				tags.add(strings.ToLower(t), t)
			}
		}
		if prose.Len() < ExcerptRunes*8 {
			if s := flatten(line); s != "" {
				prose.WriteString(s)
				prose.WriteByte(' ')
			}
		}
	})
	n.Aliases, n.Tags, n.Links = aliases.list, tags.list, links.list
	// Redacted before the clip (Second Brain's privacy filter, internal/redact):
	// the excerpt is a node's summary and what a search and an agent read.
	n.Excerpt = clip(redact.String(strings.Join(strings.Fields(prose.String()), " ")), ExcerptRunes)
	return n
}

// set keeps the first spelling of each key, in order.
type set struct {
	seen map[string]bool
	list []string
}

func newSet() *set { return &set{seen: map[string]bool{}} }

func (s *set) add(key, v string) {
	v = strings.TrimSpace(v)
	key = strings.TrimSpace(key)
	if v == "" || s.seen[key] {
		return
	}
	s.seen[key] = true
	s.list = append(s.list, v)
}

// splitFrontmatter separates a leading YAML block (--- … ---) from the body.
func splitFrontmatter(text string) (fm, body string) {
	if !strings.HasPrefix(text, "---\n") {
		return "", text
	}
	rest := text[4:]
	for i := 0; i <= len(rest); {
		j := strings.IndexByte(rest[i:], '\n')
		line := rest[i:]
		if j >= 0 {
			line = rest[i : i+j]
		}
		if t := strings.TrimRight(line, " \t"); t == "---" || t == "..." {
			if j < 0 {
				return rest[:i], ""
			}
			return rest[:i], rest[i+j+1:]
		}
		if j < 0 {
			break
		}
		i += j + 1
	}
	// No closing line: not frontmatter.
	return "", text
}

// frontmatter reads the few YAML shapes Obsidian writes for list
// properties: `key: value`, `key: [a, b]`, `key: a, b` and a block list of
// `- a` lines under `key:`. Keys are lower-cased; anything else is ignored.
func frontmatter(fm string) map[string][]string {
	out := map[string][]string{}
	cur := ""
	for _, raw := range strings.Split(fm, "\n") {
		line := strings.TrimRight(raw, " \t")
		trim := strings.TrimSpace(line)
		if trim == "" || strings.HasPrefix(trim, "#") {
			continue
		}
		if strings.HasPrefix(trim, "- ") || trim == "-" {
			if cur != "" {
				if v := unquote(strings.TrimSpace(strings.TrimPrefix(trim, "-"))); v != "" {
					out[cur] = append(out[cur], v)
				}
			}
			continue
		}
		if line[0] == ' ' || line[0] == '\t' {
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			cur = ""
			continue
		}
		cur = strings.ToLower(strings.TrimSpace(k))
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		if strings.HasPrefix(v, "[") && strings.HasSuffix(v, "]") {
			v = v[1 : len(v)-1]
		}
		for _, p := range splitList(v) {
			if p = unquote(strings.TrimSpace(p)); p != "" {
				out[cur] = append(out[cur], p)
			}
		}
	}
	return out
}

// splitList splits at commas outside quotes.
func splitList(v string) []string {
	var out []string
	var q rune
	start := 0
	for i, r := range v {
		switch {
		case q != 0 && r == q:
			q = 0
		case q == 0 && (r == '"' || r == '\''):
			q = r
		case q == 0 && r == ',':
			out = append(out, v[start:i])
			start = i + 1
		}
	}
	return append(out, v[start:])
}

func unquote(s string) string {
	if len(s) >= 2 && (s[0] == '"' && s[len(s)-1] == '"' || s[0] == '\'' && s[len(s)-1] == '\'') {
		return s[1 : len(s)-1]
	}
	return s
}

var (
	// [[target]], [[target|display]], [[target#heading]], ![[embed]].
	linkRe = regexp.MustCompile(`\[\[([^\[\]\n]+?)\]\]`)
	// #tag at the start of a line or after a space, a bracket or a comma:
	// letters, digits, _, - and / (nested tags).
	tagRe        = regexp.MustCompile(`(?:^|[\s(\[,])#([\p{L}\p{N}_\-/]+)`)
	inlineCodeRe = regexp.MustCompile("`[^`\n]*`")
	mdLinkRe     = regexp.MustCompile(`!?\[([^\]\n]*)\]\([^)\n]*\)`)
	embedRe      = regexp.MustCompile(`!\[\[[^\]\n]*\]\]`)
	wikiRe       = regexp.MustCompile(`\[\[([^\]\n|]*?)(?:\|([^\]\n]*))?\]\]`)
	leadRe       = regexp.MustCompile(`^(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|>\s*|\d+[.)]\s+)+`)
	inlineMark   = strings.NewReplacer("**", "", "__", "", "==", "", "~~", "")
)

// linkTarget is the note a [[…]] names: no display text, heading, block,
// folder or extension.
func linkTarget(inner string) string {
	t, _, _ := strings.Cut(inner, "|")
	t, _, _ = strings.Cut(t, "#")
	t, _, _ = strings.Cut(t, "^")
	t = strings.TrimSpace(t)
	if t == "" {
		return ""
	}
	if i := strings.LastIndexByte(t, '/'); i >= 0 {
		t = t[i+1:]
	}
	if strings.EqualFold(path.Ext(t), ".md") {
		t = t[:len(t)-3]
	}
	return strings.TrimSpace(t)
}

// cleanTag is a tag without its '#', nested-tag slashes at the ends
// dropped; "" when it is all digits (Obsidian does not count #2024 as a
// tag) or empty.
func cleanTag(t string) string {
	t = strings.Trim(strings.TrimPrefix(strings.TrimSpace(t), "#"), "/")
	if t == "" {
		return ""
	}
	for _, r := range t {
		if !unicode.IsDigit(r) {
			return t
		}
	}
	return ""
}

// eachProseLine calls fn with every body line outside fenced code blocks
// and comments (%% … %%).
func eachProseLine(body string, fn func(string)) {
	fence := ""
	comment := false
	for _, line := range strings.Split(body, "\n") {
		trim := strings.TrimSpace(line)
		if fence != "" {
			if strings.HasPrefix(trim, fence) {
				fence = ""
			}
			continue
		}
		if strings.HasPrefix(trim, "```") || strings.HasPrefix(trim, "~~~") {
			fence = trim[:3]
			continue
		}
		if comment {
			if strings.Contains(trim, "%%") {
				comment = false
			}
			continue
		}
		if strings.HasPrefix(trim, "%%") {
			if strings.Count(trim, "%%") == 1 {
				comment = true
			}
			continue
		}
		fn(line)
	}
}

func stripInlineCode(line string) string {
	if !strings.Contains(line, "`") {
		return line
	}
	return inlineCodeRe.ReplaceAllString(line, " ")
}

// flatten is one line of prose without its Markdown: list marks, heading
// marks, embeds, link syntax (the shown text kept), emphasis.
func flatten(line string) string {
	s := strings.TrimSpace(line)
	if s == "" || s == "---" || strings.HasPrefix(s, "|") {
		return ""
	}
	s = leadRe.ReplaceAllString(s, "")
	s = embedRe.ReplaceAllString(s, "")
	s = wikiRe.ReplaceAllStringFunc(s, func(m string) string {
		p := wikiRe.FindStringSubmatch(m)
		if p[2] != "" {
			return p[2]
		}
		t, _, _ := strings.Cut(p[1], "#")
		if t == "" {
			return strings.TrimPrefix(p[1], "#")
		}
		return t
	})
	s = mdLinkRe.ReplaceAllString(s, "$1")
	s = inlineMark.Replace(s)
	return strings.TrimSpace(s)
}

// clip shortens s to n runes with an ellipsis when cut.
func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return strings.TrimSpace(string(r[:n-1])) + "…"
}
