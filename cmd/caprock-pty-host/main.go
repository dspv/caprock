// caprock-pty-host holds one owned session's terminal so it outlives the
// daemon (ADR-033). It is `caprock pty-host` built on its own: the daemon
// starts it when it sits beside the caprock binary, and `caprock pty-host`
// otherwise. Started by the daemon, never by a person.
//
// It exists for memory. A process pays for every package the binary links
// before main runs, and the caprock binary links the whole daemon: the SQLite
// driver's libc alone parses /etc/services into tables in every process it
// starts. One holder runs per terminal, so that start-up cost was paid once
// per shell and session. This binary links only the holder (ADR-033 has the
// numbers).
package main

import (
	"fmt"
	"os"

	"github.com/dspv/caprock/internal/disclaim"
	"github.com/dspv/caprock/internal/ptyhost"
)

func main() {
	// First, as in caprock: the holder starts its child through this binary
	// as the disclaim trampoline, which becomes the child and never returns.
	disclaim.Main()
	// The child answers for itself, unless this is the Caprock Terminal
	// helper answering for its terminal (ADR-101).
	ptyhost.EnableDisclaim()
	// The argument keeps the process looking like `caprock pty-host` to the
	// daemon's sweep for holders (internal/daemon/resources.go), which goes
	// by argv[1].
	if len(os.Args) != 2 || os.Args[1] != ptyhost.Arg {
		fmt.Fprintln(os.Stderr, "caprock-pty-host holds a session's terminal for the Caprock daemon, which starts it; there is nothing to run by hand.")
		os.Exit(2)
	}
	os.Exit(ptyhost.Main(os.Stdin, os.Stdout))
}
