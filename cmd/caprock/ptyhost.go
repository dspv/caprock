package main

import (
	"os"

	"github.com/spf13/cobra"

	"github.com/dspv/caprock/internal/ptyhost"
)

// ptyHostCmd is the process that holds one owned session's terminal, started
// by the daemon and never by a person (ADR-033). It reads its launch spec on
// stdin, so it has nothing to say to a terminal and is hidden from help.
func ptyHostCmd() *cobra.Command {
	return &cobra.Command{
		Use:    "pty-host",
		Short:  "Hold one owned session's terminal so it outlives the daemon (started by the daemon)",
		Hidden: true,
		Args:   cobra.NoArgs,
		Run: func(*cobra.Command, []string) {
			os.Exit(ptyhost.Main(os.Stdin, os.Stdout))
		},
	}
}

// holderExe is the binary the daemon starts pty-hosts from: this one, or on
// Windows a copy of it (see holderBinary). Empty when it cannot be resolved,
// which runs sessions inside the daemon as before.
func holderExe(dataDir string) string {
	self, err := os.Executable()
	if err != nil {
		return ""
	}
	return holderBinary(self, dataDir)
}
