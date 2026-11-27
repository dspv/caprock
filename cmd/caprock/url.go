package main

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/dspv/caprock/internal/config"
)

// localURL is the dashboard's address on this computer: the running daemon's
// port (runtime.json), else the one config.json names — which is 22776 on a
// fresh install and 4173 on one from before the port changed, so a script
// that assumes either is wrong on some computer (#1095).
func localURL(dir string) (url string, running bool, err error) {
	if rt, err := config.ReadRuntime(dir); err == nil && daemonAlive(rt) {
		return fmt.Sprintf("http://127.0.0.1:%d", rt.Port), true, nil
	}
	cfg, err := config.Load(dir)
	if err != nil {
		return "", false, err
	}
	return fmt.Sprintf("http://127.0.0.1:%d", cfg.Port), false, nil
}

// urlCmd prints that address alone, for a script: `curl "$(caprock url)/v1/status"`.
func urlCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "url",
		Short: "Print the dashboard's local address (the configured port), for scripts",
		Long: "Prints http://127.0.0.1:<port> — the running daemon's port, or the one config.json names when it is not running " +
			"(22776 on a fresh install, 4173 on an install from before that). A note goes to stderr when it is not running; stdout is the address alone.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			dir, err := config.DataDir()
			if err != nil {
				return err
			}
			url, running, err := localURL(dir)
			if err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), url)
			if !running {
				fmt.Fprintln(cmd.ErrOrStderr(), "caprock is not running; `caprock up` listens there")
			}
			return nil
		},
	}
}
