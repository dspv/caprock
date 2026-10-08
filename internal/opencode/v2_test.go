package opencode

import (
	"context"
	"database/sql"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// The two databases under testdata/ are `sqlite3 .dump` of real ones, not
// fixtures written from the reader's understanding (see fixture_test.go for
// why that matters). Both were made on 2026-10-09 in a scratch home, against a
// local stand-in for an OpenAI-compatible provider so no model was called and
// the costs are OpenCode's own arithmetic over the stand-in's token counts.
// Only the home directory was rewritten, to /home/dev.
//
//   - opencode-2.0.26.sql: OpenCode 2.0.26 alone. Five sessions: two tool
//     calls (shell, read); a subagent with its child session; a tool call that
//     failed; and a plan-agent session started with --session and
//     OPENCODE_CONFIG_CONTENT, whose plan-mode reminder is a `synthetic`
//     message.
//   - opencode-1.15.10-then-2.0.26.sql: a session made by OpenCode 1.15.10
//     (bash, then a failed read), then continued by 2.0.26 with --session,
//     then a new 2.0.26 session in the same database.

// Session ids in the fixtures.
const (
	v2Tool     = "ses_ee23fe547ffeGrZPc2puP1wUU1"
	v2Parent   = "ses_ee23fe1e7ffeeiMs3y3TW987xd"
	v2Child    = "ses_ee23fe0f4ffeylWZL6V350JpvY"
	v2Failed   = "ses_ee23fdf58ffew3vRe12Fd7Ah2n"
	v2Plan     = "ses_caprockPlan0001"
	mixedBoth  = "ses_ee23f48fafferHslj7rwP1LkA5"
	mixedNewV2 = "ses_ee23f2130ffeQJ1hVVb2kYmDG5"
)

// loadDump builds a database from one of the dumps and returns its path.
func loadDump(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read dump: %v", err)
	}
	path := filepath.Join(t.TempDir(), "opencode.db")
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(string(b)); err != nil {
		t.Fatalf("load %s: %v", name, err)
	}
	return path
}

// dumpHarness is newHarness over a dump instead of a hand-built fixture.
type dumpHarness struct {
	t    *testing.T
	path string
	in   *Ingester
	out  *sql.DB
}

func newDumpHarness(t *testing.T, name string) *dumpHarness {
	t.Helper()
	path := loadDump(t, name)
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
	db, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return &dumpHarness{t: t, path: path, in: NewIngester(db, rollup.New(st, table, nil, lg), lg, time.Second), out: st.DB()}
}

func (h *dumpHarness) poll() {
	h.t.Helper()
	if err := h.in.once(context.Background()); err != nil {
		h.t.Fatalf("ingest: %v", err)
	}
}

