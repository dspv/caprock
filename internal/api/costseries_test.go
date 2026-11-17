package api

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// A Cursor chat keeps its whole cost on one reconciled row (ADR-095), and
// the session page drew "Cost, cumulative" from the last 60 events: once
// later work pushed that row out of the window the line read $0.00 flat
// beside a Cost tile that read $51.55. The detail carries the series over
// every priced turn, ending at the tile's figure.
func TestSessionCostSeriesCoversTheWholeSession(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	base := time.Now().Add(-time.Hour)
	rec := func(info rollup.SessionInfo, ev *event.Event) {
		t.Helper()
		if _, err := e.rec.Record(ctx, ev, info); err != nil {
			t.Fatal(err)
		}
	}
	at := func(i int) time.Time { return base.Add(time.Duration(i) * time.Second) }

	// Cursor: a reply that carried no money, the usage record holding the
	// chat's $51.55, then 80 events of later work with no cost on them.
	cu := rollup.SessionInfo{Cwd: t.TempDir(), Agent: "cursor", Model: "claude-4.5-sonnet-thinking"}
	zero, total := 0.0, 51.55
	rec(cu, &event.Event{SessionID: "cu", Source: event.SourceCursor, Kind: event.KindTurnAssistant, Key: "cu-msg:1", Ts: at(0),
		Model: cu.Model, Tokens: &event.TokenDelta{In: 10, Out: 5}, CostUSD: &zero, Payload: json.RawMessage(`{"text":"a","cost_basis":"cursor"}`)})
	rec(cu, &event.Event{SessionID: "cu", Source: event.SourceCursor, Kind: event.KindTurnAssistant, Key: "cu-usage:cu:m:1:1:99:51.55", Ts: at(1),
		Model: cu.Model, Tokens: &event.TokenDelta{In: 10921417, Out: 46852}, CostUSD: &total, Payload: json.RawMessage(`{"usage_only":true,"cost_basis":"cursor","requests":99}`)})
	for i := 0; i < 80; i++ {
		rec(cu, &event.Event{SessionID: "cu", Source: event.SourceCursor, Kind: event.KindToolPost, Key: fmt.Sprintf("cu-post:%d", i), Ts: at(2 + i),
			Payload: json.RawMessage(`{}`)})
	}

	// A table-priced session with more turns than the series keeps: thinned,
	// and still ending at the total.
	cc := rollup.SessionInfo{Cwd: t.TempDir()}
	for i := 0; i < store.CostSeriesPoints+30; i++ {
		rec(cc, &event.Event{SessionID: "cc", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: fmt.Sprintf("msg:%d", i), Ts: at(i),
			Model: "claude-opus-5", Tokens: &event.TokenDelta{In: 1000, Out: 100}, Payload: json.RawMessage(`{"text":"hi"}`)})
	}

	for _, tc := range []struct {
		id     string
		priced int64
		points int
	}{{"cu", 1, 2}, {"cc", int64(store.CostSeriesPoints + 30), store.CostSeriesPoints}} {
		var d struct {
			Stats struct {
				CostUSD float64 `json:"cost_usd"`
			} `json:"stats"`
			CostSeries *store.CostSeries `json:"cost_series"`
		}
		if code := e.get(t, "/v1/sessions/"+tc.id, &d); code != 200 {
			t.Fatalf("%s: %d", tc.id, code)
		}
		if d.Stats.CostUSD <= 0 {
			t.Fatalf("%s: stats cost %v, want it priced", tc.id, d.Stats.CostUSD)
		}
		if d.CostSeries == nil || len(d.CostSeries.Points) == 0 {
			t.Fatalf("%s: no cost_series beside a $%.2f Cost tile", tc.id, d.Stats.CostUSD)
		}
		pts := d.CostSeries.Points
		if last := pts[len(pts)-1].USD; math.Abs(last-d.Stats.CostUSD) > 1e-6 {
			t.Errorf("%s: series ends at $%.4f, the Cost tile reads $%.4f", tc.id, last, d.Stats.CostUSD)
		}
		if len(pts) != tc.points {
			t.Errorf("%s: %d points, want %d", tc.id, len(pts), tc.points)
		}
		for i := 1; i < len(pts); i++ {
			if pts[i].USD < pts[i-1].USD || pts[i].Ts < pts[i-1].Ts {
				t.Fatalf("%s: series not cumulative at %d: %+v", tc.id, i, pts[i-1:i+1])
			}
		}
		if d.CostSeries.PricedTurns != tc.priced {
			t.Errorf("%s: priced_turns = %d, want %d (a usage record is not a turn)", tc.id, d.CostSeries.PricedTurns, tc.priced)
		}
	}
}
