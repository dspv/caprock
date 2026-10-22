package brain

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/dspv/caprock/internal/store"
)

// The re-tag gives English keywords to the memories that have none — the
// ones kept before the extraction asked for keywords (migration 0069), and
// the ones typed by hand — so a search in English finds a memory titled in
// another language. It runs inside a wake, after the reads: only when no
// session waits to be read, with the calls the wake has left, within the
// same daily token limit, and only while the extraction is on. Its batches
// are brain_runs rows of their own (store.BrainRetagSession), so their
// tokens count toward the limit and the spend like a read's.

// RetagBatch is how many memories one re-tag call sends.
const RetagBatch = 40

// retagSummaryRunes clips a memory's summary in a re-tag prompt: the title
// and the start of the summary are enough to name what it is about.
const retagSummaryRunes = 200

// RetagSystem is the re-tag's instructions.
const RetagSystem = `You add search keywords to a developer's saved notes. Each note is given as its id, its kind, its title and the start of its summary; titles and summaries may be in any language.
For every note, give five to eight lowercase English words or short phrases someone would search for to find it later: the subject, the component, the product terms, the obvious synonyms. Always in English, whatever language the note is in.
Answer for every note given, with its id exactly as given, and for no other id. Answer only with the JSON asked for.`

// RetagSchema is the shape of a re-tag answer, for --json-schema.
const RetagSchema = `{"type":"object","properties":{"tags":{"type":"array","items":{"type":"object","properties":{"id":{"type":"integer"},"keywords":{"type":"array","items":{"type":"string"},"maxItems":8}},"required":["id","keywords"]}}},"required":["tags"]}`

// retagAnswer is a re-tag answer: keywords per memory id.
type retagAnswer struct {
	Tags []struct {
		ID       int64    `json:"id"`
		Keywords []string `json:"keywords"`
	} `json:"tags"`
}

// RetagPrompt lists the memories one re-tag call sends, one per line:
// `#id kind: title — summary`.
func RetagPrompt(mems []store.BrainNode) string {
	var b strings.Builder
	b.WriteString("The notes, one per line (id, kind, title, summary):\n")
	for _, m := range mems {
		fmt.Fprintf(&b, "#%d %s: %s", m.ID, m.Kind, strings.Join(strings.Fields(m.Title), " "))
		if s := strings.Join(strings.Fields(m.Summary), " "); s != "" {
			fmt.Fprintf(&b, " — %s", clip(s, retagSummaryRunes))
		}
		b.WriteString("\n")
	}
	return b.String()
}

// ParseRetag reads a re-tag answer into keywords per memory id, keeping only
// the ids the batch sent (the first answer for an id wins).
func ParseRetag(raw json.RawMessage, sent []store.BrainNode) (map[int64][]string, error) {
	var a retagAnswer
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, fmt.Errorf("claude did not answer in the expected shape: %s", clip(string(raw), 200))
	}
	in := make(map[int64]bool, len(sent))
	for _, m := range sent {
		in[m.ID] = true
	}
	out := map[int64][]string{}
	for _, t := range a.Tags {
		if !in[t.ID] {
			continue
		}
		if _, ok := out[t.ID]; !ok {
			out[t.ID] = t.Keywords
		}
	}
	return out, nil
}

// Retag is the re-tag's progress for the status: Done the memories it has
// given keywords, Total that plus the memories still waiting.
type Retag struct {
	Done  int `json:"done"`
	Total int `json:"total"`
}

// retagStatus is the re-tag's progress; nil when nothing waits.
func (e *Engine) retagStatus(ctx context.Context) *Retag {
	db := e.Store.DB()
	cur, err := store.BrainRetagCursor(ctx, db)
	if err != nil {
		return nil
	}
	left, err := store.CountBrainUntagged(ctx, db, cur)
	if err != nil || left == 0 {
		return nil
	}
	done, err := store.BrainRetagDone(ctx, db)
	if err != nil {
		return nil
	}
	return &Retag{Done: done, Total: done + left}
}

