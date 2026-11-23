package main

import (
	"fmt"
	"os"
	"strings"
)

// voiceFooter draws Claude Code's voice failure the way Claude Code 2.1
// shows it: not as a line of output but in the footer under its input box,
// where it stays (the voice store keeps the error until the next recording)
// with nothing more written after it. The frame is one synchronized update
// (DEC mode 2026): the input box's rules and prompt, then the footer row —
// the error, the update notice and its hint, each cut to its share of the
// width with "…" and joined by " · ", as the footer's truncating flex row
// lays them out. Its renderer writes only the cells that hold something, so
// a space between two words is a cursor jump (CHA), not a space; each word
// is dim red. The cursor goes back into the input box, above the footer, as
// Claude Code leaves it. A tag, when given, ends the update notice, so a
// test tells its own frame from one replayed from the ring.
func voiceFooter(tag string) {
	cols, _ := termSize()
	cols = max(cols, 40)
	rule := strings.Repeat("─", cols)
	notice := "✔ Update installed · /restart to apply" + tag
	msg := "No audio detected from microphone. Check that the correct input device is selected and that Claude Code has microphone access."
	sep := " · "
	// The error gets what the notice and the separator leave, at least 34
	// cells; both are cut with "…" when longer than their share.
	room := cols - len([]rune(sep)) - 2
	noticeW := min(len([]rune(notice)), max(0, room-34))
	footer := cut(msg, room-noticeW) + sep + cut(notice, noticeW)

	var b strings.Builder
	b.WriteString("\x1b[?2026h")
	b.WriteString("\r\n" + rule + "\r\n❯ \x1b[K\r\n" + rule + "\r\n\x1b[2K")
	col := 0
	for i, r := range []rune(footer) {
		if r == ' ' {
			continue
		}
		if i != col {
			fmt.Fprintf(&b, "\x1b[%dG", i+1)
		}
		fmt.Fprintf(&b, "\x1b[2;31m%c\x1b[22;39m", r)
		col = i + 1
	}
	// Back into the input box, after "❯ ".
	b.WriteString("\r\x1b[2A\x1b[3G")
	b.WriteString("\x1b[?2026l")
	_, _ = os.Stdout.WriteString(b.String())
}

// cut shortens s to w cells, its last one "…" when anything was cut.
func cut(s string, w int) string {
	r := []rune(s)
	if w <= 0 {
		return ""
	}
	if len(r) <= w {
		return s
	}
	return string(r[:w-1]) + "…"
}
