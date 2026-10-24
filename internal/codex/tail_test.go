package codex

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
)

// The incremental read is only allowed to be faster. Every test here holds it
// to the reference: Parse over the whole file for the parser, and for the
// store an importer with tails turned off (Ingester.replay), which parses
// every changed file whole and offers every record again — what Caprock did
// before tails. The files grow in random chunks that cut lines anywhere.

// tailFixtures is every Codex fixture in testdata, plus synthetic transcripts
// for shapes the fixtures do not carry.
func tailFixtures(t *testing.T) map[string][]byte {
	t.Helper()
	out := map[string][]byte{}
	paths, err := filepath.Glob("../../testdata/codex/*.jsonl")
	if err != nil || len(paths) == 0 {
		t.Fatalf("fixtures: %v %v", paths, err)
	}
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		out[filepath.Base(p)] = b
	}
	out["growth.jsonl"] = growthTranscript(48)
	out["late-model.jsonl"] = lateModelTranscript()
	out["late-output.jsonl"] = lateOutputTranscript()
	out["crlf-and-junk.jsonl"] = crlfAndJunkTranscript()
	// No newline after the last record: Parse reads it all the same.
	out["no-final-newline.jsonl"] = bytes.TrimRight(growthTranscript(20), "\n")
	return out
}

// lateModelTranscript names no model until a turn_context after some turns
// were already billed, so the rows stored before it are repriced.
func lateModelTranscript() []byte {
	meta := strings.Replace(growthMeta, `,"base_instructions":{"provenance":{"type":"model","model":"gpt-5-codex"}}`, "", 1)
	var b bytes.Buffer
	b.WriteString(meta + "\n")
	for i := 0; i < 24; i++ {
		b.Write(growthRecord(i))
	}
	b.WriteString(`{"timestamp":"2026-10-18T10:00:01.000Z","type":"turn_context","payload":{"model":"gpt-5-codex","cwd":"/Users/dev/proj"}}` + "\n")
	for i := 24; i < 48; i++ {
		b.Write(growthRecord(i))
	}
	return b.Bytes()
}

// lateOutputTranscript has a call its request ended without answering, whose
// output then arrives after all, and a call that is never answered.
func lateOutputTranscript() []byte {
	lines := []string{
		growthMeta,
		`{"timestamp":"2026-10-18T10:00:01.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}`,
		`{"timestamp":"2026-10-18T10:00:02.000Z","type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"c1","arguments":"{\"command\":[\"bash\",\"-lc\",\"make\"]}"}}`,
		`{"timestamp":"2026-10-18T10:00:03.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10,"total_tokens":110}}}}`,
		`{"timestamp":"2026-10-18T10:00:04.000Z","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"t1"}}`,
		`{"timestamp":"2026-10-18T10:00:05.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"done late"}}`,
		`{"timestamp":"2026-10-18T10:00:06.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t2"}}`,
		`{"timestamp":"2026-10-18T10:00:07.000Z","type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"c2","input":"ls"}}`,
		`{"timestamp":"2026-10-18T10:00:08.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"late prose"}]}}`,
		`{"timestamp":"2026-10-18T10:00:09.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":100,"output_tokens":30,"total_tokens":330}}}}`,
		`{"timestamp":"2026-10-18T10:00:09.500Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"more late prose"}]}}`,
		`{"timestamp":"2026-10-18T10:00:10.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t2"}}`,
	}
	return []byte(strings.Join(lines, "\n") + "\n")
}

// crlfAndJunkTranscript mixes CRLF line ends, blank lines and lines that are
// not JSON among real records.
func crlfAndJunkTranscript() []byte {
	var b bytes.Buffer
	b.WriteString(growthMeta + "\r\n\n")
	for i := 0; i < 16; i++ {
		rec := bytes.TrimSuffix(growthRecord(i), []byte("\n"))
		switch i % 4 {
		case 0:
			b.Write(rec)
			b.WriteString("\r\n")
		case 1:
			b.WriteString("not json at all\n")
			b.Write(rec)
			b.WriteString("\n")
		case 2:
			b.Write(rec)
			b.WriteString("\n\n")
		default:
			b.WriteString(`{"timestamp":"2026-10-18T10:00:00Z","type":"event_msg","payload":` + "\n")
			b.Write(rec)
			b.WriteString("\n")
		}
	}
	return b.Bytes()
}

