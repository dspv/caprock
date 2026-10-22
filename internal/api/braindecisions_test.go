package api

import (
	"context"
	"fmt"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

// GET /v1/brain/decisions is a project's current decisions; a supersedes
// link made by a read can be undone with DELETE /v1/brain/links naming its
// kind, which removes that edge alone and makes the older decision current
// again.
func TestBrainCurrentDecisionsAndUndoingASupersede(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	db := e.st.DB()
	add := func(kind, title string, at int64) store.BrainNode {
		t.Helper()
		n, _, err := store.InsertBrainNode(ctx, db, store.BrainNode{Kind: kind, Title: title, Source: store.BrainSource{Project: "caprock"}}, at)
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	old := add("decision", "Five dollars a month", 1)
	cur := add("decision", "Thirty dollars a year", 2)
	add("finding", "Not a decision", 3)
	if err := store.BrainSupersede(ctx, db, cur.ID, old.ID, 4); err != nil {
		t.Fatal(err)
	}
	if err := store.LinkBrain(ctx, db, cur.ID, old.ID, store.EdgeRelates, 1, 4); err != nil {
		t.Fatal(err)
	}
	if code, _ := brainDo(t, e, "GET", "/v1/brain/decisions", nil); code != 400 {
		t.Errorf("no project: %d", code)
	}
	var v struct {
		Decisions []store.BrainNode `json:"decisions"`
	}
	if code := e.get(t, "/v1/brain/decisions?project=caprock", &v); code != 200 || len(v.Decisions) != 1 || v.Decisions[0].ID != cur.ID {
		t.Fatalf("current: %d %+v", code, v.Decisions)
	}
	var node struct {
		Node store.BrainNode `json:"node"`
	}
	if code := e.get(t, fmt.Sprintf("/v1/brain/nodes/%d", old.ID), &node); code != 200 || node.Node.SupersededBy != cur.ID {
		t.Errorf("the node says what superseded it: %+v", node.Node)
	}
	if code, out := brainDo(t, e, "DELETE", "/v1/brain/links", map[string]any{"from": cur.ID, "to": old.ID, "kind": "supersedes"}); code != 204 {
		t.Fatalf("undo: %d %v", code, out)
	}
	if code := e.get(t, "/v1/brain/decisions?project=caprock", &v); code != 200 || len(v.Decisions) != 2 {
		t.Errorf("both current again: %+v", v.Decisions)
	}
	links, err := store.BrainNeighbours(ctx, db, cur.ID, 10)
	if err != nil || len(links) != 1 || links[0].Kind != store.EdgeRelates {
		t.Errorf("the relates edge stays: %+v %v", links, err)
	}
	// A supersedes made by hand is checked like a read's: a finding is
	// never superseded.
	f := add("finding", "Measured churn", 5)
	if code, _ := brainDo(t, e, "POST", "/v1/brain/links", map[string]any{"from": cur.ID, "to": f.ID, "kind": "supersedes"}); code != 400 {
		t.Errorf("superseding a finding: %d", code)
	}
}
