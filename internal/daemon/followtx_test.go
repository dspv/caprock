package daemon

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/ingest"
)

// A hook's transcript_path reaches a reader (issue #1085): the
// subscription's when its directory holds the file, else the Default
// sign-in's, which also takes one outside every directory. Once per path.
func TestFollowTranscriptGoesToTheReaderThatHoldsIt(t *testing.T) {
	sid := "0b6c7e2a-1111-4222-8333-944445555666"
	def := ingest.New(t.TempDir(), nil, nil, nil)
	subRoot := t.TempDir()
	sub := ingest.New(subRoot, nil, nil, nil)
	d := &Daemon{tail: def}
	d.subIn.claude = map[string]*ingest.Tailer{"p1": sub}

	// In a subscription's projects/: that reader.
	d.followTranscript(sid, filepath.Join(subRoot, "-proj", sid+".jsonl"))
	waitUntil(t, func() bool { return sub.Stats().Followed == 1 })
	if def.Stats().Followed != 0 {
		t.Error("the Default sign-in's reader took a subscription's transcript")
	}

	// Anywhere else — another home, a CLAUDE_CONFIG_DIR: the Default reader.
	other := "1b6c7e2a-1111-4222-8333-944445555666"
	away := filepath.Join(t.TempDir(), "elsewhere", ".claude", "projects", "C--Users-Dima-dev", other+".jsonl")
	d.followTranscript(other, away)
	waitUntil(t, func() bool { return def.Stats().Followed == 1 })

	// The same path again, from every later hook: nothing more.
	d.followTranscript(other, away)
	time.Sleep(20 * time.Millisecond)
	if n := def.Stats().Followed; n != 1 {
		t.Errorf("followed %d times, want once", n)
	}

	// Not the session's own transcript, or no reader at all: ignored.
	d.followTranscript(other, filepath.Join(t.TempDir(), "x.jsonl"))
	(&Daemon{}).followTranscript(sid, filepath.Join(subRoot, sid+".jsonl"))
}

func waitUntil(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
