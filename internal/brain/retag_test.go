package brain

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// memories adds n memories titled in accented Latin, without keywords
// unless tagged, and returns their ids in order.
func (e *env) memories(t *testing.T, n int, tagged bool) []int64 {
	t.Helper()
	var ids []int64
	for i := 0; i < n; i++ {
		v := store.BrainNode{Kind: store.BrainDecision, Title: fmt.Sprintf("Décision numéro %d: garder le cache", i),
			Summary: "Le cache reste local.", Manual: true}
		if tagged {
			v.Keywords = []string{"cache", "local"}
		}
		node, _, err := store.InsertBrainNode(context.Background(), e.st.DB(), v, e.now.UnixMilli())
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, node.ID)
	}
	return ids
}

var promptID = regexp.MustCompile(`(?m)^#(\d+) `)

// sentIDs is the memory ids a re-tag prompt lists, in order.
func sentIDs(prompt string) []int64 {
	var out []int64
	for _, m := range promptID.FindAllStringSubmatch(prompt, -1) {
		id, _ := strconv.ParseInt(m[1], 10, 64)
		out = append(out, id)
	}
	return out
}

// tagAnswer answers a re-tag for the ids given, as claude's structured
// output would carry it.
func tagAnswer(ids []int64, tokens int64) Result {
	type tag struct {
		ID       int64    `json:"id"`
		Keywords []string `json:"keywords"`
	}
	var a struct {
		Tags []tag `json:"tags"`
	}
	for _, id := range ids {
		a.Tags = append(a.Tags, tag{ID: id, Keywords: []string{"cache", "local storage", fmt.Sprintf("decision %d", id)}})
	}
	b, _ := json.Marshal(a)
	return Result{JSON: b, Model: "claude-haiku-test", TokensIn: tokens, TokensOut: 100, CostUSD: 0.001}
}

func tagAll(r Request) (Result, error) { return tagAnswer(sentIDs(r.Prompt), 5000), nil }

func keywordsOf(t *testing.T, e *env, id int64) store.BrainKeywords {
	t.Helper()
	n, err := store.GetBrainNode(context.Background(), e.st.DB(), id)
	if err != nil {
		t.Fatal(err)
	}
	return n.Keywords
}

func retagRuns(t *testing.T, e *env) (ok, failed, skipped int) {
	t.Helper()
	rows, err := e.st.DB().Query(`SELECT status FROM brain_runs WHERE session_id = ?`, store.BrainRetagSession)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		switch s {
		case store.BrainRunOK:
			ok++
		case store.BrainRunFailed:
			failed++
		case store.BrainRunSkipped:
			skipped++
		}
	}
	return ok, failed, skipped
}

func TestRetagSendsBatchesOfFortyAndCountsItsTokens(t *testing.T) {
	e := newEnv(t, tagAll)
	ids := e.memories(t, 90, false)
	ctx := context.Background()
	if st := e.eng.Status(ctx); st.Retag == nil || st.Retag.Done != 0 || st.Retag.Total != 90 {
		t.Fatalf("before: %+v", st.Retag)
	}
	n, err := e.eng.Wake(ctx)
	if err != nil || n != 3 || e.calls != 3 {
		t.Fatalf("wake: %d calls %d err %v", n, e.calls, err)
	}
	for i, want := range []int{40, 40, 10} {
		r := e.reqs[i]
		if got := len(sentIDs(r.Prompt)); got != want || r.Schema != RetagSchema || r.System != RetagSystem || r.Model != DefaultModel {
			t.Errorf("call %d: %d ids, schema %v", i, got, r.Schema == RetagSchema)
		}
	}
	if got := sentIDs(e.reqs[1].Prompt)[0]; got != ids[40] {
		t.Errorf("the second batch starts at %d, want %d", got, ids[40])
	}
	for _, id := range ids {
		if kw := keywordsOf(t, e, id); len(kw) != 3 || kw[0] != "cache" {
			t.Fatalf("memory %d: %v", id, kw)
		}
	}
	// Searchable in English now.
	found, err := store.ReadBrainGraph(ctx, e.st.DB(), store.BrainFilter{Query: "local storage"})
	if err != nil || found.Total != 90 {
		t.Fatalf("search: %d, %v", found.Total, err)
	}
	ok, _, _ := retagRuns(t, e)
	st := e.eng.Status(ctx)
	if ok != 3 || st.Spent != 3*5100 || st.SpentUSD < 0.0029 || st.Retag != nil {
		t.Errorf("runs %d, spent %d, usd %v, retag %+v", ok, st.Spent, st.SpentUSD, st.Retag)
	}
	for _, r := range st.Recent {
		if r.SessionID == store.BrainRetagSession {
			t.Error("a re-tag batch is not listed among the reads")
		}
	}
	// Nothing left: the next wake calls nothing.
	if n, _ := e.eng.Wake(ctx); n != 0 || e.calls != 3 {
		t.Errorf("after: %d, calls %d", n, e.calls)
	}
}

