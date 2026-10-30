package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// compactQueue is fakeQueue that can also compact.
type compactQueue struct {
	fakeQueue
	compacted []string
}

func (c *compactQueue) Compact(_ context.Context, id string) (SendResult, error) {
	if c.err != nil {
		return SendResult{}, c.err
	}
	c.compacted = append(c.compacted, id)
	return SendResult{Sent: true, Queue: QueueView{SessionID: id, Messages: []store.QueuedMessage{}, Waiting: WaitingTurn}}, nil
}

func (e *env) event(t *testing.T, ev event.Event) {
	t.Helper()
	if _, err := store.InsertEvent(context.Background(), e.st.DB(), &ev); err != nil {
		t.Fatal(err)
	}
}

func TestCompactionEndpoints(t *testing.T) {
	e := newEnv(t)
	now := e.api.d.Now()
	var v CompactionView
	if code := e.get(t, "/v1/sessions/s1/compaction", &v); code != 200 || v.Last != nil || v.Running || v.Typical != nil {
		t.Fatalf("nothing recorded: %d %+v", code, v)
	}
	if code := e.send(t, http.MethodPost, "/v1/agents/s1/compact", ``, nil); code != http.StatusNotImplemented {
		t.Fatalf("no queue: %d", code)
	}
	q := &compactQueue{}
	e.api.d.Queue = q

	// The PreCompact hook arrived and no boundary yet: it is running, and a
	// press is refused rather than typing a second /compact.
	e.event(t, event.Event{SessionID: "s1", Source: event.SourceHook, Kind: event.KindContextCompact, Ts: now.Add(-time.Minute),
		Payload: json.RawMessage(`{"trigger":"manual"}`)})
	if e.get(t, "/v1/sessions/s1/compaction", &v); !v.Running {
		t.Fatalf("running not seen: %+v", v)
	}
	if code := e.send(t, http.MethodPost, "/v1/agents/s1/compact", ``, nil); code != http.StatusConflict || len(q.compacted) != 0 {
		t.Fatalf("press while compacting: %d, compacted %v", code, q.compacted)
	}

	// The boundary and the turn after it: measured before and after.
	e.event(t, event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindContextCompacted, Ts: now.Add(-50 * time.Second),
		Key: "compact:b1", Payload: json.RawMessage(`{"trigger":"manual","pre_tokens":467121,"duration_ms":40000}`)})
	e.event(t, event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: now.Add(-40 * time.Second),
		Key: "msg:m1", Model: "claude-sonnet-4-6", Tokens: &event.TokenDelta{In: 10, CacheRead: 50_000, CacheWrite: 11_000}})
	v = CompactionView{}
	e.get(t, "/v1/sessions/s1/compaction", &v)
	if v.Running || v.Last == nil || v.Last.PreTokens != 467121 || v.Last.PostTokens != 61_010 || v.Last.Trigger != "manual" {
		t.Fatalf("after the boundary: %+v %+v", v, v.Last)
	}
	// One measured compaction is not a typical figure.
	if v.Typical != nil {
		t.Fatalf("typical from one: %+v", v.Typical)
	}

	var res SendResult
	if code := e.send(t, http.MethodPost, "/v1/agents/s1/compact", ``, &res); code != 200 || !res.Sent || len(q.compacted) != 1 {
		t.Fatalf("press: %d %+v %v", code, res, q.compacted)
	}
	for _, err := range []error{ErrNotOwned, ErrNotCompactable} {
		q.err = err
		if code := e.send(t, http.MethodPost, "/v1/agents/s2/compact", ``, nil); code != http.StatusConflict {
			t.Errorf("%v: %d, want 409", err, code)
		}
	}
}

// From the fifth measured compaction on this machine, its own median.
func TestCompactionTypicalFromFive(t *testing.T) {
	e := newEnv(t)
	base := e.api.d.Now().Add(-time.Hour)
	for i := range CompactTypicalMin {
		id := "s" + string(rune('a'+i))
		at := base.Add(time.Duration(i) * time.Minute)
		e.event(t, event.Event{SessionID: id, Source: event.SourceTranscript, Kind: event.KindContextCompacted, Ts: at,
			Key: "compact:x", Payload: json.RawMessage(`{"trigger":"auto","pre_tokens":200000}`)})
		e.event(t, event.Event{SessionID: id, Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: at.Add(time.Second),
			Key: "msg:x", Model: "claude-sonnet-4-6", Tokens: &event.TokenDelta{CacheRead: 30_000}})
	}
	var v CompactionView
	e.get(t, "/v1/sessions/sa/compaction", &v)
	if v.Typical == nil || v.Typical.Count != CompactTypicalMin || v.Typical.MedianKept != 0.15 {
		t.Fatalf("typical %+v", v.Typical)
	}
}

