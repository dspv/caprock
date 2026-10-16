package config

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"
)

// QuickReply is one of the one-click replies drawn under a session Caprock
// started (.ai/04-ui.md § Quick replies): Label is the chip, Text is what is
// typed into the session, through the message queue (ADR-053), when the chip
// is pressed. Never into a session Caprock did not start (rule 7).
type QuickReply struct {
	Label string `json:"label"`
	Text  string `json:"text"`
}

// The bounds of the list: a row of chips, not a prompt library — saved
// prompts (ADR-051) are that.
const (
	QuickRepliesMax  = 10
	QuickLabelMax    = 24  // runes
	QuickTextMaxByte = 300 // bytes
)

// DefaultQuickReplies are the replies a new install has (owner, 2026-10-15:
// "Continue", "Shorter" and the like). Short on purpose.
var DefaultQuickReplies = []QuickReply{
	{Label: "Continue", Text: "Continue."},
	{Label: "Shorter", Text: "Shorter, please: say it in fewer words."},
	{Label: "Explain", Text: "Explain what you just did and why."},
	{Label: "Run tests", Text: "Run the tests and fix what fails."},
	{Label: "Commit", Text: "Commit the changes with a clear message."},
}

// EffectiveQuickReplies is the list in use: the stored one, else the defaults.
func EffectiveQuickReplies(stored *[]QuickReply) []QuickReply {
	if stored == nil {
		return slices.Clone(DefaultQuickReplies)
	}
	return slices.Clone(*stored)
}

// NormalizeQuickReplies trims every label and text and checks the bounds: at
// most QuickRepliesMax, each label 1..QuickLabelMax runes on one line, each
// text 1..QuickTextMaxByte bytes with no control character but a newline.
func NormalizeQuickReplies(in []QuickReply) ([]QuickReply, error) {
	if len(in) > QuickRepliesMax {
		return nil, fmt.Errorf("quick_replies: at most %d", QuickRepliesMax)
	}
	out := make([]QuickReply, 0, len(in))
	for i, q := range in {
		label, text := strings.TrimSpace(q.Label), strings.TrimSpace(q.Text)
		if label == "" || text == "" {
			return nil, fmt.Errorf("quick_replies[%d]: a label and a text are both needed", i)
		}
		if utf8.RuneCountInString(label) > QuickLabelMax || strings.ContainsAny(label, "\r\n") {
			return nil, fmt.Errorf("quick_replies[%d]: the label is one line of at most %d characters", i, QuickLabelMax)
		}
		if len(text) > QuickTextMaxByte {
			return nil, fmt.Errorf("quick_replies[%d]: the text is at most %d bytes", i, QuickTextMaxByte)
		}
		for _, r := range text + label {
			if r != '\n' && (r < 0x20 || r == 0x7f) {
				return nil, errors.New("quick_replies: no control characters")
			}
		}
		out = append(out, QuickReply{Label: label, Text: text})
	}
	return out, nil
}
