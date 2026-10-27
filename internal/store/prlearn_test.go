package store

import (
	"context"
	"math"
	"testing"
)

// learnFixture is a repository /r whose pull requests GitHub listed
// (github_prs) and whose sessions ran Bash calls over some of their stamps.
type learnFixture struct {
	t   *testing.T
	ctx context.Context
	st  *Store
	n   int
}

func newLearnFixture(t *testing.T) *learnFixture {
	t.Helper()
	ctx := context.Background()
	st, err := Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	// The memo is keyed by the database's address, which a closed one's
	// successor may reuse; each test starts it empty.
	learnMemo.mu.Lock()
	learnMemo.m = map[string]learnHit{}
	learnMemo.mu.Unlock()
	return &learnFixture{t: t, ctx: ctx, st: st}
}

func (f *learnFixture) exec(sql string, args ...any) {
	f.t.Helper()
	if _, err := f.st.DB().ExecContext(f.ctx, sql, args...); err != nil {
		f.t.Fatal(err)
	}
}

// session adds a session of /r (or another root) with its recorded total.
func (f *learnFixture) session(id, root, branch string, cost float64) {
	f.t.Helper()
	f.exec(`INSERT INTO sessions(session_id, cwd, status, git_branch, repo_root) VALUES(?,?,?,?,?)`, id, root, "ended", branch, root)
	f.exec(`INSERT INTO session_stats(session_id, cost_usd) VALUES(?,?)`, id, cost)
}

// spend is one paid turn of a session at ts.
func (f *learnFixture) spend(id string, ts int64, cost float64) {
	f.t.Helper()
	f.exec(`INSERT INTO events(ts, sid, source, kind, payload, cost_usd) VALUES(?,(SELECT sid FROM sessions WHERE session_id = ?),?,?,?,?)`, ts, id, "transcript", "turn.assistant", "{}", cost)
}

// bash is a Bash call of a session from pre to post, paired by its id.
func (f *learnFixture) bash(id string, pre, post int64) {
	f.t.Helper()
	f.n++
	tu := "toolu_" + string(rune('a'+f.n))
	f.exec(`INSERT INTO events(ts, sid, source, kind, tool, payload, key) VALUES(?,(SELECT sid FROM sessions WHERE session_id = ?),?,?,?,?,?)`, pre, id, "hook", "tool.pre", "Bash", "{}", "pre:"+tu)
	f.exec(`INSERT INTO events(ts, sid, source, kind, tool, payload, key) VALUES(?,(SELECT sid FROM sessions WHERE session_id = ?),?,?,?,?,?)`, post, id, "hook", "tool.post", "Bash", "{}", "post:"+tu)
}

// pr is a pull request header GitHub listed for o/r.
func (f *learnFixture) pr(n int, head string, created, merged int64) string {
	f.t.Helper()
	url := PRURLPrefix("o/r") + string(rune('0'+n))
	state := "open"
	if merged > 0 {
		state = "merged"
	}
	f.exec(`INSERT INTO github_prs(repo, number, url, head, state, created_at, merged_at, updated_at, seen_at) VALUES(?,?,?,?,?,?,?,?,?)`,
		"o/r", n, url, head, state, created, merged, max(created, merged), 1)
	return url
}

func (f *learnFixture) charge(prs ...PRRef) map[string]PRSpend {
	f.t.Helper()
	got, err := SpendByPR(f.ctx, f.st.DB(), "/r", prs)
	if err != nil {
		f.t.Fatal(err)
	}
	return got
}

func near(x, y float64) bool { return math.Abs(x-y) < 1e-9 }

