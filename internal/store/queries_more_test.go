// Queries that decide what the dashboard believes: when a session counts as
// over, what the live stream replays after a reconnect, and whether a failed
// write leaves a half-applied change behind.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
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

// "Active days" on the History screen means days on which work happened. It
// used to count distinct session *start* dates, which undercounts as soon as a
// session outlives a day — and they routinely do. On the author's database one
// session spanned twelve days and contributed one, so the screen read 21 where
// 32 days had events in them.
//
// The count reads daily_stats, which the rollup fills one row per priced turn,
// so this seeds it the same way rather than inserting raw events.
func TestHistoryCountsDaysWithWorkNotSessionStarts(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)

	day := int64(24 * 3600 * 1000)
	start := time.Now().Add(-10 * 24 * time.Hour).UnixMilli()
	// One session opened on day 1 and still going on day 4.
	mustSession(t, s, "long", start+3*day)
	for i := 0; i < 4; i++ {
		d := time.UnixMilli(start + int64(i)*day).Local().Format("2006-01-02")
		if err := AddDaily(ctx, s.db, d, "proj", "claude-opus-5", 100, 0.5, i == 0); err != nil {
			t.Fatal(err)
		}
	}

	h, err := History(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if h.Sessions != 1 {
		t.Fatalf("Sessions = %d; want 1", h.Sessions)
	}
	if h.Days != 4 {
		t.Errorf("Days = %d; want 4 — one session spanning four days worked on all of them", h.Days)
	}
}

