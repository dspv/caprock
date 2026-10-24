package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// Second Brain never reads a session started at a root or in the home
// directory itself; a folder under the home, a sibling sharing its prefix
// and an unrecorded cwd are not that.
func TestRootOrHome(t *testing.T) {
	for _, tc := range []struct {
		cwd, home string
		fold      bool
		want      bool
	}{
		{"/", "/Users/u", false, true},
		{"//", "/Users/u", false, true},
		{"/Users/u", "/Users/u", false, true},
		{"/Users/u/", "/Users/u", false, true},
		{"/Users/u//", "/Users/u/", false, true},
		{"/Users/u/dev", "/Users/u", false, false},
		{"/Users/user", "/Users/u", false, false},
		{"/Users/U", "/Users/u", false, false},
		{"/home/u", "/home/u", false, true},
		{"/tmp", "/Users/u", false, false},
		{"", "/Users/u", false, false},
		{"  ", "/Users/u", false, false},
		{"/Users/u", "", false, false},
		{`C:\`, `C:\Users\u`, true, true},
		{`C:`, `C:\Users\u`, true, true},
		{`D:/`, `C:\Users\u`, true, true},
		{`C:\Users\u`, `C:\Users\u`, true, true},
		{`C:\Users\u\`, `C:\Users\u`, true, true},
		{`c:\users\U`, `C:\Users\u`, true, true},
		{`C:/Users/u`, `C:\Users\u`, true, true},
		{`C:\Users\u\dev\web`, `C:\Users\u`, true, false},
		{`C:\Users\uu`, `C:\Users\u`, true, false},
		{`C:\Users`, `C:\Users\u`, true, false},
	} {
		if got := rootOrHome(tc.cwd, tc.home, tc.fold); got != tc.want {
			t.Errorf("rootOrHome(%q, %q) = %v, want %v", tc.cwd, tc.home, got, tc.want)
		}
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		if !RootOrHome(home) || RootOrHome(filepath.Join(home, "dev")) || RootOrHome("") {
			t.Errorf("RootOrHome against this machine's home %q", home)
		}
	}
}

// A root-or-home mark keeps the session out of the candidates for good and
// out of the read sessions; the mark carries the cwd after the prefix.
func TestMarkBrainRootOrHome(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	if err := UpsertSession(ctx, s.DB(), "cron", SessionPatch{Cwd: "/", LastEventAt: 1000}); err != nil {
		t.Fatal(err)
	}
	if err := MarkBrainRootOrHome(ctx, s.DB(), BrainCandidate{SessionID: "cron", Cwd: "/", MaxEventID: 5}, 2000); err != nil {
		t.Fatal(err)
	}
	runs, err := BrainRunsOf(ctx, s.DB(), "cron")
	if err != nil || len(runs) != 1 || runs[0].Error != BrainSkipRootOrHome+": /" || runs[0].ThroughEventID != 5 {
		t.Fatalf("mark: %+v %v", runs, err)
	}
	read, err := BrainReadSessions(ctx, s.DB(), 0)
	if err != nil || len(read) != 0 {
		t.Fatalf("a marked session is not read: %+v %v", read, err)
	}
}
