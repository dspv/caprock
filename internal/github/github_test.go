package github

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/alerts"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/projects"
)

// A pasted token is checked with GitHub before anything is kept; the account,
// its scopes and the source then show, and the token is in the store only.
func TestConnectWithAPastedToken(t *testing.T) {
	x := newFixture(t)
	st, e := x.s.Connect(context.Background(), SourceToken, "  ghp_good \n")
	if e != nil {
		t.Fatal(e)
	}
	if !st.Connected || st.Source != SourceToken || st.User == nil || st.User.Login != "ada" {
		t.Fatalf("status: %+v", st)
	}
	if strings.Join(st.Scopes, ",") != "repo,read:org" || !st.ScopesKnown || st.TokenKind != "classic" {
		t.Fatalf("scopes: %+v", st)
	}
	if x.store.tok != "ghp_good" || x.cfg.source != SourceToken || !st.Sources.Stored {
		t.Fatalf("stored %q source %q", x.store.tok, x.cfg.source)
	}
	if st.Health.LastOKAt == 0 || st.Health.Rate == nil || st.Health.Rate.Remaining != 4990 {
		t.Fatalf("health: %+v", st.Health)
	}
}

// 401: a bad token is refused with a message that says what to do, and
// nothing is stored or switched.
func TestA401IsShownAndNothingIsKept(t *testing.T) {
	x := newFixture(t)
	_, e := x.s.Connect(context.Background(), SourceToken, "ghp_revoked")
	if e == nil || e.Kind != KindAuth || e.Status != 401 {
		t.Fatalf("want auth 401, got %+v", e)
	}
	for _, want := range []string{"Connecting GitHub", "rejected the token (401: Bad credentials)", "Paste a new token"} {
		if !strings.Contains(e.Error(), want) {
			t.Errorf("message %q lacks %q", e.Error(), want)
		}
	}
	if x.store.tok != "" || x.cfg.source != "" {
		t.Fatal("a refused token was kept")
	}
	if _, e := x.s.Connect(context.Background(), SourceToken, "two words"); e == nil || e.Kind != KindInvalid {
		t.Fatalf("a malformed token went out: %+v", e)
	}
	if n := len(x.f.requests()); n != 1 {
		t.Fatalf("the malformed token was sent: %d requests", n)
	}
}

// The GitHub CLI's login is used without being stored; a 401 reads it again
// once (the user may have run gh auth login since).
func TestTheGitHubCLILoginIsReadOnDemand(t *testing.T) {
	x := newFixture(t)
	x.store.tok = "ghp_old_pasted"
	x.gh.toks = []string{"ghp_good"}
	st, e := x.s.Connect(context.Background(), SourceGH, "")
	if e != nil || st.Source != SourceGH {
		t.Fatalf("connect: %+v %v", st, e)
	}
	if x.store.tok != "" {
		t.Fatal("choosing gh kept the pasted token")
	}
	// gh's login changes under Caprock: the cached token now 401s, the
	// fresh one works.
	x.f.mu.Lock()
	x.f.tokens = map[string]string{"gho_new": "ada"}
	x.f.mu.Unlock()
	x.gh.toks = []string{"gho_new"}
	if _, e := x.s.Repos(context.Background(), "", "", 1); e != nil {
		t.Fatalf("repos after gh re-login: %v", e)
	}
	if x.store.tok != "" {
		t.Fatal("the gh token was written to the store")
	}
}

// Without gh's login, connecting says so in gh's terms.
func TestConnectingWithoutAGHLoginSaysWhy(t *testing.T) {
	x := newFixture(t)
	x.gh.err = errors.New("the GitHub CLI has no login for github.com (not logged in); run `gh auth login` in a terminal")
	_, e := x.s.Connect(context.Background(), SourceGH, "")
	if e == nil || !strings.Contains(e.Error(), "gh auth login") {
		t.Fatalf("got %v", e)
	}
}

