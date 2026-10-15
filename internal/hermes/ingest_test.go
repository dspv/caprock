package hermes

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/sessionlink"
	"github.com/dspv/caprock/internal/store"
)

// t0 is a fixed moment the fixture sessions start at, in Hermes's float seconds.
var t0 = float64(time.Date(2026, 10, 15, 9, 30, 0, 0, time.Local).Unix())

type harness struct {
	ctx  context.Context
	w    *sql.DB // the test playing Hermes
	path string
	st   *store.Store
	rec  *rollup.Recorder
	in   *Ingester
	cwd  string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	ctx := context.Background()
	lg := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "caprock.db"), lg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	table, err := cost.Load("")
	if err != nil {
		t.Fatal(err)
	}
	rec := rollup.New(st, table, nil, lg)
	w, path := fixtureDB(t)
	db, err := open(path, 200)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return &harness{ctx: ctx, w: w, path: path, st: st, rec: rec, in: NewIngester(db, rec, lg, time.Second), cwd: t.TempDir()}
}

// session writes one sessions row the way Hermes's create_session and
// update_token_counts leave it. Columns not given keep the schema's defaults.
func (h *harness) session(t *testing.T, cols map[string]any) {
	t.Helper()
	if _, ok := cols["started_at"]; !ok {
		cols["started_at"] = t0
	}
	if _, ok := cols["source"]; !ok {
		cols["source"] = "cli"
	}
	names := make([]string, 0, len(cols))
	for k := range cols {
		names = append(names, k)
	}
	sort.Strings(names)
	args := make([]any, len(names))
	marks := make([]string, len(names))
	for i, k := range names {
		args[i], marks[i] = cols[k], "?"
	}
	if _, err := h.w.ExecContext(h.ctx, `INSERT OR REPLACE INTO sessions (`+strings.Join(names, ",")+`) VALUES (`+strings.Join(marks, ",")+`)`, args...); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) update(t *testing.T, id, set string, args ...any) {
	t.Helper()
	if _, err := h.w.ExecContext(h.ctx, `UPDATE sessions SET `+set+` WHERE id = ?`, append(args, id)...); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) message(t *testing.T, sid, role, content string, at float64, toolCalls string) {
	t.Helper()
	var tc any
	if toolCalls != "" {
		tc = toolCalls
	}
	if _, err := h.w.ExecContext(h.ctx, `INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?,?,?,?,?)`,
		sid, role, content, tc, at); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) once(t *testing.T) {
	t.Helper()
	if err := h.in.Once(h.ctx); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) count(t *testing.T, where string) int {
	t.Helper()
	var n int
	if err := h.st.DB().QueryRowContext(h.ctx, `SELECT COUNT(*) FROM events WHERE source = 'hermes' AND `+where).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

type sums struct {
	in, out, cr, cw int64
	cost            float64
	priced          int
}

func (h *harness) sums(t *testing.T, sessionID string) sums {
	t.Helper()
	var s sums
	if err := h.st.DB().QueryRowContext(h.ctx, `
		SELECT COALESCE(SUM(tokens_in),0), COALESCE(SUM(tokens_out),0), COALESCE(SUM(cache_read),0),
		       COALESCE(SUM(cache_write),0), COALESCE(SUM(cost_usd),0), COUNT(cost_usd)
		FROM events WHERE session_id = ? AND kind = 'turn.assistant'`, sessionID).Scan(&s.in, &s.out, &s.cr, &s.cw, &s.cost, &s.priced); err != nil {
		t.Fatal(err)
	}
	return s
}

const twoCalls = `[{"id":"call_1","type":"function","function":{"name":"terminal","arguments":"{\"command\":\"go test ./...\"}"}},` +
	`{"id":"call_2","type":"function","function":{"name":"patch","arguments":"{\"path\":\"internal/x.go\",\"old_string\":\"a\",\"new_string\":\"b\"}"}}]`

// A CLI session with a prompt, a reply that calls two tools, and a final
// reply, with Hermes's counters and estimate: the whole mapping.
func TestASessionIsMappedOntoEvents(t *testing.T) {
	h := newHarness(t)
	h.session(t, map[string]any{
		"id": "20261015_093000_a1b2c3", "model": "anthropic/claude-sonnet-4.6", "cwd": h.cwd, "git_branch": "feat/x",
		"title": "Fix the flaky test", "billing_provider": "openrouter",
		"input_tokens": 1200, "output_tokens": 300, "cache_read_tokens": 5000, "cache_write_tokens": 800, "reasoning_tokens": 40,
		"estimated_cost_usd": 0.0421, "cost_status": "estimated", "cost_source": "provider_models_api",
		"api_call_count": 2, "tool_call_count": 2, "message_count": 3, "last_activity_at": t0 + 30,
	})
	h.message(t, "20261015_093000_a1b2c3", "user", "Why does TestX flake?", t0+1, "")
	h.message(t, "20261015_093000_a1b2c3", "assistant", "Let me run it.", t0+5, twoCalls)
	h.message(t, "20261015_093000_a1b2c3", "tool", "ok", t0+9, "")
	h.message(t, "20261015_093000_a1b2c3", "assistant", "It races on the clock; fixed.", t0+30, "")
	h.once(t)

	sid := "20261015_093000_a1b2c3"
	if n := h.count(t, `kind = 'turn.user' AND json_extract(payload,'$.prompt') = 'Why does TestX flake?'`); n != 1 {
		t.Errorf("prompts stored: %d, want 1", n)
	}
	if n := h.count(t, `kind = 'turn.assistant'`); n != 2 {
		t.Errorf("replies stored: %d, want 2 (the tool result is not a reply)", n)
	}
	if n := h.count(t, `kind = 'turn.assistant' AND json_extract(payload,'$.text') = 'It races on the clock; fixed.'`); n != 1 {
		t.Error("the reply's prose was not kept for Memory")
	}
	// The usage lands on the newest reply, with Hermes's figure and its basis.
	got := h.sums(t, sid)
	if got.in != 1200 || got.out != 300 || got.cr != 5000 || got.cw != 800 {
		t.Errorf("tokens = %+v", got)
	}
	if math.Abs(got.cost-0.0421) > 1e-9 {
		t.Errorf("cost = %v, want Hermes's 0.0421 (never Caprock's table)", got.cost)
	}
	var basis string
	if err := h.st.DB().QueryRowContext(h.ctx, `SELECT json_extract(payload,'$.cost_basis') FROM events
		WHERE source='hermes' AND cost_usd IS NOT NULL`).Scan(&basis); err != nil {
		t.Fatal(err)
	}
	if basis != BasisEstimated {
		t.Errorf("basis = %q", basis)
	}
	// Tool calls, in Caprock's spellings, tied to the reply that asked.
	rows, err := h.st.DB().QueryContext(h.ctx, `SELECT tool, json_extract(payload,'$.tool_input.command'),
		COALESCE(json_extract(payload,'$.tool_input.file_path'),''), msg_id FROM events WHERE source='hermes' AND kind='tool.pre' ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var tools []string
	for rows.Next() {
		var tool, file, msg string
		var cmd sql.NullString
		if err := rows.Scan(&tool, &cmd, &file, &msg); err != nil {
			t.Fatal(err)
		}
		if msg != "hermes/2" {
			t.Errorf("%s not linked to its reply: %q", tool, msg)
		}
		tools = append(tools, tool)
		if tool == "Bash" && cmd.String != "go test ./..." {
			t.Errorf("command = %q", cmd.String)
		}
		if tool == "Edit" && file != filepath.Join(h.cwd, "internal/x.go") {
			t.Errorf("a relative path was not placed in the session's folder: %q", file)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if strings.Join(tools, ",") != "Bash,Edit" {
		t.Errorf("tools = %v", tools)
	}
	s, err := store.GetSession(h.ctx, h.st.DB(), sid)
	if err != nil {
		t.Fatal(err)
	}
	if s.Agent != Agent || s.Cwd != h.cwd || s.GitBranch != "feat/x" || s.Title != "Fix the flaky test" {
		t.Errorf("session row = agent %q cwd %q branch %q title %q", s.Agent, s.Cwd, s.GitBranch, s.Title)
	}
	st, err := store.GetStats(h.ctx, h.st.DB(), sid)
	if err != nil {
		t.Fatal(err)
	}
	if st.ToolCalls != 2 || math.Abs(st.CostUSD-0.0421) > 1e-9 {
		t.Errorf("stats = %+v", st)
	}
}

// Reading the same database again — on the next tick, or after a restart —
// stores nothing and moves no total.
func TestRereadingAddsNothing(t *testing.T) {
	h := newHarness(t)
	h.session(t, map[string]any{"id": "s1", "input_tokens": 100, "output_tokens": 10, "estimated_cost_usd": 0.01, "cost_status": "estimated"})
	h.message(t, "s1", "user", "hi", t0+1, "")
	h.message(t, "s1", "assistant", "hello", t0+2, "")
	h.once(t)
	before := h.count(t, "1=1")
	h.once(t)
	db, err := open(h.path, 200)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := NewIngester(db, h.rec, nil, time.Second).Once(h.ctx); err != nil {
		t.Fatal(err)
	}
	if after := h.count(t, "1=1"); after != before {
		t.Errorf("events %d → %d on a re-read", before, after)
	}
	if got := h.sums(t, "s1"); got.in != 100 || math.Abs(got.cost-0.01) > 1e-9 {
		t.Errorf("totals moved: %+v", got)
	}
}

// Hermes queues its counters and flushes them apart from the messages: the
// usage that arrives after its reply is stored on a record of its own, and
// the session's totals still equal Hermes's.
func TestUsageThatArrivesLaterIsStoredOnce(t *testing.T) {
	h := newHarness(t)
	h.session(t, map[string]any{"id": "s1"})
	h.message(t, "s1", "user", "hi", t0+1, "")
	h.message(t, "s1", "assistant", "hello", t0+2, "")
	h.once(t)
	if got := h.sums(t, "s1"); got.in != 0 || got.priced != 0 {
		t.Fatalf("usage before Hermes wrote any: %+v", got)
	}
	h.update(t, "s1", "input_tokens = 400, output_tokens = 50, estimated_cost_usd = 0.02, cost_status = 'estimated', api_call_count = 1, last_activity_at = ?", t0+3)
	h.once(t)
	h.once(t)
	if n := h.count(t, `json_extract(payload,'$.usage_only') = 1`); n != 1 {
		t.Errorf("usage records: %d, want 1", n)
	}
	// Another call: the next difference, and only that.
	h.update(t, "s1", "input_tokens = 900, output_tokens = 80, estimated_cost_usd = 0.05, api_call_count = 2")
	h.message(t, "s1", "assistant", "done", t0+9, "")
	h.once(t)
	got := h.sums(t, "s1")
	if got.in != 900 || got.out != 80 || math.Abs(got.cost-0.05) > 1e-9 {
		t.Errorf("totals = %+v, want Hermes's 900/80/$0.05", got)
	}
	if n := h.count(t, `json_extract(payload,'$.usage_only') = 1`); n != 1 {
		t.Errorf("the second difference went on a usage record (%d) instead of the new reply", n)
	}
}

// Which figure is used: the provider's when Hermes says it is real, the
// estimate otherwise, zero on a subscription, and none when Hermes has none.
func TestCostSource(t *testing.T) {
	for _, c := range []struct {
		name      string
		cols      map[string]any
		wantCost  float64
		wantBasis string
		priced    bool
	}{
		{"actual", map[string]any{"estimated_cost_usd": 0.30, "actual_cost_usd": 0.27, "cost_status": "actual", "cost_source": "provider_cost_api"}, 0.27, BasisActual, true},
		{"actual from the generation api", map[string]any{"estimated_cost_usd": 0.30, "actual_cost_usd": 0.25, "cost_status": "estimated", "cost_source": "provider_generation_api"}, 0.25, BasisActual, true},
		{"actual in the estimate column", map[string]any{"estimated_cost_usd": 0.22, "cost_status": "actual", "cost_source": "provider_cost_api"}, 0.22, BasisActual, true},
		{"estimated", map[string]any{"estimated_cost_usd": 0.30, "cost_status": "estimated", "cost_source": "official_docs_snapshot"}, 0.30, BasisEstimated, true},
		{"included", map[string]any{"estimated_cost_usd": 0.0, "cost_status": "included", "cost_source": "none", "billing_mode": "subscription_included"}, 0, BasisIncluded, true},
		{"unknown", map[string]any{"cost_status": "unknown", "cost_source": "none"}, 0, BasisUnknown, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			cols := map[string]any{"id": "s1", "input_tokens": 1000, "output_tokens": 100, "model": "some/model"}
			for k, v := range c.cols {
				cols[k] = v
			}
			h.session(t, cols)
			h.message(t, "s1", "assistant", "x", t0+1, "")
			h.once(t)
			got := h.sums(t, "s1")
			if (got.priced > 0) != c.priced || math.Abs(got.cost-c.wantCost) > 1e-9 {
				t.Errorf("cost = %v (priced rows %d), want %v priced=%v", got.cost, got.priced, c.wantCost, c.priced)
			}
			var basis string
			_ = h.st.DB().QueryRowContext(h.ctx, `SELECT json_extract(payload,'$.cost_basis') FROM events WHERE kind='turn.assistant'`).Scan(&basis)
			if basis != c.wantBasis {
				t.Errorf("basis = %q, want %q", basis, c.wantBasis)
			}
			if !c.priced && h.in.Stats().Unpriced != 1 {
				t.Errorf("an unpriced turn was not counted: %+v", h.in.Stats())
			}
		})
	}
}

// A delegated child is filed inside its parent as a subagent; a compression
// continuation and a branch are sessions of their own. Nothing is counted
// twice: each row holds its own calls only.
func TestSubagentsAndContinuations(t *testing.T) {
	h := newHarness(t)
	h.session(t, map[string]any{"id": "root", "cwd": h.cwd, "input_tokens": 100, "estimated_cost_usd": 0.10, "cost_status": "estimated",
		"end_reason": "compression", "ended_at": t0 + 50})
	h.session(t, map[string]any{"id": "kid", "parent_session_id": "root", "started_at": t0 + 10, "cwd": h.cwd,
		"model_config": `{"_delegate_from":"root"}`, "input_tokens": 40, "estimated_cost_usd": 0.04, "cost_status": "estimated"})
	h.session(t, map[string]any{"id": "grandkid", "parent_session_id": "kid", "started_at": t0 + 12, "cwd": h.cwd,
		"model_config": `{"_delegate_from":"kid"}`, "input_tokens": 5, "estimated_cost_usd": 0.005, "cost_status": "estimated"})
	h.session(t, map[string]any{"id": "next", "parent_session_id": "root", "started_at": t0 + 51, "cwd": h.cwd,
		"input_tokens": 70, "estimated_cost_usd": 0.07, "cost_status": "estimated"})
	h.session(t, map[string]any{"id": "branch", "parent_session_id": "next", "started_at": t0 + 60, "cwd": h.cwd,
		"model_config": `{"_branched_from":"next"}`, "input_tokens": 9, "estimated_cost_usd": 0.009, "cost_status": "estimated"})
	for _, id := range []string{"root", "kid", "grandkid", "next", "branch"} {
		h.message(t, id, "assistant", "from "+id, t0+20, "")
	}
	h.once(t)

	// The children are inside root, each under its own agent id, marked.
	rows, err := h.st.DB().QueryContext(h.ctx, `SELECT session_id, COALESCE(agent_id,''), COALESCE(json_extract(payload,'$.sidechain'),0)
		FROM events WHERE kind='turn.assistant' ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	where := map[string]string{}
	for rows.Next() {
		var sid, agent string
		var side int
		if err := rows.Scan(&sid, &agent, &side); err != nil {
			t.Fatal(err)
		}
		where[sid+"/"+agent] = map[bool]string{true: "side", false: "main"}[side == 1]
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	_ = rows.Close()
	want := map[string]string{"root/": "main", "root/kid": "side", "root/grandkid": "side", "next/": "main", "branch/": "main"}
	for k, v := range want {
		if where[k] != v {
			t.Errorf("%s = %q, want %q (all: %v)", k, where[k], v, where)
		}
	}
	if got := h.sums(t, "root"); math.Abs(got.cost-0.145) > 1e-9 || got.in != 145 {
		t.Errorf("root with its subagents = %+v, want $0.145 / 145 in", got)
	}
	var total float64
	_ = h.st.DB().QueryRowContext(h.ctx, `SELECT SUM(cost_usd) FROM events`).Scan(&total)
	if math.Abs(total-0.224) > 1e-9 {
		t.Errorf("everything = %v, want 0.224: a row counted twice or missed", total)
	}
	// Hermes ended root on compression: it is over, its continuation is not.
	if s, _ := store.GetSession(h.ctx, h.st.DB(), "root"); s.Status != store.StatusEnded {
		t.Errorf("root status = %q", s.Status)
	}
	if s, _ := store.GetSession(h.ctx, h.st.DB(), "next"); s.Status == store.StatusEnded {
		t.Error("the continuation was ended")
	}
}

// cron and gateway sessions are background work: marked on every event,
// their subagents too, and counted.
func TestBackgroundSources(t *testing.T) {
	h := newHarness(t)
	h.session(t, map[string]any{"id": "cron_abc123def456_20261015_093000", "source": "cron", "input_tokens": 10, "estimated_cost_usd": 0.5, "cost_status": "estimated"})
	h.session(t, map[string]any{"id": "kid", "source": "cron", "parent_session_id": "cron_abc123def456_20261015_093000",
		"model_config": `{"_delegate_from":"cron_abc123def456_20261015_093000"}`, "input_tokens": 1, "estimated_cost_usd": 0.1, "cost_status": "estimated"})
	h.session(t, map[string]any{"id": "tg", "source": "telegram", "input_tokens": 10, "estimated_cost_usd": 0.2, "cost_status": "estimated"})
	h.session(t, map[string]any{"id": "me", "source": "cli", "input_tokens": 10, "estimated_cost_usd": 0.3, "cost_status": "estimated"})
	for _, id := range []string{"cron_abc123def456_20261015_093000", "kid", "tg", "me"} {
		h.message(t, id, "assistant", "x", t0+1, "")
	}
	h.once(t)
	var bg float64
	_ = h.st.DB().QueryRowContext(h.ctx, `SELECT SUM(cost_usd) FROM events WHERE json_extract(payload,'$.background') = 1`).Scan(&bg)
	if math.Abs(bg-0.8) > 1e-9 {
		t.Errorf("background spend = %v, want 0.8 (cron 0.5 + its subagent 0.1 + telegram 0.2)", bg)
	}
	if got := h.in.Stats().Background; got != 2 {
		t.Errorf("background sessions = %d, want 2", got)
	}
	spend, err := store.HermesSpend(h.ctx, h.st.DB(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if spend == nil || math.Abs(spend.BackgroundUSD-0.8) > 1e-9 || math.Abs(spend.TotalUSD-1.1) > 1e-9 || math.Abs(spend.EstimatedUSD-1.1) > 1e-9 {
		t.Errorf("spend = %+v", spend)
	}
	if spend != nil && (len(spend.Sources) != 2 || spend.Sources[0].Source != "cron" || math.Abs(spend.Sources[0].CostUSD-0.6) > 1e-9) {
		t.Errorf("by source = %+v", spend.Sources)
	}
}

// A session Caprock started is found under Caprock's id: same folder, and
// Hermes's id says the CLI started within the window after the spawn.
func TestASpawnedSessionIsLinked(t *testing.T) {
	h := newHarness(t)
	link := sessionlink.New(h.st, nil)
	h.in.Link = link
	spawned := time.Date(2026, 10, 15, 9, 29, 58, 0, time.Local)
	if err := store.UpsertSession(h.ctx, h.st.DB(), "cap-1", store.SessionPatch{Cwd: h.cwd, Agent: Agent, StartedAt: spawned.UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	link.Expect(Agent, "cap-1", h.cwd, spawned, true)
	// The row is created minutes later, on the first message; the id carries
	// the moment the CLI started.
	h.session(t, map[string]any{"id": "20261015_093000_a1b2c3", "cwd": h.cwd, "started_at": t0 + 300, "input_tokens": 5, "estimated_cost_usd": 0.01, "cost_status": "estimated"})
	h.message(t, "20261015_093000_a1b2c3", "assistant", "hi", t0+301, "")
	h.once(t)
	if got := h.sums(t, "cap-1"); got.in != 5 {
		t.Errorf("the spawned session's usage went elsewhere: %+v", got)
	}
	if n := h.count(t, `session_id = '20261015_093000_a1b2c3'`); n != 0 {
		t.Errorf("%d events stored under Hermes's id as well", n)
	}
}

func TestAMissingDatabaseIsAnError(t *testing.T) {
	db, err := open(filepath.Join(t.TempDir(), "nope", "state.db"), 50)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := Sessions(context.Background(), db); err == nil {
		t.Fatal("read a database that does not exist")
	}
}

// Hermes holding the database past the busy timeout fails one pass and
// writes nothing; the next pass, once it lets go, imports normally.
func TestALockedDatabaseWaitsForTheNextPass(t *testing.T) {
	h := newHarness(t)
	h.session(t, map[string]any{"id": "s1", "input_tokens": 10, "estimated_cost_usd": 0.01, "cost_status": "estimated"})
	h.message(t, "s1", "assistant", "x", t0+1, "")
	// Out of WAL and into an exclusive lock: the one state in which a reader
	// is shut out.
	if _, err := h.w.ExecContext(h.ctx, `PRAGMA journal_mode=DELETE`); err != nil {
		t.Fatal(err)
	}
	if _, err := h.w.ExecContext(h.ctx, `PRAGMA locking_mode=EXCLUSIVE`); err != nil {
		t.Fatal(err)
	}
	if _, err := h.w.ExecContext(h.ctx, `BEGIN EXCLUSIVE`); err != nil {
		t.Fatal(err)
	}
	if err := h.in.Once(h.ctx); err == nil {
		t.Fatal("read through an exclusive lock")
	}
	if n := h.count(t, "1=1"); n != 0 {
		t.Fatalf("%d events written from a locked database", n)
	}
	if _, err := h.w.ExecContext(h.ctx, `COMMIT`); err != nil {
		t.Fatal(err)
	}
	if _, err := h.w.ExecContext(h.ctx, `PRAGMA locking_mode=NORMAL`); err != nil {
		t.Fatal(err)
	}
	// The mode takes effect at the next access; this releases the lock.
	if _, err := h.w.ExecContext(h.ctx, `SELECT COUNT(*) FROM sessions`); err != nil {
		t.Fatal(err)
	}
	h.once(t)
	if got := h.sums(t, "s1"); got.in != 10 {
		t.Errorf("not imported after the lock: %+v", got)
	}
}

// The reader never writes: its connection is read-only.
func TestTheReaderCannotWrite(t *testing.T) {
	_, path := fixtureDB(t)
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.ExecContext(context.Background(), `INSERT INTO schema_version (version) VALUES (1)`); err == nil {
		t.Fatal("a write succeeded through the reader")
	}
}

func TestPayloadHelpers(t *testing.T) {
	if got := decodeContent("\x00json:" + `[{"type":"text","text":"a"},{"type":"image_url","image_url":{}},{"type":"text","text":"b"}]`); got != "a\nb" {
		t.Errorf("parts = %q", got)
	}
	if got := decodeContent("\x00json:" + `"\u0000json:literal"`); got != "\x00json:literal" {
		t.Errorf("escaped literal = %q", got)
	}
	if got := decodeContent("plain"); got != "plain" {
		t.Errorf("plain = %q", got)
	}
	calls := ToolCalls(`[{"id":"c","function":{"name":"terminal","arguments":"not json"}},{"function":{"name":""}}]`)
	if len(calls) != 1 || calls[0].Input["command"] != "not json" {
		t.Errorf("calls = %+v", calls)
	}
	if ToolCalls("garbage") != nil {
		t.Error("garbage parsed")
	}
	b, _ := json.Marshal(ToolInput("read_file", map[string]any{"path": "/a/b"}, "/w"))
	if string(b) != `{"file_path":"/a/b"}` {
		t.Errorf("input = %s", b)
	}
}

func TestIDTimeAndBackground(t *testing.T) {
	got, ok := IDTime("20261015_093000_a1b2c3")
	if !ok || !got.Equal(time.Date(2026, 10, 15, 9, 30, 0, 0, time.Local)) {
		t.Errorf("IDTime = %v %v", got, ok)
	}
	for _, id := range []string{"cron_x_20261015_093000", "bg_a1b2c3", "short", "20261315_093000_a1b2c3"} {
		if _, ok := IDTime(id); ok {
			t.Errorf("%q read as a CLI id", id)
		}
	}
	for src, want := range map[string]bool{"cli": false, "tui": false, "desktop": false, "acp": false, "cron": true, "telegram": true, "oneshot": true, "kanban": true} {
		if Background(src) != want {
			t.Errorf("Background(%q) = %v", src, !want)
		}
	}
}

func TestHome(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	if got := home(env(map[string]string{EnvHome: "/x/h"}), "darwin"); got != "/x/h" {
		t.Errorf("HERMES_HOME ignored: %q", got)
	}
	if got := home(env(map[string]string{"LOCALAPPDATA": `C:\Users\u\AppData\Local`}), "windows"); got != filepath.Join(`C:\Users\u\AppData\Local`, "hermes") {
		t.Errorf("windows = %q", got)
	}
	if got := home(env(nil), "linux"); !strings.HasSuffix(got, ".hermes") {
		t.Errorf("default = %q", got)
	}
}
