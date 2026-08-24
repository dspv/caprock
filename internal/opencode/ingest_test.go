package opencode

import (
	"context"
	"database/sql"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// harness wires a fixture OpenCode database to a throwaway Caprock store, which
// is what every ingest assertion below is made against.
type harness struct {
	t   *testing.T
	f   *fixture
	in  *Ingester
	out *sql.DB
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	f := newFixture(t)
	lg := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))

	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "caprock.db"), lg)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	table, err := cost.Load("")
	if err != nil {
		t.Fatalf("pricing: %v", err)
	}
	rec := rollup.New(st, table, nil, lg)
	return &harness{t: t, f: f, in: NewIngester(f.open(), rec, lg, time.Second), out: st.DB()}
}

// poll runs one ingest pass.
func (h *harness) poll() {
	h.t.Helper()
	if err := h.in.once(context.Background()); err != nil {
		h.t.Fatalf("ingest: %v", err)
	}
}

func TestIngestStoresSessionsAndCost(t *testing.T) {
	h := newHarness(t)
	h.f.typical()
	h.poll()

	if n := count(t, h.out, `SELECT COUNT(*) FROM sessions WHERE agent='opencode'`); n != 3 {
		t.Errorf("%d sessions tagged opencode, want 3", n)
	}
	// Nothing else may be mislabelled: a Claude Code session must never be
	// reported as OpenCode's.
	if n := count(t, h.out, `SELECT COUNT(*) FROM sessions WHERE agent='claude'`); n != 0 {
		t.Errorf("%d sessions tagged claude in an OpenCode-only import", n)
	}

	// The cost is OpenCode's own: 1.00 + 0.25 + 0.75.
	if got := sum(t, h.out, `SELECT COALESCE(SUM(cost_usd),0) FROM events WHERE source='opencode'`); got != 2.00 {
		t.Errorf("total cost = %v, want 2.00", got)
	}
}

func TestIngestDoesNotApplyPricingTable(t *testing.T) {
	// Caprock prices Claude Code turns from its own table. Doing that to an
	// OpenCode turn as well would give one session two different totals
	// depending on which arithmetic a screen happened to use.
	h := newHarness(t)
	h.f.session(sessionOpts{ID: "s", Directory: "/d", Title: "t", Model: "claude-opus-5"})
	h.f.message(messageOpts{
		ID: "m", SessionID: "s", Model: "claude-opus-5", Cwd: "/d",
		Cost: 0.01, TokensIn: 1_000_000, TokensOut: 1_000_000,
	})
	h.poll()

	// A million tokens of Opus would price far above a cent from the table.
	got := sum(t, h.out, `SELECT cost_usd FROM events WHERE source='opencode' AND kind='turn.assistant'`)
	if got != 0.01 {
		t.Errorf("cost = %v, want 0.01 — the pricing table overrode OpenCode's own figure", got)
	}
}

func TestIngestPricesNothingWhenCostIsZero(t *testing.T) {
	// A turn OpenCode has not priced yet must not silently acquire a cost from
	// our table either: the source of a figure has to stay unambiguous.
	h := newHarness(t)
	h.f.session(sessionOpts{ID: "s", Directory: "/d", Title: "t", Model: "claude-opus-5"})
	h.f.message(messageOpts{
		ID: "m", SessionID: "s", Model: "claude-opus-5", Cwd: "/d",
		Cost: 0, TokensIn: 1000, TokensOut: 100,
	})
	h.poll()

	var cost sql.NullFloat64
	err := h.out.QueryRow(`SELECT cost_usd FROM events WHERE source='opencode' AND kind='turn.assistant'`).Scan(&cost)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if cost.Valid && cost.Float64 > 0 {
		t.Errorf("an unpriced OpenCode turn acquired cost %v from the pricing table", cost.Float64)
	}
}

