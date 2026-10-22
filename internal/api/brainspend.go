package api

import (
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// Bounds of GET /v1/brain/spend's `days`.
const (
	brainSpendDays    = 14
	brainSpendDaysMax = 90
)

// BrainSpend is GET /v1/brain/spend (03-contracts.md § Second Brain): what
// the automatic extraction's reads spent (brain_runs), per local day and per
// project, and the figures its share of all Claude Code tokens in the last
// 24 hours is counted from.
type BrainSpend struct {
	// Days is one entry per local day, oldest first, today the last.
	Days []store.BrainDaySpend `json:"days"`
	// Projects is the same window by the read session's project, most
	// tokens first.
	Projects []store.BrainProjectSpend `json:"projects"`
	// DailyTokens is the daily limit; 0 in a build without the extraction.
	DailyTokens int64 `json:"daily_tokens"`
	// Spent24h is the reads' tokens in the last 24 hours (the status's
	// `spent`); ClaudeTokens24h is Claude Code's assistant turns in the
	// recorded sessions over the same 24 hours, the reads not among them.
	Spent24h        int64 `json:"spent_24h"`
	ClaudeTokens24h int64 `json:"claude_tokens_24h"`
}

// handleBrainSpend reads what the extraction spent over the last `days`
// local days (1–90, 14 by default). It writes nothing.
func (s *Server) handleBrainSpend(w http.ResponseWriter, r *http.Request) {
	days := brainSpendDays
	if v := r.URL.Query().Get("days"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > brainSpendDaysMax {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("days must be between 1 and %d", brainSpendDaysMax)})
			return
		}
		days = n
	}
	ctx := r.Context()
	db := s.d.Store.DB()
	now := s.d.Now()
	from := store.BrainSpendStart(now, days).UnixMilli()
	day := now.Add(-24 * time.Hour).UnixMilli()
	out := BrainSpend{}
	rows, err := store.BrainSpendRows(ctx, db, from)
	if err != nil {
		s.fail(w, err)
		return
	}
	out.Days = store.BucketBrainDays(rows, now, days)
	if out.Projects, err = store.BrainSpendByProject(ctx, db, from); err != nil {
		s.fail(w, err)
		return
	}
	if out.Spent24h, err = store.BrainTokensSince(ctx, db, day); err != nil {
		s.fail(w, err)
		return
	}
	if out.ClaudeTokens24h, err = store.ClaudeTokensSince(ctx, db, day); err != nil {
		s.fail(w, err)
		return
	}
	if s.d.BrainAuto != nil {
		out.DailyTokens = s.d.BrainAuto.DailyTokens()
	}
	writeJSON(w, http.StatusOK, out)
}
