package store

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// Migration 0037, run against rows in the shape the old ingesters wrote: Codex
// and DSH turns and tool calls with no msg_id at all.
func TestLinkToolCallsMigration(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	put := func(session string, source event.Source, kind event.Kind, key string) {
		t.Helper()
		ev := &event.Event{SessionID: session, Source: source, Kind: kind, Key: key, Ts: time.UnixMilli(1_000)}
		if _, err := InsertEvent(ctx, s.db, ev); err != nil {
			t.Fatal(err)
		}
	}
	tool, turn := event.KindToolPre, event.KindTurnAssistant
	put("c1", event.SourceCodex, turn, "codex:turn:3")
	put("c1", event.SourceCodex, tool, "codex:tool:5")
	put("c1", event.SourceCodex, tool, "codex:tool:6")
	put("c1", event.SourceCodex, turn, "codex:turn:9")
	put("c1", event.SourceCodex, tool, "codex:tool:12") // no turn after it
	// A subagent's rows share the session but not the line numbering.
	put("c1", event.SourceCodex, tool, "codex:sub:T:tool:4")
	put("c1", event.SourceCodex, turn, "codex:sub:T:turn:7")
	put("d1", event.SourceDeepseek, turn, "dsh:turn:16")
	put("d1", event.SourceDeepseek, tool, "dsh:tool:17")
	put("d1", event.SourceDeepseek, tool, "dsh:tool:18")
	put("d1", event.SourceDeepseek, turn, "dsh:turn:20")
	put("d1", event.SourceDeepseek, tool, "dsh:tool:21")
	put("h1", event.SourceHook, tool, "pre:toolu_1")
	if err := s.SetMeta(ctx, MetaToolLinkCursor, ToolLinkDone); err != nil {
		t.Fatal(err)
	}

	b, err := migrationFS.ReadFile("migrations/0037_link_tool_calls.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, string(b)); err != nil {
		t.Fatal(err)
	}

	want := map[string]string{
		"codex:turn:3":       "c1/codex:turn:3",
		"codex:tool:5":       "c1/codex:turn:9",
		"codex:tool:6":       "c1/codex:turn:9",
		"codex:turn:9":       "c1/codex:turn:9",
		"codex:tool:12":      "",
		"codex:sub:T:tool:4": "c1/codex:sub:T:turn:7",
		"codex:sub:T:turn:7": "c1/codex:sub:T:turn:7",
		"dsh:turn:16":        "d1/dsh:turn:16",
		"dsh:tool:17":        "d1/dsh:turn:16",
		"dsh:tool:18":        "d1/dsh:turn:16",
		"dsh:turn:20":        "d1/dsh:turn:20",
		"dsh:tool:21":        "d1/dsh:turn:20",
		"pre:toolu_1":        "", // only the transcripts can link a hook-plane call
	}
	for key, msg := range want {
		var got sql.NullString
		if err := s.db.QueryRowContext(ctx, `SELECT msg_id FROM events WHERE key = ?`, key).Scan(&got); err != nil {
			t.Fatalf("%s: %v", key, err)
		}
		if got.String != msg {
			t.Errorf("%s: msg_id = %q, want %q", key, got.String, msg)
		}
	}
	if v, _ := s.GetMeta(ctx, MetaToolLinkCursor); v != "0" {
		t.Errorf("tool-link backfill not re-armed: cursor = %q", v)
	}
}
