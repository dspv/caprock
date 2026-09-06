package statusline

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/config"
)

// The command prints a status line from the stdin JSON and never fails — malformed
// input, empty input, and missing rate_limits all produce clean output/exit.
func TestRenderFromStdin(t *testing.T) {
	in := `{"session_id":"s1","model":{"display_name":"Opus"},"context_window":{"used_percentage":8},` +
		`"cost":{"total_cost_usd":0.012},"rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1900000000}}}`
	var out bytes.Buffer
	Run(strings.NewReader(in), &out)
	got := out.String()
	for _, want := range []string{"Opus", "ctx 8%", "$0.012", "5h", "24", "resets"} {
		if !strings.Contains(got, want) {
			t.Fatalf("status line missing %q: %q", want, got)
		}
	}
}

func TestNoRateLimitsStillRenders(t *testing.T) {
	var out bytes.Buffer
	Run(strings.NewReader(`{"model":{"display_name":"Sonnet"},"context_window":{"used_percentage":3}}`), &out)
	got := out.String()
	if !strings.Contains(got, "Sonnet") || strings.Contains(got, "5h") {
		t.Fatalf("unexpected line without rate limits: %q", got)
	}
}

func TestMalformedAndEmptyInputAreSafe(t *testing.T) {
	var out bytes.Buffer
	Run(strings.NewReader("not json at all"), &out) // must not panic
	if out.Len() != 0 {
		t.Fatalf("malformed input produced output: %q", out.String())
	}
	out.Reset()
	Run(strings.NewReader(""), &out) // empty stdin
	if out.Len() != 0 {
		t.Fatalf("empty stdin produced output: %q", out.String())
	}
}

// Colour thresholds: >85 red, 60–85 amber, else green.
func TestColorThresholds(t *testing.T) {
	cases := map[float64]string{20: "32", 70: "33", 95: "31"}
	for pct, code := range cases {
		got := colorPct("5h", pct)
		if !strings.Contains(got, "\x1b["+code+"m") {
			t.Fatalf("pct %.0f: want SGR %s, got %q", pct, code, got)
		}
	}
}

// A 5-hour window without resets_at must not leave a trailing space that turns
// the " · " separator into a double space.
func TestRenderNoTrailingSpaceWithoutReset(t *testing.T) {
	var in input
	if err := json.Unmarshal([]byte(`{"rate_limits":{"five_hour":{"used_percentage":40},"seven_day":{"used_percentage":20}}}`), &in); err != nil {
		t.Fatal(err)
	}
	out := render(in)
	if strings.Contains(out, "  ") {
		t.Fatalf("double space in render output: %q", out)
	}
}

// resetIn is empty for a missing/zero/negative reset time, and formatted otherwise.
func TestResetIn(t *testing.T) {
	if resetIn(0) != "" || resetIn(-5) != "" {
		t.Fatal("resetIn should be empty for non-positive input")
	}
	if got := resetIn(1_000_000_000); !strings.HasPrefix(got, "resets ") {
		t.Fatalf("resetIn format: %q", got)
	}
}

// post forwards only the whitelisted rate-limit windows to the daemon, with the
// bearer token, and is fire-and-forget. This exercises the happy path and, more
// importantly, asserts the whitelist: no prompt/model/cost content is ever sent.
func TestPostForwardsWhitelistedBodyWithAuth(t *testing.T) {
	var gotAuth, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	// Point the statusline at a data dir whose runtime.json names the test server.
	dir := t.TempDir()
	t.Setenv(config.EnvDataDir, dir)
	port, _ := strconv.Atoi(strings.TrimPrefix(srv.URL, "http://127.0.0.1:"))
	rt, err := config.NewRuntime(port, "test")
	if err != nil {
		t.Fatal(err)
	}
	if err := config.WriteRuntime(dir, rt); err != nil {
		t.Fatal(err)
	}

	post(forward{
		SessionID: "sess-1",
		FiveHour:  &window{UsedPercentage: 42, ResetsAt: 1_900_000_000},
	})

	if !strings.HasPrefix(gotAuth, "Bearer ") || !strings.Contains(gotAuth, rt.Token) {
		t.Fatalf("auth header wrong: %q", gotAuth)
	}
	if !strings.Contains(gotBody, "sess-1") || !strings.Contains(gotBody, "five_hour") || !strings.Contains(gotBody, "42") {
		t.Fatalf("body missing whitelisted fields: %q", gotBody)
	}
	// The whitelist is a promise: no room for prompt/model/cost content.
	for _, forbidden := range []string{"prompt", "model", "cost", "display_name"} {
		if strings.Contains(gotBody, forbidden) {
			t.Fatalf("forbidden field %q leaked into the forwarded body: %q", forbidden, gotBody)
		}
	}
}

