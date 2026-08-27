package update

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A wrong "update available" badge is worse than none: it nags a user who is
// already current, or tells someone running their own build to "upgrade" to
// something older than what they compiled.
func TestNewer(t *testing.T) {
	cases := []struct {
		current, latest string
		want            bool
	}{
		{"v0.8.0", "v0.8.1", true},
		{"v0.8.0", "v0.9.0", true},
		{"v0.8.0", "v1.0.0", true},
		{"0.8.0", "0.8.1", true}, // tags without the v prefix
		{"v0.8.1", "v0.8.1", false},
		{"v0.9.0", "v0.8.1", false}, // never downgrade
		{"v0.10.0", "v0.9.0", false},
		{"v0.9.0", "v0.10.0", true}, // numeric, not lexicographic
		// Builds nobody should be nagged about.
		{"dev", "v9.9.9", false},
		{"", "v9.9.9", false},
		{"v0.8.0-2-g46fd6bc", "v9.9.9", false},
		{"v0.8.0-dirty", "v9.9.9", false},
		// Garbage in, silence out.
		{"v0.8.0", "not-a-version", false},
		{"v0.8", "v0.9.0", false},
	}
	for _, c := range cases {
		if got := Newer(c.current, c.latest); got != c.want {
			t.Errorf("Newer(%q, %q) = %v, want %v", c.current, c.latest, got, c.want)
		}
	}
}

// Naming the wrong command sends a user to a package manager that does not own
// this binary, so an unknown install must produce no command at all.
func TestCommandForPath(t *testing.T) {
	cases := []struct{ exe, want string }{
		{"/opt/homebrew/Cellar/caprock/0.8.0/bin/caprock", "brew update && brew upgrade caprock"},
		{"/usr/local/Cellar/caprock/0.8.0/bin/caprock", "brew update && brew upgrade caprock"},
		{"/home/linuxbrew/.linuxbrew/bin/caprock", "brew update && brew upgrade caprock"},
		{`C:\Users\x\scoop\apps\caprock\0.8.0\caprock.exe`, "scoop update caprock"},
		{"/Users/x/go/bin/caprock", "go install github.com/dspv/caprock/cmd/caprock@latest"},
		// No package manager owns these — say nothing.
		{"/usr/local/bin/caprock", ""},
		{"/Users/x/Downloads/caprock", ""},
		{"/Users/x/dev/caprock/bin/caprock", ""},
	}
	for _, c := range cases {
		if got := commandForPath(c.exe); got != c.want {
			t.Errorf("commandForPath(%q) = %q, want %q", c.exe, got, c.want)
		}
	}
}

// A disabled checker must never touch the network — that is the whole opt-in
// contract, so it is asserted rather than assumed.
func TestDisabledCheckerReportsNothing(t *testing.T) {
	c := New()
	st := c.Status(false, "v0.8.0")
	if st.Enabled || st.Latest != "" || st.UpdateAvailable {
		t.Fatalf("disabled checker leaked state: %+v", st)
	}
	if st.URL == "" {
		t.Fatal("the release page is always safe to offer")
	}
}

