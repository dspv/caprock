package api

import (
	"math"
	"testing"

	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/store"
)

func savingTable(t *testing.T) *cost.Table {
	t.Helper()
	tb, err := cost.Parse([]byte(`{"version":"t","models":[
	 {"id":"claude-opus-5-5","display":"Claude Opus 5.5","input":5,"cache_write_5m":6.25,"cache_write_1h":10,"cache_read":0.5,"output":25},
	 {"id":"claude-sonnet-5-5","display":"Claude Sonnet 5.5","input":3,"cache_write_5m":3.75,"cache_write_1h":6,"cache_read":0.3,"output":15},
	 {"id":"claude-haiku-5-5","display":"Claude Haiku 5.5","input":1,"cache_write_5m":1.25,"cache_write_1h":2,"cache_read":0.1,"output":5},
	 {"id":"claude-haiku-4-5","display":"Claude Haiku 4.5","input":9,"cache_write_5m":9,"cache_write_1h":9,"cache_read":9,"output":9}]}`))
	if err != nil {
		t.Fatal(err)
	}
	return tb
}

func TestSubagentSavingMaths(t *testing.T) {
	tb := savingTable(t)
	// 10M in + 1M out on Opus: 50 + 25 = 75 USD; on the newest Haiku: 10 + 5 = 15.
	got := subagentSaving([]store.ModelTokens{{Model: "claude-opus-5-5", In: 10_000_000, Out: 1_000_000}}, tb)
	if got == nil || math.Abs(got.CostUSD-75) > 1e-9 || math.Abs(got.HaikuUSD-15) > 1e-9 || got.Haiku != "Haiku 5.5" || len(got.Models) != 1 || got.Models[0] != "Opus 5.5" {
		t.Fatalf("opus: %+v", got)
	}
	// Cache tokens are priced by type; models are listed dearest first and
	// subagents already on Haiku are left out of both figures.
	got = subagentSaving([]store.ModelTokens{
		{Model: "claude-sonnet-5-5", CacheRead: 10_000_000, CacheWrite: 2_000_000, CacheWrite1h: 1_000_000, In: 1_000_000},
		{Model: "claude-opus-5-5", In: 2_000_000},
		{Model: "claude-haiku-5-5", In: 50_000_000},
		{Model: "unknown-model", In: 99_000_000},
	}, tb)
	// Sonnet: 3 + 3 + 1*3.75 + 6 = 15.75; Opus: 10. Haiku: 1+1+1.25+2 = 5.25 and 2.
	if got == nil || math.Abs(got.CostUSD-25.75) > 1e-9 || math.Abs(got.HaikuUSD-7.25) > 1e-9 {
		t.Fatalf("mixed: %+v", got)
	}
	if len(got.Models) != 2 || got.Models[0] != "Sonnet 5.5" || got.Models[1] != "Opus 5.5" {
		t.Errorf("models = %v", got.Models)
	}
}

func TestSubagentSavingOnlyWhenWorthSaying(t *testing.T) {
	tb := savingTable(t)
	// 100k in on Opus: 0.50 vs 0.10 -> a 0.40 difference, under a dollar.
	if got := subagentSaving([]store.ModelTokens{{Model: "claude-opus-5-5", In: 100_000}}, tb); got != nil {
		t.Errorf("under a dollar: %+v", got)
	}
	// Subagents already on Haiku.
	if got := subagentSaving([]store.ModelTokens{{Model: "claude-haiku-5-5", In: 900_000_000}}, tb); got != nil {
		t.Errorf("on Haiku: %+v", got)
	}
	if subagentSaving([]store.ModelTokens{{Model: "claude-opus-5-5", In: 9e9}}, nil) != nil {
		t.Error("no table, no estimate")
	}
}
