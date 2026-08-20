// Queries that decide what the dashboard believes: when a session counts as
// over, what the live stream replays after a reconnect, and whether a failed
// write leaves a half-applied change behind.
package store

import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

func mustInsert(t *testing.T, s *Store, ev event.Event) int64 {
	t.Helper()
	id, err := InsertEvent(context.Background(), s.db, &ev)
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	return id
}

// mustSession creates the session row. InsertEvent does not create one — the
// ingest path calls UpsertSession explicitly — so a test about session status
// has to do the same.
func mustSession(t *testing.T, s *Store, id string, lastEventAt int64) {
	t.Helper()
	if err := UpsertSession(context.Background(), s.db, id, SessionPatch{
		Project: "p", LastEventAt: lastEventAt, StartedAt: lastEventAt, FromHook: true,
	}); err != nil {
		t.Fatalf("upsert %s: %v", id, err)
	}
}

// A session is "ended" once nothing has arrived for long enough. Getting the
// comparison backwards would either end every live session or never end any,
// and the Now screen is built on this status.
func TestMarkEndedSessionsOnlyTouchesTheStale(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now().UnixMilli()

	mustSession(t, s, "s-old", now-6*3600*1000)
	mustSession(t, s, "s-new", now-60*1000)

	cutoff := now - 3600*1000 // an hour of silence
	ids, err := MarkEndedSessions(ctx, s.db, cutoff)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || ids[0] != "s-old" {
		t.Fatalf("ended %v; want just s-old", ids)
	}

	// And the status must actually be written, not only reported.
	sess, err := GetSession(ctx, s.db, "s-old")
	if err != nil {
		t.Fatal(err)
	}
	if sess.Status != StatusEnded {
		t.Errorf("s-old status = %q; want ended", sess.Status)
	}
	live, err := GetSession(ctx, s.db, "s-new")
	if err != nil {
		t.Fatal(err)
	}
	if live.Status == StatusEnded {
		t.Error("s-new was ended while it was still active")
	}
}

// Running the sweep twice must not re-report sessions it already ended — the
// daemon emits an event per returned id, so a repeat would duplicate them.
func TestMarkEndedSessionsIsIdempotent(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now().UnixMilli()
	mustSession(t, s, "s-old", now-6*3600*1000)
	cutoff := now - 3600*1000

	if ids, err := MarkEndedSessions(ctx, s.db, cutoff); err != nil || len(ids) != 1 {
		t.Fatalf("first sweep: %v %v", ids, err)
	}
	ids, err := MarkEndedSessions(ctx, s.db, cutoff)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 0 {
		t.Errorf("second sweep re-reported %v; already-ended sessions must not repeat", ids)
	}
}

