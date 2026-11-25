package store

import (
	"context"
	"testing"
)

// Migration 0095: an older error never replaces a newer one, a resume is
// written only for the error it answers, and a reply turns a try into
// "recovered" and forgets a give-up.
func TestAPIErrorColumns(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	db := st.DB()
	if err := UpsertSession(ctx, db, "s1", SessionPatch{Cwd: "/r"}); err != nil {
		t.Fatal(err)
	}
	if err := MarkOwned(ctx, db, "s1", "", "claude", 1); err != nil {
		t.Fatal(err)
	}
	get := func() *APIError {
		s, err := GetSession(ctx, db, "s1")
		if err != nil {
			t.Fatal(err)
		}
		return s.APIError
	}
	if get() != nil {
		t.Fatal("a new session has no API error")
	}
	if err := SetAPIError(ctx, db, "s1", APIError{At: 2000, Reason: "529 Overloaded", Retryable: true}); err != nil {
		t.Fatal(err)
	}
	if err := SetAPIError(ctx, db, "s1", APIError{At: 1000, Reason: "old"}); err != nil {
		t.Fatal(err)
	}
	if e := get(); e == nil || e.At != 2000 || e.Reason != "529 Overloaded" || !e.Retryable {
		t.Fatalf("after an older one: %+v", e)
	}
	if list, err := OwnedAtAPIError(ctx, db); err != nil || len(list) != 1 {
		t.Fatalf("owned at an API error: %d %v", len(list), err)
	}
	if ok, _ := SetAPIResume(ctx, db, "s1", 1500, ResumeResumed, 1, 3000); ok {
		t.Fatal("a resume for another error was written")
	}
	if ok, err := SetAPIResume(ctx, db, "s1", 2000, ResumeResumed, 1, 3000); err != nil || !ok {
		t.Fatalf("resume: %v %v", ok, err)
	}
	if ok, _ := SetAPIResume(ctx, db, "s1", 2000, ResumeResumed, 1, 0); !ok {
		t.Fatal("a state change without a time")
	}
	if e := get(); e.Resume != ResumeResumed || e.Tries != 1 || e.ResumedAt != 3000 || e.For != 2000 {
		t.Fatalf("after the try: %+v", e)
	}
	if cleared, _ := ClearAPIError(ctx, db, "s1", 1500); cleared {
		t.Fatal("an older reply cleared a newer error")
	}
	if cleared, _ := ClearAPIError(ctx, db, "s1", 4000); !cleared {
		t.Fatal("the reply did not clear it")
	}
	if e := get(); e == nil || e.At != 0 || e.Resume != ResumeRecovered || e.Tries != 1 {
		t.Fatalf("after the reply: %+v", e)
	}
	if list, _ := OwnedAtAPIError(ctx, db); len(list) != 0 {
		t.Fatal("a cleared error is still listed")
	}
	if err := SetAPIError(ctx, db, "s1", APIError{At: 5000, Reason: "x", Retryable: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := SetAPIResume(ctx, db, "s1", 5000, ResumeGaveUp, 3, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := ClearAPIError(ctx, db, "s1", 6000); err != nil {
		t.Fatal(err)
	}
	if e := get(); e != nil {
		t.Fatalf("a give-up the user got past is forgotten: %+v", e)
	}
}
