package loop

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

type fixtureEvent struct {
	SessionID string          `json:"session_id"`
	Kind      string          `json:"kind"`
	Tool      string          `json:"tool"`
	TsOffsetS int             `json:"ts_offset_s"`
	Payload   json.RawMessage `json:"payload"`
}

func replay(t *testing.T, d *Detector, name string) []*Alert {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "loops", name))
	if err != nil {
		t.Fatal(err)
	}
	var evs []fixtureEvent
	if err := json.Unmarshal(b, &evs); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	var alerts []*Alert
	for _, fe := range evs {
		ev := event.Event{SessionID: fe.SessionID, Kind: event.Kind(fe.Kind), Tool: fe.Tool, Payload: fe.Payload, Ts: base.Add(time.Duration(fe.TsOffsetS) * time.Second)}
		if a := d.Observe(ev); a != nil {
			alerts = append(alerts, a)
		}
	}
	return alerts
}

func TestLoopingFixtureTriggersExactlyOneAlert(t *testing.T) {
	d := New(5, 3*time.Minute)
	alerts := replay(t, d, "looping.json")
	if len(alerts) != 1 {
		t.Fatalf("got %d alerts, want exactly 1: %+v", len(alerts), alerts)
	}
	a := alerts[0]
	if a.Tool != "Bash" || a.Count != 5 || a.SessionID != "loop-session" || a.WindowMin != 3 || a.Sample != "Bash: go test ./..." {
		t.Fatalf("alert: %+v", a)
	}
}

func TestNonLoopingFixtureTriggersNone(t *testing.T) {
	d := New(5, 3*time.Minute)
	if alerts := replay(t, d, "non_looping.json"); len(alerts) != 0 {
		t.Fatalf("false positive: %+v", alerts)
	}
}

func TestNearDuplicateInputsCount(t *testing.T) {
	d := New(5, 3*time.Minute)
	if alerts := replay(t, d, "near_duplicate.json"); len(alerts) != 1 {
		t.Fatalf("near-duplicate loop missed: %+v", alerts)
	}
}

func TestSpreadOutRepeatsAreNotALoop(t *testing.T) {
	d := New(5, 3*time.Minute)
	if alerts := replay(t, d, "stale.json"); len(alerts) != 0 {
		t.Fatalf("stale repeats alerted: %+v", alerts)
	}
}

func TestNewEpisodeAfterCooldownAlertsAgain(t *testing.T) {
	d := New(3, time.Minute)
	base := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	mk := func(ts time.Time) event.Event {
		return event.Event{SessionID: "s", Kind: event.KindToolPre, Tool: "Bash", Ts: ts, Payload: json.RawMessage(`{"tool_input":{"command":"make test"}}`)}
	}
	n := 0
	for i := 0; i < 5; i++ {
		if d.Observe(mk(base.Add(time.Duration(i)*10*time.Second))) != nil {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("first episode alerts %d", n)
	}
	// Quiet for 5 minutes, then loops again → new episode → new alert.
	later := base.Add(6 * time.Minute)
	for i := 0; i < 3; i++ {
		if a := d.Observe(mk(later.Add(time.Duration(i) * 10 * time.Second))); a != nil {
			n++
		}
	}
	if n != 2 {
		t.Fatalf("second episode not alerted, total %d", n)
	}
	d.Forget("s")
	if len(d.sessions) != 0 {
		t.Fatal("forget did not drop session")
	}
}

func TestSignatureNormalization(t *testing.T) {
	a, _ := Signature("Bash", json.RawMessage(`{"tool_input":{"command":"go test ./... -count=1","description":"x"}}`))
	b, _ := Signature("Bash", json.RawMessage(`{"tool_input":{"command":"go   test ./... -count=7","description":"y","timeout":5}}`))
	c, _ := Signature("Bash", json.RawMessage(`{"tool_input":{"command":"go build ./..."}}`))
	if a != b {
		t.Fatal("volatile differences should normalize away")
	}
	if a == c {
		t.Fatal("different commands collided")
	}
	if s, _ := Signature("", nil); s != "" {
		t.Fatal("empty tool should have empty signature")
	}
	if _, sample := Signature("Edit", json.RawMessage(`{"tool_input":{"file_path":"/a/b.go","old_string":"x"}}`)); sample != "Edit: /a/b.go" {
		t.Fatalf("sample %q", sample)
	}
	if got := Describe("mcp__gh__issue", map[string]json.RawMessage{"query": json.RawMessage(`"bugs"`)}); got != "mcp__gh__issue: bugs" {
		t.Fatalf("describe %q", got)
	}
}

// A repeated read is ordinary work, not a loop worth interrupting someone over.
//
// Measured over 64,733 real tool calls: 54% of everything the detector fired on
// was a repeated Read of one file — re-reading after an edit, while searching,
// while comparing. Tool calls cost nothing (verified: zero across every
// tool.pre), so none of those alerts could have been about the budget this
// package exists to protect.
func TestReadOnlyToolsDoNotRaiseLoops(t *testing.T) {
	for _, tool := range []string{"Read", "Glob", "Grep", "ToolSearch"} {
		t.Run(tool, func(t *testing.T) {
			d := New(3, time.Minute)
			var got *Alert
			for i := 0; i < 20; i++ {
				ev := event.Event{
					SessionID: "s", Kind: event.KindToolPre, Tool: tool,
					Ts:      time.Now().Add(time.Duration(i) * time.Second),
					Payload: json.RawMessage(`{"tool_input":{"file_path":"/x/main.go"}}`),
				}
				if a := d.Observe(ev); a != nil {
					got = a
				}
			}
			if got != nil {
				t.Errorf("%s raised a loop alert after 20 identical reads: %+v", tool, got)
			}
		})
	}
}

// The tools that can actually spend money must still be caught — the exclusion
// above must not quietly disable the feature.
func TestSpendingToolsStillRaiseLoops(t *testing.T) {
	for _, tool := range []string{"Bash", "Edit", "Write", "WebFetch"} {
		t.Run(tool, func(t *testing.T) {
			d := New(3, time.Minute)
			var got *Alert
			for i := 0; i < 10; i++ {
				ev := event.Event{
					SessionID: "s", Kind: event.KindToolPre, Tool: tool,
					Ts:      time.Now().Add(time.Duration(i) * time.Second),
					Payload: json.RawMessage(`{"tool_input":{"command":"go test ./..."}}`),
				}
				if a := d.Observe(ev); a != nil {
					got = a
				}
			}
			if got == nil {
				t.Errorf("%s repeated ten times raised nothing; the detector must still fire", tool)
			}
		})
	}
}
