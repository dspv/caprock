package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/gemini"
	"github.com/dspv/caprock/internal/rollup"
)

// geminiSessionID is the session every Gemini answer is recorded under.
//
// One session rather than one per question: the value of the screen is "what
// has Gemini cost me", and a hundred one-turn sessions would bury that under a
// list nobody reads. It reads as a long-running conversation with the model,
// which is what it is.
const geminiSessionID = "caprock-gemini"

// askGemini sends one prompt and records the exchange in the same event stream
// as everything else, so a Gemini answer is counted, priced and searchable
// beside a Claude turn rather than living in a corner of its own.
//
// The recorded turn carries tokens and a model but no cost: rollup prices it
// from the same table (ADR-023), because unlike OpenCode there is no vendor
// figure to carry — Google reports per project, never per call.
func (d *Daemon) askGemini(ctx context.Context, model, prompt string) (any, error) {
	// The user's own figures ride along, so the answer is about their machine
	// rather than about software in general. Costs the question a few hundred
	// tokens and is the difference between a chat window and a feature.
	system := geminiSystemPrompt + "\n\n" + d.geminiContext(ctx)

	c := &gemini.Client{}
	rep, err := c.Ask(ctx, model, system, prompt)
	if err != nil {
		return nil, err
	}

	info := rollup.SessionInfo{
		Cwd:   d.opt.RepoCwd,
		Model: rep.Model,
		Agent: gemini.Agent,
	}
	now := time.Now()

	// The question, then the answer — the same two-event shape a Claude turn
	// has, so narration, search and the activity feed need no special case.
	ask := &event.Event{
		Ts: now, SessionID: geminiSessionID, Source: event.SourceGemini,
		Kind: event.KindTurnUser, Payload: mustJSON(map[string]any{"prompt": prompt}),
		Key: fmt.Sprintf("gem-ask:%d", now.UnixNano()),
	}
	if _, err := d.rec.Record(ctx, ask, info); err != nil {
		d.log.Warn("gemini: could not record the question", "component", "gemini", "err", err)
	}

	u := rep.Usage
	answer := &event.Event{
		Ts: time.Now(), SessionID: geminiSessionID, Source: event.SourceGemini,
		Kind: event.KindTurnAssistant, Model: rep.Model,
		Payload: mustJSON(map[string]any{
			"text":            rep.Text,
			"thoughts_tokens": u.ThoughtsTokens,
			"elapsed_ms":      rep.Elapsed.Milliseconds(),
		}),
		// Thinking tokens are billed as output by Google, so they are counted
		// as output here — leaving them out would under-report the cost of
		// exactly the models that reason the most.
		Tokens: &event.TokenDelta{
			In:        u.PromptTokens,
			Out:       u.OutputTokens + u.ThoughtsTokens,
			CacheRead: u.CachedTokens,
		},
		Key: fmt.Sprintf("gem-ans:%d", time.Now().UnixNano()),
	}
	if _, err := d.rec.Record(ctx, answer, info); err != nil {
		d.log.Warn("gemini: could not record the answer", "component", "gemini", "err", err)
	}

	return rep, nil
}

// geminiSystemPrompt keeps answers short. A dashboard panel is not a chat
// window, and a model that writes five paragraphs into a box that fits three
// lines has spent the user's money on scrolling.
const geminiSystemPrompt = "You are answering inside Caprock, a dashboard that watches " +
	"this developer's AI coding sessions. The facts below are their own data, already " +
	"measured — use them, and say plainly when they do not answer the question rather " +
	"than filling the gap with a guess. Costs are at API list prices, not their actual " +
	"bill, so do not present a figure as what they were charged. " +
	"Be brief and concrete: a few sentences, or a short list. No preamble."

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return b
}
