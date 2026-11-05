package mail

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	store "github.com/dspv/caprock/internal/mail/mailstore"
)

// Mail's part of the Morning summary: left out until Mail is open with an
// account and AI sorting on; then the triage's own labels, sender names
// (else addresses) and subjects.
func TestDigestNeedsAnAccountAndSorting(t *testing.T) {
	ctx := context.Background()
	s := newTestService(t)
	if _, ok := s.Digest(ctx, time.Unix(0, 0), 5); ok {
		t.Fatal("a digest from a Mail never set up")
	}
	st, err := store.Open(filepath.Join(t.TempDir(), "mail.db"))
	if err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.st = st // no engine: nothing syncs in this test
	s.mu.Unlock()
	if _, ok := s.Digest(ctx, time.Unix(0, 0), 5); ok {
		t.Fatal("a digest with no account")
	}
	acct, err := st.AddAccount(ctx, store.Account{Email: "me@x.example", Username: "me", IMAPHost: "i", IMAPPort: 1, SMTPHost: "s", SMTPPort: 1})
	if err != nil {
		t.Fatal(err)
	}
	f, err := st.UpsertFolder(ctx, acct, "INBOX", "/", "inbox")
	if err != nil {
		t.Fatal(err)
	}
	for i, m := range []store.Message{
		{ThreadKey: "a", FromName: "Anna Lee", FromAddr: "anna@x.example", Subject: "Contract", Date: 100},
		{ThreadKey: "b", FromAddr: "bob@x.example", Subject: "Hello", Date: 200},
		{ThreadKey: "c", FromAddr: "news@x.example", Subject: "Digest", Date: 300},
	} {
		m.AccountID, m.FolderID, m.UID = acct, f.ID, uint32(i+1)
		if _, err := st.UpsertHeader(ctx, &m); err != nil {
			t.Fatal(err)
		}
	}
	for key, cat := range map[string]string{"a": "important", "b": "important", "c": "newsletter"} {
		if err := st.LabelTriage(ctx, acct, key, cat, ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, ok := s.Digest(ctx, time.Unix(0, 0), 5); ok {
		t.Fatal("a digest with AI sorting off")
	}
	if err := st.SetSetting(ctx, "ai_enabled", "1"); err != nil {
		t.Fatal(err)
	}
	d, ok := s.Digest(ctx, time.Unix(0, 0), 5)
	if !ok || d.Total != 3 || d.Important != 2 || len(d.Items) != 2 {
		t.Fatalf("digest %+v ok %v", d, ok)
	}
	if d.Items[0] != (DigestItem{Sender: "bob@x.example", Subject: "Hello"}) || d.Items[1].Sender != "Anna Lee" {
		t.Fatalf("items %+v", d.Items)
	}
}