// 403 for a missing classic scope names the scope and how to add it.
func TestA403ForAMissingScopeNamesIt(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	x.f.failWith("POST /repos/ada/caprock/pulls", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-OAuth-Scopes", "read:org")
		w.Header().Set("X-Accepted-OAuth-Scopes", "repo")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"Resource not accessible by integration"}`))
	})
	x.wt.changes["feat-x"] = func() projects.Changes { c := x.wt.changes["feat-x"]; c.Published, c.Ahead = true, 0; return c }()
	_, err := x.s.CreatePR(context.Background(), 1, "feat-x", CreatePRRequest{Title: "T"})
	e := asError(t, err)
	if e.Kind != KindScope || len(e.Needs) != 1 || e.Needs[0] != "repo" {
		t.Fatalf("got %+v", e)
	}
	for _, want := range []string{"Opening the pull request", "lacks `repo`", "Paste one that has it"} {
		if !strings.Contains(strings.ToLower(e.Error()), strings.ToLower(want)) {
			t.Errorf("%q lacks %q", e.Error(), want)
		}
	}
	if st := x.s.Status(); st.Health.Error == nil || st.Health.Error.Kind != KindScope {
		t.Fatalf("the health line does not carry it: %+v", st.Health)
	}
}

// A fine-grained token's missing permission is named the same way.
func TestAFineGrainedTokensMissingPermissionIsNamed(t *testing.T) {
	x := newFixture(t)
	x.f.scopes = "-"
	x.connect(t)
	if st := x.s.Status(); st.ScopesKnown {
		t.Fatal("a fine-grained token's scopes were reported as known")
	}
	x.f.failWith("GET /user/repos", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Accepted-GitHub-Permissions", "metadata=read")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"Resource not accessible by personal access token"}`))
	})
	_, e := x.s.Repos(context.Background(), "", "", 1)
	if e == nil || e.Kind != KindScope || !strings.Contains(e.Error(), "metadata=read") {
		t.Fatalf("got %+v", e)
	}
}

// 404 says the thing is absent or invisible to the token.
func TestA404SaysAbsentOrInvisible(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	_, e := x.s.Repos(context.Background(), "nobody-org", "", 1)
	if e == nil || e.Kind != KindNotFound || !strings.Contains(e.Error(), "cannot see it (404)") || !strings.Contains(e.Error(), "Listing nobody-org's repositories") {
		t.Fatalf("got %+v", e)
	}
}

// A secondary rate limit with Retry-After pauses every request until it
// lifts — none is sent meanwhile — and says until when.
func TestASecondaryRateLimitPausesRequests(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	x.f.failWith("GET /user/repos", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "120")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}`))
	})
	_, e := x.s.Repos(context.Background(), "", "", 1)
	if e == nil || e.Kind != KindRateLimit || e.RetryAt != x.clock().Add(120*time.Second).UnixMilli() {
		t.Fatalf("got %+v", e)
	}
	if !strings.Contains(e.Error(), "waits 2m0s") || !strings.Contains(e.Error(), "secondary rate limit") {
		t.Fatalf("message: %q", e.Error())
	}
	before := len(x.f.requests())
	_, e = x.s.Owners(context.Background())
	if e == nil || e.Kind != KindRateLimit || len(x.f.requests()) != before {
		t.Fatalf("a request went out during the pause: %+v (%d → %d)", e, before, len(x.f.requests()))
	}
	if st := x.s.Status(); st.Health.PausedUntil != e.RetryAt {
		t.Fatalf("paused until %d, want %d", st.Health.PausedUntil, e.RetryAt)
	}
	x.advance(121 * time.Second)
	if _, e := x.s.Owners(context.Background()); e != nil {
		t.Fatalf("still paused after Retry-After: %v", e)
	}
}

// A spent primary limit waits for its reset.
func TestASpentPrimaryLimitWaitsForReset(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	reset := x.clock().Add(30 * time.Minute)
	x.f.failWith("GET /user/orgs", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(reset.Unix(), 10))
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"API rate limit exceeded for user ID 1."}`))
	})
	_, e := x.s.Owners(context.Background())
	if e == nil || e.Kind != KindRateLimit || e.RetryAt != reset.UnixMilli() {
		t.Fatalf("got %+v", e)
	}
}

