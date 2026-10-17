package termbuf

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestRingCountsEveryByteAndServesSince(t *testing.T) {
	r := NewRing(8)
	r.Write([]byte("abcdef"))
	r.Write([]byte("ghij")) // drops "ab"
	if r.Total() != 10 || r.Start() != 2 {
		t.Fatalf("total %d start %d; want 10 and 2", r.Total(), r.Start())
	}
	if b, ok := r.Since(5); !ok || string(b) != "fghij" {
		t.Fatalf("Since(5) = %q %v", b, ok)
	}
	if b, ok := r.Since(10); !ok || len(b) != 0 {
		t.Fatalf("Since(total) = %q %v; want empty and ok", b, ok)
	}
	if _, ok := r.Since(1); ok {
		t.Fatal("Since before the ring's start must fail: those bytes are gone")
	}
	if _, ok := r.Since(11); ok {
		t.Fatal("Since past the end must fail: that offset is some other stream's")
	}
	snap, at := r.SnapshotAt()
	if string(snap) != "cdefghij" || at != 10 {
		t.Fatalf("SnapshotAt = %q %d", snap, at)
	}
}

func TestRingRestoreKeepsOffsetsAndModes(t *testing.T) {
	r := NewRing(16)
	r.Write([]byte("old"))
	r.Restore([]byte("\x1b[?2004h"), []byte("held"), 1000)
	if r.Total() != 1000 || r.Start() != 996 {
		t.Fatalf("total %d start %d", r.Total(), r.Start())
	}
	if b, ok := r.Since(998); !ok || string(b) != "ld" {
		t.Fatalf("Since(998) = %q %v", b, ok)
	}
	if snap := string(r.Snapshot()); snap != "\x1b[?2004hheld" {
		t.Fatalf("snapshot %q; the mode prefix must survive a restore", snap)
	}
	r.Write([]byte("X"))
	if b, _ := r.Since(1000); string(b) != "X" {
		t.Fatalf("after restore, Since(1000) = %q", b)
	}
}

func TestRingChangedWakesOnWrite(t *testing.T) {
	r := NewRing(8)
	ch := r.Changed()
	select {
	case <-ch:
		t.Fatal("woke before any write")
	default:
	}
	r.Write([]byte("x"))
	select {
	case <-ch:
	case <-time.After(time.Second):
		t.Fatal("a write did not wake the waiter")
	}
}

// Mode says what the output last set for a tracked mode, across chunks and
// a restore, and that a mode it never touched is unknown.
func TestRingModeReadsBracketedPaste(t *testing.T) {
	r := NewRing(64)
	if _, seen := r.Mode(2004); seen {
		t.Fatal("a mode the output never set must be unknown")
	}
	r.Write([]byte("hello\x1b[?20"))
	r.Write([]byte("04h world"))
	if on, seen := r.Mode(2004); !on || !seen {
		t.Fatalf("Mode(2004) = %v %v; want on", on, seen)
	}
	r.Write([]byte("\x1b[?2004l"))
	if on, seen := r.Mode(2004); on || !seen {
		t.Fatalf("Mode(2004) = %v %v; want off", on, seen)
	}
	r2 := NewRing(64)
	r2.Restore([]byte("\x1b[?2004h"), []byte("screen"), 6)
	if on, _ := r2.Mode(2004); !on {
		t.Fatal("a restored ring must keep the holder's modes")
	}
}

