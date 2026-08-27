// Package update checks whether a newer Caprock release exists and works out
// the command that would install it.
//
// This is the ONE place in Caprock that talks to the network, and it is off
// until the user turns it on. Engineering rule 4 ("no outbound calls") is not
// bent quietly: the check is opt-in, asked for once, visible in the UI with the
// time of the last check, and revocable. The request carries no body, no
// identifiers, and no usage data — GitHub learns an IP asked for a release tag,
// which is what any `brew update` already tells it.
//
// Caprock deliberately does NOT install the update itself. Upgrading means
// replacing the running binary, so the daemon would be killing the process
// executing the command — a race whose failure mode is a user left with no
// working Caprock. Running a package manager on the user's behalf from a web
// page is also exactly the surface a local tool should not open. Instead we
// name the exact command for how this copy was installed, and the user runs it.
package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// LatestURL is the release endpoint. Overridable in tests.
var LatestURL = "https://api.github.com/repos/dspv/caprock/releases/latest"

// ReleasesPage is where a user without a package manager goes.
const ReleasesPage = "https://github.com/dspv/caprock/releases/latest"

// Status is what the UI renders.
type Status struct {
	// Enabled reports whether the user turned checking on.
	Enabled bool `json:"enabled"`
	// Current is the running version.
	Current string `json:"current"`
	// Latest is the newest published version, "" if never checked.
	Latest string `json:"latest,omitempty"`
	// UpdateAvailable is true only when Latest is genuinely newer than Current.
	UpdateAvailable bool `json:"update_available"`
	// Command is how to install it, given how this copy was installed.
	Command string `json:"command,omitempty"`
	// URL is the release page, always safe to offer.
	URL string `json:"url,omitempty"`
	// CheckedAt is the last successful check (unix ms), 0 if never.
	CheckedAt int64 `json:"checked_at,omitempty"`
	// Error is the last failure, if any. A failed check is never fatal.
	Error string `json:"error,omitempty"`
	// Notes is the published release's own description of what changed, as
	// written on GitHub. It arrives in the same response as the tag — asking
	// for the version and then asking again for the notes would be a second
	// request for something we already had.
	Notes string `json:"notes,omitempty"`
	// NotesFor is the version Notes describes. Without it a stale note could
	// be shown beside a different version after a failed check.
	NotesFor string `json:"notes_for,omitempty"`
}

// Checker holds the cached result. It never checks on its own: the caller
// decides when, so "opt-in" is enforced at the call site as well as here.
type Checker struct {
	// Now is injectable for tests.
	Now func() time.Time
	// HTTPClient is injectable for tests.
	HTTPClient *http.Client
	// MinInterval throttles checks (default 24h). GitHub's tag does not change
	// often enough to justify asking more, and asking more is more exposure.
	MinInterval time.Duration

	mu        sync.Mutex
	latest    string
	notes     string
	checkedAt time.Time
	lastErr   string
}

// New returns a Checker with sane defaults.
func New() *Checker {
	return &Checker{
		Now:         time.Now,
		HTTPClient:  &http.Client{Timeout: 5 * time.Second},
		MinInterval: 24 * time.Hour,
	}
}

// Status returns the cached view. It performs no I/O, so the settings endpoint
// stays instant and a disabled checker can never touch the network.
func (c *Checker) Status(enabled bool, current string) Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	st := Status{Enabled: enabled, Current: current, URL: ReleasesPage}
	if !enabled {
		return st
	}
	st.Latest = c.latest
	st.Error = c.lastErr
	if !c.checkedAt.IsZero() {
		st.CheckedAt = c.checkedAt.UnixMilli()
	}
	if c.latest != "" && Newer(current, c.latest) {
		st.UpdateAvailable = true
		st.Command = InstallCommand()
	}
	// Offered whether or not an update is pending: someone who just upgraded
	// wants to read what they got, and that is the moment the question is
	// actually asked.
	st.Notes, st.NotesFor = c.notes, c.latest
	return st
}

// Check asks GitHub for the latest release tag, respecting MinInterval unless
// forced. A failure is recorded and returned but never escalated: not knowing
// about an update must not degrade a working dashboard.
func (c *Checker) Check(ctx context.Context, force bool) error {
	c.mu.Lock()
	if !force && !c.checkedAt.IsZero() && c.Now().Sub(c.checkedAt) < c.MinInterval {
		c.mu.Unlock()
		return nil
	}
	c.mu.Unlock()

	tag, notes, err := fetchLatestRelease(ctx, c.HTTPClient, LatestURL)
	c.mu.Lock()
	defer c.mu.Unlock()
	if err != nil {
		c.lastErr = err.Error()
		return err
	}
	c.latest, c.notes, c.lastErr, c.checkedAt = tag, notes, "", c.Now()
	return nil
}