// chunks cuts data into random pieces, most of them smaller than a line.
func chunks(data []byte, rng *rand.Rand) [][]byte {
	var out [][]byte
	for len(data) > 0 {
		var n int
		switch rng.Intn(4) {
		case 0:
			n = 1 + rng.Intn(8)
		case 1, 2:
			n = 1 + rng.Intn(600)
		default:
			n = 1 + rng.Intn(4000)
		}
		n = min(n, len(data))
		out = append(out, data[:n])
		data = data[n:]
	}
	return out
}

// fullView is everything a tail has read, as Parse would return it.
func fullView(tl *tail) (*Session, error) {
	s := tl.p.header()
	if s.ID == "" {
		return nil, ErrNotASession
	}
	tl.p.fill(s, marks{})
	return s, nil
}

// After every chunk, the parser a tail keeps holds exactly what Parse finds in
// the bytes written so far.
func TestTailParserMatchesParseAtEveryPrefix(t *testing.T) {
	t.Parallel()
	for name, data := range tailFixtures(t) {
		for seed := int64(1); seed <= 8; seed++ {
			t.Run(fmt.Sprintf("%s/seed=%d", name, seed), func(t *testing.T) {
				t.Parallel()
				path := filepath.Join(t.TempDir(), name)
				if err := os.WriteFile(path, nil, 0o600); err != nil {
					t.Fatal(err)
				}
				tl := newTail(path)
				var written []byte
				for i, c := range chunks(data, rand.New(rand.NewSource(seed))) {
					appendFile(t, path, c)
					written = append(written, c...)
					if _, err := tl.advance(); err != nil {
						t.Fatal(err)
					}
					want, wantErr := Parse(bytes.NewReader(written), path)
					got, gotErr := fullView(tl)
					if !errors.Is(gotErr, wantErr) || !reflect.DeepEqual(got, want) {
						t.Fatalf("after chunk %d (%d bytes): tail differs from Parse\n got %+v %v\nwant %+v %v", i, len(written), got, gotErr, want, wantErr)
					}
				}
			})
		}
	}
}

// What a tail hands over import by import adds up to one full parse: every
// item of the final Parse is handed over, and handed over last with its final
// content. Nothing is handed over that the full parse does not hold, except
// an interrupted mark a late output later replaced — which a full re-read
// stores too, whenever a poll falls between the two.
func TestTailHandsOverEveryItemOnce(t *testing.T) {
	t.Parallel()
	for name, data := range tailFixtures(t) {
		for seed := int64(1); seed <= 4; seed++ {
			t.Run(fmt.Sprintf("%s/seed=%d", name, seed), func(t *testing.T) {
				t.Parallel()
				path := filepath.Join(t.TempDir(), name)
				if err := os.WriteFile(path, nil, 0o600); err != nil {
					t.Fatal(err)
				}
				tl := newTail(path)
				last := map[string]any{}
				for _, c := range chunks(data, rand.New(rand.NewSource(seed))) {
					appendFile(t, path, c)
					if _, err := tl.advance(); err != nil {
						t.Fatal(err)
					}
					s := tl.p.header()
					if s.ID == "" {
						continue
					}
					if !tl.fresh && identityOf(s) != tl.stored {
						tl.reset()
						last = map[string]any{}
						if _, err := tl.advance(); err != nil {
							t.Fatal(err)
						}
						s = tl.p.header()
					}
					tl.pending(s)
					for _, x := range s.Prompts {
						last[x.Key] = x
					}
					for _, x := range s.Turns {
						last[x.Key] = x
					}
					for _, x := range s.Tools {
						last[x.Key] = x
					}
					for _, x := range s.Results {
						last[x.Key] = x
					}
					tl.commit(s)
				}
				want, err := Parse(bytes.NewReader(data), path)
				if err != nil {
					t.Fatal(err)
				}
				all := map[string]any{}
				for _, x := range want.Prompts {
					all[x.Key] = x
				}
				for _, x := range want.Turns {
					all[x.Key] = x
				}
				for _, x := range want.Tools {
					all[x.Key] = x
				}
				for _, x := range want.Results {
					all[x.Key] = x
				}
				for k, w := range all {
					if !reflect.DeepEqual(last[k], w) {
						t.Errorf("%s: handed over %+v, want %+v", k, last[k], w)
					}
				}
				for k, x := range last {
					if _, ok := all[k]; !ok && !strings.Contains(k, "interrupted") {
						t.Errorf("%s handed over but not in the full parse: %+v", k, x)
					}
				}
			})
		}
	}
}

