package brain

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// A made-up key: the privacy filter's own tests use the same shape.
const fakeKey = "sk-ant-api03-AbCdEf0123456789xyzXYZ_abcd"

// runsOf is the status and memories of each of a session's reads, oldest
// first.
func (e *env) runsOf(t *testing.T, session string) (status []string, nodes []int, tokens int64) {
	t.Helper()
	rows, err := e.st.DB().QueryContext(context.Background(), `SELECT status, nodes, tokens_in + tokens_out FROM brain_runs WHERE session_id = ? ORDER BY id`, session)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var s string
		var n int
		var tok int64
		if err := rows.Scan(&s, &n, &tok); err != nil {
			t.Fatal(err)
		}
		status, nodes, tokens = append(status, s), append(nodes, n), tokens+tok
	}
	return status, nodes, tokens
}

func (e *env) titles(t *testing.T) map[string]store.BrainNode {
	t.Helper()
	g, err := store.ReadBrainGraph(context.Background(), e.st.DB(), store.BrainFilter{Summaries: true})
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]store.BrainNode{}
	for _, n := range g.Nodes {
		out[n.Title] = n
	}
	return out
}

// One answer with a memory the model sent with no title, one with nothing
// at all, and one whose title is a secret: the read keeps every memory
// that can be kept, moves on, and is not asked again.
func TestOneBadMemoryNeverCostsTheReadTheRest(t *testing.T) {
	e := newEnv(t, func(Request) (Result, error) {
		return Result{
			Memories: []Memory{
				{Kind: "finding", Title: "  ## ", Summary: "The deploy key rotates every month. The old one stops at midnight.", Topics: []string{"deploy"}, Keywords: []string{"deploy"}},
				{Kind: "idea", Title: "", Summary: "   "},
				{Kind: "decision", Title: fakeKey, Summary: "Kept in the vault, never in the repository.", Topics: []string{"secrets"}, Keywords: []string{"vault"}},
				{Kind: "decision", Title: "Keep SQLite in WAL mode", Summary: "Postgres is too much for one machine.", Topics: []string{"SQLite", " / "}, Keywords: []string{"sqlite"}},
			},
			TokensIn: 4000, TokensOut: 200,
		}, nil
	})
	e.session(t, "s1", "acme-api", 20*time.Minute, [2]string{"Why is the cache test flaky?", long}, [2]string{"And the store?", long})
	if n, err := e.eng.Wake(context.Background()); err != nil || n != 1 {
		t.Fatalf("wake: read %d, err %v", n, err)
	}
	status, nodes, _ := e.runsOf(t, "s1")
	if len(status) != 1 || status[0] != store.BrainRunOK || nodes[0] != 3 {
		t.Fatalf("runs %v, memories %v: want one ok read keeping 3", status, nodes)
	}
	got := e.titles(t)
	if _, ok := got["The deploy key rotates every month"]; !ok {
		t.Errorf("a memory with no title takes its summary's first sentence: %v", keys(got))
	}
	if _, ok := got["Keep SQLite in WAL mode"]; !ok {
		t.Errorf("the good memory is kept: %v", keys(got))
	}
	for title := range got {
		if strings.Contains(title, "sk-ant") {
			t.Errorf("a secret title is kept: %q", title)
		}
	}
	if _, ok := got["[redacted: api key]"]; !ok {
		t.Errorf("a title that was a secret is kept as its placeholder: %v", keys(got))
	}
	if st := e.eng.Status(context.Background()); st.LastError != "" {
		t.Errorf("a read that kept its memories reports no problem: %q", st.LastError)
	}
	// The cursor moved: nothing is left to ask about.
	calls := e.calls
	e.now = e.now.Add(time.Hour)
	if _, err := e.eng.Wake(context.Background()); err != nil || e.calls != calls {
		t.Fatalf("the same chunk was asked again: calls %d → %d, err %v", calls, e.calls, err)
	}
}

