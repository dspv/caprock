package store

import (
	"context"
	"strings"
	"testing"
)

// Items come back newest first with their undo; a read is bounded by since
// and limit; rows a month old go when a new one is written.
func TestHandledLog(t *testing.T) {
	ctx := context.Background()
	db := openTest(t).DB()
	const day = 24 * 60 * 60 * 1000
	now := int64(100 * day)
	old, err := AddHandled(ctx, db, HandledItem{At: now - 31*day, Kind: HandledMorning, Text: "Morning summary sent"})
	if err != nil || old.ID == 0 {
		t.Fatalf("%+v %v", old, err)
	}
	if _, err := AddHandled(ctx, db, HandledItem{At: now - 1000, Kind: HandledEndDone, SessionID: "s1", Project: "caprock", Text: "Ended when done"}); err != nil {
		t.Fatal(err)
	}
	moved, err := AddHandled(ctx, db, HandledItem{At: now, Kind: HandledLimitSwitch, SessionID: "s2", Text: "Continued on Kimi",
		Reason: strings.Repeat("x", 2000), Undo: &HandledUndo{Kind: HandledUndoContinueOn, SessionID: "s2", Target: "default"}})
	if err != nil {
		t.Fatal(err)
	}
	if n := len([]rune(moved.Reason)); n != handledReasonMax {
		t.Fatalf("reason not clipped: %d runes", n)
	}
	list, err := ListHandled(ctx, db, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].Kind != HandledLimitSwitch || list[1].Kind != HandledEndDone {
		t.Fatalf("list %+v", list)
	}
	if u := list[0].Undo; u == nil || *u != (HandledUndo{Kind: HandledUndoContinueOn, SessionID: "s2", Target: "default"}) {
		t.Fatalf("undo %+v", list[0].Undo)
	}
	if list[1].Undo != nil || list[1].Project != "caprock" {
		t.Fatalf("second %+v", list[1])
	}
	if got, _ := ListHandled(ctx, db, now, 10); len(got) != 1 {
		t.Fatalf("since: %+v", got)
	}
	if got, _ := ListHandled(ctx, db, 0, 1); len(got) != 1 || got[0].ID != moved.ID {
		t.Fatalf("limit: %+v", got)
	}
	if n, err := CountHandledSince(ctx, db, now-day); err != nil || n != 2 {
		t.Fatalf("count %d %v", n, err)
	}
	if _, err := AddHandled(ctx, db, HandledItem{At: now, Kind: HandledMorning}); err == nil {
		t.Fatal("an item with no text was written")
	}
}
