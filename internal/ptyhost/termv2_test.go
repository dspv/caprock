// Terminal protocol v2 on the holder's side: offsets that continue across a
// daemon restart, input applied once per client sequence however often it is
// resent, the catch-up a reconnecting daemon is owed, and a holder from
// before all of this still working with this daemon.
package ptyhost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/ptyman"
)

// holderDir is a data directory for a test that starts holders. On Windows a
// holder that is still exiting keeps host.log open and the directory cannot
// be removed yet, so removal is retried until it goes (it runs before
// t.TempDir's own cleanup, which then finds nothing left to do).
func holderDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Cleanup(func() {
		deadline := time.Now().Add(20 * time.Second)
		for os.RemoveAll(dir) != nil && time.Now().Before(deadline) {
			time.Sleep(100 * time.Millisecond)
		}
	})
	return dir
}

// endHolder ends a session whose daemon has let go: a new daemon picks it up
// and kills it through its holder.
func endHolder(t *testing.T, data, id string) {
	t.Helper()
	att, _ := newManager(t, data).Reattach()
	for _, a := range att {
		_ = a.Session.Close()
	}
	waitGone(t, recordPath(Dir(data), id))
}

func ringOf(t *testing.T, s ptyman.Session) interface {
	Total() uint64
	Start() uint64
	Since(uint64) ([]byte, bool)
} {
	t.Helper()
	rs, ok := s.(ptyman.Ringed)
	if !ok || rs.Ring() == nil {
		t.Fatal("a hosted session must keep a ring")
	}
	return rs.Ring()
}

func waitRing(t *testing.T, s ptyman.Session, want string) {
	t.Helper()
	r := ringOf(t, s)
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if b, ok := r.Since(r.Start()); ok && strings.Contains(string(b), want) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	b, _ := r.Since(r.Start())
	t.Fatalf("ring never showed %q; has %q", want, b)
}

func TestOffsetsAndSequencedInputSurviveADaemonRestart(t *testing.T) {
	data := holderDir(t)
	s, err := newManager(t, data).Spawn(context.Background(), childSpec(t, "s-v2"))
	if err != nil {
		t.Fatal(err)
	}
	readAll(s.Output())
	waitRing(t, s, "child ready")
	sw := s.(ptyman.SeqWriter)
	if last, err := sw.WriteSeq("tab", 1, []byte("one\r")); err != nil || last != 1 {
		t.Fatalf("WriteSeq 1 = %d %v", last, err)
	}
	if last, err := sw.WriteSeq("tab", 1, []byte("one\r")); err != nil || last != 1 {
		t.Fatalf("resent 1 = %d %v", last, err)
	}
	waitRing(t, s, "you-said:one")
	r1 := ringOf(t, s)
	off := r1.Total()
	before, _ := r1.Since(r1.Start())
	start := r1.Start()

	_ = s.(ptyman.Detacher).Detach()
	att, _ := newManager(t, data).Reattach()
	if len(att) != 1 {
		t.Fatalf("reattached %d", len(att))
	}
	s2 := att[0].Session
	defer s2.Close()
	readAll(s2.Output())
	r2 := ringOf(t, s2)
	if r2.Total() < off {
		t.Fatalf("offsets restarted: %d after the restart, %d before", r2.Total(), off)
	}
	if after, ok := r2.Since(start); !ok || !bytes.HasPrefix(after, before) {
		t.Fatalf("the bytes at the same offsets differ across the restart:\nbefore %q\nafter  %q", before, after)
	}
	// The next daemon must not type what the last one already did.
	sw2 := s2.(ptyman.SeqWriter)
	if last, err := sw2.WriteSeq("tab", 0, nil); err != nil || last != 1 {
		t.Fatalf("query after the restart = %d %v; the holder forgot", last, err)
	}
	if last, err := sw2.WriteSeq("tab", 1, []byte("one\r")); err != nil || last != 1 {
		t.Fatalf("resent across the restart = %d %v", last, err)
	}
	if last, err := sw2.WriteSeq("tab", 2, []byte("two\r")); err != nil || last != 2 {
		t.Fatalf("WriteSeq 2 = %d %v", last, err)
	}
	waitRing(t, s2, "you-said:two")
	all, _ := r2.Since(r2.Start())
	if n := strings.Count(string(all), "you-said:one"); n != 1 {
		t.Fatalf("\"one\" was answered %d times; a resend was typed again", n)
	}
}