// post must not panic or block when the daemon is down (no runtime.json).
func TestPostSilentWhenDaemonDown(t *testing.T) {
	t.Setenv(config.EnvDataDir, t.TempDir()) // no runtime.json
	post(forward{SessionID: "x", FiveHour: &window{UsedPercentage: 1}})
	// Reaching here without panic/hang is the assertion.
}

// Rich mode adds the daemon's counters to the line.
func TestRichModeAddsCounters(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = io.WriteString(w, `{"turns":4,"tool_calls":23,"tokens_in":80000,"tokens_out":35600,"cache_read":1520000,"cache_write":40000}`)
	}))
	defer srv.Close()
	pointAtServer(t, srv.URL)

	var out bytes.Buffer
	RunWith(strings.NewReader(`{"session_id":"s1","model":{"display_name":"Opus"}}`), &out, Options{Rich: true, Width: 500})
	got := out.String()
	for _, want := range []string{"Opus", "4 turns", "23 steps", "cache −", "in 80.0K", "out 35.6K"} {
		if !strings.Contains(got, want) {
			t.Fatalf("rich line missing %q: %q", want, got)
		}
	}
}

// The contract this feature had to defend: rich mode may never cost the user
// more than the extra segments. A daemon that is down, slow, or refusing must
// yield exactly the plain line.
func TestRichModeFallsBackToPlainLine(t *testing.T) {
	const stdin = `{"session_id":"s1","model":{"display_name":"Opus"},"context_window":{"used_percentage":8}}`

	var plain bytes.Buffer
	RunWith(strings.NewReader(stdin), &plain, Options{Width: 500})

	t.Run("daemon down", func(t *testing.T) {
		t.Setenv(config.EnvDataDir, t.TempDir()) // no runtime.json
		var out bytes.Buffer
		RunWith(strings.NewReader(stdin), &out, Options{Rich: true, Width: 500})
		if out.String() != plain.String() {
			t.Fatalf("daemon down changed the line:\n got %q\nwant %q", out.String(), plain.String())
		}
	})

	t.Run("daemon errors", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		defer srv.Close()
		pointAtServer(t, srv.URL)
		var out bytes.Buffer
		RunWith(strings.NewReader(stdin), &out, Options{Rich: true, Width: 500})
		if out.String() != plain.String() {
			t.Fatalf("daemon error changed the line: %q", out.String())
		}
	})

	t.Run("daemon returns junk", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, "definitely not json")
		}))
		defer srv.Close()
		pointAtServer(t, srv.URL)
		var out bytes.Buffer
		RunWith(strings.NewReader(stdin), &out, Options{Rich: true, Width: 500})
		if out.String() != plain.String() {
			t.Fatalf("junk response changed the line: %q", out.String())
		}
	})
}

// A daemon that never answers must not hold the line hostage: the read is
// bounded, so the user waits statsBudget at worst and still gets the plain line.
func TestRichModeIsBoundedWhenDaemonHangs(t *testing.T) {
	// Ordering matters: Close waits for the in-flight handler, so the handler
	// must be released before it, i.e. this defer has to be registered after.
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-release // never answers within the budget
	}))
	defer srv.Close()
	defer close(release)
	pointAtServer(t, srv.URL)

	start := time.Now()
	var out bytes.Buffer
	RunWith(strings.NewReader(`{"session_id":"s1","model":{"display_name":"Opus"}}`), &out, Options{Rich: true, Width: 500})
	elapsed := time.Since(start)

	if !strings.Contains(out.String(), "Opus") {
		t.Fatalf("no line printed when the daemon hung: %q", out.String())
	}
	// Generous headroom over statsBudget for slow CI; the point is that it is
	// bounded at all, not the exact figure.
	if elapsed > 2*time.Second {
		t.Fatalf("rich read was not bounded: took %s", elapsed)
	}
}