// A line longer than maxLine stops a tail where it stops Parse, and nothing
// after it is read on later polls either.
func TestTailStopsAtAnOversizedLineAsParseDoes(t *testing.T) {
	t.Parallel()
	head := growthTranscript(10)
	huge := append([]byte(`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"`), bytes.Repeat([]byte("y"), maxLine)...)
	huge = append(huge, []byte(`"}]}}`+"\n")...)
	data := append(append(append([]byte{}, head...), huge...), growthRecord(10)...)
	path := filepath.Join(t.TempDir(), "big.jsonl")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	tl := newTail(path)
	var written []byte
	for _, n := range []int{len(head) - 7, 7, 3 << 20, 6 << 20, len(data)} {
		n = min(n, len(data)-len(written))
		appendFile(t, path, data[len(written):len(written)+n])
		written = data[:len(written)+n]
		if _, err := tl.advance(); err != nil {
			t.Fatal(err)
		}
		want, err := Parse(bytes.NewReader(written), path)
		if err != nil {
			t.Fatal(err)
		}
		got, _ := fullView(tl)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("after %d bytes: tail differs from Parse", len(written))
		}
	}
	if !tl.stopped || tl.off != int64(len(head)) {
		t.Errorf("stopped=%v off=%d, want stopped at %d", tl.stopped, tl.off, len(head))
	}
}

// twin is two importers over two stores fed the same files: inc reads
// incrementally, ref re-reads every changed file in full, as before tails.
type twin struct {
	t        *testing.T
	inc, ref *harness
}

func newTwin(t *testing.T) *twin {
	w := &twin{t: t, inc: newHarness(t), ref: newHarness(t)}
	w.ref.in.replay = true
	return w
}

func (w *twin) path(h *harness, name string) string {
	return filepath.Join(h.dir, "2026", "10", "18", name)
}

// appendTo appends b to the file name in both trees.
func (w *twin) appendTo(name string, b []byte) {
	for _, h := range []*harness{w.inc, w.ref} {
		p := w.path(h, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			w.t.Fatal(err)
		}
		appendFile(w.t, p, b)
	}
}

// rewrite replaces the file name in both trees in place, with a new mtime.
func (w *twin) rewrite(name string, b []byte, at time.Time) {
	for _, h := range []*harness{w.inc, w.ref} {
		p := w.path(h, name)
		f, err := os.OpenFile(p, os.O_WRONLY|os.O_TRUNC, 0)
		if err != nil {
			w.t.Fatal(err)
		}
		if _, err := f.Write(b); err != nil {
			w.t.Fatal(err)
		}
		_ = f.Close()
		if err := os.Chtimes(p, at, at); err != nil {
			w.t.Fatal(err)
		}
	}
}

// poll runs one pass of each importer and requires the two stores to agree.
func (w *twin) poll(step string) {
	w.t.Helper()
	w.inc.poll()
	w.ref.poll()
	w.same(step)
}

func (w *twin) same(step string) {
	w.t.Helper()
	got, want := dumpStore(w.t, w.inc.out), dumpStore(w.t, w.ref.out)
	if got != want {
		w.t.Fatalf("%s: incremental import differs from a full re-read\n%s", step, firstDiff(got, want))
	}
	if a, b := w.inc.in.Stats().Events, w.ref.in.Stats().Events; a != b {
		w.t.Fatalf("%s: %d events counted, full re-read counted %d", step, a, b)
	}
}

// dumpStore is every row of every table but meta (which holds file paths and
// times), in rowid order.
func dumpStore(t *testing.T, db *sql.DB) string {
	t.Helper()
	names, ok := dumpRows(t, db, `SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('meta') ORDER BY name`)
	if !ok {
		t.Fatal("list tables")
	}
	var b strings.Builder
	for _, n := range names {
		tb := strings.TrimSuffix(strings.TrimPrefix(n, "name="), " ")
		lines, ok := dumpRows(t, db, `SELECT * FROM "`+tb+`" ORDER BY rowid`)
		if !ok {
			// A WITHOUT ROWID table or a virtual one: ordered by content.
			if lines, ok = dumpRows(t, db, `SELECT * FROM "`+tb+`"`); !ok {
				continue
			}
			sort.Strings(lines)
		}
		fmt.Fprintf(&b, "## %s\n%s\n", tb, strings.Join(lines, "\n"))
	}
	return b.String()
}

