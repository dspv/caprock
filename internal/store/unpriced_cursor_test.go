package store

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// The owner's Cost screen said "137.96M tokens not priced" over a list of
// Cursor names (claude-4-sonnet, default, composer-1, ...), which read as
// models missing from the table. They are Cursor chats Cursor recorded no
// cost for (ADR-095), so the summary names which unpriced models came from
// Cursor and the screen can say that instead.
func TestUnpricedNamesCursorModels(t *testing.T) {
	ctx := context.Background()
	st := openTest(t)
	now := time.Now().UnixMilli()
	seed := func(id, agent, model string, ts int64) {
		t.Helper()
		src := event.SourceTranscript
		if agent == "cursor" {
			src = event.SourceCursor
		}
		err := st.WithTx(ctx, func(q Querier) error {
			if err := UpsertSession(ctx, q, id, SessionPatch{
				Cwd: "/home/dev/p", Project: "p", Model: model,
				StartedAt: ts, LastEventAt: ts, Agent: agent,
			}); err != nil {
				return err
			}
			_, err := InsertEvent(ctx, q, &event.Event{
				Ts: time.UnixMilli(ts), SessionID: id, Source: src,
				Kind: event.KindTurnAssistant, Model: model,
				Tokens: &event.TokenDelta{In: 1000, Out: 10},
			})
			return err
		})
		if err != nil {
			t.Fatalf("seed %s: %v", id, err)
		}
	}
	seed("cu1", "cursor", "default", now)
	seed("cu2", "cursor", "composer-1", now+1)
	seed("cu3", "cursor", "claude-4-sonnet", now+2)
	seed("cl1", "claude", "claude-opus-9-future", now+3)

	sum, err := Summarize(ctx, st.DB(), 0)
	if err != nil {
		t.Fatal(err)
	}
	h, err := History(ctx, st.DB(), 0)
	if err != nil {
		t.Fatal(err)
	}
	for name, u := range map[string]*Unpriced{"summary": sum.Unpriced, "history": h.Unpriced} {
		if u == nil {
			t.Fatalf("%s: no unpriced volume", name)
		}
		if len(u.Models) != 4 {
			t.Errorf("%s: models = %v, want 4", name, u.Models)
		}
		got := slices.Clone(u.Cursor)
		slices.Sort(got)
		if want := []string{"claude-4-sonnet", "composer-1", "default"}; !slices.Equal(got, want) {
			t.Errorf("%s: cursor = %v, want %v", name, got, want)
		}
		if slices.Contains(u.Cursor, "claude-opus-9-future") {
			t.Errorf("%s: a Claude Code model is named as Cursor's", name)
		}
	}
}