// A session the daemon has no counters for yet renders the plain line, not a
// row of zeros claiming nothing has happened.
func TestRichModeZeroStatsAddsNothing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"turns":0,"tool_calls":0,"tokens_in":0,"tokens_out":0,"cache_read":0,"cache_write":0}`)
	}))
	defer srv.Close()
	pointAtServer(t, srv.URL)

	var out bytes.Buffer
	RunWith(strings.NewReader(`{"session_id":"s1","model":{"display_name":"Opus"}}`), &out, Options{Rich: true, Width: 500})
	if got := out.String(); got != brandFull+" · Opus" {
		t.Fatalf("zero counters should add nothing, got %q", got)
	}
}

// Rich mode without a session id must not call the daemon at all.
func TestRichModeSkipsCallWithoutSessionID(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
	}))
	defer srv.Close()
	pointAtServer(t, srv.URL)

	var out bytes.Buffer
	RunWith(strings.NewReader(`{"model":{"display_name":"Opus"}}`), &out, Options{Rich: true, Width: 500})
	if called {
		t.Fatal("called the daemon with no session id")
	}
}

// A narrow terminal drops the counters, never the plan window the user came to
// read, and never overflows once the essentials alone fit.
func TestNarrowTerminalDropsCountersNotEssentials(t *testing.T) {
	var in input
	if err := json.Unmarshal([]byte(`{"model":{"display_name":"Opus 4.1"},"context_window":{"used_percentage":8},`+
		`"rate_limits":{"five_hour":{"used_percentage":91}}}`), &in); err != nil {
		t.Fatal(err)
	}
	st := &stats{Turns: 4, ToolCalls: 23, TokensIn: 80000, TokensOut: 35600, CacheRead: 1520000, CacheWrite: 40000}

	wide := renderWidth(in, st, 200)
	if !strings.Contains(wide, "4 turns") {
		t.Fatalf("wide line should carry the counters: %q", wide)
	}

	// The counters degrade one at a time rather than as a block: an 80-column
	// terminal — the default, and where most users are — keeps the two
	// counters worth watching instead of losing all four to save one column.
	mid := renderWidth(in, st, 80)
	if !strings.Contains(mid, "turns") {
		t.Fatalf("80 columns should keep turns/steps: %q", mid)
	}
	if strings.Contains(mid, "in 80.0K") {
		t.Fatalf("80 columns should drop the token totals first: %q", mid)
	}
	if displayWidth(mid) > 80 {
		t.Fatalf("80-column line overflows: width %d in %q", displayWidth(mid), mid)
	}

	narrow := renderWidth(in, st, 40)
	if strings.Contains(narrow, "turns") || strings.Contains(narrow, "cache") {
		t.Fatalf("narrow line kept the counters: %q", narrow)
	}
	for _, want := range []string{"Opus 4.1", "ctx 8%", "5h"} {
		if !strings.Contains(narrow, want) {
			t.Fatalf("narrow line dropped an essential %q: %q", want, narrow)
		}
	}
	if displayWidth(narrow) > 40 {
		t.Fatalf("narrow line overflows: width %d in %q", displayWidth(narrow), narrow)
	}
}

// displayWidth counts what the terminal draws — runes, not bytes, and not the
// colour codes. Getting this wrong is what would make a coloured line wrap.
func TestDisplayWidthIgnoresANSIAndCountsRunes(t *testing.T) {
	if got := displayWidth(colorPct("5h", 42)); got != len("5h 42%") {
		t.Fatalf("ANSI counted: got %d, want %d", got, len("5h 42%"))
	}
	if got := displayWidth("привет"); got != 6 {
		t.Fatalf("multibyte runes counted as bytes: got %d", got)
	}
}

func TestCompactTokens(t *testing.T) {
	for in, want := range map[int64]string{0: "0", 812: "812", 35_600: "35.6K", 1_500_000: "1.5M"} {
		if got := compactTokens(in); got != want {
			t.Fatalf("compactTokens(%d) = %q, want %q", in, got, want)
		}
	}
}

// COLUMNS drives the width; absent or absurd values fall back to 80 rather than
// guessing wide, because a wrapped status line costs a screen row every message.
func TestTerminalWidthFromCOLUMNS(t *testing.T) {
	t.Setenv("COLUMNS", "120")
	if got := terminalWidth(); got != 120 {
		t.Fatalf("COLUMNS ignored: %d", got)
	}
	for _, bad := range []string{"", "wide", "3", "-10"} {
		t.Setenv("COLUMNS", bad)
		if got := terminalWidth(); got != defaultWidth {
			t.Fatalf("COLUMNS=%q gave %d, want %d", bad, got, defaultWidth)
		}
	}
}

// pointAtServer writes a runtime.json in a temp data dir naming the test server,
// so the statusline's daemon calls reach it.
func pointAtServer(t *testing.T, url string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv(config.EnvDataDir, dir)
	port, err := strconv.Atoi(strings.TrimPrefix(url, "http://127.0.0.1:"))
	if err != nil {
		t.Fatal(err)
	}
	rt, err := config.NewRuntime(port, "test")
	if err != nil {
		t.Fatal(err)
	}
	if err := config.WriteRuntime(dir, rt); err != nil {
		t.Fatal(err)
	}
}

// The cache segment reports what the cache cut off the bill, not how often it
// was hit. This is the whole reason it is not a hit rate: on real sessions the
// cached reads outnumber uncached input by orders of magnitude, so a hit rate
// is 100% for everybody and says nothing. Two sessions with very different
// cache economics must produce different numbers here.
func TestCacheSegmentDiscriminatesBetweenSessions(t *testing.T) {
	// Shaped like this machine's real rows: tiny uncached input against
	// millions of cached reads. A hit rate would render 100% for both.
	heavy := renderWidth(input{}, &stats{Turns: 1, TokensIn: 41_083, CacheRead: 6_684_979_254, CacheWrite: 1_000_000}, 500)
	// A session that writes far more cache than it ever reads back.
	light := renderWidth(input{}, &stats{Turns: 1, TokensIn: 41_083, CacheRead: 10_000, CacheWrite: 5_000_000}, 500)

	// The session that reuses its cache shows a large, specific cut.
	if !strings.Contains(heavy, "cache −90%") {
		t.Fatalf("heavy-reuse session: want a large cut, got %q", heavy)
	}
	// The write-dominated one saves nothing — writes are billed above list
	// price, so the cache genuinely cost it more than it returned. It must say
	// nothing rather than print a saving, which is the whole point of gating
	// the segment on a positive cut.
	if strings.Contains(light, "cache") {
		t.Fatalf("write-dominated session claimed a saving: %q", light)
	}
}

// The line carries the mark, in both modes, so it is identifiably Caprock's
// rather than an anonymous row of figures.
func TestBrandOnEveryLine(t *testing.T) {
	var plain bytes.Buffer
	RunWith(strings.NewReader(`{"model":{"display_name":"Opus"}}`), &plain, Options{Width: 200})
	if !strings.HasPrefix(plain.String(), brandFull) {
		t.Fatalf("plain line does not lead with the badge: %q", plain.String())
	}
	// The mark is the amber glyph the favicon draws, and it survives even when
	// the wordmark cannot.
	if !strings.Contains(brandMark, "⛰") || !strings.Contains(brandMark, "\x1b[33m") {
		t.Fatalf("mark is not the amber glyph: %q", brandMark)
	}
}

// The badge shrinks to the mark before any counter is dropped: the wordmark
// costs ten columns and carries nothing the mark does not, so on an 80-column
// terminal it is the difference between showing turns/steps and showing none.
func TestBrandShrinksBeforeCountersAreDropped(t *testing.T) {
	var in input
	if err := json.Unmarshal([]byte(`{"model":{"display_name":"Opus 5"},"context_window":{"used_percentage":34},`+
		`"cost":{"total_cost_usd":1.234},"rate_limits":{"five_hour":{"used_percentage":91,"resets_at":1788700000}}}`), &in); err != nil {
		t.Fatal(err)
	}
	st := &stats{Turns: 113, ToolCalls: 118, TokensIn: 226, TokensOut: 59_400, CacheRead: 5_800_000, CacheWrite: 40_000}

	wide := renderWidth(in, st, 200)
	if !strings.Contains(wide, brandFull) {
		t.Fatalf("wide line should carry the full wordmark: %q", wide)
	}

	// At 80 the wordmark must go and the counters must stay — the whole point
	// of shrinking before dropping.
	mid := renderWidth(in, st, 80)
	if strings.Contains(mid, "caprock") {
		t.Fatalf("80 columns should drop the wordmark: %q", mid)
	}
	if !strings.Contains(mid, brandMark) {
		t.Fatalf("80 columns should keep the mark: %q", mid)
	}
	if !strings.Contains(mid, "113 turns") {
		t.Fatalf("80 columns should keep turns/steps once the wordmark is gone: %q", mid)
	}
	if displayWidth(mid) > 80 {
		t.Fatalf("80-column line overflows: %d in %q", displayWidth(mid), mid)
	}

	// The mark is never dropped, however narrow it gets — a badge that
	// disappears when the line is tight is not a badge.
	for _, w := range []int{60, 40, 20} {
		if got := renderWidth(in, st, w); !strings.Contains(got, brandMark) {
			t.Fatalf("width %d lost the mark: %q", w, got)
		}
	}
}
