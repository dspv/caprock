package gemini

import (
	"os"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/event"
)

// The fixture is six records lifted out of a real Gemini session — the same
// prompt, the same two model calls, the same two tool calls, one of which
// failed. Written from the file Gemini produced rather than from the shape its
// source suggests, because that distinction has already cost this feature two
// releases: what a bundle contains and what a running program emits are not
// the same thing.
const fixture = "../../testdata/gemini/telemetry.log"

func parseFixture(t *testing.T) []TelemetryEvent {
	t.Helper()
	f, err := os.Open(fixture)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	evs, err := ParseTelemetry(f)
	if err != nil {
		t.Fatal(err)
	}
	return evs
}

func TestTelemetryYieldsTheEventsCaprockNeeds(t *testing.T) {
	evs := parseFixture(t)
	if len(evs) != 6 {
		t.Fatalf("want 6 events, got %d", len(evs))
	}
	got := map[event.Kind]int{}
	for _, e := range evs {
		got[e.Kind]++
		if e.SessionID == "" {
			t.Errorf("%s carries no session id", e.Kind)
		}
	}
	for kind, want := range map[event.Kind]int{
		event.KindAgentSpawn:    1,
		event.KindTurnUser:      1,
		event.KindTurnAssistant: 2,
		event.KindToolPost:      2,
	} {
		if got[kind] != want {
			t.Errorf("%s: got %d, want %d", kind, got[kind], want)
		}
	}
}

// The point of the whole file. A session that shows zeroes is the bug this
// fixes, so the numbers are asserted exactly rather than "greater than zero" —
// a parser reading the wrong field would still pass that weaker check on some
// other field.
func TestTokensAreReadFromTheRealFieldNames(t *testing.T) {
	var totalIn, totalOut int
	for _, e := range parseFixture(t) {
		if e.Kind != event.KindTurnAssistant {
			// Tokens belong to a model call and nothing else; finding them
			// elsewhere means a field was matched by accident.
			if e.TokensIn != 0 || e.TokensOut != 0 {
				t.Errorf("%s carries tokens it should not: in=%d out=%d", e.Kind, e.TokensIn, e.TokensOut)
			}
			continue
		}
		totalIn += e.TokensIn
		totalOut += e.TokensOut
		if e.Model == "" {
			t.Error("a model call with no model name cannot be costed")
		}
	}
	// 8631+8718 and 41+27, from the session this fixture came from.
	if totalIn != 17349 {
		t.Errorf("input tokens = %d, want 17349", totalIn)
	}
	if totalOut != 68 {
		t.Errorf("output tokens = %d, want 68", totalOut)
	}
}

func TestAFailedToolCallIsRecordedAsOne(t *testing.T) {
	// Gemini reports failures through the same event as successes, and a
	// dashboard that silently drops them would show a session doing less work
	// than it did — and hide the failures, which are the interesting half.
	var tools, failed int
	for _, e := range parseFixture(t) {
		if e.Kind != event.KindToolPost {
			continue
		}
		tools++
		if e.Tool == "" {
			t.Error("a tool call with no tool name")
		}
		if !e.Success {
			failed++
		}
	}
	if tools != 2 {
		t.Fatalf("tool calls = %d, want 2", tools)
	}
	if failed != 1 {
		t.Errorf("failed tool calls = %d, want 1 (write_file was not found)", failed)
	}
}

func TestProseNeverRidesAlongOnAFiguresEvent(t *testing.T) {
	// Caprock stores what an agent wrote, on purpose and behind a screen that
	// says so. What it must not do is carry prose on events that exist to be
	// counted — a cost row is read on every screen, and text riding along on
	// one is text nobody chose to keep.
	//
	// The fixture was captured without GEMINI_TELEMETRY_LOG_PROMPTS, so its
	// user_prompt does carry text; that is the shape this must handle, not the
	// shape it should aim for. Spawned sessions set the flag, which leaves
	// prompt_length and drops the prompt itself — verified on a live session,
	// because the flag existing in the bundle would not have proved it worked.
	for _, e := range parseFixture(t) {
		if e.Kind == event.KindTurnUser {
			continue
		}
		if e.Text != "" {
			t.Errorf("%s carries prose: %q", e.Kind, e.Text)
		}
	}
}

