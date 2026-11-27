package serverscript

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Release is what the laptop reads about a release before it writes a
// script: each Linux archive's SHA-256 from its checksums.txt, and whether
// a minisign signature sits beside both.
type Release struct {
	Version string
	SHA256  map[string]string
	Signed  bool
}

// IsRelease says v names a published release rather than a development
// build ("dev", or a `git describe` string with a commit suffix), the same
// test update.Newer applies.
func IsRelease(v string) bool {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if v == "" || v == "dev" || strings.Contains(v, "-g") || strings.HasSuffix(v, "-dirty") {
		return false
	}
	return versionRe.MatchString(v)
}

// Archive is a release's Linux archive name for arch.
func Archive(version, arch string) string {
	return "caprock_" + version + "_linux_" + arch + ".tar.gz"
}

// FetchRelease reads version's checksums.txt from base (ReleaseBase when
// empty) — GitHub, which the release check already talks to, so no new
// destination (rule 4) — and asks whether each Linux archive has its
// .minisig. A request carries nothing but the path.
func FetchRelease(ctx context.Context, hc *http.Client, base, version string) (Release, error) {
	if hc == nil {
		hc = http.DefaultClient
	}
	if base == "" {
		base = ReleaseBase
	}
	version = strings.TrimPrefix(strings.TrimSpace(version), "v")
	if !IsRelease(version) {
		return Release{}, fmt.Errorf("not a release version: %q", version)
	}
	dir := strings.TrimRight(base, "/") + "/v" + version + "/"
	res, err := get(ctx, hc, http.MethodGet, dir+"checksums.txt")
	if err != nil {
		return Release{}, fmt.Errorf("could not read Caprock %s's checksums: %w", version, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return Release{}, fmt.Errorf("could not read Caprock %s's checksums: HTTP %d", version, res.StatusCode)
	}
	sums, err := ParseChecksums(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return Release{}, err
	}
	rel := Release{Version: version, SHA256: map[string]string{}, Signed: true}
	for _, a := range Arches {
		s, ok := sums[Archive(version, a)]
		if !ok {
			return Release{}, fmt.Errorf("the checksums of Caprock %s list no %s", version, Archive(version, a))
		}
		rel.SHA256[a] = s
		sig, err := get(ctx, hc, http.MethodHead, dir+Archive(version, a)+".minisig")
		if err != nil {
			return Release{}, fmt.Errorf("could not ask for Caprock %s's signatures: %w", version, err)
		}
		_ = sig.Body.Close()
		if sig.StatusCode != http.StatusOK {
			rel.Signed = false
		}
	}
	return rel, nil
}

func get(ctx context.Context, hc *http.Client, method, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "caprock")
	return hc.Do(req)
}

// ParseChecksums reads a goreleaser checksums.txt: "<sha256>  <file>" lines.
func ParseChecksums(r io.Reader) (map[string]string, error) {
	out := map[string]string{}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) != 2 {
			continue
		}
		sum := strings.ToLower(f[0])
		if !shaRe.MatchString(sum) {
			continue
		}
		out[strings.TrimPrefix(f[1], "*")] = sum
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, errors.New("the release's checksums.txt lists nothing")
	}
	return out, nil
}
