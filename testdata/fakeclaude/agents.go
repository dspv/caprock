package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// agents draws Claude Code's live subagent list the way its renderer does:
// a region at the bottom of the screen redrawn in place with relative cursor
// moves (up over the last frame, clearing each row, then the next frame),
// its row count changing between frames (4, 2, 3, 1, ...), every character
// coloured so a frame is a few KB, as Claude Code's are, each frame one
// synchronized update. A size change that shrinks the height or changes the
// width clears the viewport and draws the frame again (Claude Code 2.1's
// clearTerminal on resize). The header names the size the PTY had. After
// `frames` frames it leaves a last frame of two rows and the line
// `agents-done <frames>` under it.
//
// A terminal that parsed every byte, in order, at the PTY's size shows
// exactly one copy of the list; ui/e2e/redraw.spec.ts counts the rows.
func agents(arg string) {
	frames, err := strconv.Atoi(strings.TrimSpace(arg))
	if err != nil || frames < 1 {
		frames = 100
	}
	cols, rows := termSize()
	winch := watchResize()
	defer stopResize(winch)
	prev := 0 // rows the last frame drew
	draw := func(f, k int, clear bool) {
		var b strings.Builder
		// One synchronized update per frame (DEC mode 2026), as Claude Code
		// writes when the terminal says it has the mode.
		b.WriteString("\x1b[?2026h")
		if clear {
			// Claude Code's clearTerminal on the main screen: home, every
			// row of the viewport erased on the way down, home again. The
			// scrollback is left alone.
			b.WriteString("\x1b[H" + strings.Repeat("\x1b[2K\x1b[1B", rows) + "\x1b[H")
		} else if prev > 0 {
			// Up to the frame's first row, clearing each on the way.
			b.WriteString("\r\x1b[2K")
			for i := 1; i < prev; i++ {
				b.WriteString("\x1b[1A\x1b[2K")
			}
		}
		lines := []string{fmt.Sprintf("● Running %d agents… frame %d pty %dx%d", k, f, cols, rows)}
		for i := 0; i < k; i++ {
			lines = append(lines, fmt.Sprintf("  ⎿ subagent-%d step %d", i+1, f))
		}
		for i, l := range lines {
			if i > 0 {
				b.WriteString("\r\n")
			}
			// Each character in its own colour, the row padded to one
			// short of the width the PTY says it has.
			for j, r := range []rune(l) {
				fmt.Fprintf(&b, "\x1b[38;5;%dm%c", 16+(i*7+j)%200, r)
			}
			if pad := cols - 1 - len([]rune(l)); pad > 0 {
				b.WriteString("\x1b[39m" + strings.Repeat(" ", pad))
			}
			b.WriteString("\x1b[0m")
		}
		b.WriteString("\x1b[?2026l")
		_, _ = os.Stdout.WriteString(b.String())
		prev = len(lines)
	}
	counts := []int{4, 2, 3, 1}
	tick := time.NewTicker(30 * time.Millisecond)
	defer tick.Stop()
	for f := 1; f <= frames; {
		select {
		case <-winch:
			c, r := termSize()
			clear := r < rows || c != cols
			cols, rows = c, r
			draw(f, counts[f%len(counts)], clear)
		case <-tick.C:
			k := counts[f%len(counts)]
			if f == frames {
				k = 2
			}
			draw(f, k, false)
			f++
		}
	}
	_, _ = fmt.Fprintf(os.Stdout, "\r\nagents-done %d\r\n", frames)
}

// inputBox draws Claude Code's input box: a rule, the `❯` prompt row, a
// rule, each rule as wide as the PTY less two columns.
func inputBox() {
	cols, _ := termSize()
	rule := strings.Repeat("─", max(8, cols-2))
	_, _ = fmt.Fprintf(os.Stdout, "%s\r\n❯ type here\r\n%s\r\n", rule, rule)
}
