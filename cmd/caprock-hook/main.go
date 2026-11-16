// caprock-hook is the shim Claude Code runs on every hook event. It reads the
// hook JSON from stdin, POSTs it to the local Caprock daemon, and exits 0 — always,
// within a 1s budget, printing nothing. A broken or absent daemon must never
// affect the user's Claude session. Logic lives in internal/shim.
package main

import (
	"os"

	"github.com/dspv/caprock/internal/shim"
)

func main() {
	// `caprock-hook cursor` is Cursor's hook (ADR-095): it prints Cursor's
	// neutral reply first, then forwards the payload the same silent way.
	if len(os.Args) > 1 && os.Args[1] == shim.CursorArg {
		shim.RunCursor(os.Stdin, os.Stdout)
		os.Exit(0)
	}
	shim.Run(os.Stdin, os.Stdout)
	os.Exit(0)
}