func keys(m map[string]store.BrainNode) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestTitleFromSummary(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"The deploy key rotates every month. The old one stops.", "The deploy key rotates every month"},
		{"## Heading words\nand the rest", "Heading words"},
		{"one two three four five six seven eight nine ten eleven twelve", "one two three four five six seven eight nine ten…"},
		{"The key " + fakeKey + " lives in .env", "The key [redacted: api key] lives in .env"},
		{"", ""},
		{"  \n ", ""},
	} {
		if got := titleFromSummary(c.in); got != c.want {
			t.Errorf("titleFromSummary(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// A background claude run in "/" was labelled "/", a title no project can
// have: every read of it failed whole and was asked again at once, 3,363
// times in 13 hours (2026-10-22). Since 2026-10-24 a session in the root is
// not read at all (store.RootOrHome): it is marked skipped once, nothing is
// sent, and it is not asked again.
func TestASessionInTheFilesystemRootIsNotRead(t *testing.T) {
	e := newEnv(t, twoMemories)
	e.session(t, "s1", "", 20*time.Minute, [2]string{"Why is the cache test flaky?", long}, [2]string{"And the store?", long})
	e.inDir(t, "s1", "/", 20*time.Minute)
	if n, err := e.eng.Wake(context.Background()); err != nil || n != 0 || e.calls != 0 {
		t.Fatalf("wake: read %d, calls %d, err %v", n, e.calls, err)
	}
	status, _, _ := e.runsOf(t, "s1")
	if len(status) != 1 || status[0] != store.BrainRunSkipped {
		t.Fatalf("runs %v", status)
	}
	e.now = e.now.Add(time.Hour)
	if _, err := e.eng.Wake(context.Background()); err != nil || e.calls != 0 {
		t.Fatalf("asked again: calls %d, err %v", e.calls, err)
	}
	if status, _, _ := e.runsOf(t, "s1"); len(status) != 1 {
		t.Fatalf("marked again: %v", status)
	}
}

// Should a project the store refuses still reach keep, the memories are
// kept in no project rather than failing the read.
func TestKeepLeavesARefusedProjectOut(t *testing.T) {
	e := newEnv(t, twoMemories)
	res, _ := twoMemories(Request{})
	var added []store.BrainNode
	err := e.st.WithTx(context.Background(), func(q store.Querier) error {
		var err error
		added, _, err = keep(context.Background(), q, 0, store.BrainCandidate{SessionID: "s1", Project: "/"}, Input{}, res.Memories, 1)
		return err
	})
	if err != nil || len(added) != 2 {
		t.Fatalf("kept %d, err %v", len(added), err)
	}
	for _, n := range added {
		if n.Source.Project != "/" && n.Source.Project != "" {
			t.Errorf("project %q", n.Source.Project)
		}
	}
}

// An answer that comes back but cannot be stored is a failed read on
// record: its tokens count toward the day's limit and the session waits
// out the retry, rather than being asked again at the next wake.
func TestAnAnswerThatCannotBeStoredIsAFailedRead(t *testing.T) {
	e := newEnv(t, twoMemories)
	e.session(t, "s1", "acme-api", 20*time.Minute, [2]string{"Why is the cache test flaky?", long}, [2]string{"And the store?", long})
	ctx := context.Background()
	c, ok, err := store.BrainSessionCandidate(ctx, e.st.DB(), "s1")
	if err != nil || !ok {
		t.Fatalf("candidate: %v %v", ok, err)
	}
	in, upTo, err := chunk(ctx, e.st.DB(), c, nil, Known{})
	if err != nil {
		t.Fatal(err)
	}
	run := store.BrainRun{SessionID: "s1", FromEventID: c.Cursor, ThroughEventID: upTo, StartedAt: e.now.UnixMilli(), Model: DefaultModel}
	boom := errors.New("disk I/O error")
	if err := e.eng.ask(ctx, c, in, run, func(store.Querier) error { return boom }); !errors.Is(err, boom) {
		t.Fatalf("ask: %v", err)
	}
	status, _, tokens := e.runsOf(t, "s1")
	if len(status) != 1 || status[0] != store.BrainRunFailed || tokens != 4200 {
		t.Fatalf("runs %v, tokens %d: want one failed read with its 4200 tokens", status, tokens)
	}
	if n, _, err := store.BrainFailures(ctx, e.st.DB(), "s1"); err != nil || n != 1 {
		t.Fatalf("failures %d, err %v", n, err)
	}
	if spent := e.eng.spent(ctx); spent != 4200 {
		t.Errorf("spent %d: the tokens of a read that was not stored still count", spent)
	}
	// Waiting out the retry: the next wake does not ask again.
	calls := e.calls
	e.now = e.now.Add(time.Minute)
	if _, err := e.eng.Wake(ctx); err != nil || e.calls != calls {
		t.Fatalf("asked again within the retry: calls %d → %d, err %v", calls, e.calls, err)
	}
}
