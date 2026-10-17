package brain

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"
)

// AI;DR (ADR-072): one agent answer squeezed into at most two short
// sentences, on the user's tap, by the same headless call Second Brain makes
// to the user's own claude — a separate call, never typed into the session,
// with no session written (--no-session-persistence).

// TLDRSystem is the instructions for one squeeze.
const TLDRSystem = `You squeeze one answer a coding agent wrote into a TL;DR for someone reading it on a phone.
Write at most 2 short sentences and at most 220 characters in total.
Keep what matters: the decision or the result, the key numbers and names, and the next action if there is one.
Write in the language the answer is written in.
No preamble, no "TL;DR:", no quotes around it, no Markdown, no list: just the sentences.`

// Limits on one squeeze.
const (
	// TLDRModel is the model asked: the cheapest Second Brain uses.
	TLDRModel = DefaultModel
	// TLDRShortRunes is the length under which an answer is its own TL;DR:
	// squeezing it would not make it shorter enough to be worth a call.
	TLDRShortRunes = 280
	// TLDRMaxRunes clips what comes back, should the model run long anyway.
	TLDRMaxRunes = 300
	// TLDRMaxInputChars is the most of one answer a squeeze sends. A longer
	// answer is sent as its first TLDRHeadChars and its last
	// MaxInputChars-TLDRHeadChars: an agent states what it did up front and
	// its result and next step at the end, and the middle is the detail a
	// TL;DR drops anyway.
	TLDRMaxInputChars = 12000
	TLDRHeadChars     = 4000
)

// ErrTLDREmpty is a squeeze that came back with no text.
var ErrTLDREmpty = errors.New("claude answered with nothing")

// TLDRShort reports whether text is short enough to be its own TL;DR.
func TLDRShort(text string) bool {
	return utf8.RuneCountInString(strings.TrimSpace(text)) < TLDRShortRunes
}

// TLDRInput is the part of an answer a squeeze sends: all of it up to
// TLDRMaxInputChars characters (runes), else its head and its tail around a
// marker.
func TLDRInput(text string) string {
	text = strings.TrimSpace(text)
	if utf8.RuneCountInString(text) <= TLDRMaxInputChars {
		return text
	}
	r := []rune(text)
	head := string(r[:TLDRHeadChars])
	tail := string(r[len(r)-(TLDRMaxInputChars-TLDRHeadChars):])
	return head + "\n\n" + TLDRGap + "\n\n" + tail
}

// TLDRGap marks where the middle of a long answer was left out.
const TLDRGap = "[… the middle of the answer is left out …]"

// TLDR is one squeeze's answer.
type TLDR struct {
	Text    string
	Model   string
	CostUSD float64
}

// Squeeze asks r for one answer's TL;DR. The caller has already decided the
// answer is long enough (TLDRShort) and bounds the call with ctx.
func Squeeze(ctx context.Context, r Runner, text string) (TLDR, error) {
	res, err := r.Run(ctx, Request{
		System: TLDRSystem,
		Prompt: "The answer:\n\n" + TLDRInput(text),
		Model:  TLDRModel,
		Plain:  true,
	})
	if err != nil {
		return TLDR{}, err
	}
	out := cleanTLDR(res.Text)
	if out == "" {
		return TLDR{}, ErrTLDREmpty
	}
	model := res.Model
	if model == "" {
		model = TLDRModel
	}
	return TLDR{Text: out, Model: model, CostUSD: res.CostUSD}, nil
}

// cleanTLDR trims what a model adds around the sentences despite being told
// not to — a "TL;DR:" label, wrapping quotes, line breaks — and clips it.
func cleanTLDR(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	for _, p := range []string{"TL;DR:", "TLDR:", "TL;DR", "AI;DR:", "Summary:"} {
		if len(s) >= len(p) && strings.EqualFold(s[:len(p)], p) {
			s = strings.TrimSpace(s[len(p):])
		}
	}
	for _, q := range [][2]string{{`"`, `"`}, {"“", "”"}, {"«", "»"}, {"`", "`"}} {
		if len(s) > len(q[0])+len(q[1]) && strings.HasPrefix(s, q[0]) && strings.HasSuffix(s, q[1]) {
			s = strings.TrimSpace(s[len(q[0]) : len(s)-len(q[1])])
		}
	}
	return clip(s, TLDRMaxRunes)
}
