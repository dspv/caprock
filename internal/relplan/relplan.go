// Package relplan reads what a repository has merged and not yet released,
// and how its releases have been spaced, from the machine alone (ADR-064).
//
// The Work board's release column asks two questions: what is waiting to
// ship, and how often does this repository ship. Both are answered from git
// as it stands on this machine: the CHANGELOG's [Unreleased] section on the
// remote's default branch (`git show origin/HEAD:CHANGELOG.md`), plus the
// changelog fragments in changes/unreleased/ on that branch for a repository
// that keeps one file per change, and the newest tags. Nothing here fetches: the answer is only as fresh as the
// user's last `git fetch`, and the board says so. No release time is
// predicted; the median gap is a measured spacing, shown as one.
package relplan

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/hidewin"
)

const (
	// MaxItems is how many [Unreleased] entries are returned; the count
	// says how many there are.
	MaxItems = 30
	// TagsRead is how many of the newest tags are read: ten gaps.
	TagsRead = 11
	// MinGaps is how many gaps between releases a median needs (rule 6):
	// with fewer, the spacing is anecdote, not a measure.
	MinGaps = 3
	// gitTimeout bounds each git read.
	gitTimeout = 3 * time.Second
)

// Unreleased is the CHANGELOG's [Unreleased] section, summed up.
type Unreleased struct {
	// Items are the first lines of its top-level bullets, in order, at most
	// MaxItems; nested bullets and sub-headings are not items.
	Items []string
	// Count is how many top-level bullets the section has.
	Count int
	// Kinds counts the bullets by their Keep a Changelog kind — the `### `
	// heading they sit under in the section, a fragment's `kind:` — for the
	// six kinds only (Kinds); a bullet under no such heading counts in Count
	// alone. Nil when no bullet has a kind. The release plan predicts the
	// next version from it: an Added entry is a minor release.
	Kinds map[string]int
	// Entries are the same bullets whole, at most MaxItems: the text with
	// its continuation lines, in plain words (Plain), its scope and kind.
	// The right panel's release notes draw them.
	Entries []Entry
}

// Entry is one changelog bullet as release notes say it.
type Entry struct {
	// Text is the bullet whole, continuation lines joined, the leading
	// `**scope:**` taken off and markdown emphasis dropped; at most
	// EntryRunes runes.
	Text string
	// Scope is the `**scope:**` the bullet starts with, "" without one.
	Scope string
	// Kind is its Keep a Changelog kind, "" when none is said.
	Kind string
	// File is the fragment file it came from (base name), "" for a
	// CHANGELOG bullet.
	File string
}

// EntryRunes bounds an entry's text: release notes say it in two lines.
const EntryRunes = 280

// Kinds are Keep a Changelog's six kinds, the ones Unreleased.Kinds counts.
var Kinds = []string{"Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"}

// kindOf is the kind a `### ` heading or a `kind:` value names, "" for
// anything else; case is ignored and the canonical spelling returned.
func kindOf(s string) string {
	s = strings.TrimSpace(s)
	for _, k := range Kinds {
		if strings.EqualFold(s, k) {
			return k
		}
	}
	return ""
}

// add counts one bullet into u, under kind when it has one: item is its
// first line, whole is the bullet with its continuation lines.
func (u *Unreleased) add(item, whole, kind, file string) {
	u.Count++
	if len(u.Items) < MaxItems {
		u.Items = append(u.Items, item)
		scope, text := Plain(whole)
		u.Entries = append(u.Entries, Entry{Text: text, Scope: scope, Kind: kind, File: file})
	}
	if kind != "" {
		if u.Kinds == nil {
			u.Kinds = map[string]int{}
		}
		u.Kinds[kind]++
	}
}

// ParseUnreleased reads the [Unreleased] section of a Keep a Changelog file.
// ok is false when there is no such section; an empty section is ok with no
// items. The heading may carry more after the bracket ("## [Unreleased] -
// …"), and CRLF line ends read as LF.
func ParseUnreleased(changelog []byte) (Unreleased, bool) {
	var u Unreleased
	lines, found := section(changelog, func(h string) bool {
		return strings.HasPrefix(strings.ToLower(h), "[unreleased]")
	})
	for _, b := range bullets(lines) {
		u.add(b.first, b.whole, b.kind, "")
	}
	return u, found
}

