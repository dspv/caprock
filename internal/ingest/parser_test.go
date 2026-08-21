package ingest

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/event"
)

// The old cap counted bytes and sliced mid-rune, which clipped Cyrillic prose
// at about half the intended length and left U+FFFD at the end of a fifth of
// truncated rows — on the closing summaries people came back for.
func TestClipRunes(t *testing.T) {
	t.Run("short text is untouched", func(t *testing.T) {
		if got := clipRunes("привет", 10); got != "привет" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("counts runes, not bytes", func(t *testing.T) {
		// 100 Cyrillic characters = 200 bytes. A byte cap of 100 would have cut
		// this in half; a rune cap must not touch it.
		in := strings.Repeat("я", 100)
		if got := clipRunes(in, 100); got != in {
			t.Fatalf("clipped at %d runes, want untouched", utf8.RuneCountInString(got))
		}
	})

	t.Run("never splits a rune", func(t *testing.T) {
		in := strings.Repeat("ё", 50)
		got := clipRunes(in, 10)
		if strings.ContainsRune(got, utf8.RuneError) {
			t.Fatalf("truncation corrupted a rune: %q", got)
		}
		if !utf8.ValidString(got) {
			t.Fatalf("result is not valid UTF-8: %q", got)
		}
		if want := strings.Repeat("ё", 10) + "…"; got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})

	t.Run("emoji and combining marks survive", func(t *testing.T) {
		in := strings.Repeat("🔑", 20)
		got := clipRunes(in, 5)
		if strings.ContainsRune(got, utf8.RuneError) || !utf8.ValidString(got) {
			t.Fatalf("corrupted: %q", got)
		}
	})

	t.Run("a closing summary is kept whole", func(t *testing.T) {
		// Real summaries measured on live data ran to ~2.4k characters; the cap
		// must sit well above that so the useful content is never the casualty.
		summary := strings.Repeat("Готово, вот что изменилось. ", 80) // ~2240 runes
		if got := clipRunes(summary, MaxAssistantText); got != summary {
			t.Fatalf("a %d-rune summary was clipped", utf8.RuneCountInString(summary))
		}
	})
}

// A year-9999 timestamp shifts past year 10000 in any positive UTC offset, and
// time.Time refuses to marshal that — which aborts the encoding of the entire
// array it appears in. One such event made every session invisible in the API,
// permanently, because the event persists across restarts.
func TestImplausibleTimestampsAreRejected(t *testing.T) {
	fallback := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	cases := map[string]bool{
		"9999-12-31T23:59:59.000Z": false, // the one that broke /v1/sessions
		"0001-01-01T00:00:00Z":     false, // before Claude Code existed
		"1970-01-01T00:00:00Z":     false,
		"2030-01-01T00:00:00Z":     false, // a clock problem, not a fact
		"2026-08-20T10:00:00Z":     true,
		"2023-06-01T00:00:00Z":     true,
	}
	for stamp, wantParsed := range cases {
		l := &Line{Timestamp: stamp}
		got := l.Ts(fallback)
		usedFallback := got.Equal(fallback)
		if wantParsed && usedFallback {
			t.Errorf("%s: fell back, want it accepted", stamp)
		}
		if !wantParsed && !usedFallback {
			t.Errorf("%s: accepted %v, want the fallback", stamp, got)
		}
	}
}

// TestToolPreCarriesItsMessageID is the linkage per-directory attribution rests
// on. A tool_use block and the usage billed for it are content blocks of the
// SAME assistant message, so the tool.pre event must carry that message's id —
// nothing downstream can recover it, because the store keeps only the first of
// the several transcript lines one response is written as.
func TestToolPreCarriesItsMessageID(t *testing.T) {
	const raw = `{"type":"assistant","sessionId":"s1","uuid":"u1","cwd":"/repo",
	 "message":{"role":"assistant","id":"msg_abc","model":"claude-opus-5",
	  "usage":{"input_tokens":10,"output_tokens":2},
	  "content":[{"type":"tool_use","id":"toolu_1","name":"Edit",
	              "input":{"file_path":"/repo/api/main.go"}}]}}`
	line, err := ParseLine([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	evs := line.Events(time.Now())
	var turn, tool *event.Event
	for i := range evs {
		switch evs[i].Kind {
		case event.KindTurnAssistant:
			turn = &evs[i]
		case event.KindToolPre:
			tool = &evs[i]
		}
	}
	if turn == nil || tool == nil {
		t.Fatalf("want a turn and a tool.pre, got %d events", len(evs))
	}
	if turn.MsgID != "msg_abc" {
		t.Errorf("turn.MsgID = %q, want %q", turn.MsgID, "msg_abc")
	}
	if tool.MsgID != "msg_abc" {
		t.Errorf("tool.MsgID = %q, want %q — the tool cannot be billed to the turn that paid for it", tool.MsgID, "msg_abc")
	}
	if turn.MsgID != tool.MsgID {
		t.Error("the tool and its turn disagree on the message id, so attribution would charge the wrong turn")
	}
	// The id is also in the payload, which is what the historical backfill and
	// any future consumer read.
	if !strings.Contains(string(tool.Payload), `"message_id":"msg_abc"`) {
		t.Errorf("tool payload does not carry message_id: %s", tool.Payload)
	}
}