// retag makes up to calls re-tag calls, stopping when nothing waits, the
// daily limit is reached, the extraction is turned off, or a call fails. It
// returns how many calls it made.
func (e *Engine) retag(ctx context.Context, calls int) (int, error) {
	made := 0
	for made < calls && ctx.Err() == nil && e.Enabled() {
		if e.spent(ctx) >= e.dailyCap() {
			e.setError("today's token limit is reached; reading resumes as the day rolls over")
			return made, nil
		}
		did, more, err := e.retagBatch(ctx)
		if did {
			made++
		}
		if err != nil || !more {
			return made, err
		}
	}
	return made, nil
}

// retagBatch sends the next RetagBatch memories without keywords and keeps
// what comes back. did is true when claude was called; more is false when
// nothing waits or a failure must be waited out. A failure is recorded and
// retried after retryAfter, doubling; after MaxFailures the batch is
// recorded skipped and the re-tag goes on past it, so it never loops.
func (e *Engine) retagBatch(ctx context.Context) (did, more bool, err error) {
	db := e.Store.DB()
	cur, err := store.BrainRetagCursor(ctx, db)
	if err != nil {
		return false, false, err
	}
	mems, err := store.BrainUntagged(ctx, db, cur, RetagBatch)
	if err != nil || len(mems) == 0 {
		return false, false, err
	}
	started := e.now().UnixMilli()
	run := store.BrainRun{SessionID: store.BrainRetagSession, FromEventID: mems[0].ID, ThroughEventID: mems[len(mems)-1].ID,
		StartedAt: started, Model: e.model()}
	n, last, err := store.BrainFailures(ctx, db, store.BrainRetagSession)
	if err != nil {
		return false, false, err
	}
	if n >= MaxFailures {
		run.Status, run.Error, run.FinishedAt = store.BrainRunSkipped, "gave up after repeated failures", started
		_, err := store.InsertBrainRun(ctx, db, run)
		return false, err == nil, err
	}
	if n > 0 && started < last+(retryAfter<<(n-1)).Milliseconds() {
		return false, false, nil
	}
	res, callErr := e.Runner.Run(ctx, Request{System: RetagSystem, Prompt: RetagPrompt(mems), Model: e.model(), Schema: RetagSchema})
	run.FinishedAt = e.now().UnixMilli()
	run.TokensIn, run.TokensOut, run.CostUSD = res.TokensIn, res.TokensOut, res.CostUSD
	if res.Model != "" {
		run.Model = res.Model
	}
	var tags map[int64][]string
	if callErr == nil {
		tags, callErr = ParseRetag(res.JSON, mems)
	}
	if callErr != nil {
		if ctx.Err() != nil {
			return true, false, ctx.Err()
		}
		run.Status, run.Error = store.BrainRunFailed, clip(callErr.Error(), 500)
		if _, err := store.InsertBrainRun(ctx, db, run); err != nil {
			return true, false, err
		}
		e.setError(callErr.Error())
		e.log().Warn("second brain: a re-tag failed", "component", "brain", "err", callErr)
		return true, false, nil
	}
	run.Status = store.BrainRunOK
	err = e.Store.WithTx(ctx, func(q store.Querier) error {
		id, err := store.InsertBrainRun(ctx, q, run)
		if err != nil {
			return err
		}
		tagged := 0
		for _, m := range mems {
			kw, ok := tags[m.ID]
			if !ok {
				continue
			}
			set, err := store.SetBrainKeywords(ctx, q, m.ID, kw)
			if err != nil {
				return err
			}
			if set {
				tagged++
			}
		}
		return store.SetBrainRunNodes(ctx, q, id, tagged)
	})
	if err != nil {
		return true, false, err
	}
	e.setError("")
	return true, true, nil
}