// ParseRelease reads the newest released section of a Keep a Changelog
// file: the first `## [x.y.z]` heading that is not [Unreleased]. version is
// its bracketed name ("0.183.0"); ok is false when there is none.
func ParseRelease(changelog []byte) (version string, u Unreleased, ok bool) {
	lines, found := section(changelog, func(h string) bool {
		if !strings.HasPrefix(h, "[") || strings.HasPrefix(strings.ToLower(h), "[unreleased]") {
			return false
		}
		end := strings.IndexByte(h, ']')
		if end < 2 {
			return false
		}
		version = h[1:end]
		return true
	})
	if !found {
		return "", Unreleased{}, false
	}
	for _, b := range bullets(lines) {
		u.add(b.first, b.whole, b.kind, "")
	}
	return version, u, true
}

// section is the lines under the first `## ` heading match takes (its text
// after "## ", trimmed), up to the next `## `; CRLF read as LF.
func section(changelog []byte, match func(heading string) bool) ([]string, bool) {
	var out []string
	in, found := false, false
	sc := bufio.NewScanner(bytes.NewReader(changelog))
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if strings.HasPrefix(line, "## ") {
			if in {
				break
			}
			if match(strings.TrimSpace(line[3:])) {
				in, found = true, true
			}
			continue
		}
		if in {
			out = append(out, line)
		}
	}
	return out, found
}

type bullet struct {
	first, whole, kind string
}

// bullets are the top-level bullets in lines: a `### ` heading sets the kind
// of those under it; a top-level bullet starts at the first column, its
// indented continuation lines are part of it, and a nested bullet (and what
// follows it) is not.
func bullets(lines []string) []bullet {
	var out []bullet
	kind := ""
	open := false // the last bullet may still take continuation lines
	for _, line := range lines {
		if h, ok := strings.CutPrefix(line, "### "); ok {
			kind, open = kindOf(h), false
			continue
		}
		if strings.HasPrefix(line, "- ") || strings.HasPrefix(line, "* ") {
			text := strings.TrimSpace(line[2:])
			if text == "" {
				open = false
				continue
			}
			out = append(out, bullet{first: text, whole: text, kind: kind})
			open = true
			continue
		}
		t := strings.TrimSpace(line)
		switch {
		case t == "" || strings.HasPrefix(line, "#"):
			open = false
		case strings.HasPrefix(t, "- ") || strings.HasPrefix(t, "* "):
			open = false // a nested bullet
		case open && line != t:
			out[len(out)-1].whole += " " + t
		}
	}
	return out
}

var (
	scopeRe  = regexp.MustCompile(`^\*\*([^*]+?):\*\*\s*`)
	strongRe = regexp.MustCompile(`\*\*([^*]+?)\*\*`)
	emRe     = regexp.MustCompile(`(^|[^\w*])\*([^*\s][^*]*?)\*`)
	linkRe   = regexp.MustCompile(`\[([^\]]+)\]\([^)]*\)`)
)

// Plain is a changelog bullet in plain words: its leading `**scope:**` taken
// off and returned apart, bold, italics, code ticks and link targets dropped
// (a link keeps its words), cut to EntryRunes runes with an ellipsis.
func Plain(s string) (scope, text string) {
	s = strings.TrimSpace(s)
	if m := scopeRe.FindStringSubmatch(s); m != nil {
		scope, s = strings.TrimSpace(m[1]), s[len(m[0]):]
	}
	s = linkRe.ReplaceAllString(s, "$1")
	s = strongRe.ReplaceAllString(s, "$1")
	s = emRe.ReplaceAllString(s, "$1$2")
	s = strings.ReplaceAll(s, "`", "")
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > EntryRunes {
		s = strings.TrimSpace(string(r[:EntryRunes-1])) + "…"
	}
	return scope, s
}

// FragmentsDir is where a repository that keeps one file per change holds
// the entries waiting for the next release (changes/README.md): each file is
// a `---`/`kind: …`/`---` front matter and then its bullets.
const FragmentsDir = "changes/unreleased"

