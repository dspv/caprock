package ingest

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// A usage limit, as Claude Code writes it into the transcript.
//
// When the plan refuses a call, Claude Code writes a synthetic assistant line
// (model "<synthetic>", no usage) that the session's screen shows as the
// error. Read on the owner's machine (2.1.285 to 2.1.316, 2026-10-04 to
// 2026-11-02, 20 such lines), every one had the same shape:
//
//	{"type":"assistant","error":"rate_limit","isApiErrorMessage":true,
//	 "apiErrorStatus":429,"apiError":"usage_limit_reached",
//	 "quotaLimits":{"status":"rejected","resetsAt":1793613600,
//	                "rateLimitType":"seven_day",...},
//	 "message":{"model":"<synthetic>","content":[{"type":"text",
//	   "text":"You've hit your weekly limit · resets 12pm (Asia/Jerusalem)"}]}}
//
// apiError and apiErrorParams.rate_limit_info (the same resetsAt and
// rateLimitType) appear from 2.1.312; quotaLimits is on all of them. Older
// Claude Code wrote the reset into the text instead — "Claude AI usage limit
// reached|<unix seconds>" — which is read too. A line with the error and
// neither field is a limit with no stated reset.

// limitFields are the fields of a transcript line that describe a refusal.
type limitFields struct {
	Error             string       `json:"error"`
	IsAPIErrorMessage bool         `json:"isApiErrorMessage"`
	APIError          string       `json:"apiError"`
	QuotaLimits       *quotaLimits `json:"quotaLimits"`
	APIErrorParams    *struct {
		RateLimitInfo *quotaLimits `json:"rate_limit_info"`
	} `json:"apiErrorParams"`
}

type quotaLimits struct {
	Status        string `json:"status"`
	ResetsAt      int64  `json:"resetsAt"` // unix seconds
	RateLimitType string `json:"rateLimitType"`
}

// legacyLimit is the text older Claude Code wrote: the reset as unix seconds
// after a bar.
var legacyLimit = regexp.MustCompile(`(?i)usage limit reached\|(\d{9,11})`)

// hitYourLimit is the text of the current message, for a line that carries
// the words and none of the fields.
var hitYourLimit = regexp.MustCompile(`(?i)you(?:'|’)ve hit your (?:\w+ )?limit`)

// LimitHit reads a usage-limit refusal from one raw transcript line; ok is
// false for every other line. Only a synthetic assistant line can be one: a
// real reply that quotes the words is not.
func LimitHit(l *Line, raw []byte, fallbackTs time.Time) (store.LimitHit, bool) {
	if l == nil || l.Type != "assistant" || l.Message == nil || l.Message.Model != "<synthetic>" {
		return store.LimitHit{}, false
	}
	var f limitFields
	if json.Unmarshal(raw, &f) != nil {
		return store.LimitHit{}, false
	}
	text := ""
	for _, b := range l.blocks() {
		if b.Type == "text" {
			text = b.Text
			break
		}
	}
	q := f.QuotaLimits
	if q == nil && f.APIErrorParams != nil {
		q = f.APIErrorParams.RateLimitInfo
	}
	isLimit := f.Error == "rate_limit" || f.APIError == "usage_limit_reached" ||
		(q != nil && strings.EqualFold(q.Status, "rejected"))
	legacy := legacyLimit.FindStringSubmatch(text)
	if !isLimit && legacy == nil && (!f.IsAPIErrorMessage || !hitYourLimit.MatchString(text)) {
		return store.LimitHit{}, false
	}
	hit := store.LimitHit{At: l.Ts(fallbackTs).UnixMilli()}
	if q != nil {
		if q.ResetsAt > 0 {
			hit.ResetsAt = q.ResetsAt * 1000
		}
		hit.Window = q.RateLimitType
	}
	if hit.ResetsAt == 0 && legacy != nil {
		if sec, err := strconv.ParseInt(legacy[1], 10, 64); err == nil && sec > 0 {
			hit.ResetsAt = sec * 1000
		}
	}
	if len(hit.Window) > 64 {
		hit.Window = ""
	}
	return hit, true
}