// A daemon whose connection to the holder dropped asks for what it missed,
// and gets exactly that — or the whole screen when the ring has moved on.
func TestResumeSendsWhatTheDaemonMissed(t *testing.T) {
	data := holderDir(t)
	s, err := newManager(t, data).Spawn(context.Background(), childSpec(t, "s-catch"))
	if err != nil {
		t.Fatal(err)
	}
	readAll(s.Output())
	waitRing(t, s, "child ready")
	ring := ringOf(t, s)
	off := ring.Total()
	if _, err := s.Write([]byte("missed\r")); err != nil {
		t.Fatal(err)
	}
	waitRing(t, s, "you-said:missed")
	want, _ := ring.Since(off)

	// This test is the daemon now: the remote lets go, so it does not
	// reconnect and take the holder back mid-handshake.
	rec := s.(*remote).rec
	_ = s.(ptyman.Detacher).Detach()
	defer endHolder(t, data, rec.SessionID)
	conn, w, _, err := dial(rec, hello{Resume: true, Since: &off})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if w.Offset == nil || *w.Offset < off+uint64(len(want)) {
		t.Fatalf("welcome offset %v; want at least %d", w.Offset, off+uint64(len(want)))
	}
	typ, payload, err := readFrame(conn)
	if err != nil || typ != frameOutput || !bytes.HasPrefix(payload, want) {
		t.Fatalf("catch-up = %q %q %v; want output starting %q", typ, payload, err, want)
	}

	// An offset the ring does not hold gets the whole screen.
	past := *w.Offset + 1000
	conn2, _, _, err := dial(rec, hello{Resume: true, Since: &past})
	if err != nil {
		t.Fatal(err)
	}
	typ, _, err = readFrame(conn2)
	_ = conn2.Close()
	if err != nil || typ != frameSnapshot {
		t.Fatalf("since past the end: %q %v; want a snapshot", typ, err)
	}
}

// A holder an older release started keeps working with this daemon: no
// offsets (the ring counts from the clock), no J frames (input is written
// plainly and the daemon deduplicates).
func TestHolderFromBeforeV2StillWorks(t *testing.T) {
	data := holderDir(t)
	m := newManager(t, data)
	m.Env = append(m.Env, envPreV2+"=1")
	before := uint64(time.Now().UnixMicro()) //nolint:gosec // after 1970
	s, err := m.Spawn(context.Background(), childSpec(t, "s-old"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	out := readAll(s.Output())
	out.waitFor(t, "child ready")
	if _, err := s.(ptyman.SeqWriter).WriteSeq("tab", 1, []byte("x\r")); !errors.Is(err, ptyman.ErrNotSupported) {
		t.Fatalf("WriteSeq on an old holder = %v; want ErrNotSupported so the daemon dedupes", err)
	}
	if total := ringOf(t, s).Total(); total < before || total > 1<<53 {
		t.Fatalf("an old holder's offsets start at %d: they must pass any an earlier daemon handed out and stay exact in JavaScript", total)
	}
	if _, err := s.Write([]byte("plain\r")); err != nil {
		t.Fatal(err)
	}
	out.waitFor(t, "you-said:plain")
	waitRing(t, s, "you-said:plain")
}

// What an old daemon sends, a new holder still answers the old way.
func TestOldDaemonHelloStillGetsWelcomeAndSnapshot(t *testing.T) {
	data := holderDir(t)
	s, err := newManager(t, data).Spawn(context.Background(), childSpec(t, "s-olddaemon"))
	if err != nil {
		t.Fatal(err)
	}
	readAll(s.Output()).waitFor(t, "child ready")
	_ = s.(ptyman.Detacher).Detach()
	defer endHolder(t, data, "s-olddaemon")
	b, err := os.ReadFile(recordPath(Dir(data), "s-olddaemon"))
	if err != nil {
		t.Fatal(err)
	}
	var rec Record
	_ = json.Unmarshal(b, &rec)
	conn, w, snap, err := dial(rec, hello{}) // a v1 hello: no since, no resume
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if w.Proto != 1 || !strings.Contains(string(snap), "child ready") {
		t.Fatalf("old-daemon handshake = %+v %q", w, snap)
	}
}