// Network down: the message names the host and says Caprock tries again.
func TestNetworkDownIsShown(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	x.f.srv.Close()
	_, e := x.s.Repos(context.Background(), "", "", 1)
	if e == nil || e.Kind != KindNetwork || !strings.Contains(e.Error(), "could not reach GitHub (127.0.0.1") {
		t.Fatalf("got %+v", e)
	}
	if st := x.s.Status(); st.Health.Error == nil || st.Health.Error.Kind != KindNetwork {
		t.Fatalf("health: %+v", st.Health)
	}
}

// Conditional requests: the second read of an unchanged list carries the
// ETag, gets a 304 and still answers with the list.
func TestUnchangedAnswersAre304s(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	x.f.repos = []map[string]any{{"full_name": "ada/one", "name": "one", "owner": map[string]any{"login": "ada"}, "private": true, "clone_url": "https://github.com/ada/one.git"}}
	a, e := x.s.Repos(context.Background(), "", "", 1)
	if e != nil || len(a.Repos) != 1 || !a.Next || !a.Repos[0].Private {
		t.Fatalf("first: %+v %v", a, e)
	}
	b, e := x.s.Repos(context.Background(), "", "", 1)
	if e != nil || len(b.Repos) != 1 || b.Repos[0].FullName != "ada/one" || !b.Next {
		t.Fatalf("second: %+v %v", b, e)
	}
	reqs := x.f.requests()
	if last := reqs[len(reqs)-1]; !strings.HasSuffix(last, "[conditional]") {
		t.Fatalf("the second read was not conditional: %s", last)
	}
}

// A search is limited to the account and its organizations.
func TestSearchIsLimitedToYourOwners(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	x.f.orgs = []string{"acme"}
	p, e := x.s.Repos(context.Background(), "", "cap", 1)
	if e != nil || !p.Search {
		t.Fatalf("%+v %v", p, e)
	}
	var q string
	for _, r := range x.f.requests() {
		if strings.Contains(r, "/search/repositories") {
			q = r
		}
	}
	for _, want := range []string{"cap+in%3Aname", "user%3Aada", "org%3Aacme"} {
		if !strings.Contains(q, want) {
			t.Errorf("search %q lacks %q", q, want)
		}
	}
}

// Disconnecting removes only what Caprock stored; the GitHub CLI's login is
// never touched, and the PRs followed are dropped.
func TestDisconnectClearsOnlyWhatCaprockStored(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	st, err := x.s.Disconnect(context.Background())
	if err != nil || st.Connected || x.store.tok != "" || x.cfg.source != "" || st.Sources.Stored {
		t.Fatalf("%+v %v", st, err)
	}
	if _, e := x.s.Repos(context.Background(), "", "", 1); e == nil || e.Kind != KindNotConnected || !strings.Contains(e.Error(), "Settings → GitHub") {
		t.Fatalf("after disconnect: %+v", e)
	}
	x.gh.calls = 0
	if _, e := x.s.Connect(context.Background(), SourceGH, ""); e != nil {
		t.Fatal(e)
	}
	if _, err := x.s.Disconnect(context.Background()); err != nil {
		t.Fatal(err)
	}
	if x.gh.calls != 1 {
		t.Fatalf("gh was run %d times; disconnect must not run it", x.gh.calls)
	}
}

// The device flow is off without a client id, and says how to turn it on.
func TestTheDeviceFlowNeedsAClientID(t *testing.T) {
	x := newFixture(t)
	_, e := x.s.StartDevice(context.Background())
	if e == nil || e.Kind != KindDisabled || !strings.Contains(e.Error(), "github_client_id") {
		t.Fatalf("got %+v", e)
	}
	if len(x.f.requests()) != 0 {
		t.Fatal("asked github.com without a client id")
	}
}