// dumpRows is every row q returns, one line each; false when q cannot run.
func dumpRows(t *testing.T, db *sql.DB, q string) ([]string, bool) {
	t.Helper()
	r, err := db.Query(q)
	if err != nil {
		return nil, false
	}
	defer r.Close()
	cols, _ := r.Columns()
	var lines []string
	for r.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := r.Scan(ptrs...); err != nil {
			t.Fatal(err)
		}
		var line strings.Builder
		for i, v := range vals {
			if bs, ok := v.([]byte); ok {
				v = string(bs)
			}
			fmt.Fprintf(&line, "%s=%v ", cols[i], v)
		}
		lines = append(lines, line.String())
	}
	if err := r.Err(); err != nil {
		t.Fatal(err)
	}
	return lines, true
}

func firstDiff(got, want string) string {
	g, w := strings.Split(got, "\n"), strings.Split(want, "\n")
	for i := 0; i < max(len(g), len(w)); i++ {
		var a, b string
		if i < len(g) {
			a = g[i]
		}
		if i < len(w) {
			b = w[i]
		}
		if a != b {
			return fmt.Sprintf("line %d\n inc: %s\n ref: %s", i, a, b)
		}
	}
	return "(no line differs)"
}

func appendFile(t *testing.T, path string, b []byte) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.Write(b); err != nil {
		t.Fatal(err)
	}
}

// Every fixture, grown in random chunks and polled after each: the store an
// incremental import builds is the store a full re-read builds, row for row,
// after every poll — and at the end it is what one full import of the
// finished file builds.
func TestIncrementalImportMatchesFullReread(t *testing.T) {
	t.Parallel()
	for name, data := range tailFixtures(t) {
		for seed := int64(1); seed <= 2; seed++ {
			t.Run(fmt.Sprintf("%s/seed=%d", name, seed), func(t *testing.T) {
				t.Parallel()
				w := newTwin(t)
				for i, c := range chunks(data, rand.New(rand.NewSource(seed))) {
					w.appendTo(name, c)
					w.poll(fmt.Sprintf("chunk %d", i))
				}
				if w.inc.in.tails[w.path(w.inc, name)] == nil {
					t.Errorf("no tail kept for a file just written")
				}
				// One full import of the finished file, into a third store.
				// It can differ from a growing file's only where polling a
				// growing file always did, full re-read included (checked
				// above): an interrupted mark stored before its late output
				// arrived, and rows stored before the model was named, which
				// carry none (only turns are repriced).
				one := newHarness(t)
				p := filepath.Join(one.dir, "2026", "10", "18", name)
				if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(p, data, 0o600); err != nil {
					t.Fatal(err)
				}
				one.poll()
				if name != "late-output.jsonl" && name != "late-model.jsonl" {
					if got, want := dumpEvents(t, w.inc.out), dumpEvents(t, one.out); got != want {
						t.Errorf("finished file: incremental differs from one full import\n%s", firstDiff(got, want))
					}
				}
			})
		}
	}
}

