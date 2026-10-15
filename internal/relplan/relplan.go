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
}

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

// add counts one bullet into u, under kind when it has one.
func (u *Unreleased) add(item, kind string) {
	u.Count++
	if len(u.Items) < MaxItems {
		u.Items = append(u.Items, item)
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
	in, found := false, false
	kind := ""
	sc := bufio.NewScanner(bytes.NewReader(changelog))
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if strings.HasPrefix(line, "## ") {
			if in {
				break
			}
			if strings.HasPrefix(strings.ToLower(strings.TrimSpace(line[3:])), "[unreleased]") {
				in, found = true, true
			}
			continue
		}
		if !in {
			continue
		}
		if h, ok := strings.CutPrefix(line, "### "); ok {
			kind = kindOf(h)
			continue
		}
		// A top-level bullet starts at the first column; an indented one is
		// nested under the one before it, and anything else is a heading or
		// a continuation line.
		if !strings.HasPrefix(line, "- ") && !strings.HasPrefix(line, "* ") {
			continue
		}
		text := strings.TrimSpace(line[2:])
		if text == "" {
			continue
		}
		u.add(text, kind)
	}
	return u, found
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
	for _, line := range strings.Split(text, "\n") {
		if !strings.HasPrefix(line, "- ") && !strings.HasPrefix(line, "* ") {
			continue
		}
		item := strings.TrimSpace(line[2:])
		if item == "" {
			continue
		}
		u.add(item, kind)
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

// Fragments is the text of every `.md` file in FragmentsDir at rev, in file
// name order, read with two git processes however many there are. ok is
// false when rev has no such directory.
func Fragments(ctx context.Context, dir, rev string) ([][]byte, bool) {
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
	if len(paths) == 0 {
		return nil, len(out) > 0
	}
	sort.Strings(paths)
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
	return parseBatch(buf.Bytes()), true
}

// parseBatch splits `git cat-file --batch` output into the blobs' contents:
// "<sha> blob <size>\n<content>\n" each; a "missing" line is skipped.
func parseBatch(b []byte) [][]byte {
	var blobs [][]byte
	for len(b) > 0 {
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
		blobs = append(blobs, b[:n])
		b = b[n:]
		if len(b) > 0 && b[0] == '\n' {
			b = b[1:]
		}
	}
	return blobs
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
