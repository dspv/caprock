// Package cost turns token usage into dollars using the versioned pricing table,
// and computes the cache-savings math ported from Caprock-python (_savings.py).
package cost

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
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
	// while it was live, and a different real price afterwards; overwriting
	// the figure on the day it changes would silently restate every earlier
	// turn at a price nobody was charged, which is rule 6's "no invented
	// numbers" applied to our own history. So a superseded price stays in the
	// table with the date it stopped applying, and Lookup picks the row that
	// was in force when the turn happened. (Sonnet 5 was the first case; its
	// announced rise was then cancelled, which is a Correction, not a change.)
	//
	// Rows for one model id are ordered oldest-first in the JSON; the current
	// row is the one with no Until.
	Until string `json:"until,omitempty"`

	// Tiers are the prices for a larger prompt, lowest threshold first. A
	// vendor that prices by prompt length bills the whole request at the
	// higher rate once the prompt passes the threshold: Claude Haiku 5.5 over
	// 100,000 tokens costs five times its base rate, GPT-6 over 272K twice the
	// input and 1.5x the output. The row's own columns are the base tier;
	// ForPrompt picks the one a request falls in. Empty for most rows.
	Tiers []Tier `json:"tiers,omitempty"`
}

// Tier is a row's prices for prompts larger than AbovePromptTokens. The
// prompt is the request's whole input as the vendor counts it: fresh input,
// cache reads and cache writes (PromptTokens). Every column is given; a tier
// never inherits a price from the base row.
type Tier struct {
	AbovePromptTokens int64   `json:"above_prompt_tokens"`
	Input             float64 `json:"input"`
	CacheWrite5m      float64 `json:"cache_write_5m"`
	CacheWrite1h      float64 `json:"cache_write_1h"`
	CacheRead         float64 `json:"cache_read"`
	Output            float64 `json:"output"`
}

// PromptTokens is the size of the prompt a request sent, as Anthropic,
// OpenAI and Google count it for prompt-length pricing: all of its input,
// cache reads and cache writes included.
func PromptTokens(d event.TokenDelta) int64 {
	return max(d.In, 0) + max(d.CacheRead, 0) + max(d.CacheWrite, 0)
}

// ForPrompt is this row with its prices replaced by those of the highest tier
// whose threshold the prompt exceeds, or the row unchanged when none does. A
// prompt exactly at a threshold is in the lower tier: the vendors say "over"
// and "more than".
func (m Model) ForPrompt(prompt int64) Model {
	out := m
	for _, t := range m.Tiers {
		if prompt <= t.AbovePromptTokens {
			break
		}
		out.Input, out.CacheWrite5m, out.CacheWrite1h, out.CacheRead, out.Output =
			t.Input, t.CacheWrite5m, t.CacheWrite1h, t.CacheRead, t.Output
	}
	return out
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
	// Corrections name the turns this version prices differently because an
	// earlier version was wrong, not because a price changed. See Correction.
	Corrections []Correction `json:"corrections,omitempty"`
	// UserOverride is true when the table came from <data_dir>/pricing.json.
	UserOverride bool `json:"user_override,omitempty"`
}

// Correction marks turns an earlier table priced wrongly. A price change
// never restates history (see Model.Until); a mistake in the table is
// different — the figure it produced was one nobody was charged, and keeping it
// keeps an invented number (rule 6). Two cases made this necessary: Opus 5.5
// had no row and fell through to Opus 5's by prefix, at 1.25x its input price
// and 2.5x its cache read; and Sonnet 5's announced rise to $3/$15 on
// 2026-08-31 was cancelled, so every Sonnet 5 turn from that day had been
// priced at a rate that never applied.
//
// The daemon reprices the matching turns once per table version, at the row in
// force at each turn's own timestamp, and moves the session and daily totals by
// the difference (rollup.ApplyCorrections).
type Correction struct {
	// Model is a prefix of the stored model id (SQL LIKE "model%"); each turn
	// it selects is then repriced by the matching rule, so a turn whose id no
	// row matches is left as it was.
	Model string `json:"model"`
	// From is the first UTC day, "YYYY-MM-DD", whose turns are affected.
	// Empty means every turn of that model.
	From string `json:"from,omitempty"`
	// Reason is for the person reading the table.
	Reason string `json:"reason,omitempty"`
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
		last := int64(0)
		for i, tr := range m.Tiers {
			if tr.AbovePromptTokens <= last || tr.Input < 0 || tr.Output < 0 || tr.CacheRead < 0 || tr.CacheWrite5m < 0 || tr.CacheWrite1h < 0 {
				return nil, fmt.Errorf("pricing table: %s tier %d: thresholds must rise from above zero and prices must not be negative", m.ID, i)
			}
			last = tr.AbovePromptTokens
		}
	}
	for _, c := range t.Corrections {
		if c.Model == "" {
			return nil, errors.New("pricing table: a correction names no model")
		}
		if c.From != "" {
			if _, err := time.Parse("2006-01-02", c.From); err != nil {
				return nil, fmt.Errorf("pricing table: correction for %s: from %q is not YYYY-MM-DD", c.Model, c.From)
			}
		}
	}
	// Longest id first so matching picks the most specific row.
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
// at today's prices; see LookupAt. ok is false when nothing matches — the
// caller must then leave cost nil, never zero.
func (t *Table) Lookup(model string) (Model, bool) {
	return t.LookupAt(model, time.Time{})
}

