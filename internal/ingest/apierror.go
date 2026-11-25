package ingest

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// An API error that ended a turn, as Claude Code writes it into the
// transcript (ADR-105).
//
// While Claude Code retries a failed call itself, its screen shows "API
// error · retrying… attempt 2/10" and the transcript gets no assistant line:
// the turn is still running. Only once its retries are spent does it write
// a synthetic assistant line — model "<synthetic>", no usage — that the
// screen shows as the error, and the turn ends (the StopFailure hook). The
// shape is the usage limit's (limit.go), with another error:
//
//	{"type":"assistant","error":"server_error","isApiErrorMessage":true,
//	 "apiErrorStatus":529,
//	 "message":{"model":"<synthetic>","content":[{"type":"text",
//	   "text":"API Error: 529 Overloaded."}]}}
//
// `error` is Claude Code's category, the one its StopFailure hook carries
// too: rate_limit, authentication_failed, billing_error, invalid_request,
// server_error, max_output_tokens, unknown. A usage limit is read by
// LimitHit and is not one of these: Caprock's limit flow (ADR-090) owns it.

// apiErrorFields are the fields of a transcript line that describe a
// failed call.
type apiErrorFields struct {
	Error             string `json:"error"`
	IsAPIErrorMessage bool   `json:"isApiErrorMessage"`
	APIErrorStatus    int    `json:"apiErrorStatus"`
}

// noRetryErrors are the categories a "continue" cannot get past: the user
// has to do something (sign in, pay, shorten), or the limit flow owns it.
var noRetryErrors = map[string]bool{
	"rate_limit":            true,
	"authentication_failed": true,
	"billing_error":         true,
	"invalid_request":       true,
	"max_output_tokens":     true,
	"oauth_org_not_allowed": true,
	"permission_error":      true,
	"not_found_error":       true,
	"request_too_large":     true,
}

// noRetryText is wording that says the request itself is wrong or the
// account cannot go on, whatever else the line says.
var noRetryText = regexp.MustCompile(`(?i)prompt is too long|context (?:window|length)|too many tokens|request too large|` +
	`usage limit|hit your (?:\w+ )?limit|rate limit|credit balance|billing|invalid api key|api key|/login|log ?in|oauth|` +
	`unauthori[sz]ed|forbidden|permission|not found|invalid[_ ]request|max_tokens|output token`)

// retryText is wording of a failure on the way or on the far side: the
// same request may well go through a minute later.
var retryText = regexp.MustCompile(`(?i)overloaded|internal server error|server error|service unavailable|bad gateway|` +
	`gateway time-?out|timed? ?out|timeout|connection (?:error|reset|refused|closed)|econnreset|econnrefused|etimedout|` +
	`socket hang up|network|fetch failed|upstream|api error: 5\d\d`)

// apiErrorStatusText is the status in an "API Error: 529 ..." text.
var apiErrorStatusText = regexp.MustCompile(`(?i)api error:?\s*(\d{3})\b`)

// ClassifyAPIError says whether an API error is worth a "continue": the
// category Claude Code gave it (errField), the HTTP status (0 when not
// stated) and the text it showed. Transient failures — overloaded, a 5xx,
// a network failure, a timeout — are; a limit, a sign-in, billing, a
// request too long or any other 4xx are not, and neither is anything this
// cannot place: a "continue" typed into a session that cannot go on only
// fails again.
func ClassifyAPIError(errField string, status int, text string) bool {
	errField = strings.ToLower(strings.TrimSpace(errField))
	if noRetryErrors[errField] || noRetryText.MatchString(text) {
		return false
	}
	if status == 0 {
		if m := apiErrorStatusText.FindStringSubmatch(text); m != nil {
			status, _ = strconv.Atoi(m[1])
		}
	}
	switch {
	case status == 408 || status >= 500 && status <= 599:
		return true
	case status >= 400 && status <= 499:
		return false
	}
	if errField == "server_error" || errField == "overloaded_error" || errField == "api_error" {
		return true
	}
	return retryText.MatchString(text)
}

// jsonMessage is the message of an API error body quoted in the text.
var jsonMessage = regexp.MustCompile(`"message"\s*:\s*"([^"]{1,200})"`)

// apiErrorReasonMax bounds the reason kept and shown, in runes.
const apiErrorReasonMax = 80

// apiErrorReason is the error in a few words: the text after "API Error:",
// else the category, else "API error".
func apiErrorReason(errField string, status int, text string) string {
	t := strings.TrimSpace(text)
	if i := strings.Index(strings.ToLower(t), "api error"); i >= 0 {
		t = strings.TrimSpace(strings.TrimLeft(t[i+len("api error"):], ": "))
	}
	// "529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"
	// reads as "529 Overloaded".
	if j := strings.Index(t, "{"); j >= 0 {
		if m := jsonMessage.FindStringSubmatch(t[j:]); m != nil {
			t = strings.TrimSpace(t[:j]) + " " + m[1]
		}
	}
	t = strings.TrimSpace(strings.TrimRight(strings.Join(strings.Fields(t), " "), "."))
	if t == "" {
		t = strings.ReplaceAll(strings.TrimSpace(errField), "_", " ")
	}
	if t == "" && status > 0 {
		t = strconv.Itoa(status)
	}
	if t == "" {
		t = "API error"
	}
	if r := []rune(t); len(r) > apiErrorReasonMax {
		t = string(r[:apiErrorReasonMax-1]) + "…"
	}
	return t
}

// APIErrorLine reads an API error that ended a turn from one raw transcript
// line; ok is false for every other line, a usage limit included (LimitHit
// reads that one). Only a synthetic assistant line can be one: a real reply
// that quotes "API Error: 529" is not, and neither is anything Claude Code
// writes while it is still retrying.
func APIErrorLine(l *Line, raw []byte, fallbackTs time.Time) (store.APIError, bool) {
	if l == nil || l.Type != "assistant" || l.Message == nil || l.Message.Model != "<synthetic>" {
		return store.APIError{}, false
	}
	var f apiErrorFields
	if json.Unmarshal(raw, &f) != nil {
		return store.APIError{}, false
	}
	text := ""
	for _, b := range l.blocks() {
		if b.Type == "text" {
			text = b.Text
			break
		}
	}
	if !f.IsAPIErrorMessage && !strings.HasPrefix(strings.ToLower(strings.TrimSpace(text)), "api error") {
		return store.APIError{}, false
	}
	if _, isLimit := LimitHit(l, raw, fallbackTs); isLimit {
		return store.APIError{}, false
	}
	return store.APIError{
		At:        l.Ts(fallbackTs).UnixMilli(),
		Reason:    apiErrorReason(f.Error, f.APIErrorStatus, text),
		Retryable: ClassifyAPIError(f.Error, f.APIErrorStatus, text),
	}, true
}
