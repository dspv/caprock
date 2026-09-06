package codex

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// harness wires a directory of transcripts to a throwaway Caprock store.
type harness struct {
	t   *testing.T
	dir string
	in  *Ingester
	out *sql.DB
}

func newHarness(t *testing.T) *harness {
	t.Helper()
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
	dir := t.TempDir()
	return &harness{t: t, dir: dir, in: NewIngester(dir, rec, lg, time.Second), out: st.DB()}
}

// put copies the fixture transcript into the harness directory.
func (h *harness) put() {
	h.t.Helper()
	b, err := os.ReadFile(fixture)
	if err != nil {
		h.t.Fatal(err)
	}
	sub := filepath.Join(h.dir, "2026", "09", "06")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		h.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "rollout-a.jsonl"), b, 0o600); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) poll() {
	h.t.Helper()
	if err := h.in.once(context.Background()); err != nil {
		h.t.Fatalf("ingest: %v", err)
	}
}

func count(t *testing.T, db *sql.DB, q string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(q).Scan(&n); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
	return n
}

func TestIngestStoresSessionTurnsAndTools(t *testing.T) {
	h := newHarness(t)
	h.put()
	h.poll()

	if n := count(t, h.out, `SELECT COUNT(*) FROM sessions WHERE agent='codex'`); n != 1 {
		t.Errorf("%d sessions tagged codex, want 1", n)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='codex' AND kind='turn.assistant'`); n != 2 {
		t.Errorf("%d turns, want 2", n)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='codex' AND kind='tool.pre'`); n != 2 {
		t.Errorf("%d tool calls, want 2", n)
	}
	// The session carries the transcript's identity, not a guess.
	var cwd, model, agent string
	if err := h.out.QueryRow(`SELECT COALESCE(cwd,''), COALESCE(model,''), COALESCE(agent,'') FROM sessions LIMIT 1`).
		Scan(&cwd, &model, &agent); err != nil {
		t.Fatal(err)
	}
	if cwd != "/Users/dev/proj" || model != "gpt-5-codex" || agent != "codex" {
		t.Errorf("session row: cwd=%q model=%q agent=%q", cwd, model, agent)
	}
}

// Codex reports tokens but no cost of its own, so the pricing table has to do
// the arithmetic. This is the whole reason pricing.json grew OpenAI rows.
func TestCostIsComputedFromTheTable(t *testing.T) {
	h := newHarness(t)
	h.put()
	h.poll()

	var total sql.NullFloat64
	if err := h.out.QueryRow(`SELECT SUM(cost_usd) FROM events WHERE source='codex'`).Scan(&total); err != nil {
		t.Fatal(err)
	}
	if !total.Valid || total.Float64 <= 0 {
		t.Fatalf("codex turns were not priced: %+v", total)
	}
	// gpt-5-codex: $1.25/1M input, $0.125/1M cached, $10/1M output. The fixture
	// bills 2500 input of which 2000 cached, and 250 output.
	want := (2500-2000)/1e6*1.25 + 2000/1e6*0.125 + 250/1e6*10.0
	if diff := total.Float64 - want; diff > 1e-9 || diff < -1e-9 {
		t.Errorf("cost %.9f, want %.9f", total.Float64, want)
	}
}

// Re-reading a transcript must not duplicate anything: the keys come from the
// record ordinal, and the file is append-only.
func TestReimportIsIdempotent(t *testing.T) {
	h := newHarness(t)
	h.put()
	h.poll()
	before := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='codex'`)

	// Force a re-read by clearing what the ingester remembers, as a changed
	// mtime would.
	h.in.mu.Lock()
	h.in.seen = map[string]fileState{}
	h.in.mu.Unlock()
	h.poll()

	after := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='codex'`)
	if before != after {
		t.Fatalf("re-import duplicated events: %d -> %d", before, after)
	}
}

// An unchanged file is not parsed again. Without this every tick re-reads every
// transcript on the machine for no new information.
func TestUnchangedFilesAreSkipped(t *testing.T) {
	h := newHarness(t)
	h.put()
	h.poll()
	h.poll()
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='codex'`); n != 4 {
		t.Errorf("second poll changed the event count: %d", n)
	}
}

// A directory holding something that is not a transcript must not stop the
// import of the ones that are.
func TestJunkFileDoesNotStopTheImport(t *testing.T) {
	h := newHarness(t)
	h.put()
	sub := filepath.Join(h.dir, "2026", "09", "06")
	if err := os.WriteFile(filepath.Join(sub, "rollout-junk.jsonl"), []byte("not json\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	h.poll()
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='codex'`); n != 4 {
		t.Errorf("junk file cost us the good one: %d events", n)
	}
}

