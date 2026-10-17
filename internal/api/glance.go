package api

import (
	"context"
	"net/http"
	"strconv"
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
	// Trend is the last seven days against the seven before them, for the
	// block's change-in-share markers. Only on the all-time answer.
	Trend *GlanceTrend `json:"trend,omitempty"`
}

// trendDays is the length of each of the trend's two windows.
const trendDays = 7

// GlanceTrend is two equal windows ending now: prior = [prior_from_ms,
// cut_ms), recent = [cut_ms, to_ms).
type GlanceTrend struct {
	Days        int          `json:"days"`
	PriorFromMs int64        `json:"prior_from_ms"`
	CutMs       int64        `json:"cut_ms"`
	ToMs        int64        `json:"to_ms"`
	Prior       GlanceWindow `json:"prior"`
	Recent      GlanceWindow `json:"recent"`
}

// GlanceWindow is one trend window: the same four splits the block draws.
type GlanceWindow struct {
	// Models is stored cost by model id, the money donut's figure.
	Models map[string]float64 `json:"models"`
	Bill   *Bill              `json:"bill,omitempty"`
	// Tools is tool calls by tool.
	Tools  map[string]int64  `json:"tools"`
	Agents []store.WeekAgent `json:"agents"`
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
	// All time unless a range is asked for: the share card draws the agent
	// split of the period it is about (today, 7d, 30d). The key carries the
	// range's start, so "7d" computed yesterday is not served today.
	from, label := int64(0), "all"
	if rng := r.URL.Query().Get("range"); rng != "" && rng != "all" {
		from, label = s.rangeFrom(rng)
	}
	key := "glance:" + label + ":" + strconv.FormatInt(from, 10)
	v, err := s.glance.get(r.Context(), key, func() (any, error) {
		return s.buildGlance(context.WithoutCancel(r.Context()), from)
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
	resp.Bill = s.priceBill(toks, resp.Display)
	if from == 0 {
		t, err := s.buildTrend(ctx, resp.Display)
		if err != nil {
			return GlanceResponse{}, err
		}
		resp.Trend = t
	}
	return resp, nil
}

// buildTrend reads the two trend windows: one grouped query for the turns,
// one for the tool calls, and the agent split once per window.
func (s *Server) buildTrend(ctx context.Context, display map[string]string) (*GlanceTrend, error) {
	q := s.d.Store.DB()
	now := s.d.Now().UnixMilli()
	span := int64(trendDays) * 24 * time.Hour.Milliseconds()
	t := &GlanceTrend{Days: trendDays, PriorFromMs: now - 2*span, CutMs: now - span, ToMs: now}
	prior, recent, err := store.TrendWindows(ctx, q, t.PriorFromMs, t.CutMs)
	if err != nil {
		return nil, err
	}
	pa, err := store.AgentSplit(ctx, q, t.PriorFromMs, t.CutMs)
	if err != nil {
		return nil, err
	}
	ra, err := store.AgentSplit(ctx, q, t.CutMs, 0)
	if err != nil {
		return nil, err
	}
	window := func(w store.TrendWindow, agents []store.WeekAgent) GlanceWindow {
		g := GlanceWindow{Models: map[string]float64{}, Tools: w.Tools, Agents: agents}
		toks := make([]store.ModelTokens, 0, len(w.Models))
		for _, m := range w.Models {
			g.Models[m.Model] += m.CostUSD
			toks = append(toks, m.ModelTokens)
		}
		g.Bill = s.priceBill(toks, display)
		return g
	}
	t.Prior, t.Recent = window(prior, pa), window(recent, ra)
	return t, nil
}

// priceBill prices each model's tokens by type at the table's current rates,
// noting each priced model's display name. Nil without a pricing table.
func (s *Server) priceBill(toks []store.ModelTokens, display map[string]string) *Bill {
	if s.d.Table == nil {
		return nil
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
			display[m.Model] = row.Display
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
	return b
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