// Paging backwards through the answers.
//
// The screen used to load a fixed window and stop, which on a busy machine is
// half a day of work: one reporter saw an answer from 22 hours ago followed
// immediately by one from 30 days ago and read it as lost history. Nothing was
// lost — the middle was never fetched. `before` is what makes the rest
// reachable.
func TestSearchNotesPagesBackwards(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	base := time.Now().Add(-10 * time.Hour)
	mustSession(t, s, "s", base.UnixMilli())
	for i := 0; i < 25; i++ {
		ev := event.Event{
			SessionID: "s", Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
			Ts: base.Add(time.Duration(i) * time.Minute), Key: "n" + strconv.Itoa(i),
			Payload: []byte(`{"text":"a note long enough to count as a real answer here"}`),
		}
		if _, err := InsertEvent(ctx, s.db, &ev); err != nil {
			t.Fatal(err)
		}
	}

	first, err := SearchNotes(ctx, s.db, "", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 10 {
		t.Fatalf("first page has %d notes; want 10", len(first))
	}

	second, err := SearchNotes(ctx, s.db, "", 10, first[len(first)-1].EventID)
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 10 {
		t.Fatalf("second page has %d notes; want 10", len(second))
	}

	// No overlap, and strictly older — a repeated row would duplicate on screen.
	seen := map[int64]bool{}
	for _, n := range first {
		seen[n.EventID] = true
	}
	for _, n := range second {
		if seen[n.EventID] {
			t.Errorf("note %d appeared on both pages", n.EventID)
		}
		if n.EventID >= first[len(first)-1].EventID {
			t.Errorf("note %d is not older than the first page's last", n.EventID)
		}
	}

	// The tail is reachable, and the end is an empty page rather than a repeat.
	third, err := SearchNotes(ctx, s.db, "", 10, second[len(second)-1].EventID)
	if err != nil {
		t.Fatal(err)
	}
	if len(third) != 5 {
		t.Errorf("third page has %d notes; want the remaining 5", len(third))
	}
	last, err := SearchNotes(ctx, s.db, "", 10, third[len(third)-1].EventID)
	if err != nil {
		t.Fatal(err)
	}
	if len(last) != 0 {
		t.Errorf("got %d notes past the end; want none", len(last))
	}
}

// Paging must respect the query, or "load older" would quietly widen a search.
func TestSearchNotesPagingKeepsTheQuery(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	base := time.Now().Add(-5 * time.Hour)
	mustSession(t, s, "s", base.UnixMilli())
	for i := 0; i < 10; i++ {
		text := "an ordinary answer with plenty of words in it"
		if i%2 == 0 {
			text = "this one mentions the migration and backfill in detail"
		}
		ev := event.Event{
			SessionID: "s", Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
			Ts: base.Add(time.Duration(i) * time.Minute), Key: "q" + strconv.Itoa(i),
			Payload: []byte(`{"text":"` + text + `"}`),
		}
		if _, err := InsertEvent(ctx, s.db, &ev); err != nil {
			t.Fatal(err)
		}
	}

	page, err := SearchNotes(ctx, s.db, "migration", 3, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(page) != 3 {
		t.Fatalf("first page: %d", len(page))
	}
	next, err := SearchNotes(ctx, s.db, "migration", 3, page[len(page)-1].EventID)
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range next {
		if !strings.Contains(n.Text, "migration") {
			t.Errorf("paging returned a non-matching note: %q", n.Text)
		}
	}
}

// A model with no pricing row leaves cost_usd NULL (the rollup logs "model not
// in pricing table; cost left unknown"). Every aggregate then flattened it with
// COALESCE(SUM(cost_usd),0), so tens of thousands of tokens of an unpriced
// model rendered as a confident "$0.00" — indistinguishable from free, and an
// invented number under rule 6. The volume must be carried out of the
// aggregate, and the model that caused it must be named so the user can act.
func TestSummarizeAndHistoryCarryUnpricedVolume(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now().UnixMilli()
	mustSession(t, s, "s1", now)

	priced := 0.25
	// One priced turn, and two turns of a model shipped after the pricing table.
	mustInsert(t, s, event.Event{
		SessionID: "s1", Kind: event.KindTurnAssistant, Ts: time.UnixMilli(now),
		Model: "claude-sonnet-5", Tokens: &event.TokenDelta{In: 100, Out: 200},
		CostUSD: &priced,
	})
	for i := range 2 {
		mustInsert(t, s, event.Event{
			SessionID: "s1", Kind: event.KindTurnAssistant, Ts: time.UnixMilli(now + int64(i) + 1),
			Model: "claude-opus-9-future", Tokens: &event.TokenDelta{In: 30_000, Out: 500},
			// CostUSD deliberately nil: this is the unpriced path.
		})
	}

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if sum.Unpriced == nil {
		t.Fatal("unpriced volume was flattened into the total; the Cost screen would show $0.00 for 61k tokens")
	}
	if sum.Unpriced.Turns != 2 {
		t.Errorf("unpriced turns = %d, want 2", sum.Unpriced.Turns)
	}
	if want := int64(2 * (30_000 + 500)); sum.Unpriced.Tokens != want {
		t.Errorf("unpriced tokens = %d, want %d", sum.Unpriced.Tokens, want)
	}
	// Naming the model is the point: "some tokens unpriced" is not actionable.
	if len(sum.Unpriced.Models) != 1 || sum.Unpriced.Models[0] != "claude-opus-9-future" {
		t.Errorf("unpriced models = %v, want [claude-opus-9-future]", sum.Unpriced.Models)
	}
	// The priced total is unchanged — this reports alongside cost, not instead.
	if sum.CostUSD != priced {
		t.Errorf("cost = %v, want %v", sum.CostUSD, priced)
	}

	h, err := History(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if h.Unpriced == nil || h.Unpriced.Turns != 2 {
		t.Fatalf("History dropped the unpriced volume under a 'measured, not estimated' headline: %+v", h.Unpriced)
	}

	// It must reach the wire, and be omitted rather than zero when all is well.
	b, err := json.Marshal(sum)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"unpriced"`) || !strings.Contains(string(b), "claude-opus-9-future") {
		t.Fatalf("unpriced volume did not reach the payload:\n%s", b)
	}
}

// The common case: everything priced. The field must be absent, not a zero
// object, so no screen renders an "unpriced" warning on healthy data.
func TestUnpricedIsAbsentWhenEverythingIsPriced(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now().UnixMilli()
	mustSession(t, s, "s1", now)
	c := 0.5
	mustInsert(t, s, event.Event{
		SessionID: "s1", Kind: event.KindTurnAssistant, Ts: time.UnixMilli(now),
		Model: "claude-sonnet-5", Tokens: &event.TokenDelta{In: 10, Out: 20}, CostUSD: &c,
	})
	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if sum.Unpriced != nil {
		t.Fatalf("a fully priced range reported unpriced volume: %+v", sum.Unpriced)
	}
	b, _ := json.Marshal(sum)
	if strings.Contains(string(b), `"unpriced"`) {
		t.Fatalf("unpriced must be omitted when empty:\n%s", b)
	}
}

// Restarting the daemon ends every live session, and a session that is still
// working goes on producing events straight afterwards. Those events have to
// bring it back: an agent that is demonstrably running must not sit in the
// dashboard marked ended until its next session starts.
//
// The staleness sweep and an explicit SessionEnd still end a session — this
// only concerns what a *fresh* event means about one already marked ended.
func TestFreshEventRevivesAnEndedSession(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now().UnixMilli()

	mustSession(t, s, "s1", now-30*1000)
	if err := SetSessionStatus(ctx, s.db, "s1", StatusEnded); err != nil {
		t.Fatal(err)
	}

	// A newer event, exactly as a hook would deliver it: no explicit status.
	mustSession(t, s, "s1", now)

	sess, err := GetSession(ctx, s.db, "s1")
	if err != nil {
		t.Fatal(err)
	}
	if sess.Status == StatusEnded {
		t.Error("a session still emitting events stayed ended; the pulse would show nothing while the agent works")
	}
}

// The other half of the same rule: re-reading an old transcript must not
// resurrect a session that genuinely finished. Only an event newer than what
// the row already carries counts as a sign of life.
func TestReplayedOldEventDoesNotReviveAnEndedSession(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now().UnixMilli()

	mustSession(t, s, "s1", now)
	if err := SetSessionStatus(ctx, s.db, "s1", StatusEnded); err != nil {
		t.Fatal(err)
	}

	// A tail re-reading history: older than the last event already stored.
	mustSession(t, s, "s1", now-10*60*1000)

	sess, err := GetSession(ctx, s.db, "s1")
	if err != nil {
		t.Fatal(err)
	}
	if sess.Status != StatusEnded {
		t.Errorf("status = %q; a replayed old event revived a finished session", sess.Status)
	}
}

// Paging backwards has its own query because the timeline used to walk back by
// asking for the first N events of the session and discarding what it already
// had — on a long session that fetches the wrong end of the history.
func TestEventsBeforePagesBackwards(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	for i := 1; i <= 10; i++ {
		ev := &event.Event{SessionID: "s", Source: event.SourceHook, Kind: event.KindTurnUser, Ts: time.UnixMilli(int64(i) * 1000)}
		if _, err := InsertEvent(ctx, s.db, ev); err != nil {
			t.Fatal(err)
		}
	}
	all, err := LastEvents(ctx, s.db, "s", 10)
	if err != nil || len(all) != 10 {
		t.Fatalf("seed: %d %v", len(all), err)
	}
	// The three immediately before the 6th row, oldest-first.
	page, err := EventsBefore(ctx, s.db, "s", all[5].ID, 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(page) != 3 {
		t.Fatalf("page size %d, want 3", len(page))
	}
	for i, want := range []int64{all[2].ID, all[3].ID, all[4].ID} {
		if page[i].ID != want {
			t.Errorf("row %d: id %d, want %d", i, page[i].ID, want)
		}
	}
	// Nothing precedes the first row, which is how the UI knows to stop.
	if empty, err := EventsBefore(ctx, s.db, "s", all[0].ID, 3); err != nil || len(empty) != 0 {
		t.Fatalf("before the first row: %d %v", len(empty), err)
	}
}
