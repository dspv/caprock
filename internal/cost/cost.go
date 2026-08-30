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
	"time"

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

	// Until is the last date this row's prices applied, "YYYY-MM-DD"
	// inclusive, in UTC. Empty means "still current" — almost every row.
	//
	// A vendor's introductory price is a real price for the turns that ran
	// while it was live, and a different real price afterwards. Sonnet 5
	// launched at $2/$10 and reverts to $3/$15 on 2026-08-31; overwriting the
	// figure on that date would silently restate every August turn at a price
	// nobody was charged, which is rule 6's "no invented numbers" applied to
	// our own history. So a superseded price stays in the table with the date
	// it stopped applying, and Lookup picks the row that was in force when the
	// turn happened.
	//
	// Rows for one model id are ordered oldest-first in the JSON; the current
	// row is the one with no Until.
	Until string `json:"until,omitempty"`
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
	return t.LookupAt(model, time.Time{})
}

// LookupAt is Lookup for a turn that happened at a particular instant, which is
// what pricing a historical turn requires.
//
// Prices change, and a change is not retroactive: turns that ran under an
// introductory price were charged that price forever, and turns after it were
// not. A table with one row per model can only express "the price now", so
// restating history is the unavoidable side effect of every price change —
// August's spend would silently grow on the morning Sonnet 5's introductory
// rate expired.
//
// So a model may have several rows, oldest first, each carrying the date its
// price stopped applying (`until`, inclusive, UTC). This returns the first row
// whose window contains `at`. A zero `at` means "price it as of now", which is
// what Lookup does and what anything without a timestamp gets.
//
// Matching is still by longest id prefix after normalisation; the date only
// chooses between rows that already matched.
func (t *Table) LookupAt(model string, at time.Time) (Model, bool) {
	m := normalizeModel(model)
	if m == "" {
		return Model{}, false
	}
	for _, row := range t.Models {
		if !strings.HasPrefix(m, row.ID) {
			continue
		}
		if row.appliesAt(at) {
			return row, true
		}
	}
	return Model{}, false
}

// appliesAt reports whether this row's prices were in force at `at`.
//
// A row with no Until is the current one and applies to everything at or after
// its predecessor. A row with an Until applies through the end of that day: an
// expiry is announced as a date, not an instant, and the vendor's own switch
// happens at midnight UTC.
func (m Model) appliesAt(at time.Time) bool {
	if m.Until == "" {
		return true
	}
	if at.IsZero() {
		// No timestamp means "now". A superseded row is never the answer.
		return false
	}
	end, err := time.Parse("2006-01-02", m.Until)
	if err != nil {
		// An unparseable date must not silently price a turn at a rate that
		// expired. Treat the row as not applying and fall through to the
		// current one, which is the safe direction: today's price for a turn
		// whose date we cannot place, rather than an expired price for
		// everything.
		return false
	}
	return at.UTC().Before(end.AddDate(0, 0, 1))
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

// Price returns the USD cost of a token delta for a model, at today's prices.
// ok is false when the model is unknown to the table.
func (t *Table) Price(model string, d event.TokenDelta) (float64, bool) {
	return t.PriceAt(model, d, time.Time{})
}

// PriceAt is Price for a turn that ran at a particular instant, so a turn from
// before a price change is costed at the price it actually ran under. See
// LookupAt. A zero `at` prices at today's rates.
func (t *Table) PriceAt(model string, d event.TokenDelta, at time.Time) (float64, bool) {
	row, ok := t.LookupAt(model, at)
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
