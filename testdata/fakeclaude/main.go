// Command fakeclaude stands in for `claude` in tests that start a real daemon
// binary and need a session that behaves the same on all three OSes.
//
// It is a line REPL: it prints a ready line, answers every line it reads with
// `you-said:<line>`, and exits with code 3 on `quit`. Shell scripts do this
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
		fmt.Printf("you-said:%s\r\n", line)
	}
}