// A missing Codex directory is the normal case on almost every machine.
func TestMissingDirectoryIsQuiet(t *testing.T) {
	h := newHarness(t)
	h.in.dir = filepath.Join(h.dir, "does-not-exist")
	h.poll()
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='codex'`); n != 0 {
		t.Errorf("events from nowhere: %d", n)
	}
}

// Codex sessions are read out of files, with no process to ask about, so the
// clock is the only rule they can have: the sweep retires them by age rather
// than by asking whether a pid is alive. Without that, importing a hundred
// transcripts of somebody's history would fill the Now screen with sessions
// that claim to be running and never stop — which is exactly what happened the
// first time this was tried for OpenCode.
func TestImportedSessionsAreRetiredByTheClock(t *testing.T) {
	h := newHarness(t)
	h.put()
	h.poll()

	// Nothing in the transcript is younger than the cutoff, so one sweep must
	// end every session it imported. A pid check could never do this: there is
	// no pid.
	ended, err := store.MarkEndedSessions(context.Background(), h.out, time.Now().Add(-time.Hour).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if len(ended) == 0 {
		t.Fatal("the sweep retired nothing; an imported transcript would stay live forever")
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM sessions WHERE agent='codex' AND status != 'ended'`); n != 0 {
		t.Errorf("%d imported codex sessions survived the sweep", n)
	}
}

// A turn whose transcript names no model anywhere is stored with its real
// tokens and no cost. Rule 6: a missing number beats an invented one.
//
// This used to be the common case, because only `turn_context` was read and
// that is present in 4 of 100 real transcripts. It is now rare — the model is
// also recorded in `base_instructions.provenance`, which covers the other 96 —
// so this test has to strip *both* sources to reach the unpriced path at all.
func TestTurnWithNoModelIsStoredUnpriced(t *testing.T) {
	h := newHarness(t)
	b, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	// Drop the turn_context record, which is the only place the model appears.
	// Matched by decoding rather than by substring: JSON spacing is not part of
	// the format, and a string match on `"type":"turn_context"` silently
	// matched nothing when the fixture was written with spaces after the colon.
	var kept []byte
	for _, line := range splitLines(string(b)) {
		if len(line) == 0 {
			continue
		}
		var rec struct {
			Type    string          `json:"type"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := json.Unmarshal([]byte(line), &rec); err == nil {
			if rec.Type == "turn_context" {
				continue
			}
			// Strip the provenance too, leaving a transcript that genuinely
			// names no model — otherwise this test silently stops testing the
			// unpriced path the moment a second source is read.
			if rec.Type == "session_meta" {
				var pl map[string]any
				if json.Unmarshal(rec.Payload, &pl) == nil {
					delete(pl, "base_instructions")
					body, _ := json.Marshal(map[string]any{"type": "session_meta", "payload": pl})
					kept = append(kept, body...)
					kept = append(kept, '\n')
					continue
				}
			}
		}
		kept = append(kept, line...)
		kept = append(kept, '\n')
	}
	sub := filepath.Join(h.dir, "2026", "09", "06")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "rollout-nomodel.jsonl"), kept, 0o600); err != nil {
		t.Fatal(err)
	}
	h.poll()

	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='codex' AND kind='turn.assistant'`); n != 2 {
		t.Fatalf("turns should still be stored without a model: %d", n)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='codex' AND COALESCE(cost_usd,0) != 0`); n != 0 {
		t.Errorf("%d unpriced turns were given a cost anyway", n)
	}
	// Tokens are real and must survive: the session is still worth counting.
	// tokens_in is the *fresh* input Caprock bills separately: 2500 reported
	// by Codex, of which 2000 were cached.
	if n := count(t, h.out, `SELECT COALESCE(SUM(tokens_in),0) FROM events WHERE source='codex'`); n != 500 {
		t.Errorf("fresh tokens lost with the model: %d", n)
	}
	if n := count(t, h.out, `SELECT COALESCE(SUM(cache_read),0) FROM events WHERE source='codex'`); n != 2000 {
		t.Errorf("cached tokens lost with the model: %d", n)
	}
	if st := h.in.Stats(); st.Unpriced == 0 {
		t.Error("unpriced turns are not reported, so nobody can tell the total is partial")
	}
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}

// toolInput normalises both spellings Codex uses. Downstream code reads
// tool_input as an object, so a bare string has to become one.
func TestToolInput(t *testing.T) {
	obj := toolInput(ToolCall{Input: `{"cmd":"ls"}`})
	m, ok := obj.(map[string]any)
	if !ok || m["cmd"] != "ls" {
		t.Errorf("object input: %#v", obj)
	}
	str := toolInput(ToolCall{Input: `"echo hi"`})
	m, ok = str.(map[string]any)
	if !ok || m["command"] != "echo hi" {
		t.Errorf("string input should become {command}: %#v", str)
	}
	empty := toolInput(ToolCall{})
	if m, ok := empty.(map[string]any); !ok || len(m) != 0 {
		t.Errorf("empty input: %#v", empty)
	}
}