func TestAPromptlessTelemetryStillCounts(t *testing.T) {
	// What a spawned session actually produces: prompt_length survives, the
	// prompt does not. The tokens have to arrive either way, or turning the
	// flag on would silently cost the user their figures.
	const raw = `{
  "_body": "",
  "attributes": {
    "event.name": "gemini_cli.user_prompt",
    "session.id": "s1",
    "prompt_length": 31
  }
}
{
  "_body": "",
  "attributes": {
    "event.name": "gemini_cli.api_response",
    "session.id": "s1",
    "model": "gemini-3.5-flash-lite",
    "input_token_count": 8631,
    "output_token_count": 41
  }
}`
	evs, err := ParseTelemetry(strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 2 {
		t.Fatalf("want 2 events, got %d", len(evs))
	}
	if evs[0].Text != "" {
		t.Errorf("a prompt appeared where the flag should have removed it: %q", evs[0].Text)
	}
	if evs[1].TokensIn != 8631 || evs[1].TokensOut != 41 {
		t.Errorf("turning prompts off cost the token counts: %+v", evs[1])
	}
}

// The format is concatenated pretty-printed JSON, not JSONL, so the parser
// counts braces. A prompt containing a brace would cut a record in half under
// any simpler scheme, and prompts about code contain braces constantly.
func TestABraceInsideAPromptDoesNotEndTheRecord(t *testing.T) {
	const raw = `{
  "_body": "",
  "attributes": {
    "event.name": "gemini_cli.user_prompt",
    "session.id": "s1",
    "prompt": "fix func main() { return } and the \"quoted\" bit"
  }
}
{
  "_body": "",
  "attributes": {
    "event.name": "gemini_cli.api_response",
    "session.id": "s1",
    "model": "gemini-3.5-flash",
    "input_token_count": 12,
    "output_token_count": 3
  }
}`
	evs, err := ParseTelemetry(strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 2 {
		t.Fatalf("braces in a prompt split the stream: got %d events", len(evs))
	}
	if !strings.Contains(evs[0].Text, "{ return }") {
		t.Errorf("prompt was truncated at a brace: %q", evs[0].Text)
	}
	if evs[1].TokensIn != 12 {
		t.Errorf("the record after a brace-carrying one was misread: %+v", evs[1])
	}
}

// The file is written by another process while Caprock reads it, so the last
// record is routinely half-written. That must cost the torn record and nothing
// else — failing the whole read would mean a session shows nothing until it
// ends.
func TestATornFinalRecordDoesNotLoseTheOnesBeforeIt(t *testing.T) {
	f, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	torn := string(f) + `{"_body":"","attributes":{"event.name":"gemini_cli.api_res`
	evs, err := ParseTelemetry(strings.NewReader(torn))
	if err != nil {
		t.Fatalf("a half-written record failed the whole read: %v", err)
	}
	if len(evs) != 6 {
		t.Errorf("got %d events, want the 6 complete ones", len(evs))
	}
}

func TestSpansAndMetricsAreIgnored(t *testing.T) {
	// Spans repeat what the logs carry and the metrics block arrives on exit.
	// Reading either would double every token count in the session.
	const raw = `{
  "name": "llm_call",
  "attributes": { "gen_ai.request.model": "gemini-3.5-flash" }
}
{
  "resource": {},
  "scopeMetrics": []
}
{
  "_body": "",
  "attributes": {
    "event.name": "gemini_cli.api_response",
    "session.id": "s1",
    "model": "gemini-3.5-flash",
    "input_token_count": 5,
    "output_token_count": 1
  }
}`
	evs, err := ParseTelemetry(strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 1 {
		t.Fatalf("want 1 event from the log record alone, got %d", len(evs))
	}
	if evs[0].TokensIn != 5 {
		t.Errorf("wrong record was read: %+v", evs[0])
	}
}

func TestNumReadsWhateverShapeTheCountArrivesIn(t *testing.T) {
	// A count silently read as zero is the failure this whole file exists to
	// prevent, and JSON gives no guarantee which of these it will be.
	for _, tc := range []struct {
		in   any
		want int
	}{
		{float64(8631), 8631},
		{"8631", 8631},
		{nil, 0},
		{"", 0},
		{true, 0},
	} {
		if got := num(tc.in); got != tc.want {
			t.Errorf("num(%#v) = %d, want %d", tc.in, got, tc.want)
		}
	}
}
