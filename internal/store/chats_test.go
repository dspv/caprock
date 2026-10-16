package store

import (
	"context"
	"os"
	"strings"
	"testing"
)

// Migration 0059's backfill marks the chats recorded before the column by
// their folder: a dated name, with a counter or without, directly under a
// folder called chats, with either separator — and nothing else.
func TestMigration0059MarksTheChatsAlreadyRecorded(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	db := s.DB()
	cases := map[string]bool{
		"/Users/me/Library/Application Support/caprock/chats/2026-08-26-212735":   true,
		"/Users/me/Library/Application Support/caprock/chats/2026-08-26-212735-2": true,
		`C:\Users\me\AppData\Roaming\caprock\chats\2026-08-26-212735`:             true,
		"/Users/me/dev/chats":                   false,
		"/Users/me/chats/notes":                 false,
		"/Users/me/chats/2026-08-26-2127xx":     false,
		"/Users/me/chats/2026-08-26-212735/sub": false,
		"/Users/me/dev/caprock":                 false,
		"/Users/me/xchats/2026-08-26-212735":    false,
	}
	i := 0
	ids := map[string]string{}
	for cwd := range cases {
		i++
		id := "s" + string(rune('a'+i))
		ids[id] = cwd
		if err := UpsertSession(ctx, db, id, SessionPatch{Cwd: cwd}); err != nil {
			t.Fatal(err)
		}
	}
	b, err := os.ReadFile("migrations/0059_session_chat.sql")
	if err != nil {
		t.Fatal(err)
	}
	src := string(b)
	start := strings.Index(src, "UPDATE sessions SET chat = 1")
	end := strings.Index(src[start:], ";")
	if start < 0 || end < 0 {
		t.Fatal("the backfill is not in the migration")
	}
	if _, err := db.ExecContext(ctx, src[start:start+end]); err != nil {
		t.Fatal(err)
	}
	for id, cwd := range ids {
		got, err := GetSession(ctx, db, id)
		if err != nil {
			t.Fatal(err)
		}
		if got.Chat != cases[cwd] {
			t.Errorf("%s: chat = %v, want %v", cwd, got.Chat, cases[cwd])
		}
	}
}

func TestChatScopeAndArchive(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	db := s.DB()
	for _, id := range []string{"work", "chat1", "chat2"} {
		if err := UpsertSession(ctx, db, id, SessionPatch{Cwd: "/x/" + id}); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"chat1", "chat2"} {
		if err := MarkChat(ctx, db, id); err != nil {
			t.Fatal(err)
		}
	}
	if err := SetChatArchived(ctx, db, "chat2", 1234); err != nil {
		t.Fatal(err)
	}
	if err := SetChatArchived(ctx, db, "work", 1); err == nil {
		t.Error("a work session was archived as a chat")
	}
	count := func(f SessionQuery) int {
		n, err := CountSessionsQuery(ctx, db, f)
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := count(SessionQuery{}); n != 3 {
		t.Errorf("every session: %d", n)
	}
	if n := count(SessionQuery{Chats: ChatsExcluded}); n != 1 {
		t.Errorf("without chats: %d", n)
	}
	if n := count(SessionQuery{Chats: ChatsOnly}); n != 1 {
		t.Errorf("chats shown: %d", n)
	}
	if n := count(SessionQuery{Chats: ChatsOnly, Archived: true}); n != 1 {
		t.Errorf("chats archived: %d", n)
	}
	c, err := CountChats(ctx, db)
	if err != nil || c.Chats != 1 || c.Archived != 1 {
		t.Errorf("counts: %+v %v", c, err)
	}
	got, _ := GetSession(ctx, db, "chat2")
	if !got.Chat || got.ArchivedAt != 1234 {
		t.Errorf("chat2: %+v", got)
	}
}