// The device flow: a code to enter, polls through pending and slow_down, a
// token, the account read, and the token stored as the oauth source.
func TestTheDeviceFlowConnects(t *testing.T) {
	x := newFixture(t)
	x.cfg.clientID = "Iv1.abc"
	x.f.tokens["gho_device"] = "ada"
	x.f.device = []map[string]any{{"error": "authorization_pending"}, {"error": "slow_down", "interval": 10}, {"access_token": "gho_device", "scope": "repo,read:org"}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	x.s.ctx = ctx
	d, e := x.s.StartDevice(ctx)
	if e != nil || d.UserCode != "ABCD-1234" || d.State != "pending" || !strings.HasSuffix(d.VerificationURI, "/login/device") {
		t.Fatalf("%+v %v", d, e)
	}
	waitFor(t, func() bool { s := x.s.DeviceState(); return s != nil && s.State != "pending" })
	if s := x.s.DeviceState(); s.State != "done" || x.cfg.source != SourceOAuth || x.store.tok != "gho_device" {
		t.Fatalf("device %+v source %q stored %q", s, x.cfg.source, x.store.tok)
	}
	if st := x.s.Status(); st.User == nil || st.User.Login != "ada" || st.TokenKind != "oauth" {
		t.Fatalf("status %+v", st)
	}
}

// A denied or expired code says so.
func TestADeniedDeviceCodeSaysSo(t *testing.T) {
	x := newFixture(t)
	x.cfg.clientID = "Iv1.abc"
	x.f.device = []map[string]any{{"error": "access_denied"}}
	if _, e := x.s.StartDevice(context.Background()); e != nil {
		t.Fatal(e)
	}
	waitFor(t, func() bool { s := x.s.DeviceState(); return s != nil && s.State != "pending" })
	s := x.s.DeviceState()
	if s.State != "denied" || s.Error == nil || !strings.Contains(s.Error.Error(), "denied on github.com") || x.cfg.source != "" {
		t.Fatalf("%+v", s)
	}
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// Opening a pull request pushes an unpublished branch first, then asks
// GitHub with the branch as head and the default branch as base.
func TestCreatePRPushesFirst(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	res, err := x.s.CreatePR(context.Background(), 1, "feat-x", CreatePRRequest{Title: "Add x", Body: "why", Draft: true})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Pushed || x.wt.pushes != 1 || res.PR.Number != 1 || res.PR.URL != "https://github.com/ada/caprock/pull/1" {
		t.Fatalf("%+v pushes=%d", res, x.wt.pushes)
	}
	body := x.f.created[len(x.f.created)-1]
	if body["head"] != "feat/x" || body["base"] != "main" || body["draft"] != true || body["title"] != "Add x" {
		t.Fatalf("sent %+v", body)
	}
	if prs := x.s.PRs(); len(prs) != 1 || prs[0].Worktree != "feat-x" {
		t.Fatalf("not followed: %+v", prs)
	}
}

// A failed push stops it, with git's words, before GitHub is asked.
func TestCreatePRStopsOnAFailedPush(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	x.wt.pushErr = &projects.ChangeError{Kind: projects.KindAuth, Message: "the remote refused your credentials", Output: "fatal: Authentication failed"}
	_, err := x.s.CreatePR(context.Background(), 1, "feat-x", CreatePRRequest{Title: "x"})
	var ce *projects.ChangeError
	if !errors.As(err, &ce) || !strings.Contains(ce.Message, "pushing feat/x first failed") || ce.Output == "" {
		t.Fatalf("got %v", err)
	}
	for _, r := range x.f.requests() {
		if strings.HasPrefix(r, "POST /repos/") {
			t.Fatal("GitHub was asked after the push failed")
		}
	}
}

// 422 "already exists": the message names the open pull request, and it is
// returned so the interface can link it.
func TestA422PRExistsLinksTheOpenOne(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	x.f.pulls["ada/caprock"] = []map[string]any{pull("ada/caprock", 7, "feat/x", "sha7")}
	x.f.failWith("POST /repos/ada/caprock/pulls", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(`{"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"A pull request already exists for ada:feat/x."}]}`))
	})
	_, err := x.s.CreatePR(context.Background(), 1, "feat-x", CreatePRRequest{Title: "x"})
	var ex *ExistsError
	if !errors.As(err, &ex) || ex.PR == nil || ex.PR.Number != 7 || ex.Err.Kind != KindExists {
		t.Fatalf("got %v", err)
	}
	if !strings.Contains(err.Error(), "already open: #7") {
		t.Fatalf("message: %q", err.Error())
	}
}

