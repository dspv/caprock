package store

import (
	"context"
	"testing"
)

// A folder label is set, replaced and removed; the table refuses any label
// but work and personal.
func TestFolderLabelsRoundTrip(t *testing.T) {
	ctx := context.Background()
	db := openTest(t).DB()
	if err := SetFolderLabel(ctx, db, "/home/me/dev/acme", FolderLabelWork, 1); err != nil {
		t.Fatal(err)
	}
	if err := SetFolderLabel(ctx, db, "/home/me/notes", FolderLabelPersonal, 2); err != nil {
		t.Fatal(err)
	}
	if err := SetFolderLabel(ctx, db, "/home/me/dev/acme", FolderLabelPersonal, 3); err != nil {
		t.Fatal(err)
	}
	got, err := ListFolderLabels(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != (FolderLabel{"/home/me/dev/acme", FolderLabelPersonal, 3}) || got[1].Dir != "/home/me/notes" {
		t.Fatalf("labels = %+v", got)
	}
	if err := SetFolderLabel(ctx, db, "/home/me/notes", "", 4); err != nil {
		t.Fatal(err)
	}
	if got, _ := ListFolderLabels(ctx, db); len(got) != 1 {
		t.Fatalf("after removal: %+v", got)
	}
	if err := SetFolderLabel(ctx, db, "/x", "secret", 5); err == nil {
		t.Fatal("a label outside work and personal was stored")
	}
	if ValidFolderLabel("") || !ValidFolderLabel("work") || ValidFolderLabel("Work") {
		t.Fatal("ValidFolderLabel")
	}
}

// A continuation of a chat is a chat; of a work session, not.
func TestCarryChatFollowsTheSessionContinued(t *testing.T) {
	ctx := context.Background()
	db := openTest(t).DB()
	for _, id := range []string{"chat", "work", "next-chat", "next-work"} {
		if err := UpsertSession(ctx, db, id, SessionPatch{Cwd: "/home/me/dev/acme"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := MarkChat(ctx, db, "chat"); err != nil {
		t.Fatal(err)
	}
	if err := CarryChat(ctx, db, "next-chat", "chat"); err != nil {
		t.Fatal(err)
	}
	if err := CarryChat(ctx, db, "next-work", "work"); err != nil {
		t.Fatal(err)
	}
	if err := CarryChat(ctx, db, "next-work", "unknown"); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]bool{"next-chat": true, "next-work": false} {
		s, err := GetSession(ctx, db, id)
		if err != nil {
			t.Fatal(err)
		}
		if s.Chat != want {
			t.Errorf("%s: chat = %v, want %v", id, s.Chat, want)
		}
	}
}