func TestIngestIsIdempotent(t *testing.T) {
	// The poller re-reads sessions on every tick; storing duplicates would
	// double a project's cost every five seconds.
	h := newHarness(t)
	h.f.typical()

	h.poll()
	events := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='opencode'`)
	total := sum(t, h.out, `SELECT COALESCE(SUM(cost_usd),0) FROM events WHERE source='opencode'`)

	// Clear the change-detection cache so the second pass genuinely re-reads
	// everything rather than skipping on time_updated.
	h.in.seen = map[string]int64{}
	h.poll()

	if got := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='opencode'`); got != events {
		t.Errorf("second pass stored %d extra events", got-events)
	}
	if got := sum(t, h.out, `SELECT COALESCE(SUM(cost_usd),0) FROM events WHERE source='opencode'`); got != total {
		t.Errorf("cost changed on re-read: %v then %v", total, got)
	}
}

func TestIngestSkipsUnchangedSessions(t *testing.T) {
	// Without change detection every tick re-reads every message of every
	// session — tens of thousands of rows a minute for no new information.
	h := newHarness(t)
	h.f.typical()
	h.poll()
	first := h.in.Stats().Events

	h.poll() // seen cache intact: nothing should be read at all
	if h.in.Stats().Events != first {
		t.Errorf("an unchanged session was re-read: %d then %d", first, h.in.Stats().Events)
	}
}

func TestIngestPicksUpNewActivity(t *testing.T) {
	// The counterpart of the test above: a session that did change must be
	// re-read, or the dashboard freezes at whatever the first poll saw.
	h := newHarness(t)
	h.f.session(sessionOpts{
		ID: "s", Directory: "/d", Title: "t", Model: "m",
		Created: 1_700_000_000_000, Updated: 1_700_000_000_000,
	})
	h.f.message(messageOpts{ID: "m1", SessionID: "s", Model: "m", Cwd: "/d", Cost: 1})
	h.poll()
	before := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='opencode'`)

	// A new turn, and the session's update time moves with it.
	h.f.message(messageOpts{ID: "m2", SessionID: "s", Model: "m", Cwd: "/d", Cost: 2,
		Created: 1_700_000_500_000})
	if _, err := h.f.db.Exec(`UPDATE session SET time_updated = ? WHERE id = 's'`,
		1_700_000_500_000); err != nil {
		t.Fatal(err)
	}
	h.poll()

	after := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='opencode'`)
	if after <= before {
		t.Errorf("new activity was not picked up: %d then %d events", before, after)
	}
	if got := sum(t, h.out, `SELECT COALESCE(SUM(cost_usd),0) FROM events WHERE source='opencode'`); got != 3 {
		t.Errorf("cost after new turn = %v, want 3", got)
	}
}

func TestIngestLinksToolsToTheirTurn(t *testing.T) {
	// Equal message ids are what let per-directory attribution say which turn
	// paid for a tool call. Without the link the spend cannot be placed.
	h := newHarness(t)
	h.f.typical()
	h.poll()

	n := count(t, h.out, `
		SELECT COUNT(*) FROM events
		WHERE source='opencode' AND kind='tool.pre' AND msg_id = 'msg_a1'`)
	if n != 2 {
		t.Errorf("%d tool calls linked to msg_a1, want 2", n)
	}
}

func TestIngestRecordsTouchedDirectory(t *testing.T) {
	// Per-directory cost is built from this column; an empty one makes the
	// breakdown silently empty rather than visibly broken.
	h := newHarness(t)
	h.f.typical()
	h.poll()

	got := ""
	err := h.out.QueryRow(`
		SELECT COALESCE(touch_dir,'') FROM events
		WHERE source='opencode' AND kind='tool.pre' AND tool='Read' LIMIT 1`).Scan(&got)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if got != filepath.Dir("/home/dev/api/src/auth.go") {
		t.Errorf("touch_dir = %q, want the file's directory", got)
	}

	// bash named no file and must contribute nothing rather than a guess.
	var bash sql.NullString
	err = h.out.QueryRow(`
		SELECT touch_dir FROM events
		WHERE source='opencode' AND kind='tool.pre' AND tool='Bash' LIMIT 1`).Scan(&bash)
	if err != nil {
		t.Fatalf("scan bash: %v", err)
	}
	if bash.Valid && bash.String != "" {
		t.Errorf("bash was attributed to %q despite naming no file", bash.String)
	}
}