// A pull request a script made — no `gh pr` command recorded — is the one
// session's that had a Bash call running over GitHub's stamp, cut from its
// spend as if it had recorded the opening at the call's end.
func TestLearnedPROneSession(t *testing.T) {
	f := newLearnFixture(t)
	f.session("orch", "/r", "master", 10)
	f.spend("orch", 1000, 4)
	f.spend("orch", 9000, 6) // after the opening: the newest one's
	f.bash("orch", 4000, 6500)
	a := f.pr(1, "batch/1", 5000, 0) // stamp inside the call
	got := f.charge(PRRef{URL: a, Branch: "batch/1"})
	if x := got[a]; !near(x.CostUSD, 10) || x.Sessions != 1 || !near(x.BySlice, 10) {
		t.Fatalf("#1 = %+v, want the session whole", x)
	}

	// A second one it made later cuts it: the first is charged up to the
	// call's end (6500), the second the rest.
	f.bash("orch", 8000, 8600)
	b := f.pr(2, "batch/2", 8000, 0)
	got = f.charge(PRRef{URL: a, Branch: "batch/1"}, PRRef{URL: b, Branch: "batch/2"})
	if !near(got[a].CostUSD, 4) || !near(got[b].CostUSD, 6) || got[a].Shared != 1 {
		t.Fatalf("#1 %+v #2 %+v, want 4 and 6", got[a], got[b])
	}
	// The cut does not depend on which pull requests are asked for.
	if one := f.charge(PRRef{URL: a, Branch: "batch/1"}); !near(one[a].CostUSD, 4) {
		t.Fatalf("#1 alone = %+v, want 4", one[a])
	}
}

// A stamp no call was running over, or one two sessions' calls were, stays
// unattributed: nothing is guessed.
func TestLearnedPRNoneOrSeveral(t *testing.T) {
	f := newLearnFixture(t)
	f.session("s1", "/r", "master", 5)
	f.spend("s1", 100, 5)
	f.session("s2", "/r", "master", 7)
	f.spend("s2", 100, 7)
	// Ended before the stamp, began after its second: neither is over it.
	f.bash("s1", 1000, 4999)
	f.bash("s1", 6000, 7000)
	none := f.pr(1, "x/1", 5000, 0)
	// Two sessions' calls over the same stamp.
	f.bash("s1", 19000, 21000)
	f.bash("s2", 19500, 20500)
	two := f.pr(2, "x/2", 20000, 0)
	// A session of another repository over a stamp is not a match.
	f.session("far", "/elsewhere", "master", 3)
	f.bash("far", 29000, 31000)
	other := f.pr(3, "x/3", 30000, 0)
	got := f.charge(PRRef{URL: none, Branch: "x/1"}, PRRef{URL: two, Branch: "x/2"}, PRRef{URL: other, Branch: "x/3"})
	for _, u := range []string{none, two, other} {
		if got[u].CostUSD != 0 || got[u].Sessions != 0 {
			t.Errorf("%s = %+v, want unattributed", u, got[u])
		}
	}
	// One of several calls of a single session (a subagent's beside the
	// main thread's) is still one session.
	f.bash("s2", 39000, 41000)
	f.bash("s2", 39500, 40200)
	one := f.pr(4, "x/4", 40000, 0)
	if x := f.charge(PRRef{URL: one, Branch: "x/4"})[one]; !near(x.CostUSD, 7) || x.Sessions != 1 {
		t.Fatalf("#4 = %+v, want s2 whole", x)
	}
}

