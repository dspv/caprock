package main

import (
	"fmt"
	"io"
	"net/http"

	"github.com/spf13/cobra"

	"github.com/dspv/caprock/internal/readiness"
)

// setupCmd is the setup checklist in a terminal (ADR-099): the same items as
// Settings → Computers on a screen, from GET /v1/setup, for a computer reached
// over SSH — a VPS, a Linux VM, a Mac mini with no screen. It runs nothing it
// prints: each missing item carries the command that fixes it, for the person
// to run (ADR-046). `--link` ends with the link step, which is `caprock pair
// --computer` as it is.
func setupCmd() *cobra.Command {
	var link, noWait bool
	c := &cobra.Command{
		Use:   "setup",
		Short: "Check this computer is ready to run agents for another one, and link it",
		Long: "Lists what this computer needs before agents can run here and be started from\n" +
			"your laptop: Git, Claude Code or Codex, its sign-in, a project, and the link.\n" +
			"Each missing item prints the command that fixes it; nothing is installed for you.\n\n" +
			"With --link it then turns on access from anywhere, prints a one-time link for\n" +
			"your laptop, and waits here to ask whether to allow the laptop by name\n" +
			"(the same as `caprock pair --computer`).",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			rt, err := runningDaemon()
			if err != nil {
				return fmt.Errorf("%w here. Start it with `caprock up` (over SSH, `caprock service install` keeps it running after you log out), then run `caprock setup` again", err)
			}
			var rep readiness.Report
			if err := daemonJSON(rt, http.MethodGet, "/v1/setup", nil, &rep); err != nil {
				return fmt.Errorf("%w (is Caprock here older than this command? update it, then try again)", err)
			}
			out := cmd.OutOrStdout()
			printSetup(out, rep, link)
			autostartNote(out)
			if !link {
				lingerNote(out)
				return nil
			}
			fmt.Fprintln(out)
			return pairComputer(cmd, rt, !noWait)
		},
	}
	c.Flags().BoolVar(&link, "link", false, "then show a one-time link for your laptop and allow it here by name")
	c.Flags().BoolVar(&noWait, "no-wait", false, "with --link: print the link and return; allow later with `caprock machines allow <name>`")
	return c
}

// printSetup prints the checklist: a mark, the item, what to do, and the
// command to run for one that is missing; then the one next step.
func printSetup(out io.Writer, rep readiness.Report, linking bool) {
	fmt.Fprintf(out, "Running agents on this computer (%s):\n\n", osName(rep.OS))
	var next *readiness.Item
	for i := range rep.Items {
		it := rep.Items[i]
		mark := "[ok]"
		switch it.State {
		case readiness.Missing:
			mark = "[  ]"
		case readiness.Unknown:
			mark = "[ ?]"
		case readiness.NotNeeded:
			mark = "[--]"
		}
		fmt.Fprintf(out, "  %s %s — %s\n", mark, it.Label, it.Detail)
		if it.Command != "" && it.State != readiness.OK && it.State != readiness.NotNeeded {
			fmt.Fprintf(out, "         run: %s\n", it.Command)
		}
		if next == nil && (it.State == readiness.Missing || it.State == readiness.Unknown) {
			next = &rep.Items[i]
		}
	}
	fmt.Fprintln(out)
	switch {
	case rep.Ready():
		fmt.Fprintln(out, "Ready. Start agents from your laptop: New agent, then pick this computer.")
	case next.Key == readiness.KeyLink && linking:
		// The link step follows.
	case next.Command != "":
		fmt.Fprintf(out, "Next: %s — run the command above, then `caprock setup` again.\n", next.Label)
	default:
		fmt.Fprintf(out, "Next: %s — see above, then `caprock setup` again.\n", next.Label)
	}
}

func osName(goos string) string {
	switch goos {
	case "darwin":
		return "macOS"
	case "windows":
		return "Windows"
	case "linux":
		return "Linux"
	}
	return goos
}

// autostartNote says how to keep Caprock running with nobody logged in, when
// it is not set up to: over SSH that is the step people miss. It never
// installs anything.
func autostartNote(out io.Writer) {
	p, _, err := servicePlan(0, "")
	if err != nil || !p.Supported() {
		return
	}
	present, _, _, err := p.Installed()
	if err != nil || present {
		return
	}
	fmt.Fprintln(out, "Reached over SSH, with nobody logged in here? Keep Caprock running: caprock service install")
}
