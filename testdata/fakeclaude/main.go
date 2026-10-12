// Command fakeclaude stands in for `claude` in tests that start a real daemon
// binary and need a session that behaves the same on all three OSes.
//
// It is a line REPL: it prints a ready line, answers every line it reads with
// `you-said:<line>`, draws a permission dialog on `ask[tag]` (its footer ends
// `asked<tag>`), exits with code 3 on `quit`, and exits cleanly on `/exit` or
// Ctrl+D, as Claude Code does. Shell scripts do this
// differently under a POSIX PTY and under ConPTY; a Go binary does not. It
// accepts and ignores whatever flags the daemon passes (`--session-id …`), and
// it never contacts anything — no model, no network.
//
// Started with a permission flag (--permission-mode, --dangerously-skip-
// permissions or --allow-dangerously-skip-permissions) it also draws Claude
// Code's mode footer ("⏵⏵ accept edits on") under its prompt and cycles the
// mode on Shift+Tab (ESC [ Z) in Claude Code 2.1.296's order, bypass only
// when a flag allows it and never auto; ESC CR (a line break, as Caprock
// types one) stays in the prompt as ↵. That needs the terminal raw, so only
// then is it switched to raw mode; without the flags it stays the line REPL
// the smoke tests drive.
package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

func main() {
	mode, bypass, tui := launchMode(os.Args[1:])
	fmt.Printf("fake-claude ready pid=%d\r\n", os.Getpid())
	if tui {
		if restore, err := makeRaw(int(os.Stdin.Fd())); err == nil {
			defer restore()
			runTUI(mode, bypass)
			return
		}
	}
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		answer(strings.TrimSpace(sc.Text()))
	}
}

// answer acts on one line; "quit" exits with code 3, "/exit" with 0.
func answer(line string) {
	if line == "quit" {
		fmt.Print("bye\r\n")
		os.Exit(3)
	}
	if line == "/exit" {
		fmt.Print("goodbye\r\n")
		os.Exit(0)
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
		return
	}
	fmt.Printf("you-said:%s\r\n", line)
}

// launchMode reads the permission flags: the starting mode, whether bypass
// is in the cycle, and whether any flag was given at all.
func launchMode(args []string) (mode string, bypass, tui bool) {
	mode = "default"
	for i, a := range args {
		switch a {
		case "--dangerously-skip-permissions":
			mode, bypass, tui = "bypassPermissions", true, true
		case "--allow-dangerously-skip-permissions":
			bypass, tui = true, true
		case "--permission-mode":
			tui = true
			if i+1 < len(args) {
				mode = args[i+1]
				if mode == "manual" {
					mode = "default"
				}
				if mode == "bypassPermissions" {
					bypass = true
				}
			}
		}
	}
	return mode, bypass, tui
}

// next is Claude Code 2.1.296's Shift+Tab cycle without auto mode.
func next(mode string, bypass bool) string {
	switch mode {
	case "default":
		return "acceptEdits"
	case "acceptEdits":
		return "plan"
	case "plan":
		if bypass {
			return "bypassPermissions"
		}
	}
	return "default"
}

var indicator = map[string]string{
	"default":           "⏸ manual mode on",
	"plan":              "⏸ plan mode on",
	"acceptEdits":       "⏵⏵ accept edits on (shift+tab to cycle)",
	"bypassPermissions": "⏵⏵ bypass permissions on (shift+tab to cycle)",
	"dontAsk":           "⏵⏵ don't ask on (shift+tab to cycle)",
	"auto":              "⏵⏵ auto mode on (shift+tab to cycle)",
}

// runTUI reads keys one at a time and keeps the bottom row as the prompt
// with the mode footer after it.
func runTUI(mode string, bypass bool) {
	in := bufio.NewReader(os.Stdin)
	var line []rune
	draw := func() {
		fmt.Printf("\r\x1b[2K> %s   %s", string(line), indicator[mode])
	}
	draw()
	for {
		r, _, err := in.ReadRune()
		if err != nil {
			return
		}
		switch r {
		case 0x03, 0x04: // Ctrl+C, Ctrl+D
			fmt.Print("\r\n")
			return
		case 0x1b:
			// ESC [ Z is Shift+Tab; ESC CR is a newline inside the prompt
			// (Alt+Enter, what Caprock types for a line break), kept as ↵
			// so a test can see a message of several lines arrive as one;
			// any other sequence is read and dropped.
			b1, _ := in.ReadByte()
			if b1 == '\r' {
				line = append(line, '↵')
				break
			}
			if b1 != '[' {
				continue
			}
			b2, _ := in.ReadByte()
			if b2 == 'Z' {
				mode = next(mode, bypass)
			}
		case '\r', '\n':
			text := strings.TrimSpace(string(line))
			line = line[:0]
			fmt.Print("\r\x1b[2K")
			answer(text)
		case 0x7f, 0x08:
			if len(line) > 0 {
				line = line[:len(line)-1]
			}
		default:
			if r >= 0x20 {
				line = append(line, r)
			}
		}
		draw()
	}
}
