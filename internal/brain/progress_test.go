package brain

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/store"
)

// While claude is asked about a session, the status names it — its title,
// agent, project and when it last did something — and a progress frame
// says so before and after; once the read is over it is gone.
func TestTheStatusNamesTheSessionBeingRead(t *testing.T) {
	ctx := context.Background()
	var during Status
	var e *env
	e = newEnv(t, func(r Request) (Result, error) {
		during = e.eng.Status(ctx)
		return twoMemories(r)
	})
	e.session(t, "s1", "acme-api", 20*time.Minute, [2]string{"Why is   the cache test\nflaky?", long})
	sub := e.eng.Bus.Subscribe(16)
	defer sub.Unsubscribe()
	if _, err := e.eng.Wake(ctx); err != nil {
		t.Fatal(err)
	}
	r := during.Reading
	if r == nil || r.SessionID != "s1" || r.Project != "acme-api" || r.Agent != "claude" ||
		r.Title != "Why is the cache test flaky?" || r.StartedAt != t0.UnixMilli() || r.LastEventAt != t0.Add(-20*time.Minute).UnixMilli() {
		t.Fatalf("reading while the read runs: %+v", r)
	}
	if st := e.eng.Status(ctx); st.Reading != nil {
		t.Errorf("still reading after the read: %+v", st.Reading)
	}
	ops := []string{}
	for len(sub.C) > 0 {
		if f := <-sub.C; f.Type == bus.FrameBrain {
			ops = append(ops, f.Data.(map[string]any)["op"].(string))
		}
	}
	if strings.Join(ops, ",") != "progress,progress,added,added" {
		t.Errorf("frames: %v", ops)
	}

	// The session's own name wins over its first prompt.
	if _, err := e.st.DB().Exec(`UPDATE sessions SET title = 'Flaky cache test' WHERE session_id = 's1'`); err != nil {
		t.Fatal(err)
	}
	e.now = e.now.Add(time.Hour)
	e.session(t, "s1", "acme-api", 15*time.Minute, [2]string{"And retries?", long})
	if _, err := e.eng.Wake(ctx); err != nil {
		t.Fatal(err)
	}
	if during.Reading == nil || during.Reading.Title != "Flaky cache test" {
		t.Errorf("titled session: %+v", during.Reading)
	}
	runs, _ := store.LastBrainRuns(ctx, e.st.DB(), 1)
	if len(runs) != 1 || runs[0].Title != "Flaky cache test" || runs[0].Agent != "claude" {
		t.Errorf("a recent read names its session: %+v", runs)
	}
}

// The build counts every session in reach once — read, or quiet and
// waiting — with the memories kept, per project; a live session is not
// counted until it goes quiet, and one from before the reach not at all.
func TestTheBuildCountsWhatIsReadAndWhatWaitsPerProject(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, twoMemories)
	e.session(t, "a1", "acme-api", 1*time.Hour, [2]string{"q", long})
	e.session(t, "a2", "acme-api", 2*time.Hour, [2]string{"q", long})
	e.session(t, "a3", "acme-api", 3*time.Hour, [2]string{"q", "too short"})
	for _, id := range []string{"w1", "w2", "w3", "w4"} {
		e.session(t, id, "web", 5*time.Hour, [2]string{"q", long})
	}
	e.session(t, "live", "web", time.Minute, [2]string{"q", long})
	e.session(t, "old", "web", 72*time.Hour, [2]string{"q", long})

	st := e.eng.Status(ctx)
	b := st.Build
	if b == nil || b.Sessions != 7 || b.Read != 0 || b.Memories != 0 || b.From != e.cfg.Since {
		t.Fatalf("before any read: %+v", b)
	}
	// One wake reads the four newest that have prose (the short one is
	// recorded as skipped on the way, without a call).
	if n, _ := e.eng.Wake(ctx); n != Batch {
		t.Fatalf("read %d", n)
	}
	b = e.eng.Status(ctx).Build
	// Read: a1, a2, a3 (skipped) and two of web's; waiting: two of web's.
	if b.Sessions != 7 || b.Read != 5 || b.Memories != 8 || st.Pending != 7 {
		t.Fatalf("after a wake: %+v (pending before %d)", b, st.Pending)
	}
	want := []BuildSource{{Project: "web", Read: 2, Pending: 2, Memories: 4}, {Project: "acme-api", Read: 3, Memories: 4}}
	got, _ := json.Marshal(b.Sources)
	exp, _ := json.Marshal(want)
	if string(got) != string(exp) {
		t.Errorf("sources:\n got %s\nwant %s", got, exp)
	}
	// New prose in a read session: it waits again, counted once. An hour on,
	// the live session has gone quiet and joins.
	e.now = e.now.Add(time.Hour)
	e.session(t, "a1", "acme-api", 15*time.Minute, [2]string{"more", long})
	b = e.eng.Status(ctx).Build
	if b.Sessions != 8 || b.Read != 4 || b.Memories != 8 {
		t.Errorf("a read session waiting again: %+v", b)
	}

	// Off: no build.
	off := false
	e.cfg.Auto = &off
	if st := e.eng.Status(ctx); st.Build != nil {
		t.Errorf("off, a build: %+v", st.Build)
	}
}