// A pull request's checks and reviews are read and summed; a CI failure and
// a review landing after Caprock first looked raise one notification each.
func TestFollowingAPullRequest(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	pr := pull("ada/caprock", 3, "feat/x", "sha1")
	x.f.pulls["ada/caprock"] = []map[string]any{pr}
	x.f.runs["sha1"] = []map[string]any{{"name": "build", "status": "in_progress"}, {"name": "lint", "status": "completed", "conclusion": "success"}}
	sub := x.bus.Subscribe(64)
	defer sub.Unsubscribe()
	ctx := context.Background()
	x.s.step(ctx)
	prs := x.s.PRs()
	if len(prs) != 1 || prs[0].Checks.State != "pending" || prs[0].Checks.Passed != 1 || prs[0].Checks.Pending != 1 || prs[0].Mergeable == nil || !*prs[0].Mergeable {
		t.Fatalf("first: %+v", prs)
	}
	// Nothing changes: the next poll is a minute away, then doubles.
	n := len(x.f.requests())
	x.advance(30 * time.Second)
	x.s.step(ctx)
	if len(x.f.requests()) != n {
		t.Fatal("polled sooner than once a minute")
	}
	x.advance(31 * time.Second)
	x.s.step(ctx)
	if len(x.f.requests()) == n {
		t.Fatal("did not poll after a minute")
	}
	x.f.mu.Lock()
	x.f.runs["sha1"][0] = map[string]any{"name": "build", "status": "completed", "conclusion": "failure", "html_url": "https://ci/1"}
	x.f.reviews[3] = []map[string]any{{"user": map[string]any{"login": "grace"}, "state": "CHANGES_REQUESTED", "submitted_at": "2026-10-06T12:00:00Z"}}
	x.f.mu.Unlock()
	x.advance(10 * time.Minute)
	x.s.step(ctx)
	prs = x.s.PRs()
	if prs[0].Checks.State != "fail" || prs[0].Review != "changes_requested" || prs[0].Reviews[0].User != "grace" {
		t.Fatalf("after: %+v", prs[0])
	}
	var notes []alerts.Notification
	var frames int
	drain := true
	for drain {
		select {
		case f := <-sub.C:
			if f.Type == bus.FrameNotify {
				notes = append(notes, f.Data.(alerts.Notification))
			}
			if f.Type == FrameGitHub {
				frames++
			}
		default:
			drain = false
		}
	}
	if len(notes) != 2 || notes[0].Kind != "ci" || !strings.Contains(notes[0].Body, "build failed") || notes[1].Kind != "review" || !strings.Contains(notes[1].Body, "@grace") {
		t.Fatalf("notifications: %+v", notes)
	}
	if frames < 2 {
		t.Fatalf("live frames: %d", frames)
	}
}