func TestRetagSkipsMemoriesWithKeywordsAndResumes(t *testing.T) {
	e := newEnv(t, tagAll)
	ctx := context.Background()
	tagged := e.memories(t, 5, true)
	untagged := e.memories(t, 50, false)
	// A daily limit one batch fills: the first wake makes one call.
	e.cfg.DailyTokens = 5000
	if n, err := e.eng.Wake(ctx); err != nil || n != 1 {
		t.Fatalf("first wake: %d %v", n, err)
	}
	for _, id := range sentIDs(e.reqs[0].Prompt) {
		for _, tg := range tagged {
			if id == tg {
				t.Fatalf("memory %d already had keywords and was sent", id)
			}
		}
	}
	if st := e.eng.Status(ctx); st.Retag == nil || st.Retag.Done != 40 || st.Retag.Total != 50 {
		t.Fatalf("progress: %+v", st.Retag)
	}
	if kw := keywordsOf(t, e, tagged[0]); len(kw) != 2 {
		t.Errorf("a tagged memory was changed: %v", kw)
	}
	// The limit holds: no call until it rolls over.
	if n, _ := e.eng.Wake(ctx); n != 0 || e.calls != 1 {
		t.Fatalf("at the limit: %d, calls %d", n, e.calls)
	}
	e.now = e.now.Add(25 * time.Hour)
	if n, _ := e.eng.Wake(ctx); n != 1 || e.calls != 2 {
		t.Fatalf("after the day: %d, calls %d", n, e.calls)
	}
	sent := sentIDs(e.reqs[1].Prompt)
	if len(sent) != 10 || sent[0] != untagged[40] {
		t.Errorf("resumed with %v", sent)
	}
}

func TestRetagKeepsOnlyTheIDsItSent(t *testing.T) {
	e := newEnv(t, nil)
	ctx := context.Background()
	other := e.memories(t, 1, true)[0]
	ids := e.memories(t, 45, false)
	e.eng.Runner = RunnerFunc(func(_ context.Context, r Request) (Result, error) {
		e.calls++
		sent := sentIDs(r.Prompt)
		// An id of a memory not in this batch, one of a memory that has
		// keywords, one that does not exist, and the first one left out.
		return tagAnswer(append(sent[1:], ids[44], other, 99999), 1000), nil
	})
	e.cfg.DailyTokens = 1000
	if n, err := e.eng.Wake(ctx); err != nil || n != 1 {
		t.Fatalf("wake: %d %v", n, err)
	}
	if kw := keywordsOf(t, e, ids[44]); len(kw) != 0 {
		t.Errorf("a memory outside the batch was tagged: %v", kw)
	}
	if kw := keywordsOf(t, e, other); len(kw) != 2 {
		t.Errorf("a memory with keywords was changed: %v", kw)
	}
	if kw := keywordsOf(t, e, ids[0]); len(kw) != 0 {
		t.Errorf("an unanswered memory got keywords: %v", kw)
	}
	var nodes int
	if err := e.st.DB().QueryRow(`SELECT nodes FROM brain_runs WHERE session_id = ?`, store.BrainRetagSession).Scan(&nodes); err != nil || nodes != 39 {
		t.Errorf("nodes %d %v", nodes, err)
	}
	// The unanswered one is passed over, not asked again: the next batch
	// starts after the first one.
	e.now = e.now.Add(25 * time.Hour)
	var next []int64
	e.eng.Runner = RunnerFunc(func(_ context.Context, r Request) (Result, error) {
		next = sentIDs(r.Prompt)
		return tagAnswer(next, 10), nil
	})
	if _, err := e.eng.Wake(ctx); err != nil || len(next) != 5 || next[0] != ids[40] {
		t.Errorf("next batch %v %v", next, err)
	}
}

