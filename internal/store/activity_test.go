package store

import (
	"context"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

func TestActivityBucketsCountsTurnsAndToolsPerSession(t *testing.T) {
	ctx := context.Background()
	f := &weekFixture{t: t, s: openTest(t), loc: time.UTC}
	from := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	put := func(sid string, kind event.Kind, at time.Duration) {
		f.put(event.Event{SessionID: sid, Source: event.SourceHook, Kind: kind, Tool: "Bash", Ts: from.Add(at)})
	}
	put("a", event.KindToolPre, 30*time.Second)
	put("a", event.KindTurnAssistant, 90*time.Second)
	put("a", event.KindToolPre, 5*time.Minute)
	put("a", event.KindToolPost, 5*time.Minute) // not counted: one call is one mark
	put("b", event.KindToolPre, -time.Minute)   // before the window
	put("b", event.KindToolPre, 7*time.Minute)  // after it
	put("b", event.KindToolPre, 45*time.Second)

	got, err := ActivityBuckets(ctx, f.s.DB(), from.UnixMilli(), 2*60*1000, 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("sessions %v, want a and b", got)
	}
	if a := got["a"]; len(a) != 3 || a[0] != 2 || a[1] != 0 || a[2] != 1 {
		t.Fatalf("a = %v, want [2 0 1]", a)
	}
	if b := got["b"]; len(b) != 3 || b[0] != 1 || b[1] != 0 || b[2] != 0 {
		t.Fatalf("b = %v, want [1 0 0]", b)
	}
}
