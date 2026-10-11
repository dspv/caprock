package api

import (
	"context"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

func TestActivityServesTheLastHourInBuckets(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	ev := event.Event{SessionID: "a1", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Bash", Ts: time.Now(), Key: "k1"}
	if _, err := store.InsertEvent(ctx, e.st.DB(), &ev); err != nil {
		t.Fatal(err)
	}
	var got ActivityResponse
	if code := e.get(t, "/v1/activity", &got); code != 200 {
		t.Fatalf("status %d", code)
	}
	if got.Buckets != 30 || got.BucketMs != 120000 {
		t.Fatalf("shape %+v", got)
	}
	a := got.Sessions["a1"]
	if len(a) != 30 || a[29] != 1 {
		t.Fatalf("a1 = %v, want the call in the last bucket", a)
	}
}
