package codex

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

// A turn's prose that grew (a message written after its last token_count)
// reaches the stored row twice if the pass dies between the records and the
// prose sync: the store folds the grown text onto the old one.
func TestTurnTextIsNotDuplicatedWhenTheTextSyncFails(t *testing.T) {
	raw, err := os.ReadFile(proseFixture)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.SplitAfter(string(raw), "\n")
	first, rest := strings.Join(lines[:12], ""), strings.Join(lines[12:14], "")
	for _, restart := range []bool{false, true} {
		w := newTwin(t)
		w.appendTo("prose.jsonl", []byte(first))
		w.poll("first part")
		w.appendTo("prose.jsonl", []byte(rest))
		fail := true
		w.inc.in.beforeText = func() error {
			if fail {
				return errors.New("injected")
			}
			return nil
		}
		w.inc.poll() // the records are stored, the prose sync fails
		fail = false
		if restart {
			in := NewIngester(w.inc.in.dirs, w.inc.in.rec, w.inc.in.log, time.Second)
			in.replay = w.inc.in.replay
			w.inc.in = in
		}
		w.inc.poll()
		w.ref.poll()
		if got, want := dumpStore(t, w.inc.out), dumpStore(t, w.ref.out); got != want {
			t.Fatalf("restart=%v: retry differs from a full import\n%s", restart, firstDiff(got, want))
		}
	}
}
