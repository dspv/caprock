package mailstore

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func triageStore(t *testing.T) (*Store, int64, Folder) {
	t.Helper()
	st, err := Open(filepath.Join(t.TempDir(), "mail.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	ctx := context.Background()
	id, err := st.AddAccount(ctx, Account{Email: "me@x.example", Username: "me", IMAPHost: "i", IMAPPort: 1, SMTPHost: "s", SMTPPort: 1})
	if err != nil {
		t.Fatal(err)
	}
	f, err := st.UpsertFolder(ctx, id, "INBOX", "/", "inbox")
	if err != nil {
		t.Fatal(err)
	}
	return st, id, f
}

func put(t *testing.T, st *Store, acct int64, f Folder, uid uint32, key, from string, date int64) int64 {
	t.Helper()
	m := &Message{AccountID: acct, FolderID: f.ID, UID: uid, ThreadKey: key, FromAddr: from, Subject: key, Date: date}
	id, err := st.UpsertHeader(context.Background(), m)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// Pending is the unsorted conversations, newest first; a conversation that
// gains a message is pending again unless the user labelled it.
func TestTriagePendingSaveAndLabel(t *testing.T) {
	ctx := context.Background()
	st, acct, f := triageStore(t)
	a1 := put(t, st, acct, f, 1, "a", "ann@x.example", 100)
	put(t, st, acct, f, 2, "b", "bob@spam.example", 200)
	todo, err := st.TriagePending(ctx, 200)
	if err != nil || len(todo) != 2 || todo[0].ThreadKey != "b" {
		t.Fatalf("pending: %+v %v", todo, err)
	}
	if todo2, _ := st.TriagePending(ctx, 1); len(todo2) != 1 {
		t.Fatalf("the window caps the conversations looked at: %+v", todo2)
	}
	if err := st.SaveTriage(ctx, Triage{AccountID: acct, ThreadKey: "a", MessageID: a1, Category: "important", Summary: "hi", Model: "claude"}, "ann@x.example"); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveTriage(ctx, Triage{AccountID: acct, ThreadKey: "b", MessageID: todo[0].Newest, Category: "spam", Model: "claude"}, "bob@spam.example"); err != nil {
		t.Fatal(err)
	}
	if todo, _ := st.TriagePending(ctx, 200); len(todo) != 0 {
		t.Fatalf("all sorted: %+v", todo)
	}
	put(t, st, acct, f, 3, "a", "ann@x.example", 300)
	if todo, _ := st.TriagePending(ctx, 200); len(todo) != 1 || todo[0].ThreadKey != "a" {
		t.Fatalf("a grown conversation is sorted again: %+v", todo)
	}

	// The list filters by label and carries it.
	spam, _ := st.List(ctx, Query{View: "inbox", Category: "spam"})
	rest, _ := st.List(ctx, Query{View: "inbox", Category: "nospam"})
	if len(spam) != 1 || spam[0].ThreadKey != "b" || spam[0].AI == nil || spam[0].AI.Category != "spam" || len(rest) != 2 {
		t.Fatalf("filters: spam=%+v rest=%d", spam, len(rest))
	}
	counts, _ := st.TriageCounts(ctx)
	if len(counts) != 2 {
		t.Fatalf("counts: %+v", counts)
	}

	// Not spam: kept from then on, and the sender is cleared for later mail.
	if err := st.LabelTriage(ctx, acct, "b", "important", "bob@spam.example"); err != nil {
		t.Fatal(err)
	}
	put(t, st, acct, f, 4, "b", "bob@spam.example", 400)
	if todo, _ := st.TriagePending(ctx, 200); len(todo) != 1 || todo[0].ThreadKey != "a" {
		t.Fatalf("a user label is never sorted again: %+v", todo)
	}
	_ = st.SaveTriage(ctx, Triage{AccountID: acct, ThreadKey: "b", MessageID: 99, Category: "spam", Model: "claude"}, "bob@spam.example")
	if tr, _ := st.TriageOf(ctx, acct, "b"); tr.Category != "important" || !tr.User {
		t.Fatalf("the model overwrote the user's label: %+v", tr)
	}
	put(t, st, acct, f, 5, "c", "Bob@Spam.example", 500)
	_ = st.SaveTriage(ctx, Triage{AccountID: acct, ThreadKey: "c", MessageID: 5, Category: "spam", Model: "claude"}, "Bob@Spam.example")
	if tr, _ := st.TriageOf(ctx, acct, "c"); tr.Category != "important" || tr.User {
		t.Fatalf("a cleared sender's new mail is not spam: %+v", tr)
	}

	// Removing the account removes its labels.
	if err := st.DeleteAccount(ctx, acct); err != nil {
		t.Fatal(err)
	}
	if _, err := st.TriageOf(ctx, acct, "a"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("labels outlived the account: %v", err)
	}
}
