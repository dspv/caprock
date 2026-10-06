package store

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// The mode a session was last in is the newest hook that states one: ⇧Tab
// changes it mid-session, and a resume should pick up where the session was,
// not where it started.
func TestLastPermissionModeIsTheNewestHookThatSaysOne(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	at := time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC)
	put := func(id string, src event.Source, kind event.Kind, payload string, d time.Duration) {
		t.Helper()
		ev := event.Event{SessionID: id, Source: src, Kind: kind, Ts: at.Add(d), Payload: json.RawMessage(payload)}
		if _, err := InsertEvent(ctx, s.DB(), &ev); err != nil {
			t.Fatal(err)
		}
	}
	put("s", event.SourceHook, event.KindAgentSpawn, `{"permission_mode":"default"}`, 0)
	put("s", event.SourceHook, event.KindTurnUser, `{"permission_mode":"bypassPermissions"}`, time.Second)
	// Newer, but none of these may answer: a transcript line, a hook without
	// the field, and a PostToolUse (skipped for its size).
	put("s", event.SourceTranscript, event.KindTurnAssistant, `{"permission_mode":"plan"}`, 2*time.Second)
	put("s", event.SourceHook, event.KindAgentStop, `{"stop_reason":"end_turn"}`, 3*time.Second)
	put("s", event.SourceHook, event.KindToolPost, `{"permission_mode":"acceptEdits"}`, 4*time.Second)

	got, err := LastPermissionMode(ctx, s.DB(), "s")
	if err != nil || got != "bypassPermissions" {
		t.Fatalf("got %q, %v; want bypassPermissions", got, err)
	}

	// A session with no hooks at all has no recorded mode, and that is not an error.
	put("quiet", event.SourceTranscript, event.KindTurnUser, `{"text":"hi"}`, 0)
	for _, id := range []string{"quiet", "unknown"} {
		if got, err := LastPermissionMode(ctx, s.DB(), id); err != nil || got != "" {
			t.Fatalf("%s: got %q, %v; want empty", id, got, err)
		}
	}
}
