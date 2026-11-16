package store

import (
	"context"
	"database/sql"
	"errors"
	"sort"

	"github.com/dspv/caprock/internal/modelclass"
)

// CursorCost is what Cursor's chats cost in a range, in Cursor's own terms
// (ADR-095). Cursor keeps a cost per chat and model for some chats
// (`usageData`) and none for the rest; the importer carries its figure as
// it is and leaves the others unpriced, never priced from Caprock's table.
type CursorCost struct {
	// TotalUSD is the cost Cursor recorded, inside the screen's total.
	TotalUSD float64 `json:"total_usd"`
	// Requests is the number of requests Cursor counted for that cost.
	Requests int64 `json:"requests"`
	// Chats is how many Cursor sessions had turns in the range; PricedChats
	// how many of them Cursor recorded a cost for.
	Chats       int64 `json:"chats"`
	PricedChats int64 `json:"priced_chats"`
	// UnpricedTokens are tokens of chats Cursor recorded no cost for.
	UnpricedTokens int64 `json:"unpriced_tokens"`
	// Models splits the figures by the model Cursor named.
	Models []CursorModel `json:"models,omitempty"`
}

// CursorModel is one model's line in CursorCost.
type CursorModel struct {
	Model    string  `json:"model"`
	CostUSD  float64 `json:"cost_usd"`
	Requests int64   `json:"requests"`
	Tokens   int64   `json:"tokens"`
	Priced   bool    `json:"priced"`
}

