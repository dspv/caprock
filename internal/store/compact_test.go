package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// oldRow stores a payload the way a version before event.CapToolField did:
// verbatim.
// oldRowSeq keys the rows: Windows' clock can return the same nanosecond
// twice in a tight loop, and a repeated key is a duplicate event.
var oldRowSeq atomic.Int64

func oldRow(t *testing.T, st *Store, kind event.Kind, payload string) int64 {
	t.Helper()
	ctx := context.Background()
	var id int64
	if err := st.WithTx(ctx, func(q Querier) error {
		if err := UpsertSession(ctx, q, "s1", SessionPatch{StartedAt: 1, LastEventAt: 1}); err != nil {
			return err
		}
		var err error
		id, err = InsertEvent(ctx, q, &event.Event{
			Ts: time.UnixMilli(1_790_000_000_000), SessionID: "s1", Source: event.SourceHook, Kind: kind,
			Tool: "mcp__browser__screenshot", Key: "k" + strconv.FormatInt(oldRowSeq.Add(1), 10), Payload: json.RawMessage(payload),
		})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return id
}

func rowOf(t *testing.T, st *Store, id int64) (payload string, toolBytes int64) {
	t.Helper()
	if err := st.DB().QueryRow(`SELECT payload, tool_bytes FROM events WHERE id = ?`, id).Scan(&payload, &toolBytes); err != nil {
		t.Fatal(err)
	}
	return payload, toolBytes
}

func compactAll(t *testing.T, st *Store, window int) (rows int, freed int64, steps int) {
	t.Helper()
	for {
		s, err := st.CompactPayloadsStep(context.Background(), window)
		if err != nil {
			t.Fatal(err)
		}
		rows += s.Rewritten
		freed += s.Freed
		steps++
		if s.Done {
			return rows, freed, steps
		}
		if steps > 10000 {
			t.Fatal("compaction never finished")
		}
	}
}

func openCompactTest(t *testing.T) *Store {
	t.Helper()
	st, err := Open(context.Background(), filepath.Join(t.TempDir(), "c.db"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// An old row's screenshot becomes exactly the marker a new row gets, and its
// text, its other fields and its tool size stay as they were.
func TestCompactPayloadsReplacesBase64AndKeepsText(t *testing.T) {
	st := openCompactTest(t)
	img := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("\x89PNG pixels ", 40000)))
	long := strings.Repeat("a line of output that is kept\n", 4000) // 120 KB: over MaxToolField
	shot := `{"tool_name":"mcp__browser__screenshot","tool_response":[{"type":"text","text":"took it"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + img + `"}}]}`
	textOnly := `{"tool_name":"Bash","tool_response":{"stdout":` + strconv.Quote(long) + `,"exit_code":0}}`
	shotID := oldRow(t, st, event.KindToolPost, shot)
	textID := oldRow(t, st, event.KindToolPost, textOnly)
	// A prompt with an image pasted into it: the image goes, every word stays.
	prompt := `{"prompt":` + strconv.Quote(long) + `,"images":[{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"` + img + `"}}]}`
	promptID := oldRow(t, st, event.KindTurnUser, prompt)
	_, bytesBefore := rowOf(t, st, shotID)

	rows, freed, _ := compactAll(t, st, 500)
	if rows != 2 {
		t.Fatalf("rewrote %d rows, want 2", rows)
	}
	gotPrompt, _ := rowOf(t, st, promptID)
	var pp struct{ Prompt string }
	if err := json.Unmarshal([]byte(gotPrompt), &pp); err != nil || pp.Prompt != long || !strings.Contains(gotPrompt, "[image image/jpeg ") {
		t.Fatalf("prompt row: %.200s %v", gotPrompt, err)
	}
	got, toolBytes := rowOf(t, st, shotID)
	// The marker is CapToolField's, character for character.
	capped := string(event.CapToolField(json.RawMessage(`{"type":"base64","media_type":"image/png","data":"` + img + `"}`)))
	wantMarker := strings.TrimSuffix(strings.SplitN(capped, `"data":`, 2)[1], `,"media_type":"image/png","type":"base64"}`)
	if !strings.Contains(got, `"data":`+wantMarker) || !strings.Contains(wantMarker, "[image image/png ") || !strings.Contains(wantMarker, " not stored]") {
		t.Fatalf("marker %s not in %s", wantMarker, got)
	}
	if strings.Contains(got, img[:64]) {
		t.Fatal("base64 still stored")
	}
	if !strings.Contains(got, `"text":"took it"`) {
		t.Fatalf("the text block went: %s", got)
	}
	if toolBytes != bytesBefore {
		t.Fatalf("tool_bytes %d, want the original %d", toolBytes, bytesBefore)
	}
	if want := int64(len(shot) - len(got) + len(prompt) - len(gotPrompt)); freed != want {
		t.Fatalf("freed %d, want %d", freed, want)
	}
	// Long text is not clipped, not even re-encoded.
	if text, _ := rowOf(t, st, textID); text != textOnly {
		t.Fatal("a text-only row changed")
	}
}

// The pass moves a window at a time, survives being stopped between steps,
// finishes once, and a second pass over the same rows changes nothing.
func TestCompactPayloadsResumesAndIsIdempotent(t *testing.T) {
	st := openCompactTest(t)
	ctx := context.Background()
	img := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("x", 3000)))
	var ids []int64
	for i := 0; i < 5; i++ {
		ids = append(ids, oldRow(t, st, event.KindToolPost, `{"tool_response":{"file":{"base64":"`+img+`","type":"image/jpeg"}}}`))
	}
	s, err := st.CompactPayloadsStep(ctx, 2)
	if err != nil || s.Done || s.Rewritten != 2 {
		t.Fatalf("first step %+v %v", s, err)
	}
	if cur, _ := st.GetMeta(ctx, MetaPayloadCompactCursor); cur != strconv.FormatInt(ids[1], 10) {
		t.Fatalf("cursor %q, want %d", cur, ids[1])
	}
	// A row written after the pass began was written capped: not examined.
	late := oldRow(t, st, event.KindToolPost, `{"tool_response":{"file":{"base64":"`+img+`","type":"image/jpeg"}}}`)

	// A daemon restarted here goes on from the cursor.
	st2 := &Store{db: st.db, log: st.log}
	rows, _, _ := compactAll(t, st2, 2)
	if rows != 3 {
		t.Fatalf("resumed pass rewrote %d, want 3", rows)
	}
	if done, _ := st.PayloadCompactFinished(ctx); !done {
		t.Fatal("not marked done")
	}
	if p, _ := rowOf(t, st, late); !strings.Contains(p, img[:64]) {
		t.Fatal("a row after the ceiling was examined")
	}
	for _, id := range ids {
		if p, _ := rowOf(t, st, id); !strings.Contains(p, `"[image image/jpeg 3 KB not stored]"`) {
			t.Fatalf("row %d: %s", id, p)
		}
	}
	// Finished: a step does nothing.
	if s, err := st.CompactPayloadsStep(ctx, 2); err != nil || !s.Done || s.Rewritten != 0 {
		t.Fatalf("after done %+v %v", s, err)
	}
	// Run again from the start: the markers are not base64, nothing changes.
	before, _ := rowOf(t, st, ids[0])
	if err := st.SetMeta(ctx, MetaPayloadCompactCursor, "0"); err != nil {
		t.Fatal(err)
	}
	if rows, _, _ := compactAll(t, st, 2); rows != 0 {
		t.Fatalf("second pass rewrote %d rows", rows)
	}
	if after, _ := rowOf(t, st, ids[0]); after != before {
		t.Fatal("second pass changed a row")
	}
}

// An empty database finishes at once.
func TestCompactPayloadsEmpty(t *testing.T) {
	st := openCompactTest(t)
	if rows, _, steps := compactAll(t, st, 500); rows != 0 || steps != 1 {
		t.Fatalf("rows %d steps %d", rows, steps)
	}
}