// now is the clock a lookup without a timestamp reads; a test replaces it.
var now = time.Now

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
// whose window contains `at`. A zero `at` means the current time, which is
// what Lookup does and what anything without a timestamp gets. It means the
// clock, not "the row with no until": a change announced for a future date is
// entered in advance as a row with that `until` followed by the new one, and
// today must still read today's price (Gemini 4 Carbon's rise on 2026-12-01
// was the first such change).
//
// A row matches an id when the id is the row's id, or the row's id followed by
// a suffix that names the same model (matchesID). The longest matching id
// wins; the date only chooses between rows that already matched.
func (t *Table) LookupAt(model string, at time.Time) (Model, bool) {
	m := normalizeModel(model)
	if m == "" {
		return Model{}, false
	}
	if at.IsZero() {
		at = now()
	}
	for _, row := range t.Models {
		if !matchesID(m, row.ID) {
			continue
		}
		if row.appliesAt(at) {
			return row, true
		}
	}
	if isFreeModel(m) {
		return Model{ID: m, Display: m}, true
	}
	return Model{}, false
}

// matchesID reports whether a normalised model id names the model a row
// prices: the row's id itself, or the row's id followed by a suffix a vendor
// or a launcher adds to the same model —
//
//   - a dated snapshot, "-YYYYMMDD" ("claude-haiku-4-5-20251001"), which may
//     carry Bedrock's version after it ("-v1:0");
//   - a Bedrock version alone, "-vN" or "-vN:N";
//   - a bracket, "[1m]", which Claude Code's launchers append for a 1M
//     context ("kimi-k3[1m]", "deepseek-flash[1m]");
//   - a ":" and anything after it: Bedrock's ":0", an OpenRouter tag.
//
// (Vertex's "@20251101" never reaches here: normalizeModel cuts it off.)
// Anything else is a different model. A bare prefix match priced
// claude-fable-5-2 as claude-fable-5, at 1.25x its input and 5x its cache
// read, and would price minimax-m3.1-flash as minimax-m3 and gpt-5.5 as a
// gpt-5 row. An id no row matches is unpriced and named as such, which a
// reader can see and report; a wrong price looks like any other (rule 6).
func matchesID(m, id string) bool {
	if !strings.HasPrefix(m, id) {
		return false
	}
	return modelSuffix.MatchString(m[len(id):])
}

// modelSuffix is what may follow a row's id in an id it matches; see matchesID.
var modelSuffix = regexp.MustCompile(`^(?:-\d{8})?(?:-v\d+(?::\d+)?)?(?:\[[^\]]*\])?(?::.*)?$`)

