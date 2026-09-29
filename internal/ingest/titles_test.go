package ingest

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

func titleLine(title string) string {
	return `{"type":"ai-title","aiTitle":"` + title + `","sessionId":"s1"}` + "\n"
}

// Claude Code names a session in its transcript; the tailer stores the name,
// and the last one wins because Claude Code rewrites it as the work moves.
func TestTailerStoresTheSessionTitle(t *testing.T) {
	root := t.TempDir()
	tl, st := newTailerAt(t, root)
	path := filepath.Join(root, "-proj", "s1.jsonl")
	writeTranscript(t, path, "s1")
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString(titleLine("Первое имя") + titleLine("Fix the paste bug"))
	_ = f.Close()
	if err := tl.discover(nil); err != nil {
		t.Fatal(err)
	}
	tl.pass(context.Background(), false)
	s, err := store.GetSession(context.Background(), st.DB(), "s1")
	if err != nil {
		t.Fatal(err)
	}
	if s.Title != "Fix the paste bug" {
		t.Fatalf("title = %q", s.Title)
	}
	if n := tl.Stats().EventsStored; n != 1 {
		t.Fatalf("a title line must not become an event: %d stored", n)
	}
}

// Sessions ingested before titles were read get them from the file, once —
// including when the recorded path points into a subagent.
func TestBackfillTitlesFromTheMainTranscript(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	st, err := store.Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	main := filepath.Join(dir, "s1.jsonl")
	if err := os.WriteFile(main, []byte(`{"type":"user","sessionId":"s1"}`+"\n"+titleLine("Old")+titleLine("Named")), 0o600); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(dir, "s1", "subagents", "agent-a.jsonl")
	for id, p := range map[string]string{"s1": sub, "gone": filepath.Join(dir, "gone.jsonl")} {
		if err := store.UpsertSession(ctx, st.DB(), id, store.SessionPatch{Cwd: "/r", TranscriptPath: p}); err != nil {
			t.Fatal(err)
		}
	}
	n, err := BackfillTitles(ctx, st.DB(), nil)
	if err != nil || n != 1 {
		t.Fatalf("named %d, err %v", n, err)
	}
	s, _ := store.GetSession(ctx, st.DB(), "s1")
	if s.Title != "Named" {
		t.Fatalf("title = %q", s.Title)
	}
}

func TestMainTranscript(t *testing.T) {
	sep := string(filepath.Separator)
	p := filepath.Join("a", "proj", "abc", "subagents", "agent-1.jsonl")
	if got, want := MainTranscript(p, "abc"), filepath.Join("a", "proj")+sep+"abc.jsonl"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
	if got := MainTranscript(filepath.Join("a", "abc.jsonl"), "abc"); got != filepath.Join("a", "abc.jsonl") {
		t.Fatalf("main path changed: %q", got)
	}
}

func TestNeedsTitleBackfill(t *testing.T) {
	for in, want := range map[string]bool{"": false, "1": true, "2": true, fmt.Sprint(SchemaVersion): false} {
		if got := NeedsTitleBackfill(in); got != want {
			t.Errorf("NeedsTitleBackfill(%q) = %v, want %v", in, got, want)
		}
	}
	// Moving to v3 must not rerun the v1 text repair.
	if NeedsTextRepair("2") {
		t.Error("v2 → v3 reran the text repair")
	}
}
