package relay

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

func openStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

var seq int

func put(t *testing.T, st *store.Store, sid string, kind event.Kind, at time.Time, payload any) {
	t.Helper()
	b, _ := json.Marshal(payload)
	seq++
	ev := &event.Event{SessionID: sid, Source: event.SourceTranscript, Kind: kind, Key: "k" + sid + string(rune('a'+seq)) + at.Format("150405.000"), Ts: at, Payload: b}
	if _, err := store.InsertEvent(context.Background(), st.DB(), ev); err != nil {
		t.Fatal(err)
	}
}

func gitRun(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// The brief carries the last substantial passage, the working tree as it is
// now, and the PRs the session opened — and says plainly that it is a summary,
// not the conversation.
func TestBuildCarriesPassageTreeAndPRs(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	ctx := context.Background()
	st := openStore(t)
	dir := t.TempDir()
	gitRun(t, dir, "init", "-q", "-b", "master")
	_ = os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0o600)
	gitRun(t, dir, "add", "a.txt")
	gitRun(t, dir, "commit", "-q", "-m", "init")
	_ = os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\n"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "new.go"), []byte("package x\n"), 0o600)

	now := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
	if err := store.UpsertSession(ctx, st.DB(), "src", store.SessionPatch{Cwd: dir, Agent: "codex"}); err != nil {
		t.Fatal(err)
	}
	long := strings.Repeat("The retry loop is fixed; the flaky test remains. ", 12)
	put(t, st, "src", event.KindTurnAssistant, now.Add(-3*time.Hour), map[string]string{"text": long})
	put(t, st, "src", event.KindTurnAssistant, now.Add(-2*time.Hour), map[string]string{"text": "Done."})
	put(t, st, "src", event.KindToolPost, now.Add(-90*time.Minute), map[string]any{
		"tool_name":     "Bash",
		"tool_response": map[string]any{"gitOperation": map[string]any{"pr": map[string]any{"number": 7, "url": "https://github.com/o/r/pull/7", "action": "created"}}},
	})
	put(t, st, "src", event.KindToolPost, now.Add(-80*time.Minute), map[string]any{
		"tool_name":     "Bash",
		"tool_response": map[string]any{"gitOperation": map[string]any{"pr": map[string]any{"number": 5, "url": "https://github.com/o/r/pull/5", "action": "merged"}}},
	})

	sess, err := store.GetSession(ctx, st.DB(), "src")
	if err != nil {
		t.Fatal(err)
	}
	b, err := Build(ctx, st.DB(), sess, now)
	if err != nil {
		t.Fatal(err)
	}
	if !b.CwdExists {
		t.Error("cwd_exists = false for a folder that exists")
	}
	if b.PassageAt != now.Add(-3*time.Hour).UnixMilli() {
		t.Errorf("passage_at = %d; the one-word 'Done.' must not win over the substantial passage", b.PassageAt)
	}
	if len(b.PRs) != 1 || b.PRs[0].Number != 7 {
		t.Errorf("prs = %+v, want only the created #7 (a merge is not an opening)", b.PRs)
	}
	if b.Git == nil || b.Git.Branch != "master" || len(b.Git.Files) != 2 {
		t.Fatalf("git = %+v", b.Git)
	}
	for _, want := range []string{
		"earlier Codex session",
		"You do not have that conversation",
		"(3 hours ago)",
		"> The retry loop is fixed",
		"branch master",
		"modified a.txt (+1 -0)",
		"untracked new.go",
		"https://github.com/o/r/pull/7",
		"Pick up from here.",
	} {
		if !strings.Contains(b.Text, want) {
			t.Errorf("brief lacks %q:\n%s", want, b.Text)
		}
	}
	if strings.Contains(b.Text, "pull/5") {
		t.Error("a merged PR is listed as opened")
	}
}

// A session that left only short passages still hands over its last one, and a
// folder that is gone gives no git section rather than an error.
func TestBuildWithShortPassageAndMissingFolder(t *testing.T) {
	ctx := context.Background()
	st := openStore(t)
	now := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
	gone := filepath.Join(t.TempDir(), "gone")
	if err := store.UpsertSession(ctx, st.DB(), "s", store.SessionPatch{Cwd: gone}); err != nil {
		t.Fatal(err)
	}
	put(t, st, "s", event.KindTurnAssistant, now.Add(-10*time.Minute), map[string]string{"text": "Tests pass now."})
	sess, _ := store.GetSession(ctx, st.DB(), "s")
	b, err := Build(ctx, st.DB(), sess, now)
	if err != nil {
		t.Fatal(err)
	}
	if b.CwdExists || b.Git != nil {
		t.Errorf("cwd_exists=%v git=%+v for a folder that is gone", b.CwdExists, b.Git)
	}
	if !strings.Contains(b.Text, "> Tests pass now.") || !strings.Contains(b.Text, "earlier Claude Code session") {
		t.Errorf("brief:\n%s", b.Text)
	}
	if b.PRs == nil {
		t.Error("prs is null; the dialog expects a list")
	}
}

func TestClip(t *testing.T) {
	if got := Clip("short", 10); got != "short" {
		t.Errorf("Clip short = %q", got)
	}
	got := Clip(strings.Repeat("a", 90)+". "+strings.Repeat("b", 20), 100)
	if !strings.HasSuffix(got, ".") {
		t.Errorf("Clip did not stop at the sentence end: %q", got)
	}
}

func TestHumanAge(t *testing.T) {
	for d, want := range map[time.Duration]string{
		5 * time.Minute: "5 minutes",
		3 * time.Hour:   "3 hours",
		72 * time.Hour:  "3 days",
	} {
		if got := HumanAge(d); got != want {
			t.Errorf("HumanAge(%v) = %q, want %q", d, got, want)
		}
	}
}
