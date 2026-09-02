package gemini

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

func newIngester(t *testing.T) (*Ingester, *store.Store, string) {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	dir := t.TempDir()
	table, err := cost.Load("")
	if err != nil {
		t.Fatal(err)
	}
	rec := rollup.New(st, table, nil, nil)
	return NewIngester(dir, rec, nil), st, dir
}

func writeTelemetry(t *testing.T, dir, sessionID, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, sessionID+".otel.log"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func fixtureBody(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The whole point: a Gemini session used to sit in the list with zeroes in
// every column, because Caprock started it and then saw nothing. This asserts
// the figures arrive.
func TestASweepGivesAGeminiSessionItsFigures(t *testing.T) {
	ctx := context.Background()
	g, st, dir := newIngester(t)
	const sid = "26580d90-de2f-4088-9d9e-8200137b1b71"
	writeTelemetry(t, dir, sid, fixtureBody(t))

	n, err := g.Sweep(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n == 0 {
		t.Fatal("the sweep stored nothing")
	}

	s, err := store.GetSession(ctx, st.DB(), sid)
	if err != nil {
		t.Fatal(err)
	}
	if s.Agent != "gemini" {
		t.Errorf("agent = %q, want gemini", s.Agent)
	}
	stats, err := store.GetStats(ctx, st.DB(), sid)
	if err != nil {
		t.Fatal(err)
	}
	// 8631+8718 in and 41+27 out, from the session the fixture came from.
	if stats.TokensIn != 17349 {
		t.Errorf("tokens in = %d, want 17349", stats.TokensIn)
	}
	if stats.TokensOut != 68 {
		t.Errorf("tokens out = %d, want 68", stats.TokensOut)
	}
	if stats.Turns != 2 {
		t.Errorf("turns = %d, want 2", stats.Turns)
	}
}

// The file is appended to while Caprock reads it, and the daemon restarts. A
// second read of the same bytes must not double the session's cost.
func TestReadingTheSameFileTwiceDoesNotDoubleAnything(t *testing.T) {
	ctx := context.Background()
	g, st, dir := newIngester(t)
	const sid = "s1"
	writeTelemetry(t, dir, sid, fixtureBody(t))

	if _, err := g.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	first, err := store.GetStats(ctx, st.DB(), sid)
	if err != nil {
		t.Fatal(err)
	}

	// Forget the offset, which is what a daemon restart amounts to, and read
	// the identical file again.
	g.Forget(sid)
	if _, err := g.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	second, err := store.GetStats(ctx, st.DB(), sid)
	if err != nil {
		t.Fatal(err)
	}
	if second.TokensIn != first.TokensIn || second.Turns != first.Turns {
		t.Errorf("a re-read changed the figures: %d/%d then %d/%d",
			first.TokensIn, first.Turns, second.TokensIn, second.Turns)
	}
}

// A tail that arrives between sweeps must be picked up, and only it.
func TestOnlyTheNewTailIsReadOnASecondSweep(t *testing.T) {
	ctx := context.Background()
	g, st, dir := newIngester(t)
	const sid = "s2"
	const first = `{
  "_body": "",
  "attributes": {
    "event.name": "gemini_cli.api_response",
    "session.id": "s2",
    "model": "gemini-3.5-flash-lite",
    "event.timestamp": "2026-09-02T10:00:00.000Z",
    "input_token_count": 100,
    "output_token_count": 10
  }
}`
	writeTelemetry(t, dir, sid, first)
	if _, err := g.Sweep(ctx); err != nil {
		t.Fatal(err)
	}

	appended := first + `{
  "_body": "",
  "attributes": {
    "event.name": "gemini_cli.api_response",
    "session.id": "s2",
    "model": "gemini-3.5-flash-lite",
    "event.timestamp": "2026-09-02T10:00:05.000Z",
    "input_token_count": 200,
    "output_token_count": 20
  }
}`
	writeTelemetry(t, dir, sid, appended)
	if _, err := g.Sweep(ctx); err != nil {
		t.Fatal(err)
	}

	stats, err := store.GetStats(ctx, st.DB(), sid)
	if err != nil {
		t.Fatal(err)
	}
	if stats.TokensIn != 300 || stats.Turns != 2 {
		t.Errorf("tokens=%d turns=%d, want 300/2", stats.TokensIn, stats.Turns)
	}
}

// A session's events belong to the directory the user picked in the dialog,
// which Caprock knows and the telemetry does not.
func TestTrackedCwdDecidesTheProject(t *testing.T) {
	ctx := context.Background()
	g, st, dir := newIngester(t)
	const sid = "s3"
	g.Track(sid, "/Users/someone/dev/myproject")
	writeTelemetry(t, dir, sid, fixtureBody(t))
	if _, err := g.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	s, err := store.GetSession(ctx, st.DB(), sid)
	if err != nil {
		t.Fatal(err)
	}
	if s.Cwd != "/Users/someone/dev/myproject" {
		t.Errorf("cwd = %q; a session whose cwd is lost lands on no project", s.Cwd)
	}
}

func TestAnEmptyDirectoryIsNotAnError(t *testing.T) {
	// The directory only appears when the first Gemini session spawns, and the
	// loop starts before that. Erroring every tick until then would be noise.
	ctx := context.Background()
	rec := rollup.New(nil, nil, nil, nil)
	g := NewIngester(filepath.Join(t.TempDir(), "not-created-yet"), rec, nil)
	n, err := g.Sweep(ctx)
	if err != nil {
		t.Errorf("a missing directory reported an error: %v", err)
	}
	if n != 0 {
		t.Errorf("stored %d events from nothing", n)
	}
}

func TestANilIngesterIsSafe(t *testing.T) {
	// NewIngester returns nil when there is no data directory, and the daemon
	// calls Track and Run unconditionally — a panic here would take the daemon
	// down over a feature that is merely off.
	var g *Ingester
	g.Track("s", "/tmp")
	g.Forget("s")
	if n, err := g.Sweep(context.Background()); n != 0 || err != nil {
		t.Errorf("nil ingester: %d, %v", n, err)
	}
}

// A record that was half-written when the sweep ran must be picked up once the
// writer finishes it.
//
// The file is tailed while Gemini writes it, so landing mid-record is the
// normal case, not an edge one. The reader used to advance to the end of
// whatever was available whenever *any* record had parsed — the opposite of
// what its own comment promised — so the half-written record ended up below
// the stored offset and was never read again. The turn, and its tokens, were
// gone with nothing reporting a loss.
func TestATornRecordIsReadOnceItIsWhole(t *testing.T) {
	ctx := context.Background()
	g, st, dir := newIngester(t)
	const sid = "26580d90-de2f-4088-9d9e-8200137b1b71"

	full := fixtureBody(t)
	// Cut inside the last record: one whole record, then a fragment.
	last := strings.LastIndex(full, "{")
	if last <= 0 {
		t.Fatal("fixture has no second record to tear")
	}
	torn := full[:last+30]

	writeTelemetry(t, dir, sid, torn)
	if _, err := g.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	partial := countTurns(t, st, sid)

	// The writer finishes the record it had started.
	writeTelemetry(t, dir, sid, full)
	if _, err := g.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	whole := countTurns(t, st, sid)

	if whole <= partial {
		t.Fatalf("turns after the record was completed = %d, same as before (%d) — the torn record was skipped permanently", whole, partial)
	}
}

func countTurns(t *testing.T, st *store.Store, sid string) int {
	t.Helper()
	var n int
	if err := st.DB().QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM events WHERE session_id = ?`, sid).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// Two records that carry no usable timestamp are still two events.
//
// The dedupe key was kind + tool + millisecond, which is unique right up until
// it is not: `event.timestamp` missing or in an unexpected layout yields the
// zero time, so every such record in a session shared one key and only the
// first was ever stored. The turns, and their tokens, were silently gone. A
// record's byte offset is unique by construction, which is what a dedupe key
// needs.
func TestRecordsWithNoTimestampAreNotCollapsedIntoOne(t *testing.T) {
	ctx := context.Background()
	g, st, dir := newIngester(t)
	const sid = "26580d90-de2f-4088-9d9e-8200137b1b71"

	rec := func(in, out int) string {
		return `{"_body":"api",` +
			`"attributes":{"event.name":"gemini_cli.api_response","session.id":"` + sid + `",` +
			`"model":"gemini-2.5-pro","input_token_count":` + strconv.Itoa(in) +
			`,"output_token_count":` + strconv.Itoa(out) + `}}` + "\n"
	}
	// No event.timestamp on either: both used to key to the zero time.
	writeTelemetry(t, dir, sid, rec(10, 20)+rec(30, 40))

	if _, err := g.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if got := countTurns(t, st, sid); got != 2 {
		t.Fatalf("stored %d events, want 2 — records with no timestamp collapsed into one", got)
	}
}
