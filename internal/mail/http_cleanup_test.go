package mail

import (
	"context"
	"encoding/json"
	"testing"

	store "github.com/dspv/caprock/internal/mail/mailstore"
)

func TestCleanupPreviewAndExecutionRevalidateSnapshot(t *testing.T) {
	s := newTestService(t)
	st, err := s.open()
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	acct, err := st.AddAccount(ctx, store.Account{Email: "test@example.com", IMAPHost: "localhost", SMTPHost: "localhost"})
	if err != nil {
		t.Fatal(err)
	}
	inbox, err := st.UpsertFolder(ctx, acct, "INBOX", "/", "inbox")
	if err != nil {
		t.Fatal(err)
	}
	trash, err := st.UpsertFolder(ctx, acct, "Trash", "/", "trash")
	if err != nil {
		t.Fatal(err)
	}
	add := func(f store.Folder, uid uint32) int64 {
		t.Helper()
		id, err := st.UpsertHeader(ctx, &store.Message{AccountID: acct, FolderID: f.ID, UID: uid, Date: 100})
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	reviewed := add(trash, 1)
	h := s.Handler()
	q := store.CleanupQuery{View: "trash", AccountID: acct}
	w := do(t, h, "POST", "/v1/mail/cleanup/preview", q)
	var result struct {
		IDs        []int64          `json:"ids"`
		Identities map[int64]string `json:"identities"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.IDs) != 1 || result.IDs[0] != reviewed {
		t.Fatalf("preview: %d %s", w.Code, w.Body)
	}
	if _, err := st.Message(ctx, reviewed); err != nil {
		t.Fatal("preview deleted mail")
	}
	// A restored message loses its old row; SQLite can reuse its ID for new mail.
	if err := st.DeleteMessages(ctx, []int64{reviewed}); err != nil {
		t.Fatal(err)
	}
	arrived := add(trash, 2)
	if arrived != reviewed {
		t.Fatal("fixture must exercise a reused local ID")
	}
	restored := add(inbox, 1)
	// Even a supplied out-of-scope ID cannot delete restored Inbox mail.
	w = do(t, h, "POST", "/v1/mail/cleanup", cleanupReq{CleanupQuery: q, IDs: []int64{reviewed, restored}, Identities: result.Identities})
	if w.Code != 200 {
		t.Fatalf("revalidated empty snapshot: %d %s", w.Code, w.Body)
	}
	for _, id := range []int64{restored, arrived} {
		if _, err := st.Message(ctx, id); err != nil {
			t.Fatalf("unreviewed mail removed: %d", id)
		}
	}
	for _, body := range []any{q, cleanupReq{CleanupQuery: store.CleanupQuery{View: "inbox"}, IDs: []int64{}}, cleanupReq{CleanupQuery: store.CleanupQuery{View: "trash", MinScore: 101}, IDs: []int64{}}} {
		if w := do(t, h, "POST", "/v1/mail/cleanup", body); w.Code != 400 {
			t.Fatalf("accepted invalid request: %d %s", w.Code, w.Body)
		}
	}
}