func TestRetagOnlyWhileOnAndAfterTheReads(t *testing.T) {
	e := newEnv(t, func(r Request) (Result, error) {
		if r.Schema == RetagSchema {
			return tagAll(r)
		}
		return twoMemories(r)
	})
	ctx := context.Background()
	e.memories(t, 3, false)
	off := false
	e.cfg.Auto = &off
	if n, _ := e.eng.Wake(ctx); n != 0 || e.calls != 0 {
		t.Fatalf("off: %d, calls %d", n, e.calls)
	}
	if st := e.eng.Status(ctx); st.Retag != nil {
		t.Errorf("off, the status has %+v", st.Retag)
	}
	e.cfg.Auto = on()
	e.session(t, "s1", "acme-api", 20*time.Minute, [2]string{"Why is the cache test flaky?", long})
	if n, _ := e.eng.Wake(ctx); n != 1 || e.calls != 1 || e.reqs[0].Schema != "" {
		t.Fatalf("a waiting session goes first: %d, calls %d", n, e.calls)
	}
	if n, _ := e.eng.Wake(ctx); n != 1 || e.calls != 2 || e.reqs[1].Schema != RetagSchema {
		t.Fatalf("then the re-tag: %d, calls %d", n, e.calls)
	}
}

func TestRetagGivesUpOnABatchThatKeepsFailing(t *testing.T) {
	fail := true
	e := newEnv(t, func(r Request) (Result, error) {
		if fail {
			return Result{TokensIn: 100}, errors.New("claude: overloaded")
		}
		return tagAll(r)
	})
	ctx := context.Background()
	ids := e.memories(t, 45, false)
	for i := 0; i < MaxFailures; i++ {
		if n, err := e.eng.Wake(ctx); err != nil || n != 1 {
			t.Fatalf("failure %d: %d %v", i, n, err)
		}
		// Within the wait nothing is called. After the last failure the
		// next wake gives the batch up instead.
		if i < MaxFailures-1 {
			if n, _ := e.eng.Wake(ctx); n != 0 {
				t.Fatalf("retried at once after failure %d", i)
			}
		}
		e.now = e.now.Add(retryAfter << i)
	}
	fail = false
	if n, err := e.eng.Wake(ctx); err != nil || n != 1 {
		t.Fatalf("after giving up: %d %v", n, err)
	}
	ok, failed, skipped := retagRuns(t, e)
	if ok != 1 || failed != MaxFailures || skipped != 1 {
		t.Errorf("runs ok %d failed %d skipped %d", ok, failed, skipped)
	}
	if kw := keywordsOf(t, e, ids[0]); len(kw) != 0 {
		t.Error("the given-up batch was tagged")
	}
	if kw := keywordsOf(t, e, ids[44]); len(kw) == 0 {
		t.Error("the batch after it was not")
	}
	if st := e.eng.Status(ctx); st.Spent != MaxFailures*100+5100 {
		t.Errorf("failed calls' tokens count too: %d", st.Spent)
	}
}

// The real runner against testdata/fakeclaude: a re-tag request carries its
// own schema and its answer comes back as JSON.
func TestRetagAgainstTheFakeClaude(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the fake claude")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "claude")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	root, _ := filepath.Abs("../..")
	cmd := exec.Command("go", "build", "-o", bin, "./testdata/fakeclaude")
	cmd.Dir = root
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fake claude: %v\n%s", err, out)
	}
	r := ClaudeRunner{Binary: func() string { return bin }, Dir: filepath.Join(dir, "work"), Timeout: time.Minute}
	mems := []store.BrainNode{{ID: 7, Kind: "decision", Title: "Héros sans compte ni cloud", Summary: "Local only."}, {ID: 9, Kind: "idea", Title: "Cache tests"}}
	res, err := r.Run(context.Background(), Request{System: RetagSystem, Prompt: RetagPrompt(mems), Model: "haiku", Schema: RetagSchema})
	if err != nil {
		t.Fatal(err)
	}
	tags, err := ParseRetag(res.JSON, mems[:1])
	if err != nil || len(tags) != 1 || len(tags[7]) == 0 {
		t.Fatalf("%v %v (%s)", tags, err, res.JSON)
	}
	args, _ := Argv(Request{Schema: RetagSchema}, "s.json", false)
	if args[len(args)-1] != RetagSchema {
		t.Errorf("argv: %v", args)
	}
}
