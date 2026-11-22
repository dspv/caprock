package store

import (
	"context"
	"encoding/json"
	"testing"
)

// A collection's version moves on every write to it and on no other's, and a
// restart (a new boot value) never hands back a version an earlier process
// did, even at the same count.
func TestModuleDocsVersion(t *testing.T) {
	ctx := context.Background()
	db := openTest(t).DB()
	v0 := ModuleDocsVersion("alpha", "notes")
	if _, err := SetModuleDoc(ctx, db, "alpha", "notes", "a", []byte(`{}`), 1); err != nil {
		t.Fatal(err)
	}
	v1 := ModuleDocsVersion("alpha", "notes")
	if v1 == v0 {
		t.Fatal("a set did not move the version")
	}
	if _, err := SetModuleDoc(ctx, db, "alpha", "other", "a", []byte(`{}`), 1); err != nil {
		t.Fatal(err)
	}
	if _, err := SetModuleDoc(ctx, db, "beta", "notes", "a", []byte(`{}`), 1); err != nil {
		t.Fatal(err)
	}
	if ModuleDocsVersion("alpha", "notes") != v1 {
		t.Fatal("another collection's write moved this one")
	}
	if _, err := UpdateModuleDoc(ctx, db, "alpha", "notes", "a", map[string]json.RawMessage{"x": json.RawMessage(`1`)}, 2); err != nil {
		t.Fatal(err)
	}
	v2 := ModuleDocsVersion("alpha", "notes")
	if v2 == v1 {
		t.Fatal("an update did not move the version")
	}
	if _, err := DeleteModuleDoc(ctx, db, "alpha", "notes", "a"); err != nil {
		t.Fatal(err)
	}
	v3 := ModuleDocsVersion("alpha", "notes")
	if v3 == v2 {
		t.Fatal("a delete did not move the version")
	}
	TouchModuleDocs("alpha", "notes")
	if ModuleDocsVersion("alpha", "notes") == v3 {
		t.Fatal("a touch did not move the version")
	}

	// A restart: every count back at zero, and still no version seen before.
	seen := map[string]bool{v0: true, v1: true, v2: true, v3: true}
	for range 3 {
		reseedModuleGens()
		v := ModuleDocsVersion("alpha", "notes")
		if seen[v] {
			t.Fatalf("a restart handed back %s again", v)
		}
		seen[v] = true
	}
}
