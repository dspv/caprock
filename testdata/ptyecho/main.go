// Command ptyecho prints the bytes it receives, in hex, one line per read.
//
// The milestone's acceptance criterion for raw input is that arrows, Ctrl+C and
// Tab "arrive verbatim" — which cannot be checked against `claude`, because
// what a real TUI does with a sequence is invisible from outside. This prints
// what it got, so a test can assert on the bytes themselves, and a person can
// answer "what does my browser actually send for Shift+Enter" by pressing the
// key and reading the line.
//
// Raw mode is set with `stty` rather than a terminal library: this is a test
// fixture, and a dependency in go.mod is a cost the whole project carries
// forever for something only the test suite runs.
package main

import (
	"fmt"
	"os"
	"os/exec"
)

func main() {
	// -icanon: deliver bytes as they arrive rather than holding them until
	// Enter. -echo: we print them ourselves. -isig: Ctrl+C must arrive as the
	// byte 0x03 rather than becoming a signal, which is the whole point.
	raw := exec.Command("stty", "raw", "-echo", "-isig")
	raw.Stdin = os.Stdin
	if err := raw.Run(); err != nil {
		fmt.Printf("ptyecho: stty failed: %v\r\n", err)
		return
	}
	defer func() {
		restore := exec.Command("stty", "sane")
		restore.Stdin = os.Stdin
		_ = restore.Run()
	}()

	fmt.Print("ptyecho ready\r\n")
	buf := make([]byte, 256)
	for {
		n, err := os.Stdin.Read(buf)
		if n > 0 {
			// `q` quits, so a test ends the session deterministically rather
			// than killing the process and racing its output.
			if buf[0] == 'q' {
				fmt.Print("bye\r\n")
				return
			}
			fmt.Printf("got % x\r\n", buf[:n])
		}
		if err != nil {
			return
		}
	}
}