// isFreeModel reports whether a gateway names the id as its no-charge
// variant: OpenCode Zen spells it "-free" ("deepseek-v4.1-flash-free",
// issue #787) and OpenRouter ":free" ("deepseek/deepseek-chat:free"). The
// gateway bills nothing for those, so $0 is the measured price, not a guess —
// and an unpriced line asking the user to report a model that is free by name
// is noise. A row in the table still wins, as for any other id. The row has
// no context window, which is not known from the id.
func isFreeModel(m string) bool {
	return strings.HasSuffix(m, "-free") || strings.HasSuffix(m, ":free")
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
	// A vendor that prices by prompt length bills the whole request at the
	// tier its prompt falls in, so the tier is chosen per turn, never from a
	// total.
	row = row.ForPrompt(PromptTokens(d))
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

// Savings is the cache-savings math from Caprock-python, in input-token
// equivalents, with each model's cache weighed at its own prices:
//
//	billed_with    = in + Σ write_m·cache_write_m + Σ read_m·cache_read_m
//	billed_without = in + cache_write + cache_read     (all fresh input)
//	saved          = billed_without − billed_with
//
// where read_m and write_m are model m's cache-read and 5-minute cache-write
// prices over its input price (SavingsWeights): 0.10 and 1.25 on most Claude
// rows, 0.05 on Opus 5.5 and Sonnet 5.5, 0.025 on Fable and Mythos 5.1.
type Savings struct {
	BilledWith    float64 `json:"billed_with"`
	BilledWithout float64 `json:"billed_without"`
	Saved         float64 `json:"saved"`
	// HitRate = cache_read / (in + cache_read + cache_write); 0 when no input.
	HitRate float64 `json:"hit_rate"`
	// CutPct = saved / billed_without × 100; 0 when nothing was billed.
	CutPct float64 `json:"cut_pct"`
}

// The weights for tokens no pricing row speaks for: Anthropic's documented
// prompt-cache multipliers that held for every model before the 5.5 family,
// writes +25% (5m TTL), reads 10% of base input.
const (
	fallbackWrite = 1.25
	fallbackRead  = 0.10
)

// SavingsWeights are a model's cache-read and cache-write prices over its
// input price, from its current row: what one cached token costs in fresh-
// input tokens. A model with no row, or a row with no input price (a free
// model), gets the fallback 0.10 and 1.25; so does a row's read price of 0,
// which no row means as "free". A cache-write price of 0 — OpenAI's and
// Google's rows, which bill no surcharge for writing — counts as 1: written
// tokens cost what fresh input does, and the meter never counts them as
// saved. The 1-hour write (2x on Claude rows) is not split here: the summed
// events do not carry it, so every write is weighed at the 5-minute price,
// as the meter always has; Price() prices the 1-hour tokens correctly.
func (t *Table) SavingsWeights(model string) (read, write float64) {
	if t == nil {
		return fallbackRead, fallbackWrite
	}
	m, ok := t.Lookup(model)
	if !ok || m.Input <= 0 {
		return fallbackRead, fallbackWrite
	}
	read, write = fallbackRead, 1.0
	if m.CacheRead > 0 {
		read = m.CacheRead / m.Input
	}
	if m.CacheWrite5m > 0 {
		write = m.CacheWrite5m / m.Input
	}
	return read, write
}

// CacheUse is one model's cache tokens within a savings figure.
type CacheUse struct {
	Model                 string
	CacheRead, CacheWrite int64
}

// SavingsFor is the savings over the totals in, cacheRead and cacheWrite, the
// cache tokens of each model in byModel weighed at that model's own rates
// (SavingsWeights). Whatever part of the totals byModel does not name — a
// figure summed with no model beside it — is weighed at the fallback rates,
// and an entry past what the totals hold is cut to fit, so the result is
// always over the totals given. A nil table weighs everything at the
// fallback.
func (t *Table) SavingsFor(in, cacheRead, cacheWrite int64, byModel []CacheUse) Savings {
	s := Savings{BilledWithout: float64(in + cacheWrite + cacheRead)}
	with := float64(in)
	leftRead, leftWrite := max(cacheRead, 0), max(cacheWrite, 0)
	for _, u := range byModel {
		cr, cw := min(max(u.CacheRead, 0), leftRead), min(max(u.CacheWrite, 0), leftWrite)
		if cr == 0 && cw == 0 {
			continue
		}
		r, w := t.SavingsWeights(u.Model)
		with += r*float64(cr) + w*float64(cw)
		leftRead -= cr
		leftWrite -= cw
	}
	with += fallbackRead*float64(leftRead) + fallbackWrite*float64(leftWrite)
	s.BilledWith = with
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

// ComputeSavings applies the formula to raw token counts with no model known,
// at the fallback rates. Callers that know the models use SavingsFor.
func ComputeSavings(in, cacheRead, cacheWrite int64) Savings {
	return (*Table)(nil).SavingsFor(in, cacheRead, cacheWrite, nil)
}
