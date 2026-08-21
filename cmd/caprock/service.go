package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/service"
)

// serviceCmd manages autostart: registering the daemon with the OS's own
// login-time supervisor so it survives a reboot. Same contract as `hooks` and
// `statusline` — it writes one file the user owns, prints the exact path, and
// prints the command that undoes it.
func serviceCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "service",
		Short: "Start the daemon automatically at login (launchd / systemd / Startup folder)",
		Long: "Register the Caprock daemon with this machine's own login-time supervisor so it comes back after a reboot.\n" +
			"macOS: a LaunchAgent in ~/Library/LaunchAgents. Linux: a systemd user unit in ~/.config/systemd/user.\n" +
			"Windows: a logon script in your Startup folder. Nothing needs root and nothing is written outside your own home.",
	}
	c.AddCommand(serviceInstallCmd(), serviceUninstallCmd(), serviceStatusCmd())
	return c
}

// servicePlan resolves the plan the way every subcommand needs it: the running
// binary's absolute path (never a bare "caprock" — a login agent's PATH is not
// the shell's), the resolved data dir, and the port from config.json unless the
// user overrode it.
func servicePlan(port int, hiveDir string) (service.Plan, string, error) {
	dir, err := config.EnsureDataDir()
	if err != nil {
		return service.Plan{}, "", err
	}
	cfg, err := config.Load(dir)
	if err != nil {
		return service.Plan{}, "", err
	}
	if port != 0 {
		cfg.Port = port
	}
	self, err := os.Executable()
	if err != nil {
		return service.Plan{}, "", fmt.Errorf("resolve this executable: %w", err)
	}
	p, err := service.NewPlan(self, dir, cfg.Port, hiveDir)
	return p, dir, err
}

func serviceInstallCmd() *cobra.Command {
	var (
		port    int
		hiveDir string
	)
	c := &cobra.Command{
		Use:   "install",
		Short: "Register the daemon to start at login (and restart it if it crashes)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			p, dir, err := servicePlan(port, hiveDir)
			if err != nil {
				return err
			}
			if !p.Supported() {
				return fmt.Errorf("caprock service is not supported on this platform — run `caprock up` to start the daemon")
			}
			// Check before writing: a machine with no systemd user session must
			// not end up with a unit file nothing will ever read.
			if err := p.PreflightErr(); err != nil {
				return err
			}
			present, current, _, err := p.Installed()
			if err != nil {
				return err
			}
			path, err := p.Write()
			if err != nil {
				return err
			}
			if err := p.Load(path); err != nil {
				return err
			}

			out := cmd.OutOrStdout()
			switch {
			case present && current:
				fmt.Fprintf(out, "already installed — reloaded it unchanged\n")
			case present:
				fmt.Fprintf(out, "updated the existing autostart entry\n")
			default:
				fmt.Fprintf(out, "autostart installed (%s)\n", p.Mechanism())
			}
			fmt.Fprintf(out, "file:    %s\n", path)
			fmt.Fprintf(out, "runs:    %s %s\n", p.Exe, joinArgs(p.Args()))
			fmt.Fprintf(out, "log:     %s\n", p.LogPath())
			fmt.Fprintf(out, "data:    %s\n", dir)

			// If a daemon was already up before this, it is a process the
			// supervisor did not start, so the supervisor cannot manage it. Say
			// so rather than silently leaving two notions of "running" around.
			if rt, err := config.ReadRuntime(dir); err == nil && daemonAlive(rt) && rt.PID != 0 {
				fmt.Fprintf(out, "\nA daemon is already running on port %d (pid %d) — it was left alone.\n", rt.Port, rt.PID)
				fmt.Fprintf(out, "It is not the supervised one yet; run `caprock down` and the service will bring it back.\n")
			}
			if p.OS() == "windows" {
				fmt.Fprintln(out, "\nWindows note: this starts Caprock at every logon. Windows has no per-user")
				fmt.Fprintln(out, "crash supervisor without admin rights, so a mid-session crash is not auto-restarted.")
			}
			fmt.Fprintf(out, "\nUndo with: caprock service uninstall\n")
			return nil
		},
	}
	c.Flags().IntVar(&port, "port", 0, "port the service listens on (default: your config.json port)")
	c.Flags().StringVar(&hiveDir, "hive", "", "also enable Phase 2 orchestration with this hive directory")
	return c
}

func serviceUninstallCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "uninstall",
		Short: "Remove the autostart registration (the daemon and your data are untouched)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			p, _, err := servicePlan(0, "")
			if err != nil {
				return err
			}
			if !p.Supported() {
				fmt.Fprintln(cmd.OutOrStdout(), "nothing to remove (autostart is not supported on this platform)")
				return nil
			}
			registered := p.Registered()
			// Deregister first: removing the file while the supervisor still
			// holds the label leaves a half state that survives until logout.
			if err := p.Unload(); err != nil {
				return err
			}
			removed, path, err := p.Remove()
			if err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			if !removed && !registered {
				fmt.Fprintf(out, "nothing to remove — autostart was not installed (looked in %s)\n", path)
				return nil
			}
			if removed {
				fmt.Fprintf(out, "autostart removed: %s\n", path)
			} else {
				fmt.Fprintf(out, "autostart deregistered; no file at %s\n", path)
			}
			fmt.Fprintln(out, "The daemon keeps running if it is up now; `caprock down` stops it.")
			return nil
		},
	}
}

func serviceStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show whether autostart is installed, whether the daemon is running, and which file defines it",
		RunE: func(cmd *cobra.Command, _ []string) error {
			p, dir, err := servicePlan(0, "")
			if err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			if !p.Supported() {
				fmt.Fprintf(out, "autostart: unsupported on this platform\n")
				return nil
			}
			present, current, path, err := p.Installed()
			if err != nil {
				return err
			}
			state := "not installed"
			switch {
			case present && current:
				state = "installed"
			case present:
				state = "installed (file differs from what this binary would write — run `caprock service install` to refresh)"
			}
			fmt.Fprintf(out, "autostart:  %s (%s)\n", state, p.Mechanism())
			fmt.Fprintf(out, "file:       %s\n", path)
			fmt.Fprintf(out, "registered: %v\n", p.Registered())

			rt, rtErr := config.ReadRuntime(dir)
			if rtErr == nil && daemonAlive(rt) {
				fmt.Fprintf(out, "daemon:     running at http://127.0.0.1:%d (pid %d)\n", rt.Port, rt.PID)
			} else {
				fmt.Fprintf(out, "daemon:     not running\n")
			}
			fmt.Fprintf(out, "log:        %s\n", p.LogPath())
			return nil
		},
	}
}

// joinArgs renders an argument vector for display. Quoting matters: a path with
// a space must not read as two arguments in the line we print as the truth
// about what the service runs.
func joinArgs(args []string) string {
	shown := make([]string, 0, len(args))
	for _, a := range args {
		if strings.ContainsAny(a, " \t") {
			a = `"` + a + `"`
		}
		shown = append(shown, a)
	}
	return strings.Join(shown, " ")
}