// exec changes the OpenCode database behind the reader's back, as OpenCode
// itself would.
func (h *dumpHarness) exec(q string) {
	h.t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(h.path))
	if err != nil {
		h.t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(q); err != nil {
		h.t.Fatalf("exec %q: %v", q, err)
	}
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestV2SessionsAreRead(t *testing.T) {
	db, err := Open(loadDump(t, "opencode-2.0.26.sql"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ss, err := Sessions(context.Background(), db)
	if err != nil {
		t.Fatalf("sessions: %v", err)
	}
	if len(ss) != 5 {
		t.Fatalf("%d sessions, want 5", len(ss))
	}
	for i, s := range ss {
		if !s.InV2 || s.InV1 {
			t.Errorf("%s: InV1=%v InV2=%v, want only v2", s.ID, s.InV1, s.InV2)
		}
		if i > 0 && s.Updated > ss[i-1].Updated {
			t.Errorf("not newest first at %d", i)
		}
		if s.Directory != "/home/dev/proj" {
			t.Errorf("%s: directory %q", s.ID, s.Directory)
		}
	}
	child, ok, err := SessionByID(context.Background(), db, v2Child)
	if err != nil || !ok {
		t.Fatalf("child: ok=%v err=%v", ok, err)
	}
	if child.ParentID != v2Parent || !child.IsChild() {
		t.Errorf("child parent = %q", child.ParentID)
	}
	if _, ok, err := SessionByID(context.Background(), db, "ses_nope"); ok || err != nil {
		t.Errorf("missing session: ok=%v err=%v", ok, err)
	}
}

func TestV2ReadMapsMessagesToolsAndText(t *testing.T) {
	db, err := Open(loadDump(t, "opencode-2.0.26.sql"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	s, _, _ := SessionByID(ctx, db, v2Tool)
	msgs, calls, parts, err := Read(ctx, db, s)
	if err != nil {
		t.Fatal(err)
	}
	var roles []string
	for _, m := range msgs {
		roles = append(roles, m.Role)
	}
	if len(msgs) != 4 || roles[0] != "user" || roles[3] != "assistant" {
		t.Fatalf("roles = %v, want user + three assistant steps (idle skipped)", roles)
	}
	a := msgs[1]
	if a.Model != "m1" || a.Provider != "fake" || !near(a.Cost, 0.00357) ||
		a.TokensIn != 1000 || a.TokensOut != 34 || a.CacheRead != 200 || a.Created == 0 || a.Completed == 0 {
		t.Errorf("assistant step = %+v", a)
	}
	if len(calls) != 2 {
		t.Fatalf("%d tool calls, want 2", len(calls))
	}
	if c := calls[0]; c.Tool != "Bash" || c.RawTool != "shell" || c.Status != "completed" ||
		c.MessageID != msgs[1].ID || c.ID != msgs[1].ID+"/call_00491653" || c.Start == 0 {
		t.Errorf("shell call = %+v", c)
	}
	if c := calls[1]; c.Tool != "Read" || c.FilePath != "note.txt" {
		t.Errorf("read call = %+v", c)
	}
	if got := ToolInput(calls[0].Input)["command"]; got == nil {
		t.Errorf("shell input lost its command")
	}
	if got := parts[msgs[0].ID]; len(got) != 1 || got[0] != `"Please USE A TOOL to print hi"` {
		t.Errorf("prompt parts = %q", got)
	}
	if got := parts[msgs[3].ID]; len(got) != 1 || got[0] != "The command ran; it printed hi. Done." {
		t.Errorf("reply parts = %q", got)
	}
}

func TestV2IngestStoresTurnsPromptsAndTools(t *testing.T) {
	h := newDumpHarness(t, "opencode-2.0.26.sql")
	h.poll()

	if n := count(t, h.out, `SELECT COUNT(*) FROM sessions WHERE agent='opencode'`); n != 5 {
		t.Errorf("%d opencode sessions, want 5", n)
	}
	// Eight steps at 0.00357 on m1 and two at 0.00117 on m2, each as OpenCode
	// priced it. The session rows carry more — OpenCode 2 adds the title
	// call to session_v2.cost, and no message carries it — which is the
	// documented difference.
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE kind='turn.assistant'`); n != 10 {
		t.Errorf("%d assistant turns, want 10", n)
	}
	if got := sum(t, h.out, `SELECT SUM(cost_usd) FROM events WHERE kind='turn.assistant'`); !near(got, 8*0.00357+2*0.00117) {
		t.Errorf("cost = %v, want %v", got, 8*0.00357+2*0.00117)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE kind='turn.user'`); n != 5 {
		t.Errorf("%d prompts, want 5 (the plan reminder is OpenCode's, not a prompt)", n)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE kind='turn.user' AND payload LIKE '%Plan mode%'`); n != 0 {
		t.Errorf("a synthetic message was stored as a prompt")
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE kind='tool.pre'`); n != 4 {
		t.Errorf("%d tool calls, want 4", n)
	}
	for tool, want := range map[string]int{"Bash": 1, "Read": 2, "Agent": 1} {
		if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE kind='tool.pre' AND tool=?`, tool); n != want {
			t.Errorf("%d %s calls, want %d", n, tool, want)
		}
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE kind='tool.pre' AND json_extract(payload,'$.status')='error'`); n != 1 {
		t.Errorf("%d failed calls, want 1", n)
	}
	// The model is on each step, not on session_v2; the session row gets it.
	if n := count(t, h.out, `SELECT COUNT(*) FROM sessions WHERE session_id=? AND model='m2'`, v2Plan); n != 1 {
		t.Errorf("plan session model not taken from its steps")
	}
	// A subagent's child session is a sidechain, as for OpenCode 1.
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE session_id=? AND json_extract(payload,'$.sidechain')=1`, v2Child); n != 2 {
		t.Errorf("%d sidechain events in the child, want 2", n)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE session_id=? AND json_extract(payload,'$.text')='The command ran; it printed hi. Done.'`, v2Tool); n != 1 {
		t.Errorf("reply text not stored")
	}

	// Idempotent: a second full pass stores nothing.
	before := count(t, h.out, `SELECT COUNT(*) FROM events`)
	h.in.mu.Lock()
	h.in.seen = map[string]int64{}
	h.in.mu.Unlock()
	h.poll()
	if after := count(t, h.out, `SELECT COUNT(*) FROM events`); after != before {
		t.Errorf("second pass stored %d more events", after-before)
	}
}

func TestV2TouchReadsOneSession(t *testing.T) {
	h := newDumpHarness(t, "opencode-2.0.26.sql")
	h.in.Touch(context.Background(), v2Tool)
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE session_id=?`, v2Tool); n != 6 {
		t.Errorf("%d events after a touch, want 6 (a prompt, three steps, two calls)", n)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE session_id<>?`, v2Tool); n != 0 {
		t.Errorf("a touch read other sessions")
	}
}

func TestMixedDatabaseCountsEachMessageOnce(t *testing.T) {
	db, err := Open(loadDump(t, "opencode-1.15.10-then-2.0.26.sql"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ss, err := Sessions(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	if len(ss) != 2 {
		t.Fatalf("%d sessions, want 2 (the migrated one once)", len(ss))
	}
	both := ss[0]
	if both.ID != mixedBoth {
		both = ss[1]
	}
	if !both.InV1 || !both.InV2 {
		t.Errorf("migrated session: InV1=%v InV2=%v", both.InV1, both.InV2)
	}
	// session_v2 is the row that kept moving; its later update time wins.
	if both.Updated != 1791500541274 {
		t.Errorf("updated = %d, want session_v2's", both.Updated)
	}
	if both.Model != "m1" {
		t.Errorf("model = %q", both.Model)
	}
}

func TestMixedIngest(t *testing.T) {
	h := newDumpHarness(t, "opencode-1.15.10-then-2.0.26.sql")
	h.poll()

	// The migrated session: three OpenCode 1 steps and one OpenCode 2 step,
	// at 0.00357 each — session_v2.cost says 0.01428 too.
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE session_id=? AND kind='turn.assistant'`, mixedBoth); n != 4 {
		t.Errorf("%d turns in the migrated session, want 4", n)
	}
	if got := sum(t, h.out, `SELECT SUM(cost_usd) FROM events WHERE session_id='`+mixedBoth+`'`); !near(got, 0.01428) {
		t.Errorf("migrated session cost = %v, want 0.01428", got)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE session_id=? AND kind='turn.user'`, mixedBoth); n != 2 {
		t.Errorf("%d prompts, want 2 (one per version)", n)
	}
	// Its tool calls come from OpenCode 1's part rows, keyed by part id, and
	// are not read a second time from the same messages in session_message.
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE session_id=? AND kind='tool.pre'`, mixedBoth); n != 2 {
		t.Errorf("%d tool calls, want 2", n)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE session_id=? AND kind='tool.pre' AND key LIKE 'oc-tool:prt_%'`, mixedBoth); n != 2 {
		t.Errorf("tool calls not keyed by OpenCode 1's part id")
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE session_id=? AND kind='tool.pre'`, mixedNewV2); n != 2 {
		t.Errorf("%d tool calls in the OpenCode 2 session, want 2", n)
	}
}

// A machine that ran Caprock with OpenCode 1 has the session's OpenCode 1
// messages stored already when OpenCode 2 migrates the database and the person
// continues the session there. The next pass adds only the new turn.
func TestUpgradeAddsOnlyTheContinuation(t *testing.T) {
	h := newDumpHarness(t, "opencode-1.15.10-then-2.0.26.sql")
	// Before OpenCode 2: only OpenCode 1's tables.
	h.exec(`ALTER TABLE session_v2 RENAME TO later_session_v2; ALTER TABLE session_message RENAME TO later_session_message`)
	h.poll()
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE session_id=? AND kind='turn.assistant'`, mixedBoth); n != 3 {
		t.Fatalf("%d turns before the upgrade, want 3", n)
	}
	before := count(t, h.out, `SELECT COUNT(*) FROM events`)

	h.exec(`ALTER TABLE later_session_v2 RENAME TO session_v2; ALTER TABLE later_session_message RENAME TO session_message`)
	h.poll()
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE session_id=? AND kind='turn.assistant'`, mixedBoth); n != 4 {
		t.Errorf("%d turns after the upgrade, want 4", n)
	}
	// Two events for the continuation (its prompt and its step) and six for
	// the new OpenCode 2 session (a prompt, three steps, two calls) — and
	// nothing from the messages already stored.
	if added := count(t, h.out, `SELECT COUNT(*) FROM events`) - before; added != 2+6 {
		t.Errorf("upgrade pass added %d events, want 8", added)
	}
}

func TestV2CompactionIsATurnWithCost(t *testing.T) {
	// No compaction ran in the scratch sessions; this row follows OpenCode
	// 2.0.26's own schema for one (Session.Message.Compaction.Completed:
	// status, reason, model, summary, recent, cost, tokens).
	h := newDumpHarness(t, "opencode-2.0.26.sql")
	h.exec(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES
		('msg_compact1', '` + v2Tool + `', 'compaction', 30, 1791500492000, 1791500492000,
		 '{"time":{"created":1791500492000},"status":"completed","reason":"auto","model":{"id":"m1","providerID":"fake"},"summary":"so far","recent":"","cost":0.002,"tokens":{"input":500,"output":20,"reasoning":0,"cache":{"read":0,"write":0}}}'),
		('msg_compact2', '` + v2Tool + `', 'compaction', 31, 1791500493000, 1791500493000,
		 '{"time":{"created":1791500493000},"status":"running","reason":"manual","summary":"","recent":""}')`)
	h.poll()
	if got := sum(t, h.out, `SELECT COALESCE(SUM(cost_usd),0) FROM events WHERE key='oc-msg:msg_compact1'`); !near(got, 0.002) {
		t.Errorf("compaction cost = %v, want 0.002", got)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE key='oc-msg:msg_compact2'`); n != 0 {
		t.Errorf("a running compaction was stored")
	}
}

func TestTablesRefusesAForeignDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.db")
	w, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Exec(`CREATE TABLE unrelated (id text)`); err != nil {
		t.Fatal(err)
	}
	_ = w.Close()
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := Sessions(context.Background(), db); err == nil {
		t.Error("a database with neither schema read as OpenCode's")
	}
}

func TestNormalizeToolV2Names(t *testing.T) {
	for in, want := range map[string]string{"shell": "Bash", "subagent": "Agent", "execute": "Execute", "read": "Read"} {
		if got := NormalizeTool(in); got != want {
			t.Errorf("NormalizeTool(%q) = %q, want %q", in, got, want)
		}
	}
}