func TestCheckAndStatus(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		// The request must carry nothing that identifies the machine.
		if len(r.Cookies()) != 0 || r.Header.Get("Authorization") != "" {
			t.Errorf("request carried identifying data: cookies=%d auth=%q", len(r.Cookies()), r.Header.Get("Authorization"))
		}
		_, _ = w.Write([]byte(`{"tag_name":"v0.9.0"}`))
	}))
	defer srv.Close()

	old := LatestURL
	LatestURL = srv.URL
	defer func() { LatestURL = old }()

	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	c := New()
	c.Now = func() time.Time { return now }
	if err := c.Check(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	st := c.Status(true, "v0.8.0")
	if !st.UpdateAvailable || st.Latest != "v0.9.0" || st.CheckedAt == 0 {
		t.Fatalf("expected an available update: %+v", st)
	}

	// Throttled: a second check inside the interval must not hit the network.
	if err := c.Check(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if hits != 1 {
		t.Fatalf("throttle failed: %d requests", hits)
	}
	// Forced checks bypass the throttle.
	if err := c.Check(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if hits != 2 {
		t.Fatalf("forced check did not run: %d requests", hits)
	}
}

// A failed check must degrade to "we don't know", never to a broken dashboard.
func TestCheckFailureIsNotFatal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	old := LatestURL
	LatestURL = srv.URL
	defer func() { LatestURL = old }()

	c := New()
	if err := c.Check(context.Background(), true); err == nil {
		t.Fatal("expected an error")
	}
	st := c.Status(true, "v0.8.0")
	if st.UpdateAvailable {
		t.Fatal("a failed check must not claim an update")
	}
	if st.Error == "" {
		t.Fatal("the failure should be visible to the user")
	}
}

// A tap is not served by the Homebrew API: it is read from a local git clone
// that `brew upgrade` refreshes only through auto-update, which runs at most
// once every 24 hours. Without `brew update` first, a user who ran any brew
// command earlier that day is told "already installed" for a release that has
// been public for hours — and the command Caprock gave them looks broken.
// Reported by a user on the day v0.31.1 shipped.
func TestBrewCommandRefreshesTheTapFirst(t *testing.T) {
	for _, exe := range []string{
		"/opt/homebrew/Cellar/caprock/0.8.0/bin/caprock",
		"/usr/local/Cellar/caprock/0.8.0/bin/caprock",
		"/home/linuxbrew/.linuxbrew/bin/caprock",
	} {
		got := commandForPath(exe)
		if !strings.HasPrefix(got, "brew update") {
			t.Errorf("commandForPath(%q) = %q, want it to refresh the tap first", exe, got)
		}
	}
}

// The release notes ride along with the tag: GitHub returns both in one
// response, so showing "what's new" costs no extra request and no extra
// exposure. What matters is that a long body is cut to something a dialog can
// hold, and cut at a line rather than mid-word.
func TestTrimNotes(t *testing.T) {
	if got := trimNotes("  hello\r\nworld  "); got != "hello\nworld" {
		t.Errorf("trimNotes = %q, want CRLF normalised and trimmed", got)
	}
	if got := trimNotes(""); got != "" {
		t.Errorf("trimNotes(\"\") = %q, want empty", got)
	}

	// A body far past the limit is cut at a line boundary. The bound is stated
	// as a fixed number rather than as `notesLimit`, because comparing the
	// constant against itself passes however the constant is changed — which
	// is a test that cannot fail.
	long := strings.Repeat("a line of release notes\n", 5000)
	got := trimNotes(long)
	if len(got) >= len(long) {
		t.Errorf("trimNotes kept all %d bytes, want it cut", len(got))
	}
	if len(got) > 8000 {
		t.Errorf("trimNotes kept %d bytes, want a dialog-sized excerpt", len(got))
	}
	if strings.HasSuffix(got, "a li") || strings.HasSuffix(got, "a lin") {
		t.Errorf("trimNotes cut mid-word: %q", got[len(got)-20:])
	}

	// One enormous line with nowhere to cut still has to be bounded.
	if got := trimNotes(strings.Repeat("x", 100_000)); len(got) > 8000 {
		t.Errorf("trimNotes kept %d bytes of an unbroken line, want it bounded", len(got))
	}
}

// A note must never be shown beside a version it does not describe: the
// version it belongs to travels with it.
func TestStatusPairsNotesWithTheirVersion(t *testing.T) {
	c := New()
	c.latest, c.notes, c.checkedAt = "v9.9.9", "* fixed a thing", c.Now()
	st := c.Status(true, "v0.1.0")
	if st.Notes != "* fixed a thing" {
		t.Errorf("Notes = %q, want the release body", st.Notes)
	}
	if st.NotesFor != "v9.9.9" {
		t.Errorf("NotesFor = %q, want the version the notes describe", st.NotesFor)
	}
}
