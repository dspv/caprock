package cursor

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// fixtureChat is testdata/editor-chat.json: one real editor chat from Cursor
// 2.3.41 (composer-1, 37 messages, Cursor's own cost 11 cents over 15
// requests, one measured turn of 19,330 tokens in and 299 out), with every
// word, path and id replaced and every number kept.
const fixtureChat = "c0ffee00-0000-4000-8000-000000000001"

type harness struct {
	ctx  context.Context
	w    *sql.DB // the test playing Cursor
	path string
	st   *store.Store
	in   *Ingester
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
	path := filepath.Join(t.TempDir(), "state.vscdb")
	w, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })
	for _, q := range []string{
		`PRAGMA journal_mode=WAL`,
		`CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)`,
		`CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)`,
		// The sign-in rows the reader must never touch live in ItemTable.
		`INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', 'not-a-real-token')`,
	} {
		if _, err := w.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	db, err := open(path, 200)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return &harness{ctx: ctx, w: w, path: path, st: st, in: NewIngester(db, path, "", rec, lg, time.Second)}
}

func (h *harness) put(t *testing.T, key string, v any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.w.Exec(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`, key, b); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) load(t *testing.T) map[string]map[string]any {
	t.Helper()
	return h.loadFile(t, "editor-chat.json")
}

// loadFile writes a fixture's rows into the test's Cursor database.
func (h *harness) loadFile(t *testing.T, name string) map[string]map[string]any {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	var rows map[string]map[string]any
	if err := json.Unmarshal(b, &rows); err != nil {
		t.Fatal(err)
	}
	for k, v := range rows {
		h.put(t, k, v)
	}
	return rows
}

func (h *harness) once(t *testing.T) {
	t.Helper()
	// The signature check would skip a pass whose writes landed within the
	// file system's clock tick; tests change the data on purpose.
	h.in.mu.Lock()
	h.in.sig = ""
	h.in.mu.Unlock()
	if err := h.in.Once(h.ctx); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) scalar(t *testing.T, q string) float64 {
	t.Helper()
	var v sql.NullFloat64
	if err := h.st.DB().QueryRowContext(h.ctx, q).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v.Float64
}

func (h *harness) count(t *testing.T, where string) int {
	return int(h.scalar(t, `SELECT COUNT(*) FROM events WHERE `+where))
}

func TestEditorChatIsImported(t *testing.T) {
	h := newHarness(t)
	h.load(t)
	h.once(t)
	s, err := store.GetSession(h.ctx, h.st.DB(), fixtureChat)
	if err != nil {
		t.Fatal(err)
	}
	// The real chat names no terminal folder; its folder is the one its first
	// absolute path sits in (no .git above it in the fixture).
	if s.Agent != Agent || s.Title != "Update the sign-up link" || s.Cwd != "/work/site/app" {
		t.Fatalf("session %+v", s)
	}
	if n := h.count(t, `kind = 'turn.user'`); n != 1 {
		t.Errorf("prompts: %d", n)
	}
	if n := h.count(t, `kind = 'tool.pre'`); n != 14 {
		t.Errorf("tool calls: %d", n)
	}
	if n := h.count(t, `kind = 'tool.pre' AND tool = 'Bash'`); n != 6 {
		t.Errorf("run_terminal_cmd as Bash: %d", n)
	}
	// Cursor's figures, to the cent: 11 cents, 15 requests, one turn's tokens.
	if got := h.scalar(t, `SELECT SUM(cost_usd) FROM events WHERE kind = 'turn.assistant'`); math.Abs(got-0.11) > 1e-9 {
		t.Errorf("cost %v, want Cursor's 0.11", got)
	}
	if got := h.scalar(t, `SELECT SUM(json_extract(payload,'$.requests')) FROM events WHERE kind = 'turn.assistant'`); got != 15 {
		t.Errorf("requests %v", got)
	}
	if got := h.scalar(t, `SELECT SUM(tokens_in) FROM events`); got != 19330 {
		t.Errorf("tokens in %v", got)
	}
	if got := h.scalar(t, `SELECT SUM(tokens_out) FROM events`); got != 299 {
		t.Errorf("tokens out %v", got)
	}
	// No pricing-table figure was added to Cursor's.
	if n := h.count(t, `kind = 'turn.assistant' AND tokens_in > 0 AND json_extract(payload,'$.cost_basis') != 'cursor'`); n != 0 {
		t.Errorf("%d turns with a cost basis other than Cursor's", n)
	}

	// A second pass, and a restart, add nothing.
	before := h.count(t, `1`)
	h.once(t)
	if n := h.count(t, `1`); n != before {
		t.Fatalf("re-read added %d events", n-before)
	}
	h.in = NewIngester(h.in.db, h.path, "", h.in.rec, h.in.log, time.Second)
	h.once(t)
	if n := h.count(t, `1`); n != before {
		t.Fatalf("restart added %d events", n-before)
	}
}

// Cursor writes tokenCount and grows usageData after the reply is stored;
// the next pass records the difference, never the whole again.
func TestUsageThatArrivesLaterIsReconciled(t *testing.T) {
	h := newHarness(t)
	rows := h.load(t)
	key := "composerData:" + fixtureChat
	h.once(t)
	comp := rows[key]
	comp["usageData"] = map[string]any{"composer-1": map[string]any{"costInCents": 30, "amount": 40}}
	comp["lastUpdatedAt"] = comp["lastUpdatedAt"].(float64) + 60000
	h.put(t, key, comp)
	h.once(t)
	if got := h.scalar(t, `SELECT SUM(cost_usd) FROM events`); math.Abs(got-0.30) > 1e-9 {
		t.Fatalf("cost %v after Cursor's total grew to 30 cents", got)
	}
	if got := h.scalar(t, `SELECT SUM(json_extract(payload,'$.requests')) FROM events WHERE kind = 'turn.assistant'`); got != 40 {
		t.Fatalf("requests %v", got)
	}
	// A model the chat switched to keeps its own cost.
	comp["usageData"] = map[string]any{
		"composer-1":                 map[string]any{"costInCents": 30, "amount": 40},
		"claude-4.5-sonnet-thinking": map[string]any{"costInCents": 125, "amount": 3},
	}
	comp["lastUpdatedAt"] = comp["lastUpdatedAt"].(float64) + 60000
	h.put(t, key, comp)
	h.once(t)
	if got := h.scalar(t, `SELECT SUM(cost_usd) FROM events WHERE model = 'claude-4.5-sonnet-thinking'`); math.Abs(got-1.25) > 1e-9 {
		t.Fatalf("second model's cost %v", got)
	}
	if got := h.scalar(t, `SELECT SUM(cost_usd) FROM events`); math.Abs(got-1.55) > 1e-9 {
		t.Fatalf("total %v", got)
	}
	// Cursor rewinding its total is not negative spend.
	comp["usageData"] = map[string]any{"composer-1": map[string]any{"costInCents": 5, "amount": 1}}
	comp["lastUpdatedAt"] = comp["lastUpdatedAt"].(float64) + 60000
	h.put(t, key, comp)
	h.once(t)
	if got := h.scalar(t, `SELECT MIN(cost_usd) FROM events WHERE cost_usd IS NOT NULL`); got < 0 {
		t.Fatalf("negative cost %v", got)
	}
}

// A chat Cursor recorded no cost for keeps its tokens and has no cost: never
// a figure from Caprock's table (rule 6).
func TestAChatWithoutCursorsCostIsUnpriced(t *testing.T) {
	h := newHarness(t)
	rows := h.load(t)
	comp := rows["composerData:"+fixtureChat]
	delete(comp, "usageData")
	h.put(t, "composerData:"+fixtureChat, comp)
	h.once(t)
	if n := h.count(t, `cost_usd IS NOT NULL`); n != 0 {
		t.Fatalf("%d priced events", n)
	}
	if got := h.scalar(t, `SELECT SUM(tokens_in) FROM events`); got != 19330 {
		t.Fatalf("tokens %v", got)
	}
	spend, err := store.CursorSpend(h.ctx, h.st.DB(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if spend == nil || spend.PricedChats != 0 || spend.UnpricedTokens != 19330+299 {
		t.Fatalf("spend %+v", spend)
	}
}

// One model in a chat Cursor priced and in another it did not: the second
// chat's tokens are the ones without a cost, not none because the model has
// a price somewhere.
func TestUnpricedTokensAreCountedPerChat(t *testing.T) {
	h := newHarness(t)
	rows := h.load(t)
	const other = "c0ffee00-0000-4000-8000-000000000002"
	// The copy's message and model-call ids differ too: Cursor's are UUIDs,
	// unique across chats, and one call id seen twice is priced once.
	fresh := strings.NewReplacer(fixtureChat, other, "-8000-000000000000", "-8000-000000000002")
	call := regexp.MustCompile(`-5([0-9a-f]{3})-`)
	for k, v := range rows {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		c := map[string]any{}
		if err := json.Unmarshal([]byte(call.ReplaceAllString(fresh.Replace(string(b)), "-6$1-")), &c); err != nil {
			t.Fatal(err)
		}
		k = fresh.Replace(k)
		if strings.HasPrefix(k, "composerData:") {
			delete(c, "usageData")
		}
		h.put(t, k, c)
	}
	h.once(t)
	spend, err := store.CursorSpend(h.ctx, h.st.DB(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if spend == nil || spend.Chats != 2 || spend.PricedChats != 1 || spend.UnpricedTokens != 19330+299 {
		t.Fatalf("spend %+v", spend)
	}
}

func TestFirstRequestOverheadIsEstimated(t *testing.T) {
	h := newHarness(t)
	h.load(t)
	h.once(t)
	o, err := store.SessionOverheadFor(h.ctx, h.st.DB(), fixtureChat)
	if err != nil || o == nil {
		t.Fatalf("overhead %+v %v", o, err)
	}
	if o.RequestTokens != 19330 || o.Model != "composer-1" {
		t.Fatalf("overhead %+v", o)
	}
	if o.OverheadTokens != o.RequestTokens-o.VisibleTokens || o.VisibleTokens <= o.TypedTokens {
		t.Fatalf("arithmetic %+v", o)
	}
	if !o.Clean {
		t.Fatalf("a first turn this small is a clean sample: %+v", o)
	}
	rep, err := store.ContextOverhead(h.ctx, h.st.DB(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Cursor) != 1 || rep.Cursor[0].Family != "composer-1" || rep.Cursor[0].MedianTokens != o.OverheadTokens {
		t.Fatalf("report %+v", rep.Cursor)
	}
}

func TestEmptyDraftsAreSkippedAndTheSignInTableUntouched(t *testing.T) {
	h := newHarness(t)
	h.put(t, "composerData:draft", map[string]any{"composerId": "draft", "fullConversationHeadersOnly": []any{}})
	h.once(t)
	if n := h.count(t, `1`); n != 0 {
		t.Fatalf("a draft became %d events", n)
	}
	if !h.in.Known("draft") {
		t.Fatal("the draft is not known to the hook plane")
	}
}
