package relplan

import (
	"context"
	"regexp"
	"strconv"
	"strings"
)

// Which pull requests each release shipped, from the local checkout alone
// (the Pipeline's Most expensive releases; owner, 2026-10-23). A release is
// a version tag on the default branch's first-parent line; what it shipped
// is the pull requests named by the commits on that line after the release
// before it, up to and including its own commit — `git log --first-parent
// prev..tag` — read as a squash merge's subject names one ("feat: x
// (#123)") or a merge commit's does ("Merge pull request #123 from …").
// Nothing here fetches: it is as fresh as the user's last `git fetch`.

// ReleaseTag is the version tags read as releases: v-prefixed semver,
// "v0.152.0". A pre-release ("v1.0.0-rc.1") or a tag of another shape
// ("app-v2.0.1", "1.4") is not one: its pull requests fall to the next
// release.
var ReleaseTag = regexp.MustCompile(`^v(\d+)\.(\d+)\.(\d+)$`)

// Release is one version tag and the pull requests it shipped.
type Release struct {
	Tag string
	// At is when the tag was made (unix ms): an annotated tag's own date,
	// else its commit's.
	At int64
	// PRs are the pull request numbers its commits name, oldest first, each
	// once.
	PRs []int
	// First says it is the oldest release on the line: it shipped everything
	// before it too, back to the first commit.
	First bool
}

// squashPR is a squash merge's subject: the pull request in parentheses at
// its end. mergePR is a merge commit's.
var (
	squashPR = regexp.MustCompile(`\(#(\d+)\)\s*$`)
	mergePR  = regexp.MustCompile(`^Merge pull request #(\d+) from `)
)

// SubjectPR is the pull request a first-parent commit's subject names, 0
// when it names none.
func SubjectPR(subject string) int {
	subject = strings.TrimRight(subject, "\r\n")
	m := mergePR.FindStringSubmatch(subject)
	if m == nil {
		m = squashPR.FindStringSubmatch(subject)
	}
	if m == nil {
		return 0
	}
	n, err := strconv.Atoi(m[1])
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

// TagRef is a tag and the commit it names (peeled for an annotated one).
type TagRef struct {
	Name   string
	Commit string
	At     int64 // unix ms
}

// ParseTagRefs reads for-each-ref output in the format ReleaseHistory asks
// for ("name<TAB>object<TAB>peeled<TAB>unix seconds"), keeping version tags
// (ReleaseTag) only. Lines it cannot read are skipped; CRLF is read as LF.
func ParseTagRefs(out string) []TagRef {
	var refs []TagRef
	for _, l := range strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n") {
		f := strings.Split(strings.TrimSpace(l), "\t")
		if len(f) != 4 || !ReleaseTag.MatchString(f[0]) {
			continue
		}
		commit := f[2]
		if commit == "" {
			commit = f[1]
		}
		sec, err := strconv.ParseInt(f[3], 10, 64)
		if err != nil || sec <= 0 || commit == "" {
			continue
		}
		refs = append(refs, TagRef{Name: f[0], Commit: commit, At: sec * 1000})
	}
	return refs
}

// ParseReleases walks first-parent history ("sha<TAB>subject" per line,
// newest first, as `git log --first-parent` prints it) and charges each
// commit's pull request to the first release at or after it on the line.
// Tags whose commit is not on the line are left out; of several version
// tags on one commit, the highest version is the release. Newest first.
func ParseReleases(log string, tags []TagRef) []Release {
	onCommit := map[string]TagRef{}
	for _, t := range tags {
		if have, ok := onCommit[t.Commit]; !ok || versionLess(have.Name, t.Name) {
			onCommit[t.Commit] = t
		}
	}
	lines := strings.Split(strings.ReplaceAll(log, "\r\n", "\n"), "\n")
	var out []Release
	var pending []int
	seen := map[int]bool{}
	// Oldest first.
	for i := len(lines) - 1; i >= 0; i-- {
		sha, subject, ok := strings.Cut(strings.TrimRight(lines[i], "\r"), "\t")
		if !ok || sha == "" {
			continue
		}
		if n := SubjectPR(subject); n > 0 && !seen[n] {
			seen[n] = true
			pending = append(pending, n)
		}
		if t, ok := onCommit[sha]; ok {
			out = append(out, Release{Tag: t.Name, At: t.At, PRs: pending, First: len(out) == 0})
			pending = nil
			seen = map[int]bool{}
		}
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

// versionLess orders two ReleaseTag names by version.
func versionLess(a, b string) bool {
	ma, mb := ReleaseTag.FindStringSubmatch(a), ReleaseTag.FindStringSubmatch(b)
	if ma == nil || mb == nil {
		return a < b
	}
	for i := 1; i <= 3; i++ {
		x, _ := strconv.Atoi(ma[i])
		y, _ := strconv.Atoi(mb[i])
		if x != y {
			return x < y
		}
	}
	return false
}

// HistoryKey is what ReleaseHistory's answer rests on, read cheaply: the
// line's tip and every tag with the commit it names. When it has not
// changed, neither has the answer.
func HistoryKey(ctx context.Context, dir string) (key, ref, tagsOut string, err error) {
	ref, sha, err := DefaultRef(ctx, dir)
	if err != nil {
		// No remote default branch known: the checkout's own HEAD.
		ref = "HEAD"
		if sha, err = run(ctx, dir, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"); err != nil || sha == "" {
			return "", "", "", ErrNoRef
		}
	}
	tagsOut, err = run(ctx, dir, "for-each-ref", "refs/tags",
		"--format=%(refname:short)%09%(objectname)%09%(*objectname)%09%(creatordate:unix)")
	if err != nil {
		return "", "", "", err
	}
	return ref + "@" + sha + "\n" + tagsOut, ref, tagsOut, nil
}

// ReleaseHistory is every release on ref's first-parent line and the pull
// requests each shipped, newest first: two git reads, the tags and the
// line's history (one `git log`, not one per release).
func ReleaseHistory(ctx context.Context, dir, ref, tagsOut string) ([]Release, error) {
	tags := ParseTagRefs(tagsOut)
	if len(tags) == 0 {
		return []Release{}, nil
	}
	out, err := runRaw(ctx, dir, "log", "--first-parent", "--format=%H%x09%s", ref, "--")
	if err != nil {
		return nil, err
	}
	return ParseReleases(string(out), tags), nil
}