// A worktree that shows up after the daemon started (git not read yet at
// startup) is found on the next rediscovery, without a push or a kick.
func TestWorktreesFoundAfterStartupAreFollowed(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	x.f.pulls["ada/caprock"] = []map[string]any{pull("ada/caprock", 3, "feat/x", "sha1")}
	x.wt.mu.Lock()
	views := x.wt.views
	x.wt.views = nil
	x.wt.mu.Unlock()
	ctx := context.Background()
	x.s.step(ctx)
	if len(x.s.PRs()) != 0 {
		t.Fatal("followed a pull request with no worktree")
	}
	x.wt.mu.Lock()
	x.wt.views = views
	x.wt.mu.Unlock()
	x.advance(discoverEvery)
	x.s.step(ctx)
	if prs := x.s.PRs(); len(prs) != 1 || prs[0].Number != 3 {
		t.Fatalf("after rediscovery: %+v", prs)
	}
}

// Notifications are off when switched off; the state still updates.
func TestNotificationsCanBeSwitchedOff(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	x.cfg.notify = false
	x.f.pulls["ada/caprock"] = []map[string]any{pull("ada/caprock", 3, "feat/x", "sha1")}
	x.f.runs["sha1"] = []map[string]any{{"name": "build", "status": "in_progress"}}
	x.s.step(context.Background())
	sub := x.bus.Subscribe(64)
	defer sub.Unsubscribe()
	x.f.mu.Lock()
	x.f.runs["sha1"][0] = map[string]any{"name": "build", "status": "completed", "conclusion": "failure"}
	x.f.mu.Unlock()
	x.advance(MaxPoll)
	x.s.step(context.Background())
	for {
		select {
		case f := <-sub.C:
			if f.Type == bus.FrameNotify {
				t.Fatal("notified while switched off")
			}
		default:
			if x.s.PRs()[0].Checks.State != "fail" {
				t.Fatal("state not updated")
			}
			return
		}
	}
}

// A merged pull request leaves the open list and is read once more.
func TestAMergedPullRequestIsShownMerged(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	pr := pull("ada/caprock", 3, "feat/x", "sha1")
	x.f.pulls["ada/caprock"] = []map[string]any{pr}
	x.s.step(context.Background())
	x.f.mu.Lock()
	pr["state"], pr["merged"] = "closed", true
	x.f.mu.Unlock()
	x.advance(MaxPoll)
	x.s.step(context.Background())
	if prs := x.s.PRs(); prs[0].State != "merged" {
		t.Fatalf("%+v", prs[0])
	}
}

// Not connected: nothing is ever sent, whatever is due.
func TestNothingIsSentWhileNotConnected(t *testing.T) {
	x := newFixture(t)
	x.s.step(context.Background())
	x.advance(time.Hour)
	x.s.step(context.Background())
	if n := len(x.f.requests()); n != 0 {
		t.Fatalf("%d requests while not connected", n)
	}
}

// The draft: one commit's subject, else the branch said as words; the body
// lists the commits oldest first.
func TestDraft(t *testing.T) {
	if d := draftFor("feat/github-auth", []string{"Add the client"}); d.Title != "Add the client" || d.Body != "" {
		t.Fatalf("%+v", d)
	}
	d := draftFor("feat/github-auth", []string{"second", "first"})
	if d.Title != "feat: github auth" || d.Body != "- first\n- second" {
		t.Fatalf("%+v", d)
	}
	if d := draftFor("fast_path", nil); d.Title != "Fast path" {
		t.Fatalf("%+v", d)
	}
}

// The Changes view's read: a published branch's PR and its draft.
func TestWorktreeInfo(t *testing.T) {
	x := newFixture(t)
	x.wt.subjects = []string{"Add x"}
	info, err := x.s.Worktree(context.Background(), 1, "feat-x")
	if err != nil || info.Connected || info.Repo == nil || info.Repo.FullName != "ada/caprock" || info.Draft == nil || info.Draft.Title != "Add x" {
		t.Fatalf("%+v %v", info, err)
	}
	if len(x.f.requests()) != 0 {
		t.Fatal("asked GitHub while not connected")
	}
	x.connect(t)
	x.f.pulls["ada/caprock"] = []map[string]any{pull("ada/caprock", 9, "feat/x", "sha9")}
	info, err = x.s.Worktree(context.Background(), 1, "feat-x")
	if err != nil || info.PR == nil || info.PR.Number != 9 || info.Draft != nil || !info.Primed {
		t.Fatalf("%+v %v", info, err)
	}
	main, _ := x.s.Worktree(context.Background(), 1, "")
	if main.Reason != "default_branch" {
		t.Fatalf("%+v", main)
	}
	x.wt.changes["other"] = projects.Changes{Branch: "x", Remote: "origin", RemoteURL: "https://gitlab.com/a/b.git", DefaultBranch: "main"}
	if o, _ := x.s.Worktree(context.Background(), 1, "other"); o.Reason != "not_github" {
		t.Fatalf("%+v", o)
	}
}