// fetchLatestRelease returns the newest published tag and the notes that came
// with it. Both live in one response, so reading the notes costs nothing.
func fetchLatestRelease(ctx context.Context, hc *http.Client, url string) (tag, notes string, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", "", err
	}
	// No auth, no cookies, no body — nothing that identifies this machine
	// beyond the IP any HTTP request necessarily carries.
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "caprock")
	resp, err := hc.Do(req)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("release check: HTTP %d", resp.StatusCode)
	}
	var body struct {
		TagName string `json:"tag_name"`
		Body    string `json:"body"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(nil, resp.Body, 1<<20)).Decode(&body); err != nil {
		return "", "", fmt.Errorf("release check: %w", err)
	}
	if body.TagName == "" {
		return "", "", errors.New("release check: no tag in response")
	}
	return body.TagName, trimNotes(body.Body), nil
}

// notesLimit keeps a release description to something a dialog can hold. Ours
// run long — the changelog entries are prose — and a modal is not where anyone
// reads three screens of it; the release page is one click away for that.
const notesLimit = 4000

// trimNotes normalises a release body for display: CRLF out, trailing space
// gone, and cut to a length a dialog can show without becoming the page.
func trimNotes(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.TrimSpace(s)
	if len(s) <= notesLimit {
		return s
	}
	// Cut at a line boundary rather than mid-word, so the last thing shown is
	// a whole thought.
	cut := strings.LastIndex(s[:notesLimit], "\n")
	if cut < notesLimit/2 {
		cut = notesLimit
	}
	return strings.TrimSpace(s[:cut])
}

// Newer reports whether latest is a strictly newer release than current.
// A non-release build ("dev", or a `git describe` string with a commit suffix)
// is never told it is out of date: the person running it built it themselves.
func Newer(current, latest string) bool {
	if current == "" || current == "dev" || strings.Contains(current, "-g") || strings.HasSuffix(current, "-dirty") {
		return false
	}
	cur, ok1 := parseSemver(current)
	lat, ok2 := parseSemver(latest)
	if !ok1 || !ok2 {
		return false
	}
	for i := range cur {
		if lat[i] != cur[i] {
			return lat[i] > cur[i]
		}
	}
	return false
}

func parseSemver(v string) ([3]int, bool) {
	var out [3]int
	parts := strings.SplitN(strings.TrimPrefix(strings.TrimSpace(v), "v"), ".", 4)
	if len(parts) < 3 {
		return out, false
	}
	for i := 0; i < 3; i++ {
		// Drop any pre-release/build suffix on the patch component.
		p := parts[i]
		if j := strings.IndexAny(p, "-+"); j >= 0 {
			p = p[:j]
		}
		n, err := strconv.Atoi(p)
		if err != nil {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// InstallCommand returns the upgrade command for how this copy was installed,
// inferred from the executable's path. When we cannot tell, we say nothing
// rather than suggest a command that might do the wrong thing — an empty
// result means the UI offers the release page instead.
func InstallCommand() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return commandForPath(exe)
}

// commandForPath is the pure core of InstallCommand, split out for tests.
func commandForPath(exe string) string {
	// Normalise separators ourselves: filepath.ToSlash is a no-op on Unix, so a
	// Windows path reaching a Unix build (or a test) would keep its backslashes.
	p := strings.ReplaceAll(exe, `\`, "/")
	lower := strings.ToLower(p)

	switch {
	// Homebrew: /opt/homebrew/... (Apple silicon), /usr/local/Cellar/... (Intel),
	// or a linuxbrew prefix.
	case strings.Contains(p, "/Cellar/") || strings.Contains(p, "/homebrew/") || strings.Contains(p, "/linuxbrew/"):
		// `brew update` first, and it is not decoration.
		//
		// A tap is not served by the Homebrew API — it is read from a local
		// git clone that `brew upgrade` only refreshes through auto-update,
		// which runs at most once every 24 hours. A user who ran any brew
		// command earlier the same day gets "0.31.0 already installed" for a
		// release that has been published for hours, and the command we told
		// them to run appears to be broken. Reported by a user on the day
		// v0.31.1 shipped.
		return "brew update && brew upgrade caprock"
	// Scoop keeps apps under <scoop root>/apps/<name>/<version>.
	case strings.Contains(lower, "/scoop/apps/"):
		return "scoop update caprock"
	// go install lands in GOBIN or GOPATH/bin.
	case strings.HasSuffix(p, "/go/bin/caprock") || strings.HasSuffix(lower, "/go/bin/caprock.exe"):
		return "go install github.com/dspv/caprock/cmd/caprock@latest"
	}
	// A downloaded binary, a container, or a source build: no package manager
	// owns it, so there is no honest command to name.
	return ""
}
