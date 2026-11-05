package mailstore

import (
	"context"
	"testing"
)

// The digest counts new inbox conversations, leaves out spam, and lists the
// important ones newest first — from labels already stored.
func TestDigest(t *testing.T) {
	ctx := context.Background()
	st, acct, f := triageStore(t)
	put(t, st, acct, f, 1, "old", "old@x.example", 50) // before since
	put(t, st, acct, f, 2, "a", "ann@x.example", 100)
	put(t, st, acct, f, 3, "b", "bob@x.example", 200)
	put(t, st, acct, f, 4, "c", "cat@x.example", 300)
	put(t, st, acct, f, 5, "s", "spam@x.example", 400)
	for key, cat := range map[string]string{"a": "important", "b": "updates", "c": "important", "s": "spam", "old": "important"} {
		if err := st.LabelTriage(ctx, acct, key, cat, ""); err != nil {
			t.Fatal(err)
		}
	}
	total, important, items, err := st.Digest(ctx, 100, 1)
	if err != nil {
		t.Fatal(err)
	}
	if total != 3 || important != 2 || len(items) != 1 || items[0].FromAddr != "cat@x.example" || items[0].Subject != "c" {
		t.Fatalf("total %d important %d items %+v", total, important, items)
	}
}