// Creating a repository: private by default, set as origin, pushed.
func TestCreateRepo(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	x.wt.changes[""] = projects.Changes{ProjectID: 1, Branch: "main", Head: "abc", DefaultBranch: "main"}
	res, err := x.s.CreateRepo(context.Background(), 1, CreateRepoRequest{Name: "new-thing"})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Pushed || res.RemoteURL != "https://github.com/ada/new-thing.git" || x.wt.remotes[0] != "origin https://github.com/ada/new-thing.git" {
		t.Fatalf("%+v %v", res, x.wt.remotes)
	}
	if x.f.created[0]["private"] != true {
		t.Fatalf("not private by default: %+v", x.f.created[0])
	}
	if _, err := x.s.CreateRepo(context.Background(), 1, CreateRepoRequest{Name: "again"}); err == nil || !strings.Contains(err.Error(), "already has a remote") {
		t.Fatalf("a second repository for one project: %v", err)
	}
	if _, err := x.s.CreateRepo(context.Background(), 1, CreateRepoRequest{Name: "bad name"}); asError(t, err).Kind != KindInvalid {
		t.Fatal("a bad name went out")
	}
}

// A name taken on GitHub says so.
func TestCreateRepoNameTaken(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	x.wt.changes[""] = projects.Changes{ProjectID: 1, Branch: "main", Head: "abc"}
	x.f.failWith("POST /user/repos", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(`{"message":"Repository creation failed.","errors":[{"resource":"Repository","code":"custom","field":"name","message":"name already exists on this account"}]}`))
	})
	_, err := x.s.CreateRepo(context.Background(), 1, CreateRepoRequest{Name: "taken"})
	if e := asError(t, err); e.Kind != KindExists || !strings.Contains(e.Error(), "already exists there") {
		t.Fatalf("%+v", e)
	}
	if len(x.wt.remotes) != 0 {
		t.Fatal("a remote was set for a repository that was not created")
	}
}

func TestParseRemote(t *testing.T) {
	for in, want := range map[string]string{
		"https://github.com/ada/caprock.git": "ada/caprock",
		"https://github.com/ada/caprock":     "ada/caprock",
		"git@github.com:ada/caprock.git":     "ada/caprock",
		"ssh://git@github.com/ada/caprock":   "ada/caprock",
		"https://gitlab.com/ada/caprock.git": "",
		"https://github.com/ada":             "",
		"https://github.com/a/b/c":           "",
		"git@github.com:ada/../x":            "",
		"/local/path":                        "",
	} {
		r, ok := ParseRemote(in)
		got := ""
		if ok {
			got = r.FullName()
		}
		if got != want {
			t.Errorf("ParseRemote(%q) = %q, want %q", in, got, want)
		}
	}
}

// A Link header to another host is never followed with the token.
func TestTheTokenNeverLeavesTheAPIHost(t *testing.T) {
	x := newFixture(t)
	c := newClient(x.f.srv.URL, x.f.srv.Client(), time.Now)
	_, e := c.do(context.Background(), request{method: http.MethodGet, path: "https://evil.example/user", token: "ghp_good", doing: "x"})
	if e == nil || !strings.Contains(e.Message, "not the API host") {
		t.Fatalf("got %+v", e)
	}
}