// AddFragment counts one fragment's top-level bullets into u, as
// ParseUnreleased counts the section's: the front matter is read for its
// `kind:` and skipped, and a file without a closing `---` is read as bullets
// alone, of no kind.
func AddFragment(u *Unreleased, fragment []byte) {
	AddFragmentFile(u, "", fragment)
}

// AddFragmentFile is AddFragment for a fragment named file, the name its
// entries carry.
func AddFragmentFile(u *Unreleased, file string, fragment []byte) {
	text := strings.ReplaceAll(string(fragment), "\r\n", "\n")
	kind := ""
	if rest, ok := strings.CutPrefix(text, "---\n"); ok {
		if front, body, ok := strings.Cut(rest, "\n---\n"); ok {
			text = body
			for _, l := range strings.Split(front, "\n") {
				if v, ok := strings.CutPrefix(strings.TrimSpace(l), "kind:"); ok {
					kind = kindOf(v)
				}
			}
		}
	}
	for _, b := range bullets(strings.Split(text, "\n")) {
		// A fragment has no headings: its kind is the front matter's.
		u.add(b.first, b.whole, kind, file)
	}
}

// Tag is one tag and when it was made (unix ms): an annotated tag's own
// date, else its commit's.
type Tag struct {
	Name string
	At   int64
}

// ParseTags reads for-each-ref output in the format Tags asks for
// ("name<TAB>unix seconds" per line), newest first as git sorted it. Lines
// it cannot read are skipped.
func ParseTags(out string) []Tag {
	var tags []Tag
	for _, l := range strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n") {
		name, at, ok := strings.Cut(strings.TrimSpace(l), "\t")
		if !ok || name == "" {
			continue
		}
		sec, err := strconv.ParseInt(strings.TrimSpace(at), 10, 64)
		if err != nil || sec <= 0 {
			continue
		}
		tags = append(tags, Tag{Name: name, At: sec * 1000})
	}
	return tags
}

// MedianGap is the median time between consecutive tags (ms) and how many
// gaps it is taken over; 0 with fewer than MinGaps gaps. Order does not
// matter; tags made in the same second are one release.
func MedianGap(tags []Tag) (int64, int) {
	ats := make([]int64, 0, len(tags))
	for _, t := range tags {
		ats = append(ats, t.At)
	}
	sort.Slice(ats, func(a, b int) bool { return ats[a] < ats[b] })
	var gaps []int64
	for i := 1; i < len(ats); i++ {
		if d := ats[i] - ats[i-1]; d > 0 {
			gaps = append(gaps, d)
		}
	}
	if len(gaps) < MinGaps {
		return 0, len(gaps)
	}
	sort.Slice(gaps, func(a, b int) bool { return gaps[a] < gaps[b] })
	n := len(gaps)
	if n%2 == 1 {
		return gaps[n/2], n
	}
	return (gaps[n/2-1] + gaps[n/2]) / 2, n
}

// ErrNoRef is returned when the clone has no remote default branch known
// locally (no refs/remotes/origin/HEAD).
var ErrNoRef = errors.New("no remote default branch known locally")