// dumpEvents is the stored events by session and key, without row ids — what
// one import of a finished file and many of a growing one must agree on.
func dumpEvents(t *testing.T, db *sql.DB) string {
	t.Helper()
	rows, err := db.Query(`SELECT s.session_id, key, kind, ts, COALESCE(e.model,''), tokens_in, tokens_out, cache_read, cache_write,
		COALESCE(cost_usd,-1), COALESCE(msg_id,''), COALESCE(agent_id,''), payload
		FROM events e JOIN sessions s USING (sid) ORDER BY s.session_id, key`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var sid, key, kind, model, msg, agent, payload string
		var ts int64
		var tin, tout, cr, cw sql.NullInt64
		var usd float64
		if err := rows.Scan(&sid, &key, &kind, &ts, &model, &tin, &tout, &cr, &cw, &usd, &msg, &agent, &payload); err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(&b, "%s %s %s %d %s %v %v %v %v %.9f %s %s %s\n", sid, key, kind, ts, model, tin, tout, cr, cw, usd, msg, agent, payload)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return b.String()
}

// A subagent and its parent grow side by side: the subagent's rows go to the
// parent's session under its own keys, interleaved polls and all.
func TestIncrementalImportOfParentAndSubagent(t *testing.T) {
	t.Parallel()
	parent, err := os.ReadFile(parentFixture)
	if err != nil {
		t.Fatal(err)
	}
	child, err := os.ReadFile(childFixture)
	if err != nil {
		t.Fatal(err)
	}
	for seed := int64(1); seed <= 4; seed++ {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			t.Parallel()
			w := newTwin(t)
			rng := rand.New(rand.NewSource(seed))
			pc, cc := chunks(parent, rng), chunks(child, rng)
			for i := 0; len(pc) > 0 || len(cc) > 0; i++ {
				if len(pc) > 0 && (len(cc) == 0 || rng.Intn(2) == 0) {
					w.appendTo(filepath.Base(parentFixture), pc[0])
					pc = pc[1:]
				} else {
					w.appendTo(filepath.Base(childFixture), cc[0])
					cc = cc[1:]
				}
				w.poll(fmt.Sprintf("step %d", i))
			}
		})
	}
}

// A restart forgets every tail: the next change replays the file once, and
// the import goes on incrementally from there.
func TestIncrementalImportAcrossARestart(t *testing.T) {
	t.Parallel()
	data := growthTranscript(40)
	w := newTwin(t)
	cs := chunks(data, rand.New(rand.NewSource(7)))
	for i, c := range cs {
		if i == len(cs)/3 || i == 2*len(cs)/3 {
			for _, h := range []*harness{w.inc, w.ref} {
				in := NewIngester(h.in.dirs, h.in.rec, h.in.log, time.Second)
				in.replay = h.in.replay
				h.in = in
			}
		}
		w.appendTo("growth.jsonl", c)
		w.poll(fmt.Sprintf("chunk %d", i))
	}
}

// A store write that fails mid-pass commits nothing: the next pass offers
// again everything the failed one did not finish.
func TestIncrementalImportAfterAFailedWrite(t *testing.T) {
	t.Parallel()
	data := growthTranscript(32)
	for _, failAt := range []int{1, 3, 8} {
		t.Run(fmt.Sprintf("fail-at=%d", failAt), func(t *testing.T) {
			t.Parallel()
			w := newTwin(t)
			calls := 0
			var cancel context.CancelFunc
			w.inc.in.rec.OnWrite = func() {
				calls++
				if calls%failAt == 0 && cancel != nil {
					cancel()
				}
			}
			failures := 0
			for i, c := range chunks(data, rand.New(rand.NewSource(int64(failAt)))) {
				w.appendTo("growth.jsonl", c)
				ctx, stop := context.WithCancel(context.Background())
				cancel = stop
				failed := w.inc.in.once(ctx) != nil
				cancel = nil
				stop()
				if failed {
					failures++
				}
				// The retry, with nothing new on disk.
				w.inc.poll()
				w.ref.poll()
				w.same(fmt.Sprintf("chunk %d (failed=%v)", i, failed))
			}
			if failures == 0 {
				t.Fatal("no pass failed: the test injected nothing")
			}
		})
	}
}

