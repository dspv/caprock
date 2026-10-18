package store

import (
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/modelclass"
)

// HistoryFrom takes turns, tool calls, cost, unpriced and background volume
// from Summarize instead of scanning for them again (resource-usage audit
// F13). Equal, not close: the history screen states its totals as measured,
// so the shortcut must give exactly what History's own scans give, at every
// range, with internal turns, unpriced turns and events outside the range in
// the data.
func TestHistoryFromMatchesHistory(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	add := func(sess string, kind event.Kind, model string, ts time.Time, key string, cost *float64, tok *event.TokenDelta) {
		t.Helper()
		ev := &event.Event{SessionID: sess, Source: event.SourceTranscript, Kind: kind, Model: model, Ts: ts, Key: key, CostUSD: cost, Tokens: tok}
		if kind == event.KindTurnAssistant {
			ev.MsgID = "m-" + key
		}
		if _, err := InsertEvent(ctx, s.db, ev); err != nil {
			t.Fatal(err)
		}
		if err := UpsertSession(ctx, s.db, sess, SessionPatch{LastEventAt: ts.UnixMilli()}); err != nil {
			t.Fatal(err)
		}
	}
	price := func(v float64) *float64 { return &v }
	tok := &event.TokenDelta{In: 10, Out: 20, CacheRead: 300, CacheWrite: 40}
	for i := 0; i < 40; i++ {
		ts := now.Add(-time.Duration(i) * 36 * time.Hour)
		sess := fmt.Sprintf("s%d", i%5)
		add(sess, event.KindTurnAssistant, "claude-opus-5", ts, fmt.Sprintf("a%d", i), price(0.1+float64(i)/7), tok)
		add(sess, event.KindToolPre, "", ts, fmt.Sprintf("p%d", i), nil, nil)
		add(sess, event.KindToolPost, "", ts, fmt.Sprintf("q%d", i), nil, nil)
		if i%4 == 0 {
			// Volume with no price, and background machinery.
			add(sess, event.KindTurnAssistant, "unknown-model-x", ts, fmt.Sprintf("u%d", i), nil, tok)
			add(sess, event.KindTurnAssistant, modelclass.CodexAutoReview, ts, fmt.Sprintf("b%d", i), price(0.5), tok)
		}
	}
	ranges := []int64{0, now.Add(-7 * 24 * time.Hour).UnixMilli(), now.Add(-time.Hour).UnixMilli(), now.Add(time.Hour).UnixMilli()}
	for _, from := range ranges {
		want, err := History(ctx, s.db, from)
		if err != nil {
			t.Fatal(err)
		}
		sum, err := Summarize(ctx, s.db, from)
		if err != nil {
			t.Fatal(err)
		}
		got, err := HistoryFrom(ctx, s.db, from, sum)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("from %d: HistoryFrom = %+v, History = %+v", from, got, want)
		}
		if from == 0 && (want.Unpriced == nil || want.Background == nil || want.Turns == 0 || want.ToolCalls == 0) {
			t.Fatalf("the data must exercise every reused field: %+v", want)
		}
	}
}
