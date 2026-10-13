package rollup

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/event"
)

// An unpriced model is reported once per model per daemon run, not once per
// event: per event it wrote 46,652 identical lines to the owner's log in two
// days (2026-09-27 and 09-29).
func TestUnpricedModelIsLoggedOncePerModel(t *testing.T) {
	r, _ := newRecorder(t)
	var buf bytes.Buffer
	r.Log = slog.New(slog.NewTextHandler(&buf, nil))
	ctx := context.Background()
	for i := 0; i < 50; i++ {
		for _, m := range []string{"mystery-9", "mystery-10"} {
			ev := &event.Event{SessionID: "s", Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
				Key: fmt.Sprintf("%s-%d", m, i), Model: m, Tokens: &event.TokenDelta{In: 5}}
			if _, err := r.Record(ctx, ev, SessionInfo{}); err != nil {
				t.Fatal(err)
			}
		}
	}
	out := buf.String()
	if n := strings.Count(out, "model not in pricing table"); n != 2 {
		t.Fatalf("want one line per model (2), got %d:\n%s", n, out)
	}
	for _, m := range []string{"model=mystery-9 ", "model=mystery-10 "} {
		if strings.Count(out, m) != 1 {
			t.Fatalf("%q not logged exactly once:\n%s", m, out)
		}
	}
}