// A file rewritten rather than appended to — truncated, replaced by another
// file, or changed in place — is read again from the start.
func TestIncrementalImportAfterARewrite(t *testing.T) {
	t.Parallel()
	// 31 records end on a request's late prose, still waiting for the
	// task_complete (record 31) that joins it to the request's last turn.
	data := growthTranscript(31)
	at := time.Now().Add(time.Hour)
	cases := map[string]func(w *twin){
		"truncated": func(w *twin) { w.rewrite("growth.jsonl", data[:len(data)/3], at) },
		"replaced": func(w *twin) {
			for _, h := range []*harness{w.inc, w.ref} {
				p := w.path(h, "growth.jsonl")
				if err := os.WriteFile(p+".new", growthTranscript(40), 0o600); err != nil {
					w.t.Fatal(err)
				}
				if err := os.Rename(p+".new", p); err != nil {
					w.t.Fatal(err)
				}
			}
		},
		// Same file, same size, the last line's prose changed: only the
		// fingerprint of what was read can tell.
		"changed in place": func(w *twin) {
			b := append([]byte{}, data...)
			tail := b[len(b)-2000:]
			if !bytes.Contains(tail, []byte("done 3 ")) {
				w.t.Fatal("the late prose is not where the test expects it")
			}
			copy(tail, bytes.ReplaceAll(tail, []byte("done 3 "), []byte("DONE 3 ")))
			w.rewrite("growth.jsonl", b, at)
		},
		"another session, same size": func(w *twin) {
			b := bytes.ReplaceAll(data, []byte("01f3f3f3-0000-7000-8000-000000000001"), []byte("01f3f3f3-0000-7000-8000-000000000002"))
			w.rewrite("growth.jsonl", b, at)
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			w := newTwin(t)
			w.appendTo("growth.jsonl", data)
			w.poll("written")
			change(w)
			w.poll("rewritten")
			w.appendTo("growth.jsonl", growthRecord(31))
			w.poll("appended after the rewrite")
		})
	}
}

// Codex compresses a rollout untouched for a week and deletes the plain file.
// The tail of the plain file is dropped, and the compressed one is read whole.
func TestIncrementalImportWhenTheRolloutIsCompressed(t *testing.T) {
	t.Parallel()
	data := growthTranscript(40)
	w := newTwin(t)
	for i, c := range chunks(data, rand.New(rand.NewSource(3))) {
		w.appendTo("growth.jsonl", c)
		w.poll(fmt.Sprintf("chunk %d", i))
	}
	for _, h := range []*harness{w.inc, w.ref} {
		p := w.path(h, "growth.jsonl")
		f, err := os.Create(p + ".zst")
		if err != nil {
			t.Fatal(err)
		}
		enc, err := zstd.NewWriter(f)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := enc.Write(data); err != nil {
			t.Fatal(err)
		}
		_ = enc.Close()
		_ = f.Close()
		if err := os.Remove(p); err != nil {
			t.Fatal(err)
		}
	}
	w.poll("compressed")
	if len(w.inc.in.tails) != 0 {
		t.Errorf("%d tails kept after the plain file went away", len(w.inc.in.tails))
	}
}

// A tail is let go once its file has been quiet for tailIdle; the next change
// replays the file once.
func TestIdleTailIsLetGo(t *testing.T) {
	t.Parallel()
	w := newTwin(t)
	w.appendTo("growth.jsonl", growthTranscript(10))
	w.poll("written")
	p := w.path(w.inc, "growth.jsonl")
	if w.inc.in.tails[p] == nil {
		t.Fatal("no tail for a live file")
	}
	old := time.Now().Add(-2 * tailIdle)
	for _, h := range []*harness{w.inc, w.ref} {
		if err := os.Chtimes(w.path(h, "growth.jsonl"), old, old); err != nil {
			t.Fatal(err)
		}
	}
	w.poll("quiet")
	if w.inc.in.tails[p] != nil {
		t.Error("tail kept for a file quiet for longer than tailIdle")
	}
	w.appendTo("growth.jsonl", growthRecord(10))
	w.poll("picked up again")
}

// The counters say what a pass cost: a one-line append reads that line, not
// the file, and offers what it added rather than the whole history again.
func TestAnAppendCostsTheAppend(t *testing.T) {
	t.Parallel()
	w := newTwin(t)
	w.appendTo("growth.jsonl", growthTranscript(400))
	w.poll("written")
	w.appendTo("growth.jsonl", growthRecord(400)) // a task_started: no event
	w.appendTo("growth.jsonl", growthRecord(401)) // the prompt: one event
	w.poll("appended")
	inc, ref := w.inc.in.Work().Last, w.ref.in.Work().Last
	if inc.Records != 2 || inc.Offered != 1 || inc.Stored != 1 {
		t.Errorf("incremental pass: %+v, want 2 records decoded and 1 offered", *inc)
	}
	if inc.BytesRead >= int64(len(growthTranscript(400)))/10 {
		t.Errorf("incremental pass read %d bytes of a %d-byte file", inc.BytesRead, len(growthTranscript(400)))
	}
	if ref.Records < 400 || ref.Offered-ref.Stored < 200 {
		t.Errorf("full re-read: %+v, expected the whole file again", *ref)
	}
}
