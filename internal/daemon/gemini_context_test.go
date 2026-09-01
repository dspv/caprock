package daemon

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
)

func geminiTestDaemon(t *testing.T) *Daemon {
	t.Helper()
	st := memStore(t)
	rec := rollup.New(st, embeddedTable(t), bus.New(), quietLog())
	rec.Location = time.UTC
	return &Daemon{log: quietLog(), store: st, rec: rec}
}

// The context is the point of the feature: a model asked "what did I spend"
// with no figures can only explain what spending is.
func TestContextCarriesTheUsersOwnNumbers(t *testing.T) {
	ctx := context.Background()
	d := geminiTestDaemon(t)

	cost := 4.25
	ev := &event.Event{
		Ts: time.Now(), SessionID: "s1", Source: event.SourceHook,
		Kind: event.KindTurnAssistant, Model: "claude-opus-5",
		Tokens: &event.TokenDelta{In: 1000, Out: 500}, CostUSD: &cost,
		Payload: json.RawMessage(`{}`),
	}
	if _, err := d.rec.Record(ctx, ev, rollup.SessionInfo{Cwd: "/home/u/myrepo"}); err != nil {
		t.Fatal(err)
	}

	got := d.geminiContext(ctx)
	for _, want := range []string{"myrepo", "claude-opus-5", "4.25"} {
		if !strings.Contains(got, want) {
			t.Errorf("context missing %q:\n%s", want, got)
		}
	}
	// The basis travels with the figure, so the model cannot present a list
	// price as the user's bill (rule 6).
	if !strings.Contains(got, "list price") {
		t.Errorf("context does not state the costing basis:\n%s", got)
	}
}

// What is sent is the narrow part: totals and names. Caprock's database holds
// the prose Claude wrote and every command it ran, and none of that belongs in
// an outbound request the user did not specifically ask for.
func TestContextCarriesNoPromptsOrToolOutput(t *testing.T) {
	ctx := context.Background()
	d := geminiTestDaemon(t)

	secret := "SECRET-PROMPT-TEXT-do-not-send"
	toolOut := "SECRET-TOOL-OUTPUT-do-not-send"
	path := "/home/u/private/keys.txt"

	for _, ev := range []*event.Event{
		{Ts: time.Now(), SessionID: "s1", Source: event.SourceHook, Kind: event.KindTurnUser,
			Payload: json.RawMessage(`{"prompt":"` + secret + `"}`)},
		{Ts: time.Now(), SessionID: "s1", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Read",
			Payload: json.RawMessage(`{"tool_input":{"file_path":"` + path + `"}}`)},
		{Ts: time.Now(), SessionID: "s1", Source: event.SourceHook, Kind: event.KindToolPost, Tool: "Bash",
			Payload: json.RawMessage(`{"tool_response":"` + toolOut + `"}`)},
	} {
		if _, err := d.rec.Record(ctx, ev, rollup.SessionInfo{Cwd: "/home/u/myrepo"}); err != nil {
			t.Fatal(err)
		}
	}

	got := d.geminiContext(ctx)
	for _, leak := range []string{secret, toolOut, path} {
		if strings.Contains(got, leak) {
			t.Errorf("context leaked %q to an outbound request:\n%s", leak, got)
		}
	}
}

// An empty machine must produce a context that says so rather than one that
// invents activity — and it must not crash on the way.
func TestContextOnAnEmptyMachine(t *testing.T) {
	d := geminiTestDaemon(t)
	got := d.geminiContext(context.Background())
	if got == "" {
		t.Fatal("empty context")
	}
	if strings.Contains(got, "live sessions") {
		t.Errorf("claimed live sessions on an empty machine:\n%s", got)
	}
}

func TestCompactTokens(t *testing.T) {
	for _, c := range []struct {
		in   int64
		want string
	}{{999, "999"}, {1500, "1.5k"}, {2_400_000, "2.4M"}, {3_100_000_000, "3.1B"}} {
		if got := compactTokens(c.in); got != c.want {
			t.Errorf("compactTokens(%d) = %q, want %q", c.in, got, c.want)
		}
	}
}
