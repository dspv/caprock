package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestModuleDocs(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	db := s.DB()

	if _, err := GetModuleDoc(ctx, db, "alpha", "notes", "a"); !errors.Is(err, ErrModuleDocNotFound) {
		t.Fatalf("get on an empty store: %v", err)
	}
	d, err := SetModuleDoc(ctx, db, "alpha", "notes", "a", []byte(`{"x":1,"y":2}`), 100)
	if err != nil || d.CreatedAt != 100 || d.UpdatedAt != 100 {
		t.Fatalf("set: %+v %v", d, err)
	}
	// A second set replaces the data and keeps when it was first made.
	if d, err = SetModuleDoc(ctx, db, "alpha", "notes", "a", []byte(`{"x":3}`), 200); err != nil || d.CreatedAt != 100 || d.UpdatedAt != 200 || string(d.Data) != `{"x":3}` {
		t.Fatalf("replace: %+v %v", d, err)
	}
	// Update merges the top level; null removes a field.
	d, err = UpdateModuleDoc(ctx, s.DB(), "alpha", "notes", "a", map[string]json.RawMessage{"y": json.RawMessage(`"z"`), "x": json.RawMessage(`null`)}, 300)
	if err != nil || string(d.Data) != `{"y":"z"}` || d.UpdatedAt != 300 {
		t.Fatalf("update: %s %+v %v", d.Data, d, err)
	}
	if _, err := UpdateModuleDoc(ctx, db, "alpha", "notes", "missing", map[string]json.RawMessage{}, 1); !errors.Is(err, ErrModuleDocNotFound) {
		t.Errorf("update of a missing doc: %v", err)
	}

	// Modules and collections are separate spaces.
	for _, k := range []struct{ m, c, id string }{{"alpha", "notes", "b"}, {"alpha", "notes", "c"}, {"alpha", "other", "a"}, {"beta", "notes", "a"}} {
		if _, err := SetModuleDoc(ctx, db, k.m, k.c, k.id, []byte(`{}`), 1); err != nil {
			t.Fatal(err)
		}
	}
	list, err := ListModuleDocs(ctx, db, "alpha", "notes", "", 10)
	if err != nil || len(list) != 3 || list[0].ID != "a" || list[2].ID != "c" {
		t.Fatalf("list: %+v %v", list, err)
	}
	if list, _ = ListModuleDocs(ctx, db, "alpha", "notes", "a", 1); len(list) != 1 || list[0].ID != "b" {
		t.Errorf("paged list: %+v", list)
	}
	if ok, err := DeleteModuleDoc(ctx, db, "alpha", "notes", "a"); !ok || err != nil {
		t.Errorf("delete: %v %v", ok, err)
	}
	if ok, _ := DeleteModuleDoc(ctx, db, "alpha", "notes", "a"); ok {
		t.Error("a second delete found a document")
	}
	if _, err := GetModuleDoc(ctx, db, "beta", "notes", "a"); err != nil {
		t.Errorf("another module's document went with it: %v", err)
	}
}
