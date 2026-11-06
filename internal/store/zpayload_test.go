package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// toolPayload is a tool result of about the size most stored ones have.
func toolPayload(i int) []byte {
	out := strings.Repeat(fmt.Sprintf("line %d of a build log: ok package github.com/x/y %d\n", i, i*7), 40)
	b, _ := json.Marshal(map[string]any{
		"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_use_id": fmt.Sprintf("toolu_%d", i),
		"cwd": "/w/app", "tool_input": map[string]any{"command": "go test ./..."},
		"tool_response": map[string]any{"stdout": out, "stderr": "", "interrupted": false},
	})
	return b
}

func TestCompressedPayloadRoundTrips(t *testing.T) {
	plain := toolPayload(1)
	z, ok := CompressPayload(plain)
	if !ok {
		t.Fatal("a 3 KB log did not compress")
	}
	if !IsCompressedPayload(z) || len(z) >= len(plain)/2 {
		t.Fatalf("stored form: compressed=%v, %d of %d bytes", IsCompressedPayload(z), len(z), len(plain))
	}
	back, err := DecodePayload(z)
	if err != nil || !bytes.Equal(back, plain) {
		t.Fatalf("round trip: %v, equal=%v", err, bytes.Equal(back, plain))
	}
	if n, ok := PlainSize(z[:zHeaderLen+18]); !ok || n != int64(len(plain)) {
		t.Errorf("PlainSize from the header = %d, %v; want %d", n, ok, len(plain))
	}
	// Plain JSON passes through unchanged, and a row too small to be worth it
	// is not compressed.
	if b, err := DecodePayload(plain); err != nil || !bytes.Equal(b, plain) {
		t.Error("a plain payload did not pass through")
	}
	if _, ok := CompressPayload([]byte(`{"a":1}`)); ok {
		t.Error("a 7-byte payload was compressed")
	}
	// Bytes that only look like the envelope are not taken for it.
	for _, b := range [][]byte{z[:len(z)-1], append([]byte{0xEB}, z[1:]...), {0xEA, 0, 0, 0, 4, 1, 2, 3, 4}} {
		if IsCompressedPayload(b) {
			t.Errorf("%x read as compressed", b[:min(len(b), 9)])
		}
	}
}

// The reason for the envelope: SQLite reads it as a JSON string, so a bare
// read of a compressed row is NULL, never an error that fails the query.
func TestBareSQLReadsOfACompressedRowNeverFail(t *testing.T) {
	st := openCompactTest(t)
	z, _ := CompressPayload(toolPayload(2))
	ctx := context.Background()
	var extract, arrow any
	var valid, each int
	var typ string
	err := st.DB().QueryRowContext(ctx, `
		SELECT json_extract(?1, '$.tool_input.command'), ?1 ->> '$.cwd', json_valid(?1), json_type(?1),
		       (SELECT COUNT(*) FROM json_each(?1, '$.tool_input'))`, z).Scan(&extract, &arrow, &valid, &typ, &each)
	if err != nil {
		t.Fatalf("a bare read failed: %v", err)
	}
	if extract != nil || arrow != nil || valid != 0 || each != 0 {
		t.Errorf("bare read = %v, %v, valid %d, each %d; want NULL, NULL, 0, 0", extract, arrow, valid, each)
	}
	// Through ZPayload it is the JSON again.
	var cmd string
	if err := st.DB().QueryRowContext(ctx, `SELECT json_extract(`+strings.ReplaceAll(ZPayload, "payload", "?1")+`, '$.tool_input.command')`, z).Scan(&cmd); err != nil || cmd != "go test ./..." {
		t.Errorf("through ZPayload: %q, %v", cmd, err)
	}
	// A damaged frame reads as an empty object, and fails nothing.
	bad := bytes.Clone(z)
	bad[len(bad)-3] ^= 0xFF
	var s string
	if err := st.DB().QueryRowContext(ctx, `SELECT zjson(?)`, bad).Scan(&s); err != nil || s != "{}" {
		t.Errorf("damaged frame: %q, %v", s, err)
	}
}

