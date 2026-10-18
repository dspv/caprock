package engine

import (
	"context"
	"testing"

	"github.com/dspv/caprock/internal/mail/fakemail"
	store "github.com/dspv/caprock/internal/mail/mailstore"
)

func TestCleanupMovesSpamAndOnlyExpungesSelectedTrash(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	for _, subject := range []string{"Selected", "Keep"} {
		if err := h.srv.Deliver("INBOX", fakemail.Msg{From: "a@example.com", To: h.acc.Email, Subject: subject, Body: "Hello"}.Raw()); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.e.Start(); err != nil {
		t.Fatal(err)
	}
	h.waitFor("inbox", func() bool { return len(h.list("inbox")) == 2 })
	inbox := h.list("inbox")
	cleanup := func(ids []int64, view string) error {
		identities := map[int64]string{}
		for _, id := range ids {
			m, err := h.st.Message(ctx, id)
			if err != nil {
				return err
			}
			f, err := h.st.Folder(ctx, m.FolderID)
			if err != nil {
				return err
			}
			identities[id] = store.CleanupIdentity(m.AccountID, m.FolderID, f.UIDValidity, m.UID)
		}
		return h.e.Cleanup(ctx, ids, view, identities)
	}
	if err := cleanup([]int64{inbox[0].ID}, "trash"); err == nil {
		t.Fatal("purged Inbox")
	}
	for _, m := range inbox {
		if err := cleanup([]int64{m.ID}, "junk"); err != nil {
			t.Fatal(err)
		}
	}
	h.waitFor("trash", func() bool { return len(h.list("trash")) == 2 })
	trash := h.list("trash")
	if err := cleanup([]int64{trash[0].ID}, "junk"); err == nil {
		t.Fatal("spam cleanup accepted Trash")
	}
	if err := cleanup([]int64{trash[0].ID}, "trash"); err != nil {
		t.Fatal(err)
	}
	left := h.list("trash")
	if len(left) != 1 || left[0].ID != trash[1].ID {
		t.Fatalf("wrong messages remain: %+v", left)
	}
}
