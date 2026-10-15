package config

import (
	"strings"
	"testing"
)

// The quick replies: trimmed, bounded, one-line labels, no control
// characters but a newline in the text; the defaults until changed.
func TestQuickReplies(t *testing.T) {
	if got := EffectiveQuickReplies(nil); len(got) != len(DefaultQuickReplies) || got[0].Label != "Continue" {
		t.Fatalf("defaults = %+v", got)
	}
	empty := []QuickReply{}
	if got := EffectiveQuickReplies(&empty); got == nil || len(got) != 0 {
		t.Fatalf("an emptied list came back as %+v", got)
	}
	got, err := NormalizeQuickReplies([]QuickReply{{Label: "  Go on ", Text: " Keep going.\nThen stop. "}})
	if err != nil || got[0].Label != "Go on" || got[0].Text != "Keep going.\nThen stop." {
		t.Fatalf("normalized = %+v %v", got, err)
	}
	bad := [][]QuickReply{
		{{Label: "", Text: "x"}},
		{{Label: "x", Text: "  "}},
		{{Label: "two\nlines", Text: "x"}},
		{{Label: strings.Repeat("é", QuickLabelMax+1), Text: "x"}},
		{{Label: "x", Text: strings.Repeat("a", QuickTextMaxByte+1)}},
		{{Label: "x", Text: "esc \x1b[2J"}},
		make([]QuickReply, QuickRepliesMax+1),
	}
	for i, b := range bad {
		if _, err := NormalizeQuickReplies(b); err == nil {
			t.Fatalf("case %d accepted: %+v", i, b)
		}
	}
}