// The newest compaction carries its estimate once the pass has made its
// row: the cost, the saving counted from the calls since, and a series of
// at most 24 points that starts at the boundary at zero and ends at the
// saving. The period endpoint sums the rows of its window.
func TestCompactionEstimateAndPeriod(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	now := e.api.d.Now()
	at := now.Add(-time.Hour)
	turn := func(key string, ts time.Time, read int64) {
		e.event(t, event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: ts,
			Key: key, Model: "claude-sonnet-4-6", Tokens: &event.TokenDelta{In: 10, CacheRead: read}})
	}
	turn("msg:before", at.Add(-time.Minute), 400_000)
	e.event(t, event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindContextCompacted, Ts: at,
		Key: "compact:b1", Payload: json.RawMessage(`{"trigger":"auto","pre_tokens":500000,"post_tokens":100000,"duration_ms":30000}`)})
	var v CompactionView
	if e.get(t, "/v1/sessions/s1/compaction", &v); v.Last == nil || v.Estimate != nil {
		t.Fatalf("before the pass: %+v", v)
	}
	for i := range 40 {
		turn("msg:a"+string(rune('A'+i)), at.Add(time.Duration(i+1)*time.Minute), 100_000)
	}
	if _, err := e.rec.RefreshCompactionStats(ctx); err != nil {
		t.Fatal(err)
	}
	// Two more calls after the pass: the series and its end count them.
	turn("msg:late1", now.Add(-2*time.Minute), 100_000)
	turn("msg:late2", now.Add(-time.Minute), 100_000)
	v = CompactionView{}
	e.get(t, "/v1/sessions/s1/compaction", &v)
	est := v.Estimate
	if est == nil || est.EstCostUSD == nil || !est.Warm || est.Model != "claude-sonnet-4-6" || est.SummaryTokensEst != nil {
		t.Fatalf("estimate %+v", est)
	}
	// Warm: 500,000 read from the cache at $0.30 per million; no summary read.
	if d := *est.EstCostUSD - 0.15; d > 1e-9 || d < -1e-9 {
		t.Fatalf("cost %v", *est.EstCostUSD)
	}
	// 42 calls × 400,000 dropped × $0.30 per million.
	if want := 42 * 0.12; est.TurnsAfter != 42 || est.EstSavedUSD-want > 1e-9 || want-est.EstSavedUSD > 1e-9 {
		t.Fatalf("saved %v over %d", est.EstSavedUSD, est.TurnsAfter)
	}
	n := len(est.Series)
	if n > CompactSeriesMax || n < 2 || est.Series[0] != (SavingPoint{At: at.UnixMilli()}) ||
		est.Series[n-1].SavedUSD != est.EstSavedUSD || est.Series[n-1].At != now.Add(-time.Minute).UnixMilli() {
		t.Fatalf("series of %d: %+v", n, est.Series)
	}
	for i := 1; i < n; i++ {
		if est.Series[i].At < est.Series[i-1].At || est.Series[i].SavedUSD < est.Series[i-1].SavedUSD {
			t.Fatalf("series not cumulative at %d: %+v", i, est.Series)
		}
	}

	var p CompactionPeriod
	if code := e.get(t, "/v1/stats/compactions?range=all", &p); code != 200 || p.Count != 1 || p.Priced != 1 || p.Range != "all" {
		t.Fatalf("period: %d %+v", code, p)
	}
	// The stored row counted the 40 calls of its pass.
	if d := p.EstSavedUSD - 40*0.12; d > 1e-9 || d < -1e-9 || p.NetUSD != p.EstSavedUSD-p.EstCostUSD {
		t.Fatalf("period sums %+v", p)
	}
	q := "/v1/stats/compactions?from=" + itoa(now.UnixMilli()) + "&to=" + itoa(now.Add(time.Hour).UnixMilli())
	if code := e.get(t, q, &p); code != 200 || p.Count != 0 {
		t.Fatalf("empty window: %d %+v", code, p)
	}
	if code := e.get(t, "/v1/stats/compactions?from=5&to=1", nil); code != http.StatusBadRequest {
		t.Fatalf("backwards window: %d", code)
	}
}
