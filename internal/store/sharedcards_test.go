package store

import (
	"context"
	"testing"
)

func TestSharedCardsKeepListAndForget(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	db := s.DB()
	for _, c := range []SharedCard{
		{ID: "a1", URL: "https://caprock.dev/c/a1", Image: "https://caprock.dev/c/a1.png", DeleteToken: "tok-a", Bytes: 10, At: 100},
		{ID: "b2", URL: "https://caprock.dev/c/b2", DeleteToken: "tok-b", Bytes: 20, At: 200},
	} {
		if err := RecordSharedCard(ctx, db, c); err != nil {
			t.Fatal(err)
		}
	}
	got, err := SharedCards(ctx, db)
	if err != nil || len(got) != 2 || got[0].ID != "b2" || got[1].DeleteToken != "tok-a" {
		t.Fatalf("SharedCards = %+v (%v)", got, err)
	}
	c, ok, err := GetSharedCard(ctx, db, "a1")
	if err != nil || !ok || c.Image != "https://caprock.dev/c/a1.png" || c.Bytes != 10 {
		t.Fatalf("GetSharedCard = %+v %v (%v)", c, ok, err)
	}
	if err := ForgetSharedCard(ctx, db, "a1"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := GetSharedCard(ctx, db, "a1"); ok {
		t.Fatal("a forgotten card is still there")
	}
	if got, _ := SharedCards(ctx, db); len(got) != 1 {
		t.Fatalf("after forgetting: %+v", got)
	}
}