// A session that recorded pull requests normally and made one by a script
// is cut between all of them; a recorded opening is never re-matched; a
// merge another session's call ran over gives that session a row at it; and
// every session is charged once, so the figures add up to what they cost.
func TestLearnedPRWithRecordedAndNoDoubleCharge(t *testing.T) {
	f := newLearnFixture(t)
	f.session("orch", "/r", "master", 9)
	f.spend("orch", 500, 1)
	f.spend("orch", 1500, 2)
	f.spend("orch", 2500, 3)
	f.spend("orch", 3500, 3)
	rec := f.pr(1, "feat/1", 1000, 4000) // merged at 4000, below
	f.exec(`INSERT INTO session_prs(session_id, url, number, opened_at, last_at) VALUES('orch',?,1,1000,1000)`, rec)
	// A call over #1's stamp too: recorded already, so not matched again.
	f.bash("orch", 900, 1100)
	f.bash("orch", 1900, 2100)
	script := f.pr(2, "batch/2", 2000, 0)
	rec3 := f.pr(3, "feat/3", 3000, 0)
	f.exec(`INSERT INTO session_prs(session_id, url, number, opened_at, last_at) VALUES('orch',?,3,3000,3000)`, rec3)

	// #1 was merged by a script another session was waiting on.
	f.session("wait", "/r", "", 4)
	f.spend("wait", 100, 4)
	f.bash("wait", 3900, 4100)

	refs := []PRRef{{URL: rec, Branch: "feat/1"}, {URL: script, Branch: "batch/2"}, {URL: rec3, Branch: "feat/3"}}
	got := f.charge(refs...)
	if !near(got[rec].CostUSD, 1+4) || !near(got[script].CostUSD, 2) || !near(got[rec3].CostUSD, 3+3) {
		t.Fatalf("#1 %v #2 %v #3 %v, want 5 (1 and wait's 4), 2, 6", got[rec].CostUSD, got[script].CostUSD, got[rec3].CostUSD)
	}
	total := 0.0
	for _, r := range refs {
		total += got[r.URL].CostUSD
	}
	if !near(total, 9+4) {
		t.Fatalf("charged %v, the sessions cost %v", total, 9+4)
	}
	// The stored rows are what the sessions ran: nothing is written.
	var n int
	if err := f.st.DB().QueryRowContext(f.ctx, `SELECT COUNT(*) FROM session_prs`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("session_prs rows %d (%v), want the 2 recorded", n, err)
	}
}

// A session on a pull request's head branch stays charged to it whole when
// what it was matched to is its only pull request, and is cut once it drove
// two — a recorded one and a learned one counted once each.
func TestLearnedPRBranchSession(t *testing.T) {
	f := newLearnFixture(t)
	f.session("wrk", "/r", "feat/a", 6)
	f.spend("wrk", 500, 2)
	f.spend("wrk", 1500, 4)
	f.bash("wrk", 900, 1100)
	a := f.pr(1, "feat/a", 1000, 0)
	got := f.charge(PRRef{URL: a, Branch: "feat/a"})
	if x := got[a]; !near(x.CostUSD, 6) || !near(x.ByBranch, 6) {
		t.Fatalf("#1 = %+v, want the branch session whole", x)
	}
	b := f.pr(2, "feat/b", 1200, 0)
	f.exec(`INSERT INTO session_prs(session_id, url, number, opened_at, last_at) VALUES('wrk',?,2,1200,1200)`, b)
	got = f.charge(PRRef{URL: a, Branch: "feat/a"}, PRRef{URL: b, Branch: "feat/b"})
	if !near(got[a].CostUSD, 2) || !near(got[b].CostUSD, 4) || got[a].ByBranch != 0 {
		t.Fatalf("#1 %+v #2 %+v, want 2 and 4 by slice", got[a], got[b])
	}
}

// A settled stamp's match is kept; one still young is matched afresh, so a
// call that has not ended yet can still be found.
func TestLearnedPRSettles(t *testing.T) {
	f := newLearnFixture(t)
	old := learnNow
	t.Cleanup(func() { learnNow = old })
	learnNow = func() int64 { return 1000 + learnLookback/2 }
	f.session("s", "/r", "", 3)
	f.spend("s", 100, 3)
	a := f.pr(1, "x/1", 1000, 0)
	if x := f.charge(PRRef{URL: a})[a]; x.CostUSD != 0 {
		t.Fatalf("before the call ends: %+v", x)
	}
	f.bash("s", 900, 2000) // its PostToolUse arrives later
	if x := f.charge(PRRef{URL: a})[a]; !near(x.CostUSD, 3) {
		t.Fatalf("after the call ended: %+v, want 3", x)
	}
	if got := prRepo("https://github.com/o/r/pull/7"); got != "o/r" {
		t.Fatalf("prRepo = %q", got)
	}
	if got := prRepo("https://gitlab.com/o/r/-/merge_requests/7"); got != "" {
		t.Fatalf("prRepo of another host = %q", got)
	}
}
