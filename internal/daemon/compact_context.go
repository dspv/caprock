package daemon

import (
	"context"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
)

var _ api.Compacter = (*msgQueue)(nil)

// Compact is POST /v1/agents/{id}/compact (ADR-085): Claude Code's own
// /compact sent through the message queue, so it is typed in at once when
// the session sits at its prompt and otherwise when its turn ends. The
// session goes on in place with a summary; /clear is never typed.
//
// Typed as any message is (typeMessage): the text, then a bare CR 200 ms
// later, which Claude Code reads as Enter and submits — an ESC CR would be
// a line break inside the prompt. The confirmation a moment later presses
// Enter again only while the prompt still shows /compact.
//
// Only a Claude Code session Caprock started (rule 7); a press while a
// /compact already waits in the queue answers with that one, not a second.
func (q *msgQueue) Compact(ctx context.Context, id string) (api.SendResult, error) {
	unlock := q.lock(id)
	defer unlock()
	a, ok := q.owned(id)
	if !ok {
		return api.SendResult{}, api.ErrNotOwned
	}
	if a.Kind != "" && a.Kind != agents.AgentClaude {
		return api.SendResult{}, api.ErrNotCompactable
	}
	v, err := q.view(ctx, a)
	if err != nil {
		return api.SendResult{}, err
	}
	for i := range v.Messages {
		if v.Messages[i].Text == api.CompactCommand {
			m := v.Messages[i]
			return api.SendResult{Queued: &m, Queue: v}, nil
		}
	}
	return q.sendLocked(ctx, id, api.CompactCommand, "", v)
}
