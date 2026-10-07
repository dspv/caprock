// Command fakeclaude stands in for `claude` in tests that start a real daemon
// binary and need a session that behaves the same on all three OSes.
//
// It is a line REPL: it prints a ready line, answers every line it reads with
// `you-said:<line>`, draws a permission dialog on `ask[tag]` (its footer ends
// `asked<tag>`), and exits with code 3 on `quit`. Shell scripts do this
// differently under a POSIX PTY and under ConPTY; a Go binary does not. It
// accepts and ignores whatever flags the daemon passes (`--session-id …`), and
// it never contacts anything — no model, no network.
package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

func main() {
	fmt.Printf("fake-claude ready pid=%d\r\n", os.Getpid())
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "quit" {
			fmt.Print("bye\r\n")
			os.Exit(3)
		}
		if tag, ok := strings.CutPrefix(line, "ask"); ok {
			// A permission dialog as Claude Code draws it: words placed with
			// column moves, in colour. A button reads it off the screen
			// before it types (ADR-035). The footer carries the tag, so a
			// test can wait for this dialog rather than an earlier one.
			fmt.Print("\x1b[1G\x1b[1mDo\x1b[4Gyou\x1b[8Gwant\x1b[13Gto\x1b[16Gproceed?\x1b[22m\r\n" +
				"\x1b[2G\x1b[36m❯\x1b[4G1.\x1b[7GYes\x1b[39m\r\n" +
				"\x1b[4G2.\x1b[7GYes, and always allow access to /x from this project\r\n" +
				"\x1b[4G3.\x1b[7GNo\r\n" +
				"\r\n\x1b[2GEsc to cancel · asked" + strings.TrimSpace(tag) + "\r\n")
			continue
		}
		fmt.Printf("you-said:%s\r\n", line)
	}
}