func TestInputsApplyOnceAndForget(t *testing.T) {
	in := NewInputs(time.Minute)
	now := time.Unix(0, 0)
	in.now = func() time.Time { return now }
	var typed []uint64
	apply := func(seq uint64) (uint64, error) {
		return in.Apply("c1", seq, func() error { typed = append(typed, seq); return nil })
	}
	for _, s := range []uint64{1, 2, 2, 1, 3} {
		if _, err := apply(s); err != nil {
			t.Fatal(err)
		}
	}
	if len(typed) != 3 {
		t.Fatalf("typed %v; a retried sequence was applied twice", typed)
	}
	if last, _ := apply(0); last != 3 {
		t.Fatalf("query = %d; want 3", last)
	}
	// A failed write is not applied: the retry goes through.
	boom := errors.New("boom")
	if last, err := in.Apply("c1", 4, func() error { return boom }); !errors.Is(err, boom) || last != 3 {
		t.Fatalf("failed write = %d %v", last, err)
	}
	if last, _ := apply(4); last != 4 {
		t.Fatalf("retry after a failure = %d", last)
	}
	// Other clients have their own numbering.
	if last, _ := in.Apply("c2", 1, func() error { return nil }); last != 1 {
		t.Fatalf("c2 = %d", last)
	}
	now = now.Add(2 * time.Minute)
	if in.Last("c1") != 0 {
		t.Fatal("a client silent past the TTL must be forgotten")
	}
}

// codexStartup is what codex-cli 0.161 writes as it takes the screen with its
// own transcript (codex-rs/tui/src/tui/alternate_screen.rs: EnterAlternateScreen,
// then DisableAlternateScroll, EnablePointerCapture and SGR reports).
const codexStartup = "\x1b[?1049h\x1b[?2004h\x1b[?1004h\x1b[?1007l\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h"

// The Codex scroll bug (2026-10-18): once the startup scrolled out of the
// ring, a terminal attached later was on the normal screen with the mouse
// off, so the wheel never reached Codex. The snapshot must open on the
// alternate screen with SGR any-event mouse reporting on.
func TestRingSnapshotKeepsCodexOnTheAlternateScreenWithTheMouse(t *testing.T) {
	r := NewRing(256)
	r.Write([]byte(codexStartup))
	frame := []byte("\x1b[?2026h\x1b[3;1H\x1b[2Kworking\x1b[?2026l")
	for range 100 {
		r.Write(frame)
	}
	if r.Start() <= uint64(len(codexStartup)) {
		t.Fatal("the startup is still in the ring; the test proves nothing")
	}
	snap := string(r.Snapshot())
	for _, mode := range []string{"\x1b[?1049h", "\x1b[?1003h", "\x1b[?1006h", "\x1b[?2004h"} {
		if !strings.Contains(snap[:strings.Index(snap, "\x1b[?2026h")], mode) {
			t.Errorf("snapshot prefix lacks %q: %q", mode, snap[:64])
		}
	}
	for _, mode := range []int{1049, 1003, 1006} {
		if on, _ := r.Mode(mode); !on {
			t.Errorf("Mode(%d) off", mode)
		}
	}
}

// The prefix is the modes where the held bytes start, not where they end:
// a shell's lines printed before an app took the alternate screen replay on
// the normal screen, and the app's own ESC[?1049h in the bytes switches.
func TestRingSnapshotSwitchesScreensWhereTheOutputDid(t *testing.T) {
	r := NewRing(32)
	r.Write([]byte("\x1b[?2004h"))
	r.Write([]byte(strings.Repeat("s", 40))) // the 2004 scrolls out
	r.Write([]byte("$ codex\r\n\x1b[?1049hTUI"))
	snap := string(r.Snapshot())
	if !strings.HasPrefix(snap, "\x1b[?2004h") || strings.Count(snap, "\x1b[?1049h") != 1 {
		t.Fatalf("snapshot %q: want the start-of-ring modes, then the bytes", snap)
	}
	if on, seen := r.Mode(1049); !on || !seen {
		t.Fatal("Mode(1049) must read the held bytes too")
	}
	// Leaving again: the prefix follows once the switch scrolls out.
	r.Write([]byte("\x1b[?1049l" + strings.Repeat("z", 40)))
	if snap := string(r.Snapshot()); !strings.Contains(snap, "\x1b[?1049l") || strings.Contains(snap, "\x1b[?1049h") {
		t.Fatalf("after leaving, snapshot %q", snap)
	}
}
