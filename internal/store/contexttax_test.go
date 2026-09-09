package store

import (
	"context"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// A tool call is priced by the turn that ISSUED it, found through msg_id.
// The ordering trap this guards is real: a turn's own tool calls are written
// to the transcript on a later line than the turn, and an earlier version that
// resolved during the scan instead of after it dropped every call.
func TestLoopTaxCallsPricesCallsByTheirIssuingTurn(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	base := time.Now().Truncate(time.Millisecond)

	turn := event.Event{
		SessionID: "s1", Source: event.SourceHook, Kind: event.KindTurnAssistant,
		Ts: base, Key: "turn-1", MsgID: "msg-a", Model: "claude-opus-5",
		Tokens: &event.TokenDelta{In: 1_000, CacheRead: 300_000, CacheWrite: 2_000, Out: 500},
	}
	if _, err := InsertEvent(ctx, s.DB(), &turn); err != nil {
		t.Fatal(err)
	}
	// Two calls from that turn, written after it, as the real ingest does.
	for i, tool := range []string{"Bash", "Bash"} {
		e := event.Event{
			SessionID: "s1", Source: event.SourceHook, Kind: event.KindToolPre,
			Tool: tool, Ts: base.Add(time.Duration(i+1) * time.Second),
			Key: string(rune('a'+i)) + "-call", MsgID: "msg-a",
		}
		if _, err := InsertEvent(ctx, s.DB(), &e); err != nil {
			t.Fatal(err)
		}
	}

	calls, unlinked, err := LoopTaxCalls(ctx, s.DB(), "s1", base.Add(-time.Minute), base.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 {
		t.Fatalf("got %d calls, want 2", len(calls))
	}
	if unlinked != 0 {
		t.Fatalf("unlinked = %d, want 0", unlinked)
	}
	for _, c := range calls {
		// C_i = in + cache_read + cache_write, exactly as the spec defines it.
		if c.Context != 303_000 {
			t.Fatalf("context %d, want 303000", c.Context)
		}
		if c.Result != 500 {
			t.Fatalf("result %d, want 500", c.Result)
		}
		if c.Model != "claude-opus-5" {
			t.Fatalf("model %q", c.Model)
		}
	}
}

// A call whose turn carried no usage cannot be priced. It must be dropped, not
// returned as free: a zero would be summed into the tax as if the call had
// re-read nothing.
func TestLoopTaxCallsDropsUnpriceableCalls(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	base := time.Now().Truncate(time.Millisecond)

	orphan := event.Event{
		SessionID: "s2", Source: event.SourceHook, Kind: event.KindToolPre,
		Tool: "Bash", Ts: base, Key: "orphan", MsgID: "msg-missing",
	}
	if _, err := InsertEvent(ctx, s.DB(), &orphan); err != nil {
		t.Fatal(err)
	}
	// A call with no msg_id at all -- the hook plane writes these.
	noMsg := event.Event{
		SessionID: "s2", Source: event.SourceHook, Kind: event.KindToolPre,
		Tool: "Bash", Ts: base.Add(time.Second), Key: "nomsg",
	}
	if _, err := InsertEvent(ctx, s.DB(), &noMsg); err != nil {
		t.Fatal(err)
	}

	calls, unlinked, err := LoopTaxCalls(ctx, s.DB(), "s2", base.Add(-time.Minute), base.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 0 {
		t.Fatalf("got %d calls, want none priced", len(calls))
	}
	// Both are reported as unlinked rather than silently vanishing: a tax
	// summed over fewer calls than the loop ran is an understatement, and the
	// caller has to be able to say so.
	if unlinked != 2 {
		t.Fatalf("unlinked = %d, want 2", unlinked)
	}
}

// The window is the alert's own first-to-last span; calls outside it belong to
// other work and must not be charged to the loop.
func TestLoopTaxCallsHonoursTheWindow(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	base := time.Now().Truncate(time.Millisecond)

	turn := event.Event{
		SessionID: "s3", Source: event.SourceHook, Kind: event.KindTurnAssistant,
		Ts: base, Key: "turn", MsgID: "m", Model: "claude-opus-5",
		Tokens: &event.TokenDelta{In: 100, CacheRead: 200, Out: 10},
	}
	if _, err := InsertEvent(ctx, s.DB(), &turn); err != nil {
		t.Fatal(err)
	}
	inside := event.Event{
		SessionID: "s3", Source: event.SourceHook, Kind: event.KindToolPre,
		Tool: "Bash", Ts: base.Add(time.Second), Key: "in", MsgID: "m",
	}
	outside := event.Event{
		SessionID: "s3", Source: event.SourceHook, Kind: event.KindToolPre,
		Tool: "Bash", Ts: base.Add(time.Hour), Key: "out", MsgID: "m",
	}
	for _, e := range []event.Event{inside, outside} {
		ev := e
		if _, err := InsertEvent(ctx, s.DB(), &ev); err != nil {
			t.Fatal(err)
		}
	}

	calls, unlinked, err := LoopTaxCalls(ctx, s.DB(), "s3", base, base.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 {
		t.Fatalf("got %d calls, want only the one inside the window", len(calls))
	}
	if unlinked != 0 {
		t.Fatalf("unlinked = %d, want 0", unlinked)
	}
}
