package daemon

import (
	"context"
	"errors"
	"testing"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/event"
)

// The Compact button types Claude Code's own /compact — never /clear — as
// two writes, the text and then a bare CR that submits it (an ESC CR would
// be a line break in the prompt). At the prompt it goes in at once.
func TestCompactTypesSlashCompactAndSubmits(t *testing.T) {
	q, f, d := newTestQueue(t)
	ctx := context.Background()
	set(f, f.owned, "s1", agents.AgentClaude)
	hook(t, q, d, "s1", event.KindAgentStop, nil, false)

	res, err := q.Compact(ctx, "s1")
	if err != nil || !res.Sent {
		t.Fatalf("compact at the prompt: %+v %v", res, err)
	}
	w := f.writesOf("s1")
	if len(w) != 2 || w[0].data != "/compact" || w[1].data != "\r" {
		t.Fatalf("writes %+v; want \"/compact\" then a bare CR", w)
	}
}

// Mid-turn it waits in the queue for the Stop; a second press while it
// waits answers with the one already there, and the Stop types it.
func TestCompactWaitsForTheTurnOnce(t *testing.T) {
	q, f, d := newTestQueue(t)
	ctx := context.Background()
	set(f, f.owned, "s1", agents.AgentClaude)
	hook(t, q, d, "s1", event.KindTurnUser, nil, false)
	hook(t, q, d, "s1", event.KindToolPre, map[string]any{"tool_name": "Bash"}, false)

	first, err := q.Compact(ctx, "s1")
	if err != nil || first.Sent || first.Queued == nil || first.Queued.Text != api.CompactCommand {
		t.Fatalf("compact mid-turn: %+v %v", first, err)
	}
	again, err := q.Compact(ctx, "s1")
	if err != nil || again.Queued == nil || again.Queued.ID != first.Queued.ID {
		t.Fatalf("second press: %+v %v", again, err)
	}
	if l := queued(t, d, "s1"); len(l) != 1 {
		t.Fatalf("queued %+v; want one /compact", l)
	}
	hook(t, q, d, "s1", event.KindAgentStop, nil, false)
	waitQueue(t, "the /compact", func() bool { return f.got("s1") == "/compact\r" })
}

// Rule 7: never into a session Caprock did not start; and only Claude
// Code, whose boundary measures the compaction.
func TestCompactOnlyOwnedClaude(t *testing.T) {
	q, f, _ := newTestQueue(t)
	ctx := context.Background()
	if _, err := q.Compact(ctx, "theirs"); !errors.Is(err, api.ErrNotOwned) {
		t.Fatalf("not owned: %v", err)
	}
	set(f, f.owned, "cx", agents.AgentCodex)
	if _, err := q.Compact(ctx, "cx"); !errors.Is(err, api.ErrNotCompactable) {
		t.Fatalf("codex: %v", err)
	}
	if got := f.got("cx") + f.got("theirs"); got != "" {
		t.Fatalf("typed %q", got)
	}
}