func TestMarkEndedSessionsOnAnEmptyDatabase(t *testing.T) {
	ids, err := MarkEndedSessions(context.Background(), openTest(t).db, time.Now().UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 0 {
		t.Errorf("ended %v on an empty database", ids)
	}
}

// LastEvents feeds the narrator, which decides the phrase on every session
// card. It must return the newest events, not the oldest.
func TestLastEventsReturnsTheNewest(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	base := time.Now().UnixMilli() - 10*60*1000
	for i := 0; i < 10; i++ {
		mustInsert(t, s, eventForTool("s", "Tool", base+int64(i)*1000))
	}

	evs, err := LastEvents(ctx, s.db, "s", 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 3 {
		t.Fatalf("got %d events; want 3", len(evs))
	}
	// Whatever the order they come back in, they must be the last three.
	var earliest int64 = 1 << 62
	for _, e := range evs {
		if ms := e.Ts.UnixMilli(); ms < earliest {
			earliest = ms
		}
	}
	if earliest < base+7*1000 {
		t.Errorf("returned an event from %d; want only the newest three (>= %d)", earliest, base+7*1000)
	}
}

func TestLastEventsOnASessionWithNoEvents(t *testing.T) {
	evs, err := LastEvents(context.Background(), openTest(t).db, "nobody", 10)
	if err != nil {
		t.Fatalf("an unknown session must not error: %v", err)
	}
	if len(evs) != 0 {
		t.Errorf("got %d events for an unknown session", len(evs))
	}
}

// EventsAfter is the live stream's catch-up query: a browser that reconnects
// asks for everything after the last id it saw. Returning events it already has
// would duplicate rows in the feed; missing one loses it forever.
func TestEventsAfterReturnsOnlyWhatIsNew(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	base := time.Now().UnixMilli() - 60*1000
	var ids []int64
	for i := 0; i < 5; i++ {
		ids = append(ids, mustInsert(t, s, eventForTool("s", "Tool", base+int64(i)*1000)))
	}

	evs, err := EventsAfter(ctx, s.db, ids[2], 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 2 {
		t.Fatalf("got %d events after id %d; want the 2 newer ones", len(evs), ids[2])
	}
	for _, e := range evs {
		if e.ID <= ids[2] {
			t.Errorf("returned event id %d, which the client already had", e.ID)
		}
	}
}

// A brand-new browser passes 0 and must get the backlog rather than nothing.
func TestEventsAfterZeroReturnsTheBacklog(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	base := time.Now().UnixMilli() - 60*1000
	for i := 0; i < 3; i++ {
		mustInsert(t, s, eventForTool("s", "Tool", base+int64(i)*1000))
	}
	evs, err := EventsAfter(ctx, s.db, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 3 {
		t.Errorf("got %d events from id 0; want the whole backlog", len(evs))
	}
}

// An unbounded limit would let one reconnect pull the entire history into
// memory; the clamp is what keeps a large database from stalling the daemon.
func TestEventsAfterClampsAnAbsurdLimit(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	base := time.Now().UnixMilli() - 60*1000
	for i := 0; i < 20; i++ {
		mustInsert(t, s, eventForTool("s", "Tool", base+int64(i)*1000))
	}
	evs, err := EventsAfter(ctx, s.db, 0, 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) > MaxEventPage {
		t.Errorf("returned %d events; the page is capped at %d", len(evs), MaxEventPage)
	}
}

// WithTx is how every multi-statement write runs. If a failure did not roll
// back, a half-applied change would outlive the error that caused it.
func TestWithTxRollsBackOnError(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	boom := errors.New("boom")

	err := s.WithTx(ctx, func(q Querier) error {
		if _, e := InsertEvent(ctx, q, &event.Event{
			SessionID: "s-tx", Source: event.SourceHook, Kind: event.KindToolPre,
			Tool: "Bash", Ts: time.Now(), Key: "k1",
		}); e != nil {
			return e
		}
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("WithTx = %v; want the callback's error", err)
	}

	evs, err := LastEvents(ctx, s.db, "s-tx", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 0 {
		t.Errorf("%d events survived a rolled-back transaction", len(evs))
	}
}

func TestWithTxCommitsOnSuccess(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	err := s.WithTx(ctx, func(q Querier) error {
		_, e := InsertEvent(ctx, q, &event.Event{
			SessionID: "s-ok", Source: event.SourceHook, Kind: event.KindToolPre,
			Tool: "Bash", Ts: time.Now(), Key: "k1",
		})
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	evs, err := LastEvents(ctx, s.db, "s-ok", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 1 {
		t.Errorf("%d events after a committed transaction; want 1", len(evs))
	}
}

// The throttle count is a measured fact shown on the Cost screen — it must be
// zero when nothing was recorded rather than an error or a guess.
func TestCountThrottlesIsZeroWithoutObservations(t *testing.T) {
	n, err := CountThrottles(context.Background(), openTest(t).db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("CountThrottles = %d on an empty database; want 0", n)
	}
}

// The page cap is what stops one request from serialising an entire history
// into memory. It needs more rows than the cap to be observable at all — with
// a handful of notes any limit looks the same, which is why this lives here
// rather than at the endpoint.
func TestNotesClampAnAbsurdLimit(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	base := time.Now().UnixMilli() - time.Hour.Milliseconds()
	mustSession(t, s, "s", base)
	for i := 0; i < MaxEventPage+50; i++ {
		ev := event.Event{
			SessionID: "s", Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
			Ts: time.UnixMilli(base + int64(i)), Key: "n" + strconv.Itoa(i),
			Payload: []byte(`{"text":"a note with enough words to be kept"}`),
		}
		if _, err := InsertEvent(ctx, s.db, &ev); err != nil {
			t.Fatal(err)
		}
	}

	notes, err := SessionNotes(ctx, s.db, "s", 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) > MaxEventPage {
		t.Errorf("returned %d notes; the page is capped at %d", len(notes), MaxEventPage)
	}
	if len(notes) == 0 {
		t.Error("returned nothing; the clamp must bound the page, not empty it")
	}
}

// A cancelled context must surface as an error rather than an empty-but-clean
// result, for the sweeps that follow their scan with an UPDATE.
//
// What this does *not* prove is the rows.Err() check those functions carry.
// Deleting it leaves these tests green, because QueryContext validates the
// context before the query runs and fails there — measured. Reaching the
// rows.Err() path needs a failure partway through iteration, which is not
// producible from a test without substituting the driver; the check stays as
// defence against a truncated scan reporting a short id list as a complete
// one, and `rowserrcheck` in the linter is what keeps it in place.
func TestMarkSweepsFailOnACancelledContext(t *testing.T) {
	s := openTest(t)
	now := time.Now().UnixMilli()
	for i := 0; i < 200; i++ {
		mustSession(t, s, "s-"+strconv.Itoa(i), now-6*3600*1000)
	}
	cutoff := now - 3600*1000

	for name, fn := range map[string]func(context.Context, Querier, int64) ([]string, error){
		"MarkEndedSessions": MarkEndedSessions,
		"MarkIdleSessions":  MarkIdleSessions,
	} {
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			ids, err := fn(ctx, s.db, cutoff)
			if err == nil {
				t.Errorf("returned %d ids and no error on a cancelled context", len(ids))
			}
			if len(ids) != 0 {
				t.Errorf("returned %d ids alongside a failure; callers act on this list", len(ids))
			}
		})
	}
}

// The same for Summarize, whose numbers go straight onto the Cost screen.
func TestSummarizeFailsOnACancelledContext(t *testing.T) {
	s := openTest(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Summarize(ctx, s.db, 0); err == nil {
		t.Error("Summarize returned no error on a cancelled context")
	}
}