// CursorSpend sums Cursor's turns since fromMs; nil when there are none.
func CursorSpend(ctx context.Context, q Querier, fromMs int64) (*CursorCost, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT s.sid, COALESCE(e.model,''),
		       COALESCE(SUM(e.cost_usd),0),
		       COALESCE(SUM(json_extract(e.payload,'$.requests')),0),
		       COALESCE(SUM(COALESCE(e.tokens_in,0)+COALESCE(e.tokens_out,0)),0),
		       COALESCE(MAX(e.cost_usd IS NOT NULL),0)
		FROM sessions s JOIN events e INDEXED BY idx_events_session_ts
		  ON e.sid = s.sid AND e.ts >= ?
		WHERE s.agent = 'cursor' AND e.source = 'cursor' AND e.kind = 'turn.assistant'`+nonInternalEventE+`
		GROUP BY 1, 2`, fromMs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out CursorCost
	chats := map[int64]bool{}
	priced := map[int64]bool{}
	byModel := map[string]*CursorModel{}
	for rows.Next() {
		var sid, requests, tokens int64
		var model string
		var usd float64
		var hasCost int
		if err := rows.Scan(&sid, &model, &usd, &requests, &tokens, &hasCost); err != nil {
			return nil, err
		}
		chats[sid] = true
		m := byModel[model]
		if m == nil {
			m = &CursorModel{Model: model}
			byModel[model] = m
		}
		m.CostUSD += usd
		m.Requests += requests
		m.Tokens += tokens
		out.TotalUSD += usd
		out.Requests += requests
		if hasCost == 1 {
			priced[sid] = true
			m.Priced = true
		} else {
			out.UnpricedTokens += tokens
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(chats) == 0 {
		return nil, nil
	}
	out.Chats, out.PricedChats = int64(len(chats)), int64(len(priced))
	for _, m := range byModel {
		out.Models = append(out.Models, *m)
	}
	sort.Slice(out.Models, func(i, j int) bool {
		if out.Models[i].CostUSD != out.Models[j].CostUSD {
			return out.Models[i].CostUSD > out.Models[j].CostUSD
		}
		if out.Models[i].Tokens != out.Models[j].Tokens {
			return out.Models[i].Tokens > out.Models[j].Tokens
		}
		return out.Models[i].Model < out.Models[j].Model
	})
	return &out, nil
}

// OverheadRow is one model family's first-request figures for one agent.
type OverheadRow struct {
	// Family is the model the figures are for, as modelclass.Family names it,
	// so Cursor's and Claude Code's names for one model share a row.
	Family string `json:"family"`
	// Models are the agent's own ids that fell into the family.
	Models []string `json:"models"`
	// Samples is how many sessions were measured; Clean how many of them
	// had a first request whose conversation was small enough for the
	// difference to be read (Cursor only; every Claude Code sample is).
	Samples int `json:"samples"`
	Clean   int `json:"clean"`
	// MedianTokens and MinTokens are over the clean samples: what the agent
	// sent beyond the conversation, in tokens.
	MedianTokens int64 `json:"median_tokens"`
	MinTokens    int64 `json:"min_tokens"`
}

// OverheadReport sets Cursor's estimate beside Claude Code's measured first
// request, family by family (ADR-095).
type OverheadReport struct {
	Cursor []OverheadRow `json:"cursor"`
	Claude []OverheadRow `json:"claude"`
}

// ContextOverhead reads both agents' first requests in sessions active since
// fromMs.
//
// Cursor's come from the context.overhead rows the importer writes: the
// first measured request minus the conversation before it. Claude Code's are
// read here from each main thread's first priced turn: its whole prompt
// (fresh input, cache read and cache write — exact, from the API) minus the
// prompt the person typed, at the same four bytes a token. Both are
// therefore "what the agent sent that the person did not write".
func ContextOverhead(ctx context.Context, q Querier, fromMs int64) (*OverheadReport, error) {
	out := &OverheadReport{}
	cur := map[string]*famAcc{}
	rows, err := q.QueryContext(ctx, `
		SELECT COALESCE(e.model,''),
		       COALESCE(json_extract(e.payload,'$.overhead_tokens'),0),
		       COALESCE(json_extract(e.payload,'$.clean'),0)
		FROM sessions s JOIN events e INDEXED BY idx_events_session_ts ON e.sid = s.sid
		WHERE s.agent = 'cursor' AND s.last_event_at >= ? AND e.kind = 'context.overhead'
		  AND json_valid(e.payload)`, fromMs)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var model string
		var tokens int64
		var clean int
		if err := rows.Scan(&model, &tokens, &clean); err != nil {
			_ = rows.Close()
			return nil, err
		}
		acc(cur, model).add(tokens, clean == 1)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	cl := map[string]*famAcc{}
	rows, err = q.QueryContext(ctx, `
		WITH first AS (
		  SELECT e.sid, MIN(e.id) AS id
		  FROM sessions s JOIN events e INDEXED BY idx_events_session_ts ON e.sid = s.sid
		  WHERE s.agent = 'claude' AND s.started_at >= ? AND s.chat = 0
		    AND e.kind = 'turn.assistant' AND e.internal = 0 AND `+MainThreadWhere+`
		    AND COALESCE(e.tokens_in,0)+COALESCE(e.cache_read,0)+COALESCE(e.cache_write,0) > 0
		  GROUP BY e.sid)
		SELECT COALESCE(e.model,''),
		       COALESCE(e.tokens_in,0)+COALESCE(e.cache_read,0)+COALESCE(e.cache_write,0),
		       COALESCE((SELECT LENGTH(CAST(json_extract(u.payload,'$.prompt') AS BLOB))
		                 FROM events u INDEXED BY idx_events_session_id
		                 WHERE u.sid = e.sid AND u.id < e.id AND u.kind = 'turn.user'
		                 ORDER BY u.id LIMIT 1),0)
		FROM first f JOIN events e ON e.id = f.id`, fromMs)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var model string
		var prompt, typed int64
		if err := rows.Scan(&model, &prompt, &typed); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if model == "" || modelclass.IsInternal(model) {
			continue
		}
		acc(cl, model).add(prompt-typed/4, true)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out.Cursor = finish(cur)
	out.Claude = finish(cl)
	return out, nil
}

type famAcc struct {
	family string
	models map[string]bool
	clean  []int64
	n      int
}

func acc(m map[string]*famAcc, model string) *famAcc {
	f := modelclass.Family(model)
	a := m[f]
	if a == nil {
		a = &famAcc{family: f, models: map[string]bool{}}
		m[f] = a
	}
	a.models[model] = true
	return a
}

func (a *famAcc) add(tokens int64, clean bool) {
	a.n++
	if clean && tokens > 0 {
		a.clean = append(a.clean, tokens)
	}
}

func finish(m map[string]*famAcc) []OverheadRow {
	out := make([]OverheadRow, 0, len(m))
	for _, a := range m {
		r := OverheadRow{Family: a.family, Samples: a.n, Clean: len(a.clean)}
		for k := range a.models {
			r.Models = append(r.Models, k)
		}
		sort.Strings(r.Models)
		if len(a.clean) > 0 {
			sort.Slice(a.clean, func(i, j int) bool { return a.clean[i] < a.clean[j] })
			r.MinTokens = a.clean[0]
			n := len(a.clean)
			if n%2 == 1 {
				r.MedianTokens = a.clean[n/2]
			} else {
				r.MedianTokens = (a.clean[n/2-1] + a.clean[n/2]) / 2
			}
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Samples != out[j].Samples {
			return out[i].Samples > out[j].Samples
		}
		return out[i].Family < out[j].Family
	})
	return out
}

// SessionOverhead is one Cursor chat's first-request estimate, as the
// importer recorded it (cursor.Overhead); nil for a chat with none.
type SessionOverhead struct {
	Model          string `json:"model"`
	RequestTokens  int64  `json:"request_tokens"`
	TypedTokens    int64  `json:"typed_tokens"`
	VisibleTokens  int64  `json:"visible_tokens"`
	OverheadTokens int64  `json:"overhead_tokens"`
	// ModelCalls is how many model requests Cursor made in the turn up to
	// and including the measured one.
	ModelCalls int64 `json:"model_calls"`
	Clean      bool  `json:"clean"`
}

// SessionOverheadFor reads a session's context.overhead row.
func SessionOverheadFor(ctx context.Context, q Querier, sessionID string) (*SessionOverhead, error) {
	var o SessionOverhead
	var clean int
	err := q.QueryRowContext(ctx, `
		SELECT COALESCE(e.model,''),
		       COALESCE(json_extract(e.payload,'$.request_tokens'),0),
		       COALESCE(json_extract(e.payload,'$.typed_tokens'),0),
		       COALESCE(json_extract(e.payload,'$.visible_tokens'),0),
		       COALESCE(json_extract(e.payload,'$.overhead_tokens'),0),
		       COALESCE(json_extract(e.payload,'$.model_calls'),0),
		       COALESCE(json_extract(e.payload,'$.clean'),0)
		FROM events e
		WHERE e.sid = (SELECT sid FROM sessions WHERE session_id = ?) AND e.kind = 'context.overhead'
		  AND json_valid(e.payload)
		ORDER BY e.id LIMIT 1`, sessionID).Scan(&o.Model, &o.RequestTokens, &o.TypedTokens, &o.VisibleTokens, &o.OverheadTokens, &o.ModelCalls, &clean)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	o.Clean = clean == 1
	return &o, nil
}