// seedZstd stores a session with every kind of row the readers read: old tool
// calls of several tools, a subagent, prose, and young rows the job must leave.
func seedZstd(t *testing.T, st *Store, old, young time.Time) {
	t.Helper()
	ctx := context.Background()
	n := 0
	add := func(e event.Event) {
		t.Helper()
		n++
		e.SessionID, e.Key = "zs", fmt.Sprintf("%s:%d", e.Key, n)
		if err := st.WithTx(ctx, func(q Querier) error {
			if err := UpsertSession(ctx, q, "zs", SessionPatch{StartedAt: old.UnixMilli(), LastEventAt: young.UnixMilli(), Cwd: "/w/app"}); err != nil {
				return err
			}
			_, err := InsertEvent(ctx, q, &e)
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	js := func(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
	for i, ts := range []time.Time{old, old.Add(time.Minute), young} {
		at := ts.Add(time.Duration(i) * time.Second)
		add(event.Event{Ts: at, Source: event.SourceHook, Kind: event.KindTurnUser, Key: "u", Payload: js(map[string]any{"prompt": "fix the build " + strings.Repeat("please ", 60)})})
		add(event.Event{Ts: at.Add(1), Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Bash", Key: fmt.Sprintf("pre:b%d", i), Payload: js(map[string]any{
			"hook_event_name": "PreToolUse", "tool_use_id": fmt.Sprintf("b%d", i), "permission_mode": "plan", "cwd": "/w/app",
			"tool_input": map[string]any{"command": "gh pr create --fill " + strings.Repeat("--label x ", 40)}})})
		add(event.Event{Ts: at.Add(2), Source: event.SourceHook, Kind: event.KindToolPost, Tool: "Bash", Key: fmt.Sprintf("post:b%d", i), Payload: js(map[string]any{
			"hook_event_name": "PostToolUse", "tool_use_id": fmt.Sprintf("b%d", i), "cwd": "/w/app",
			"tool_input":    map[string]any{"command": "gh pr create --fill"},
			"tool_response": map[string]any{"stdout": strings.Repeat("https://github.com/o/r/pull/7\n", 50), "gitOperation": map[string]any{"pr": map[string]any{"number": 7 + i, "url": fmt.Sprintf("https://github.com/o/r/pull/%d", 7+i), "action": "created"}}}})})
		add(event.Event{Ts: at.Add(3), Source: event.SourceHook, Kind: event.KindToolPre, Tool: "TodoWrite", Key: fmt.Sprintf("pre:t%d", i), Payload: js(map[string]any{
			"tool_use_id": fmt.Sprintf("t%d", i), "tool_input": map[string]any{"todos": []map[string]any{{"content": strings.Repeat("write the tests ", 30), "status": "in_progress", "activeForm": "Writing"}}}})})
		add(event.Event{Ts: at.Add(4), Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Edit", Key: fmt.Sprintf("pre:e%d", i), Payload: js(map[string]any{
			"tool_use_id": fmt.Sprintf("e%d", i), "tool_input": map[string]any{"file_path": "/w/app/main.go", "old_string": strings.Repeat("a\n", 200), "new_string": strings.Repeat("b\n", 210)}})})
		add(event.Event{Ts: at.Add(5), Source: event.SourceHook, Kind: event.KindToolPost, Tool: "Edit", Key: fmt.Sprintf("post:e%d", i), Payload: js(map[string]any{
			"hook_event_name": "PostToolUse", "tool_use_id": fmt.Sprintf("e%d", i), "cwd": "/w/app",
			"tool_input":    map[string]any{"file_path": "/w/app/main.go", "old_string": strings.Repeat("a\n", 200), "new_string": strings.Repeat("b\n", 210)},
			"tool_response": map[string]any{"filePath": "/w/app/main.go", "structuredPatch": strings.Repeat("-a\n+b\n", 100)}})})
		// A subagent's call and its result.
		add(event.Event{Ts: at.Add(6), Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Read", AgentID: "ag1", Key: fmt.Sprintf("pre:r%d", i), Payload: js(map[string]any{
			"tool_use_id": fmt.Sprintf("r%d", i), "agent_type": "Explore", "tool_input": map[string]any{"file_path": "/w/app/" + strings.Repeat("deep/", 40) + "x.go"}})})
		add(event.Event{Ts: at.Add(7), Source: event.SourceHook, Kind: event.KindToolPost, Tool: "Read", AgentID: "ag1", Key: fmt.Sprintf("post:r%d", i), Payload: js(map[string]any{
			"tool_use_id": fmt.Sprintf("r%d", i), "agent_type": "Explore", "is_error": i == 1, "tool_response": map[string]any{"file": map[string]any{"content": strings.Repeat("package x\n", 120)}}})})
		add(event.Event{Ts: at.Add(8), Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: "a", Model: "claude-x", Payload: js(map[string]any{"text": "Done: the build passes. " + strings.Repeat("Details. ", 40)})})
	}
}

