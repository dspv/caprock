package main

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

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
	var agent string
	c := &cobra.Command{
		Use:   "setup [--agent <id> on|off]",
		Short: "Check this computer is ready to run agents for another one, and link it",
		Long: "Lists what this computer needs before agents can run here and be started from\n" +
			"your laptop: Git, the agents you switched on (each installed and signed in),\n" +
			"and the link; projects here are optional.\n" +
			"Each missing item prints the command that fixes it; nothing is installed for you.\n\n" +
			"--agent <id> on|off switches an agent on or off in this list (claude, codex,\n" +
			"opencode, gemini, cursor, …). It changes only the setting: nothing is installed\n" +
			"or removed.\n\n" +
			"With --link it then turns on access from anywhere, prints a one-time link for\n" +
			"your laptop, and waits here to ask whether to allow the laptop by name\n" +
			"(the same as `caprock pair --computer`).",
		Args: func(cmd *cobra.Command, args []string) error {
			if agent == "" {
				return cobra.NoArgs(cmd, args)
			}
			if len(args) != 1 || (args[0] != "on" && args[0] != "off") {
				return fmt.Errorf("say on or off: caprock setup --agent %s on", agent)
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			rt, err := runningDaemon()
			if err != nil {
				return fmt.Errorf("%w here. Start it with `caprock up` (over SSH, `caprock service install` keeps it running after you log out), then run `caprock setup` again", err)
			}
			var rep readiness.Report
			if agent != "" {
				err = daemonJSON(rt, http.MethodPut, "/v1/setup/agents/"+url.PathEscape(agent), map[string]bool{"on": args[0] == "on"}, &rep)
			} else {
				err = daemonJSON(rt, http.MethodGet, "/v1/setup", nil, &rep)
			}
			if err != nil {
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
	c.Flags().StringVar(&agent, "agent", "", "switch an agent on or off in the checklist: --agent codex on")
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
		if it.Optional && it.State == readiness.NotNeeded {
			mark = "[ ·]"
		}
		fmt.Fprintf(out, "  %s %s — %s\n", mark, it.Label, it.Detail)
		switch {
		case it.Key == readiness.KeyAgent && len(rep.Agents) > 0:
			printAgents(out, rep.Agents)
		case it.Command != "" && it.State != readiness.OK && it.State != readiness.NotNeeded:
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

// printAgents prints the agent item's rows: each switched-on agent with its
// state and, while a step is left, the command; the ones switched off on one
// line; then how to switch one.
func printAgents(out io.Writer, rows []readiness.AgentRow) {
	var off []string
	for _, a := range rows {
		if !a.On {
			off = append(off, a.ID)
			continue
		}
		mark := "ok"
		switch a.State {
		case readiness.Missing:
			mark = "  "
		case readiness.Unknown:
			mark = " ?"
		}
		fmt.Fprintf(out, "         [%s] %s — %s\n", mark, a.Label, a.Detail)
		if a.Command != "" && a.State != readiness.OK {
			fmt.Fprintf(out, "              run: %s\n", a.Command)
		}
	}
	if len(off) > 0 {
		fmt.Fprintf(out, "         off: %s\n", strings.Join(off, ", "))
	}
	fmt.Fprintln(out, "         switch one: caprock setup --agent <id> on|off")
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
