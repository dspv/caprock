package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// GlanceResponse is GET /v1/glance: what the Now screen's At a glance block
// draws beyond /v1/history, over everything Caprock has seen — who did the
// work, and what kind of token the bill was made of. Contract:
// .ai/03-contracts.md § At a glance.
type GlanceResponse struct {
	Agents []store.WeekAgent `json:"agents"`
	// Bill prices each model's tokens by type at the table's current rates,
	// the way the context tax is priced. Absent without a pricing table.
	Bill *Bill `json:"bill,omitempty"`
	// Display maps the model ids in range to the pricing table's names, so a
	// chart can say "Opus 5.5" rather than an id.
	Display map[string]string `json:"display"`
}

// Bill is the cost of each type of token. CacheRead is the context tax.
type Bill struct {
	InputUSD      float64 `json:"input_usd"`
	OutputUSD     float64 `json:"output_usd"`
	CacheWriteUSD float64 `json:"cache_write_usd"`
	CacheReadUSD  float64 `json:"cache_read_usd"`
	// UnpricedTokens belong to models with no pricing row and are in no
	// figure above.
	UnpricedTokens int64 `json:"unpriced_tokens,omitempty"`
}

// glanceTTL: all-time figures move a turn at a time, and the agent split reads
// every assistant turn, so it is computed at most once a minute.
const glanceTTL = 60 * time.Second

func (s *Server) handleGlance(w http.ResponseWriter, r *http.Request) {
	v, err := s.glance.get(r.Context(), "glance:all", func() (any, error) {
		return s.buildGlance(context.WithoutCancel(r.Context()), 0)
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) buildGlance(ctx context.Context, from int64) (GlanceResponse, error) {
	q := s.d.Store.DB()
	agents, err := store.AgentSplit(ctx, q, from, 0)
	if err != nil {
		return GlanceResponse{}, err
	}
	resp := GlanceResponse{Agents: agents, Display: map[string]string{}}
	toks, err := store.TokensByModel(ctx, q, from)
	if err != nil {
		return GlanceResponse{}, err
	}
	if s.d.Table == nil {
		return resp, nil
	}
	b := &Bill{}
	const perM = 1_000_000.0
	for _, m := range toks {
		row, ok := s.d.Table.Lookup(m.Model)
		if !ok {
			b.UnpricedTokens += m.In + m.Out + m.CacheRead + m.CacheWrite
			continue
		}
		if row.Display != "" {
			resp.Display[m.Model] = row.Display
		}
		cw5m := m.CacheWrite - m.CacheWrite1h
		if cw5m < 0 {
			cw5m = 0
		}
		b.InputUSD += float64(m.In) * row.Input / perM
		b.OutputUSD += float64(m.Out) * row.Output / perM
		b.CacheWriteUSD += (float64(cw5m)*row.CacheWrite5m + float64(m.CacheWrite1h)*row.CacheWrite1h) / perM
		b.CacheReadUSD += float64(m.CacheRead) * row.CacheRead / perM
	}
	resp.Bill = b
	return resp, nil
}

// modelDisplay is the pricing table's short name for a model: "Opus 5.5"
// rather than "claude-opus-5-5". Empty when the table does not know it.
func (s *Server) modelDisplay(model string) string {
	if s.d.Table == nil || model == "" {
		return ""
	}
	row, ok := s.d.Table.Lookup(model)
	if !ok || row.Display == "" {
		return ""
	}
	return strings.TrimPrefix(row.Display, "Claude ")
}

// liveSubagentWindow bounds how long a silent subagent is believed to be
// working: one whose SubagentStop never arrived must not count forever.
const liveSubagentWindow = store.LiveSubagentWindow
