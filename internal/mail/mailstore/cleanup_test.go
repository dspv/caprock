package mailstore

import (
	"context"
	"reflect"
	"testing"
)

func TestCleanupScopeAndFilters(t *testing.T) {
	st, acct, inbox := triageStore(t)
	ctx := context.Background()
	folder := func(a int64, name, role string) Folder {
		t.Helper()
		f, err := st.UpsertFolder(ctx, a, name, "/", role)
		if err != nil {
			t.Fatal(err)
		}
		return f
	}
	junk := folder(acct, "Junk", "junk")
	trash := folder(acct, "Trash", "trash")
	archive := folder(acct, "Archive", "archive")
	normal := put(t, st, acct, inbox, 1, "normal", "a@example.com", 100)
	local := put(t, st, acct, inbox, 2, "local", "b@example.com", 100)
	if err := st.SetJunk(ctx, local, true, 90, "test"); err != nil {
		t.Fatal(err)
	}
	ai := put(t, st, acct, inbox, 3, "ai", "c@example.com", 100)
	if err := st.SaveTriage(ctx, Triage{AccountID: acct, ThreadKey: "ai", MessageID: ai, Category: "spam"}, "c@example.com"); err != nil {
		t.Fatal(err)
	}
	provider := put(t, st, acct, junk, 1, "provider", "d@example.com", 100)
	deleted := put(t, st, acct, trash, 1, "deleted", "e@example.com", 100)
	put(t, st, acct, archive, 1, "ai", "c@example.com", 100)
	unknown := put(t, st, acct, trash, 2, "unknown", "e@example.com", 0)
	boundary := put(t, st, acct, trash, 3, "boundary", "e@example.com", 200)
	other, err := st.AddAccount(ctx, Account{Email: "other@example.com", Username: "other", IMAPHost: "i", SMTPHost: "s"})
	if err != nil {
		t.Fatal(err)
	}
	otherID := put(t, st, other, folder(other, "Junk", "junk"), 1, "other", "a@example.com", 100)
	for _, tc := range []struct {
		name string
		q    CleanupQuery
		want []int64
	}{
		{"spam union", CleanupQuery{View: "junk", AccountID: acct}, []int64{local, ai, provider}},
		{"all accounts", CleanupQuery{View: "junk"}, []int64{local, ai, provider, otherID}},
		{"score excludes AI and provider only", CleanupQuery{View: "junk", MinScore: 90}, []int64{local}},
		{"above score", CleanupQuery{View: "junk", MinScore: 91}, []int64{}},
		{"trash", CleanupQuery{View: "trash"}, []int64{deleted, unknown, boundary}},
		{"strict age excludes unknown", CleanupQuery{View: "trash", Before: 200}, []int64{deleted}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := st.CleanupIDs(ctx, tc.q)
			if err != nil || !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v, %v; want %v (normal inbox %d)", got, err, tc.want, normal)
			}
		})
	}
	for _, q := range []CleanupQuery{{View: "inbox"}, {View: "trash", MinScore: 101}, {View: "junk", AccountID: -1}, {View: "trash", Before: -1}} {
		if _, err := st.CleanupIDs(ctx, q); err == nil {
			t.Fatalf("accepted %+v", q)
		}
	}
}

func TestCleanupIncludesMoreThanOneListPage(t *testing.T) {
	st, acct, _ := triageStore(t)
	ctx := context.Background()
	f, err := st.UpsertFolder(ctx, acct, "Trash", "/", "trash")
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 510; i++ {
		put(t, st, acct, f, uint32(i), "bulk", "a@example.com", 100)
	}
	ids, err := st.CleanupIDs(ctx, CleanupQuery{View: "trash"})
	if err != nil || len(ids) != 510 {
		t.Fatalf("got %d: %v", len(ids), err)
	}
}
