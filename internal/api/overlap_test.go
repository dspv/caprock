package api

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
)

// Two live sessions in one clone that both edited main.go are each other's
// neighbours, named, with the file; a third in a worktree of its own is not.
func TestOverlap(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	root := t.TempDir()
	wt := filepath.Join(root, ".caprock-worktrees", "other")
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(wt, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: "+filepath.Join(root, ".git", "worktrees", "other")), 0o644); err != nil {
		t.Fatal(err)
	}
	file := filepath.ToSlash(root) + "/main.go"
	edit := func(id, cwd, path, prompt string, at time.Duration) {
		for _, ev := range []*event.Event{
			{SessionID: id, Source: event.SourceHook, Kind: event.KindTurnUser, Key: id + ":p", Ts: e.now.Add(at), Payload: json.RawMessage(`{"prompt":"` + prompt + `"}`)},
			{SessionID: id, Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Edit", Key: id + ":e", Ts: e.now.Add(at + time.Second), Payload: json.RawMessage(`{"tool_name":"Edit","tool_input":{"file_path":"` + path + `"}}`)},
		} {
			if _, err := e.rec.Record(ctx, ev, rollup.SessionInfo{Cwd: cwd}); err != nil {
				t.Fatal(err)
			}
		}
	}
	edit("a", root, file, "fix the login bug", -10*time.Minute)
	edit("b", root, file, "refactor the router", -time.Minute)
	edit("c", wt, filepath.ToSlash(wt)+"/main.go", "write the docs", 0)

	var got Overlap
	if code := e.get(t, "/v1/overlap", &got); code != 200 {
		t.Fatalf("status %d", code)
	}
	if got.WindowMinutes != 30 || len(got.Sessions) != 2 {
		t.Fatalf("overlap: %+v", got)
	}
	if _, ok := got.Sessions["c"]; ok {
		t.Fatal("a session in its own worktree was flagged")
	}
	b := got.Sessions["b"]
	if len(b.With) != 1 || b.With[0].SessionID != "a" || b.With[0].Name != "fix the login bug" || b.With[0].NameSource != DescriptionPrompt {
		t.Fatalf("b: %+v", b)
	}
	if len(b.With[0].Files) != 1 || filepath.Base(b.With[0].Files[0]) != "main.go" {
		t.Fatalf("files: %v", b.With[0].Files)
	}
}