// readAll runs every reader of a tool row's payload in the store, and the
// prose ones beside them.
func readAll(t *testing.T, st *Store, old, young time.Time) map[string]any {
	t.Helper()
	ctx := context.Background()
	q := st.DB()
	out := map[string]any{}
	must := func(name string, v any, err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		out[name] = v
	}
	evs, err := ListEvents(ctx, q, "zs", 0, 1000)
	var payloads []string
	for _, e := range evs {
		payloads = append(payloads, string(e.Payload))
	}
	must("ListEvents", payloads, err)
	todos, err := SessionTodos(ctx, q, "zs")
	must("SessionTodos", todos, err)
	trail, _, err := SubagentTrailOf(ctx, q, "zs", "ag1")
	must("SubagentTrailOf", trail, err)
	mode, err := LastPermissionMode(ctx, q, "zs")
	must("LastPermissionMode", mode, err)
	var prs []string
	err = PRToolPosts(ctx, q, func(sid string, ts int64, p []byte) error {
		prs = append(prs, fmt.Sprintf("%s %d %s", sid, ts, p))
		return nil
	})
	must("PRToolPosts", prs, err)
	calls, err := SessionCalls(ctx, q, "zs", 50)
	must("SessionCalls", calls, err)
	files, err := runFiles(ctx, q, "zs", 0, young.Add(time.Hour).UnixMilli())
	must("runFiles", files, err)
	drill, err := ToolDrillStats(ctx, q, DrillOptions{Tool: "Bash", FromMs: 0, ToMs: young.Add(time.Hour).UnixMilli()})
	must("ToolDrillStats", drill, err)
	week, err := WeekStats(ctx, q, WeekOptions{From: old.Add(-time.Hour), To: young.Add(time.Hour), Loc: time.UTC, LoopK: 3, LoopWindow: time.Hour, Home: "/home/u"})
	must("WeekStats", week, err)
	notes, err := SessionNotes(ctx, q, "zs", 50)
	must("SessionNotes", notes, err)
	var fields []string
	rows, err := q.QueryContext(ctx, `SELECT event_id, COALESCE(drill_key,''), COALESCE(drill_by,''), COALESCE(is_error,0), COALESCE(agent_id,'') FROM tool_fields ORDER BY event_id`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id, isErr int64
		var k, by, ag string
		if err := rows.Scan(&id, &k, &by, &isErr, &ag); err != nil {
			t.Fatal(err)
		}
		fields = append(fields, fmt.Sprint(id, k, by, isErr, ag))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	_ = rows.Close()
	out["tool_fields"] = fields
	return out
}

func compressAll(t *testing.T, st *Store, window int, cutoff, now int64) (rows, steps int) {
	t.Helper()
	for {
		s, err := st.CompressPayloadsStep(context.Background(), window, cutoff, now)
		if err != nil {
			t.Fatal(err)
		}
		rows += s.Rows
		steps++
		if s.Done {
			return rows, steps
		}
		if steps > 10000 {
			t.Fatal("never finished")
		}
	}
}

func storedKinds(t *testing.T, st *Store) map[string]int {
	t.Helper()
	rows, err := st.DB().Query(`SELECT kind, ts, typeof(payload) FROM events ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var kind, typ string
		var ts int64
		if err := rows.Scan(&kind, &ts, &typ); err != nil {
			t.Fatal(err)
		}
		out[kind+" "+typ]++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// Every reader gives the same answer whether a tool row is stored compressed
// or plain, with both kinds of row in one session; the job compresses only old
// tool rows, stops at the first young one, and restores every byte.
func TestEveryReaderAgreesOnMixedRows(t *testing.T) {
	st := openCompactTest(t)
	young := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	old := young.AddDate(0, 0, -20)
	seedZstd(t, st, old, young)
	ctx := context.Background()
	if _, err := st.FillToolFields(ctx, 1000, 0); err != nil {
		t.Fatal(err)
	}
	plainPayloads := payloadsByID(t, st)
	before := readAll(t, st, old, young)
	// Each comparison below means something only if the reader found rows.
	for _, name := range []string{"ListEvents", "PRToolPosts", "runFiles", "tool_fields"} {
		if reflect.ValueOf(before[name]).Len() == 0 {
			t.Fatalf("%s read nothing from the fixture", name)
		}
	}
	if len(before["SessionTodos"].(TodoList).Items) == 0 || len(before["SubagentTrailOf"].(SubagentTrail).Calls) == 0 {
		t.Fatalf("the fixture has no todos or no subagent calls: %+v %+v", before["SessionTodos"], before["SubagentTrailOf"])
	}

	cutoff := young.Add(-CompressAge).UnixMilli()
	rows, steps := compressAll(t, st, 7, cutoff, young.UnixMilli())
	if rows == 0 || steps < 3 {
		t.Fatalf("compressed %d rows in %d steps", rows, steps)
	}
	kinds := storedKinds(t, st)
	for k, n := range kinds {
		if strings.HasPrefix(k, "turn.") && strings.HasSuffix(k, "blob") {
			t.Errorf("prose was compressed: %s ×%d", k, n)
		}
	}
	if kinds["tool.post blob"] == 0 || kinds["tool.pre blob"] == 0 {
		t.Fatalf("no tool row compressed: %v", kinds)
	}
	// The young third stays plain: 8 tool rows from the last round.
	var youngBlobs int
	_ = st.DB().QueryRow(`SELECT COUNT(*) FROM events WHERE ts >= ? AND typeof(payload) = 'blob'`, cutoff).Scan(&youngBlobs)
	if youngBlobs != 0 {
		t.Errorf("%d rows younger than a day were compressed", youngBlobs)
	}
	after := readAll(t, st, old, young)
	for name := range before {
		if !reflect.DeepEqual(before[name], after[name]) {
			t.Errorf("%s differs once tool rows are compressed:\nplain      %v\ncompressed %v", name, before[name], after[name])
		}
	}
	// Idempotent: a second pass finds nothing.
	if again, _ := compressAll(t, st, 7, cutoff, young.UnixMilli()); again != 0 {
		t.Errorf("a second pass compressed %d rows", again)
	}
	// A refresh of a compressed call's fields derives the same fields.
	var id int64
	_ = st.DB().QueryRow(`SELECT id FROM events WHERE typeof(payload) = 'blob' AND kind = 'tool.pre' LIMIT 1`).Scan(&id)
	if err := RefreshToolFields(ctx, st.DB(), id); err != nil {
		t.Fatal(err)
	}
	if got := readAll(t, st, old, young)["tool_fields"]; !reflect.DeepEqual(got, before["tool_fields"]) {
		t.Error("tool_fields changed after a refresh from a compressed payload")
	}
	// An in-place repair through ZPayload writes plain JSON with the change,
	// never the stored form wrapped in a string.
	var repairedSaved int64
	_ = st.DB().QueryRow(`SELECT length(zjson(payload)) - length(payload) FROM events WHERE id = ?`, id).Scan(&repairedSaved)
	if _, err := st.DB().ExecContext(ctx, `UPDATE events SET payload = json_set(`+ZPayload+`, '$.tool_input', json(?)) WHERE id = ?`, `{"command":"ls"}`, id); err != nil {
		t.Fatal(err)
	}
	var fixed string
	_ = st.DB().QueryRow(`SELECT payload FROM events WHERE id = ?`, id).Scan(&fixed)
	if !strings.Contains(fixed, `"tool_input":{"command":"ls"}`) || !json.Valid([]byte(fixed)) {
		t.Errorf("repair over a compressed row wrote %.80q", fixed)
	}

	// Off: every row comes back byte for byte (the repaired one as repaired).
	for {
		s, err := st.DecompressPayloadsStep(ctx, 5)
		if err != nil {
			t.Fatal(err)
		}
		if s.Done {
			break
		}
	}
	var blobs int
	_ = st.DB().QueryRow(`SELECT COUNT(*) FROM events WHERE typeof(payload) = 'blob'`).Scan(&blobs)
	if cur, _ := st.PayloadZstdCursor(ctx); blobs != 0 || cur != 0 {
		t.Errorf("after restoring: %d blobs, cursor %d", blobs, cur)
	}
	// The saved total keeps what the repaired row saved: it is an upper
	// bound, which is the side the free-disk check needs.
	if saved, _ := st.PayloadZstdSaved(ctx); saved != repairedSaved {
		t.Errorf("saved after restoring everything = %d, want the repaired row's %d", saved, repairedSaved)
	}
	for rid, p := range payloadsByID(t, st) {
		if rid != id && p != plainPayloads[rid] {
			t.Errorf("event %d restored as %.60q, stored as %.60q", rid, p, plainPayloads[rid])
		}
	}
}

func payloadsByID(t *testing.T, st *Store) map[int64]string {
	t.Helper()
	rows, err := st.DB().Query(`SELECT id, payload FROM events`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[int64]string{}
	for rows.Next() {
		var id int64
		var p string
		if err := rows.Scan(&id, &p); err != nil {
			t.Fatal(err)
		}
		out[id] = p
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// The job can stop anywhere: a step that fails leaves the cursor where it
// was, a stopped daemon resumes from it, and a row rewritten between a step's
// read and its write keeps what it now holds.
func TestCompressionIsResumableAndYieldsToWriters(t *testing.T) {
	st := openCompactTest(t)
	young := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	old := young.AddDate(0, 0, -20)
	seedZstd(t, st, old, young)
	ctx := context.Background()
	cutoff := young.Add(-CompressAge).UnixMilli()

	// A cancelled step changes nothing.
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := st.CompressPayloadsStep(cctx, 5, cutoff, young.UnixMilli()); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled step: %v", err)
	}
	if cur, _ := st.PayloadZstdCursor(ctx); cur != 0 {
		t.Fatalf("cursor moved on a cancelled step: %d", cur)
	}
	// One step, then a reopen of the same file, then the rest.
	first, err := st.CompressPayloadsStep(ctx, 5, cutoff, young.UnixMilli())
	if err != nil || first.Cursor == 0 || first.Done {
		t.Fatalf("first step: %+v, %v", first, err)
	}
	path := filepath.Join(t.TempDir(), "z.db")
	if _, err := st.DB().ExecContext(ctx, `VACUUM INTO ?`, path); err != nil {
		t.Fatal(err)
	}
	st2, err := Open(ctx, path, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer st2.Close()
	if cur, _ := st2.PayloadZstdCursor(ctx); cur != first.Cursor {
		t.Fatalf("reopened at %d, want %d", cur, first.Cursor)
	}
	rest, _ := compressAll(t, st2, 5, cutoff, young.UnixMilli())
	all, _ := compressAll(t, st, 1000, cutoff, young.UnixMilli())
	// The copy resumed where the first step stopped; the original went on
	// in one pass. Both did the same rest.
	if rest != all || rest == 0 {
		t.Errorf("after the first step (%d rows): resumed copy compressed %d, the original %d", first.Rows, rest, all)
	}

	// A row that changed after it was read is not overwritten.
	var id int64
	var p string
	_ = st2.DB().QueryRow(`SELECT id, payload FROM events WHERE kind = 'tool.pre' AND typeof(payload) = 'text' AND ts < ? ORDER BY id DESC LIMIT 1`, cutoff).Scan(&id, &p)
	if id != 0 {
		z, _ := CompressPayload([]byte(p))
		var st3 ZstdStep
		if _, err := st2.DB().ExecContext(ctx, `UPDATE events SET payload = json_set(payload, '$.x', 1) WHERE id = ?`, id); err != nil {
			t.Fatal(err)
		}
		if err := st2.applyZstd(ctx, []zChange{{id: id, old: p, new: z, saved: 1}}, 0, &st3); err != nil || st3.Rows != 0 {
			t.Errorf("a stale change was applied: %+v, %v", st3, err)
		}
	}
}

// Rows that are not tool calls, rows a day old or less, and rows too small to
// gain are never compressed; a row stamped far in the future does not hold
// the cursor back forever.
func TestCompressionLeavesWhatItShould(t *testing.T) {
	st := openCompactTest(t)
	now := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	ctx := context.Background()
	add := func(kind event.Kind, ts time.Time, payload string) {
		if err := st.WithTx(ctx, func(q Querier) error {
			if err := UpsertSession(ctx, q, "w", SessionPatch{StartedAt: 1, LastEventAt: 1}); err != nil {
				return err
			}
			_, err := InsertEvent(ctx, q, &event.Event{Ts: ts, SessionID: "w", Source: event.SourceHook, Kind: kind, Tool: "Bash",
				Key: fmt.Sprintf("k%d", ts.UnixNano()), Payload: json.RawMessage(payload)})
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	big := string(toolPayload(3))
	add(event.KindToolPost, now.AddDate(1, 0, 0), big) // a skewed clock
	add(event.KindToolPost, now.Add(-48*time.Hour), `{"a":1}`)
	add(event.KindAgentStop, now.Add(-47*time.Hour), `{"last_assistant_message":"`+strings.Repeat("x", 4000)+`"}`)
	add(event.KindToolPost, now.Add(-46*time.Hour), big)
	compressAll(t, st, 100, now.Add(-CompressAge).UnixMilli(), now.UnixMilli())
	k := storedKinds(t, st)
	if k["tool.post blob"] != 2 || k["tool.post text"] != 1 || k["agent.stop text"] != 1 {
		t.Errorf("stored kinds %v: want the two large tool results compressed, the small one and agent.stop plain", k)
	}
}

// The storage measurement counts what is compressed from the frame headers
// and estimates the rest from a sample of the database's own rows.
func TestStorageCountsCompression(t *testing.T) {
	st := openCompactTest(t)
	young := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	seedZstd(t, st, young.AddDate(0, 0, -20), young)
	ctx := context.Background()
	m, err := MeasureStorage(ctx, st.DB(), young)
	if err != nil {
		t.Fatal(err)
	}
	z := m.Compression
	if z.Rows != 0 || z.EligibleRows == 0 || z.SampleRows == 0 || z.EstSavingBytes <= 0 || z.EstSavingBytes >= z.EligibleBytes {
		t.Fatalf("before: %+v", z)
	}
	compressAll(t, st, 100, young.Add(-CompressAge).UnixMilli(), young.UnixMilli())
	m, err = MeasureStorage(ctx, st.DB(), young)
	if err != nil {
		t.Fatal(err)
	}
	z = m.Compression
	var plain int64
	_ = st.DB().QueryRow(`SELECT COALESCE(SUM(length(zjson(payload))), 0) FROM events WHERE typeof(payload) = 'blob'`).Scan(&plain)
	if z.Rows == 0 || z.PlainBytes != plain || z.StoredBytes >= z.PlainBytes {
		t.Errorf("after: %+v; plain bytes by decompressing %d", z, plain)
	}
}

// Migration 0080 on a database an earlier release left at 79, with rows in
// it: it applies, sets the cursor to nothing compressed, and changes no
// payload. The release before it then refuses the file, untouched.
func TestMigration0080IsTheFence(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "caprock.db")
	st, err := Open(ctx, path, nil)
	if err != nil {
		t.Fatal(err)
	}
	young := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	seedZstd(t, st, young.AddDate(0, 0, -20), young)
	before := payloadsByID(t, st)
	if _, err := st.DB().Exec(`DELETE FROM meta WHERE k IN (?, ?)`, MetaPayloadZstdCursor, MetaPayloadZstdSaved); err != nil {
		t.Fatal(err)
	}
	_ = st.Close()
	setRawSchema(t, path, 79, "")

	st, err = Open(ctx, path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if v, _ := st.SchemaVersion(ctx); v < 80 {
		t.Fatalf("schema %d after the upgrade", v)
	}
	if c, err := st.GetMeta(ctx, MetaPayloadZstdCursor); err != nil || c != "0" {
		t.Errorf("cursor %q, %v", c, err)
	}
	if !reflect.DeepEqual(payloadsByID(t, st), before) {
		t.Error("the migration changed a payload")
	}
	_ = st.Close()
	var newer *SchemaTooNewError
	if err := schemaNewer(path, "80", 79); !errors.As(err, &newer) {
		t.Errorf("a Caprock that knows up to 79 would open it: %v", err)
	}
}