func TestIngestNormalisesToolNames(t *testing.T) {
	// Loop detection and work-kind classification match Claude Code spellings.
	h := newHarness(t)
	h.f.typical()
	h.poll()

	for _, want := range []string{"Read", "Bash", "Edit"} {
		if n := count(t, h.out,
			`SELECT COUNT(*) FROM events WHERE source='opencode' AND tool=?`, want); n == 0 {
			t.Errorf("no tool call stored as %q", want)
		}
	}
	if n := count(t, h.out,
		`SELECT COUNT(*) FROM events WHERE source='opencode' AND tool IN ('read','bash','edit')`); n != 0 {
		t.Errorf("%d tool calls kept OpenCode's lowercase spelling", n)
	}
}

func TestIngestGroupsByRepository(t *testing.T) {
	// The headline feature. It must survive the whole path from OpenCode's
	// directory column to Caprock's project grouping.
	h := newHarness(t)
	h.f.typical()
	h.poll()

	rows, err := h.out.Query(`
		SELECT s.project, ROUND(SUM(e.cost_usd), 2)
		FROM events e JOIN sessions s USING(session_id)
		WHERE e.source='opencode'
		GROUP BY s.project ORDER BY 2 DESC`)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()

	got := map[string]float64{}
	for rows.Next() {
		var p string
		var c float64
		if err := rows.Scan(&p, &c); err != nil {
			t.Fatal(err)
		}
		got[p] = c
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("grouped into %d projects, want 2: %v", len(got), got)
	}
	// api holds the parent (1.00) and its subagent (0.25).
	if got["api"] != 1.25 {
		t.Errorf("api = %v, want 1.25", got["api"])
	}
	if got["web"] != 0.75 {
		t.Errorf("web = %v, want 0.75", got["web"])
	}
}

func TestIngestStoresUserTurnsAsNonAssistant(t *testing.T) {
	// A user message carries no cost and must not be recorded as a turn the
	// model produced, or turn counts and cost-per-turn are both wrong.
	h := newHarness(t)
	h.f.typical()
	h.poll()

	n := count(t, h.out, `
		SELECT COUNT(*) FROM events
		WHERE source='opencode' AND kind='turn.assistant'`)
	if n != 3 {
		t.Errorf("%d assistant turns, want 3 (the user message must not be one)", n)
	}
}

func TestIngestSurvivesMalformedRows(t *testing.T) {
	// A single corrupt row in someone's database must not stop the import of
	// everything around it.
	h := newHarness(t)
	h.f.session(sessionOpts{ID: "s", Directory: "/d", Title: "t", Model: "m"})
	broken := `{"role":"assistant","tokens":`
	h.f.message(messageOpts{ID: "m_bad", SessionID: "s", RawData: &broken})
	h.f.message(messageOpts{ID: "m_ok", SessionID: "s", Model: "m", Cwd: "/d", Cost: 1,
		Created: 1_700_000_100_000})
	h.poll()

	if got := sum(t, h.out, `SELECT COALESCE(SUM(cost_usd),0) FROM events WHERE source='opencode'`); got != 1 {
		t.Errorf("cost = %v, want 1 — the good row was lost with the bad one", got)
	}
}

func TestIngestEmptyDatabase(t *testing.T) {
	// A fresh OpenCode install has a database and no sessions. That is not an
	// error and must not be logged as one.
	h := newHarness(t)
	h.poll()
	if n := count(t, h.out, `SELECT COUNT(*) FROM sessions`); n != 0 {
		t.Errorf("%d sessions from an empty database", n)
	}
	if h.in.Stats().Events != 0 {
		t.Errorf("%d events from an empty database", h.in.Stats().Events)
	}
}

func TestIngestStatsReflectWork(t *testing.T) {
	h := newHarness(t)
	h.f.typical()
	h.poll()

	st := h.in.Stats()
	if st.Sessions != 3 {
		t.Errorf("stats report %d sessions, want 3", st.Sessions)
	}
	if st.Events == 0 {
		t.Error("stats report no events after a successful import")
	}
	if st.LastPoll == 0 {
		t.Error("stats carry no poll timestamp")
	}
}

func TestRunStopsOnContextCancel(t *testing.T) {
	// The daemon cancels this context on shutdown; a poller that ignores it
	// keeps a handle on the database open past exit.
	h := newHarness(t)
	h.f.typical()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.in.Run(ctx) }()
	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Run returned %v on cancellation, want nil", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return within 5s of cancellation")
	}
}
