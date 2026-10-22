package brain

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// longSession writes session "long" of n turns, each answer about 2,400
// characters and marked with its number, so a read's prompt says which
// turns it sent. It returns the event ids of the answers, by turn.
func (e *env) longSession(t *testing.T, n int) []int64 {
	t.Helper()
	turns := make([][2]string, n)
	for i := range turns {
		turns[i] = [2]string{fmt.Sprintf("question q%03d", i), fmt.Sprintf("answer a%03d ", i) + strings.Repeat("The fixture is rewritten by another test. ", 57)}
	}
	max := e.session(t, "long", "acme-api", 20*time.Minute, turns...)
	ids := make([]int64, n)
	for i := range ids {
		ids[i] = max - int64(2*(n-1-i))
	}
	return ids
}

var (
	answerMark   = regexp.MustCompile(`Agent: answer a(\d{3}) `)
	questionMark = regexp.MustCompile(`User: question q(\d{3})`)
)

// sent is the turns a request's prompt carried, in order.
func sent(r Request) []int {
	var out []int
	for _, m := range answerMark.FindAllStringSubmatch(r.Prompt, -1) {
		n, _ := strconv.Atoi(m[1])
		out = append(out, n)
	}
	return out
}

// runsOf is a session's reads, oldest first.
func runsOf(t *testing.T, e *env, session string) []store.BrainRun {
	t.Helper()
	rows, err := e.st.DB().Query(`SELECT from_event_id, through_event_id, status FROM brain_runs WHERE session_id = ? ORDER BY id`, session)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []store.BrainRun
	for rows.Next() {
		var r store.BrainRun
		if err := rows.Scan(&r.FromEventID, &r.ThroughEventID, &r.Status); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

func TestALongSessionIsReadInChunksOldestFirstAndNothingIsSkipped(t *testing.T) {
	e := newEnv(t, twoMemories)
	const turns = 60 // about 150,000 characters: several reads of MaxInputChars
	ids := e.longSession(t, turns)
	ctx := context.Background()

	// The cap: one wake makes at most Batch calls, all of them chunks of
	// the long session, oldest first.
	n, err := e.eng.Wake(ctx)
	if err != nil || n != Batch || e.calls != Batch {
		t.Fatalf("first wake: read %d, calls %d, err %v", n, e.calls, err)
	}
	// The rest waits for the next wakes, which go on where the cursor is.
	for i := 0; i < 5; i++ {
		got, err := e.eng.Wake(ctx)
		if err != nil || got > Batch {
			t.Fatalf("wake %d: read %d, err %v", i+2, got, err)
		}
		if got == 0 {
			break
		}
	}
	if e.calls <= Batch || e.calls > 10 {
		t.Fatalf("%d calls for %d turns", e.calls, turns)
	}

	// Every turn was sent exactly once, in order, each read within budget.
	var all []int
	for i, r := range e.reqs {
		s := sent(r)
		if len(s) == 0 {
			t.Fatalf("read %d sent no answer", i+1)
		}
		if len(r.Prompt) > MaxInputChars+2000 {
			t.Errorf("read %d sent %d chars, more than one read's budget", i+1, len(r.Prompt))
		}
		all = append(all, s...)
	}
	if len(all) != turns {
		t.Fatalf("sent %d answers, want %d: %v", len(all), turns, all)
	}
	for i, n := range all {
		if n != i {
			t.Fatalf("answer %d sent at position %d: %v", n, i, all)
		}
	}

	// The prompts too: each sent once, in order.
	questions := 0
	for _, r := range e.reqs {
		for _, m := range questionMark.FindAllStringSubmatch(r.Prompt, -1) {
			if m[1] != fmt.Sprintf("%03d", questions) {
				t.Fatalf("question %s sent at position %d", m[1], questions)
			}
			questions++
		}
	}
	if questions != turns {
		t.Fatalf("sent %d questions, want %d", questions, turns)
	}

	// The cursor never passes unsent text: each read goes through the last
	// passage it sent (its last answer, or the question after it), the next
	// starts there, and the last reaches the end.
	runs := runsOf(t, e, "long")
	if len(runs) != len(e.reqs) {
		t.Fatalf("%d runs for %d reads", len(runs), len(e.reqs))
	}
	var from int64
	for i, r := range runs {
		s := sent(e.reqs[i])
		last := s[len(s)-1]
		want := ids[last]
		if strings.Contains(e.reqs[i].Prompt, fmt.Sprintf("User: question q%03d", last+1)) {
			want = ids[last] + 1
		}
		if r.Status != store.BrainRunOK || r.FromEventID != from || r.ThroughEventID != want {
			t.Errorf("run %d: %+v, from want %d, through want %d", i+1, r, from, want)
		}
		from = r.ThroughEventID
	}
	if from != ids[turns-1] {
		t.Errorf("read through %d, the session ends at %d", from, ids[turns-1])
	}
	if got, _ := e.eng.Wake(ctx); got != 0 {
		t.Errorf("a session read through is read again: %d", got)
	}
}

func TestTheCapLeavesOtherSessionsForTheNextWake(t *testing.T) {
	e := newEnv(t, twoMemories)
	e.longSession(t, 60)
	e.session(t, "short", "acme-api", time.Hour, [2]string{"Why?", long})
	ctx := context.Background()
	total := 0
	for i := 0; i < 6; i++ {
		before := e.calls
		got, err := e.eng.Wake(ctx)
		if err != nil || got > Batch || e.calls-before > Batch {
			t.Fatalf("wake %d: read %d, calls %d, err %v", i+1, got, e.calls-before, err)
		}
		total += got
	}
	if len(runsOf(t, e, "short")) != 1 || total != e.calls {
		t.Errorf("the short session was not read once after the long one: %d calls", e.calls)
	}
}

func TestAChunkThatFailsStopsTheSessionWithoutMovingItsCursor(t *testing.T) {
	calls := 0
	e := newEnv(t, func(r Request) (Result, error) {
		calls++
		if calls == 2 {
			return Result{}, fmt.Errorf("rate limited")
		}
		return twoMemories(r)
	})
	ids := e.longSession(t, 60)
	if n, _ := e.eng.Wake(context.Background()); n != 2 {
		t.Fatalf("read %d, want the first chunk and the failed second", n)
	}
	runs := runsOf(t, e, "long")
	if len(runs) != 2 || runs[0].Status != store.BrainRunOK || runs[1].Status != store.BrainRunFailed || runs[0].ThroughEventID >= ids[59] {
		t.Fatalf("runs: %+v", runs)
	}
	// The retry, after the wait, starts where the first chunk ended.
	e.now = e.now.Add(time.Hour)
	if n, _ := e.eng.Wake(context.Background()); n == 0 {
		t.Fatal("no retry")
	}
	first := sent(e.reqs[0])
	if s := sent(e.reqs[2]); len(s) == 0 || s[0] != first[len(first)-1]+1 {
		t.Errorf("the retry sent %v after %v", s, first)
	}
}

func TestASessionWithinBudgetIsOneReadToItsEnd(t *testing.T) {
	e := newEnv(t, twoMemories)
	ids := e.longSession(t, 5)
	if n, _ := e.eng.Wake(context.Background()); n != 1 || e.calls != 1 {
		t.Fatalf("read %d, calls %d", n, e.calls)
	}
	runs := runsOf(t, e, "long")
	if len(runs) != 1 || runs[0].FromEventID != 0 || runs[0].ThroughEventID != ids[4] || len(sent(e.reqs[0])) != 5 {
		t.Errorf("runs %+v, sent %v", runs, sent(e.reqs[0]))
	}
}

func TestTheEstimateCountsEveryChunk(t *testing.T) {
	e := newEnv(t, twoMemories)
	e.longSession(t, 60)
	est, err := e.eng.EstimateFrom(context.Background(), e.cfg.Since)
	if err != nil {
		t.Fatal(err)
	}
	// Several reads of about 24,000 characters, each with its fixed cost.
	if est.Sessions != 1 || est.Tokens < 5*(MaxInputChars/4+OverheadTokens) {
		t.Errorf("estimate %+v", est)
	}
}