// DefaultRef is the remote default branch as this clone knows it,
// "origin/main", and its commit. It reads refs only; it never fetches.
func DefaultRef(ctx context.Context, dir string) (ref, sha string, err error) {
	ref, err = run(ctx, dir, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
	if err != nil || ref == "" {
		return "", "", ErrNoRef
	}
	sha, err = run(ctx, dir, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	if err != nil || sha == "" {
		return "", "", ErrNoRef
	}
	return ref, sha, nil
}

// OriginURL is the address of the remote named origin, as configured.
func OriginURL(ctx context.Context, dir string) (string, error) {
	return run(ctx, dir, "remote", "get-url", "origin")
}

// Changelog is CHANGELOG.md at rev; ok is false when the file is not there.
func Changelog(ctx context.Context, dir, rev string) ([]byte, bool) {
	out, err := runRaw(ctx, dir, "show", rev+":CHANGELOG.md")
	if err != nil {
		return nil, false
	}
	return out, true
}

// Fragment is one changelog fragment file: its base name and its text.
type Fragment struct {
	Name string
	Body []byte
}

// Fragments is every `.md` file in FragmentsDir at rev, in file name order,
// read with two git processes however many there are. ok is false when rev
// has no such directory.
func Fragments(ctx context.Context, dir, rev string) ([]Fragment, bool) {
	paths, ok := FragmentNames(ctx, dir, rev)
	if !ok || len(paths) == 0 {
		return nil, ok
	}
	return ReadFragments(ctx, dir, rev, paths)
}

// FragmentNames is the `.md` files in FragmentsDir at rev, as paths from the
// repository's root, sorted. ok is false when rev has no such directory.
func FragmentNames(ctx context.Context, dir, rev string) ([]string, bool) {
	out, err := runRaw(ctx, dir, "ls-tree", "-z", "--name-only", rev, FragmentsDir+"/")
	if err != nil {
		return nil, false
	}
	var paths []string
	for _, p := range strings.Split(string(out), "\x00") {
		if strings.HasSuffix(p, ".md") {
			paths = append(paths, p)
		}
	}
	sort.Strings(paths)
	return paths, len(out) > 0
}

// ReadFragments reads the files at paths (FragmentNames') at rev with one
// `git cat-file --batch`. A path git cannot find is left out.
func ReadFragments(ctx context.Context, dir, rev string, paths []string) ([]Fragment, bool) {
	if len(paths) == 0 {
		return nil, true
	}
	var in strings.Builder
	for _, p := range paths {
		in.WriteString(rev + ":" + p + "\n")
	}
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := hidewin.CommandContext(ctx, "git", "-C", dir, "cat-file", "--batch")
	cmd.Stdin = strings.NewReader(in.String())
	var buf bytes.Buffer
	cmd.Stdout = &buf
	if err := cmd.Run(); err != nil {
		return nil, false
	}
	return parseBatch(buf.Bytes(), paths), true
}

// RemoteBranch is the commit of origin/<branch> as this clone knows it;
// ok is false when the clone has no such remote-tracking branch. Nothing is
// fetched.
func RemoteBranch(ctx context.Context, dir, branch string) (string, bool) {
	if branch == "" || strings.HasPrefix(branch, "-") {
		return "", false
	}
	sha, err := run(ctx, dir, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/"+branch+"^{commit}")
	return sha, err == nil && sha != ""
}

// MergeBase is the best common ancestor of a and b; ok is false when git
// cannot say.
func MergeBase(ctx context.Context, dir, a, b string) (string, bool) {
	sha, err := run(ctx, dir, "merge-base", a, b)
	return sha, err == nil && sha != ""
}

// parseBatch splits `git cat-file --batch` output into the blobs, each
// named after the path it was asked for, in order: "<sha> blob
// <size>\n<content>\n" each; a "missing" answer skips its path.
func parseBatch(b []byte, paths []string) []Fragment {
	var out []Fragment
	for i := 0; len(b) > 0 && i < len(paths); i++ {
		nl := bytes.IndexByte(b, '\n')
		if nl < 0 {
			break
		}
		f := strings.Fields(string(b[:nl]))
		b = b[nl+1:]
		if len(f) != 3 || f[1] != "blob" {
			continue
		}
		n, err := strconv.Atoi(f[2])
		if err != nil || n > len(b) {
			break
		}
		out = append(out, Fragment{Name: path.Base(paths[i]), Body: b[:n]})
		b = b[n:]
		if len(b) > 0 && b[0] == '\n' {
			b = b[1:]
		}
	}
	return out
}

// Tags is the repository's newest TagsRead tags, newest first.
func Tags(ctx context.Context, dir string) ([]Tag, error) {
	out, err := run(ctx, dir, "for-each-ref", "refs/tags", "--sort=-creatordate",
		"--count="+strconv.Itoa(TagsRead), "--format=%(refname:short)%09%(creatordate:unix)")
	if err != nil {
		return nil, err
	}
	return ParseTags(out), nil
}

// Ahead is how many commits rev has that the tag does not.
func Ahead(ctx context.Context, dir, tag, rev string) (int, error) {
	out, err := run(ctx, dir, "rev-list", "--count", "refs/tags/"+tag+".."+rev)
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(out)
}

// runRaw runs one git read in dir, its window hidden on Windows.
func runRaw(ctx context.Context, dir string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := hidewin.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func run(ctx context.Context, dir string, args ...string) (string, error) {
	b, err := runRaw(ctx, dir, args...)
	return strings.TrimSpace(string(b)), err
}
