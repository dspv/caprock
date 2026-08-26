// Package cost turns token usage into dollars using the versioned pricing table,
// and computes the cache-savings math ported from Caprock-python (_savings.py).
package cost

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/pricing"
)

// Model is one row of the pricing table. Prices are USD per million tokens.
type Model struct {
	ID            string  `json:"id"`
	Display       string  `json:"display"`
	Input         float64 `json:"input"`
	CacheWrite5m  float64 `json:"cache_write_5m"`
	CacheWrite1h  float64 `json:"cache_write_1h"`
	CacheRead     float64 `json:"cache_read"`
	Output        float64 `json:"output"`
	ContextWindow int64   `json:"context_window"`
}

// Table is the parsed pricing table.
type Table struct {
	Version   string   `json:"version"`
	Source    string   `json:"source"`
	FetchedAt string   `json:"fetched_at"`
	Currency  string   `json:"currency"`
	Unit      string   `json:"unit"`
	Notes     []string `json:"notes"`
	Models    []Model  `json:"models"`
	// UserOverride is true when the table came from <data_dir>/pricing.json.
	UserOverride bool `json:"user_override,omitempty"`
}

// Parse decodes a pricing table and validates it.
func Parse(b []byte) (*Table, error) {
	var t Table
	if err := json.Unmarshal(b, &t); err != nil {
		return nil, fmt.Errorf("parse pricing table: %w", err)
	}
	if t.Version == "" {
		return nil, errors.New("pricing table has no version")
	}
	if len(t.Models) == 0 {
		return nil, errors.New("pricing table has no models")
	}
	for _, m := range t.Models {
		if m.ID == "" || m.Input < 0 || m.Output < 0 || m.CacheRead < 0 || m.CacheWrite5m < 0 || m.CacheWrite1h < 0 {
			return nil, fmt.Errorf("pricing table: invalid model row %+v", m)
		}
	}
	// Longest id first so prefix matching picks the most specific row.
	sort.SliceStable(t.Models, func(i, j int) bool { return len(t.Models[i].ID) > len(t.Models[j].ID) })
	return &t, nil
}

// Embedded returns the table compiled into the binary.
func Embedded() (*Table, error) { return Parse(pricing.JSON) }

// Load returns the user override at overridePath if it exists and parses, else the
// embedded table. A broken override is an error (never silently ignored — a wrong
// price file must not masquerade as the default).
func Load(overridePath string) (*Table, error) {
	if overridePath != "" {
		b, err := os.ReadFile(overridePath)
		switch {
		case err == nil:
			t, err := Parse(b)
			if err != nil {
				return nil, fmt.Errorf("user pricing override %s: %w", overridePath, err)
			}
			t.UserOverride = true
			return t, nil
		case !errors.Is(err, os.ErrNotExist):
			return nil, fmt.Errorf("read pricing override: %w", err)
		}
	}
	return Embedded()
}

// Lookup finds the pricing row for a model id observed in a transcript
// (e.g. "claude-opus-5", "claude-sonnet-4-5-20250929", "us.anthropic.claude-sonnet-4-5-20250929-v1:0").
// Matching is by longest id prefix after stripping known provider prefixes. ok is
// false when nothing matches — the caller must then leave cost nil, never zero.
func (t *Table) Lookup(model string) (Model, bool) {
	m := normalizeModel(model)
	if m == "" {
		return Model{}, false
	}
	for _, row := range t.Models {
		if strings.HasPrefix(m, row.ID) {
			return row, true
		}
	}
	return Model{}, false
}

func normalizeModel(model string) string {
	m := strings.ToLower(strings.TrimSpace(model))
	// Bedrock ids: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" → "claude-sonnet-4-5-20250929-v1:0"
	if i := strings.Index(m, "anthropic."); i >= 0 {
		m = m[i+len("anthropic."):]
	}
	// Vertex ids: "claude-opus-4-5@20251101" → keep the part before "@".
	if i := strings.Index(m, "@"); i >= 0 {
		m = m[:i]
	}
	// Gateway ids carry the vendor ahead of the model: OpenRouter reports
	// "minimax/minimax-m3" and "openai/gpt-5.5" for the same models a direct
	// API calls "MiniMax-M3" and "gpt-5.5". Without this the same model priced
	// through two routes is two rows, one of them unpriced — which is exactly
	// what the owner's own database looked like: four spellings of MiniMax,
	// 38 turns nobody could cost.
	if i := strings.LastIndex(m, "/"); i >= 0 {
		m = m[i+1:]
	}
	return m
}

const perMTok = 1_000_000

// Price returns the USD cost of a token delta for a model. ok is false when the
// model is unknown to the table.
func (t *Table) Price(model string, d event.TokenDelta) (float64, bool) {
	row, ok := t.Lookup(model)
	if !ok {
		return 0, false
	}
	cw5m := d.CacheWrite - d.CacheWrite1h
	if cw5m < 0 {
		cw5m = 0
	}
	usd := float64(d.In)*row.Input +
		float64(cw5m)*row.CacheWrite5m +
		float64(d.CacheWrite1h)*row.CacheWrite1h +
		float64(d.CacheRead)*row.CacheRead +
		float64(d.Out)*row.Output
	return usd / perMTok, true
}

// Savings is the cache-savings math from Caprock-python, in input-token equivalents.
//
//	billed_with    = in + 1.25·cache_write + 0.10·cache_read
//	billed_without = in + cache_write + cache_read     (all fresh input)
//	saved          = billed_without − billed_with
type Savings struct {
	BilledWith    float64 `json:"billed_with"`
	BilledWithout float64 `json:"billed_without"`
	Saved         float64 `json:"saved"`
	// HitRate = cache_read / (in + cache_read + cache_write); 0 when no input.
	HitRate float64 `json:"hit_rate"`
	// CutPct = saved / billed_without × 100; 0 when nothing was billed.
	CutPct float64 `json:"cut_pct"`
}

// Anthropic prompt-cache multipliers relative to base input (documented): writes
// +25% (5m TTL), reads 10%. The 1h TTL write is 2× and is priced correctly by
// Price(); the savings *meter* keeps the legacy 1.25 for continuity with the
// numbers Caprock-python printed.
const (
	wWrite = 1.25
	wRead  = 0.10
)

// ComputeSavings applies the formula to raw token counts.
func ComputeSavings(in, cacheRead, cacheWrite int64) Savings {
	s := Savings{
		BilledWith:    float64(in) + wWrite*float64(cacheWrite) + wRead*float64(cacheRead),
		BilledWithout: float64(in + cacheWrite + cacheRead),
	}
	s.Saved = s.BilledWithout - s.BilledWith
	if s.Saved < 0 {
		s.Saved = 0
	}
	if denom := in + cacheRead + cacheWrite; denom > 0 {
		s.HitRate = float64(cacheRead) / float64(denom)
	}
	if s.BilledWithout > 0 {
		s.CutPct = s.Saved / s.BilledWithout * 100
	}
	return s
}
