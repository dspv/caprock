// Package relplan reads what a repository has merged and not yet released,
// and how its releases have been spaced, from the machine alone (ADR-064).
//
// The Work board's release column asks two questions: what is waiting to
// ship, and how often does this repository ship. Both are answered from git
// as it stands on this machine: the CHANGELOG's [Unreleased] section on the
// remote's default branch (`git show origin/HEAD:CHANGELOG.md`) and the
// newest tags. Nothing here fetches: the answer is only as fresh as the
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
}

// ParseUnreleased reads the [Unreleased] section of a Keep a Changelog file.
// ok is false when there is no such section; an empty section is ok with no
// items. The heading may carry more after the bracket ("## [Unreleased] -
// …"), and CRLF line ends read as LF.
func ParseUnreleased(changelog []byte) (Unreleased, bool) {
	var u Unreleased
	in, found := false, false
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
		u.Count++
		if len(u.Items) < MaxItems {
			u.Items = append(u.Items, text)
		}
	}
	return u, found
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
