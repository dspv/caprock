package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/peers"
)

// Join keys from a terminal (ADR-108).
//
//   - `caprock join <key>` on the new computer: the key made on the computer
//     the user works on. It turns access from anywhere on here, lets that one
//     computer in, and says what it did and what is next.
//   - `caprock machines key` on the computer the user works on: makes a key
//     and prints the command to run on the new one, for a machine reached
//     over SSH.

func joinCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "join [key]",
		Short: "Link this computer to the one you work on, with the key it shows",
		Long: "Run this on the new computer with the key from Settings → Computers → Add with a key\n" +
			"on the computer you work on (or `caprock machines key` there). With no key, it reads one\n" +
			"from standard input, so the key stays out of your shell history.\n\n" +
			"It turns on access from anywhere here, and lets that one computer start and watch\n" +
			"agents here, as a pasted link and Allow do. The key works once, for 15 minutes, and\n" +
			"carries no secrets.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			key := ""
			if len(args) == 1 {
				key = args[0]
			} else {
				fmt.Fprint(cmd.ErrOrStderr(), "Paste the key: ")
				line, err := bufio.NewReader(cmd.InOrStdin()).ReadString('\n')
				if err != nil && !errors.Is(err, io.EOF) {
					return err
				}
				key = strings.TrimSpace(line)
			}
			if key == "" {
				return errors.New("no key: run `caprock join <key>` with the key the other computer shows")
			}
			rt, err := runningDaemon()
			if err != nil {
				return errors.New("caprock is not running here: start it (open the app, or `caprock up`), then run this again")
			}
			out := cmd.OutOrStdout()
			fmt.Fprintln(out, "Joining… (this computer reaches its relay, then the other computer links back; up to a minute)")
			var res api.JoinResult
			if err := daemonJSONWait(rt, http.MethodPost, "/v1/join", map[string]string{"key": key}, &res, 150*time.Second); err != nil {
				return fmt.Errorf("could not join: %w", err)
			}
			printJoined(out, res)
			return nil
		},
	}
}

// printJoined says what a join did and what is next, plainly.
func printJoined(out io.Writer, res api.JoinResult) {
	main := res.ControllerName
	if main == "" {
		main = "the other computer"
	}
	fmt.Fprintf(out, "\nJoined. %s can now start and watch agents on this computer (%s).\n\n", main, res.Name)
	fmt.Fprintln(out, "What this did here:")
	if res.TurnedOnRemote {
		fmt.Fprintf(out, "  - turned on access from anywhere, through %s (end-to-end encrypted: the relay sees that\n    the two computers talk, never what)\n", res.Relay)
	} else {
		fmt.Fprintf(out, "  - access from anywhere was already on, through %s\n", res.Relay)
	}
	fmt.Fprintf(out, "  - allowed %s as a computer that controls this one, and no other\n", main)
	fmt.Fprintln(out, "  - nothing was installed, and no secret or token came with the key")
	fmt.Fprintln(out, "\nNext, on "+main+":")
	fmt.Fprintln(out, "  - its page for this computer lists what is still missing here (Git, agents, sign-ins);")
	fmt.Fprintln(out, "    each step runs here when you click it there")
	fmt.Fprintln(out, "  - Send secrets on that page copies the keys you tick to this computer")
	fmt.Fprintln(out, "  - or, here: `caprock setup` lists the same steps")
	fmt.Fprintf(out, "\nTo undo: `caprock machines revoke %s` here, or Disconnect in Settings → Computers.\n", shellQuote(main))
}

// machinesKeyCmd is `caprock machines key`: a join key, printed.
func machinesKeyCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "key",
		Short: "Make a one-time key that links a new computer to this one (`caprock join <key>` there)",
		Long: "Makes a join key: it works once, for 15 minutes, and lets the computer that uses it be\n" +
			"reached from this one, as a pasted link and Allow do. While it is open this computer waits\n" +
			"for it at its relay (Settings → Use on your phone names it); only end-to-end ciphertext\n" +
			"passes through. The key is printed here once and kept nowhere.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			rt, err := runningDaemon()
			if err != nil {
				return err
			}
			var k peers.NewJoinKey
			if err := daemonJSON(rt, http.MethodPost, "/v1/machines/join-key", nil, &k); err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			left := time.Until(time.UnixMilli(k.ExpiresAt)).Round(time.Minute)
			fmt.Fprintf(out, "On the new computer, run (works once, for %s):\n\n  caprock join %s\n\n", left, k.Key)
			fmt.Fprintln(out, "Caprock not installed there yet? Install it first:")
			for _, l := range installLines {
				fmt.Fprintf(out, "  %-8s %s\n", l[0]+":", l[1])
			}
			fmt.Fprintln(out, "then open the app and paste the key in Settings → Computers → Run agents for another computer.")
			fmt.Fprintln(out, "\nOnce it has joined, `caprock machines` lists it here.")
			return nil
		},
	}
}

// machinesServerScriptCmd is `caprock machines server-script`: New server's
// setup script, for a laptop reached over SSH (ADR-109).
func machinesServerScriptCmd() *cobra.Command {
	var sshKey bool
	c := &cobra.Command{
		Use:   "server-script",
		Short: "Print the setup script for a new server: paste it as the server's user data, or run it there as root",
		Long: "Makes a join key for a server (it works once, for 60 minutes) and prints the setup script with it\n" +
			"inside, to standard output, so `caprock machines server-script > caprock-setup.sh` saves it. Paste it\n" +
			"whole as the new server's user data (Hetzner Cloud: Cloud config; DigitalOcean: User data; any\n" +
			"provider that runs cloud-init), or run it once as root over SSH. It installs Caprock at this\n" +
			"computer's version, checked against that release's checksums read from GitHub now, and joins this\n" +
			"computer. Keep Caprock running and online here until the server joins.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			rt, err := runningDaemon()
			if err != nil {
				return err
			}
			var s api.ServerScript
			if err := daemonJSONWait(rt, http.MethodPost, "/v1/machines/server-script", api.ServerScriptRequest{SSHKey: sshKey}, &s, 45*time.Second); err != nil {
				return err
			}
			fmt.Fprint(cmd.OutOrStdout(), s.Script)
			check := "signature and SHA-256"
			if !s.Signed {
				check = "SHA-256 only (this release's Linux archives are not signed)"
			}
			left := time.Until(time.UnixMilli(s.ExpiresAt)).Round(time.Minute)
			e := cmd.ErrOrStderr()
			fmt.Fprintf(e, "\nThe script installs Caprock %s, checked by %s.\n", s.Version, check)
			fmt.Fprintf(e, "The key in it works once, for %s. Keep Caprock running and online here until the server joins;\n", left)
			fmt.Fprintln(e, "`caprock machines` lists it once it has.")
			return nil
		},
	}
	c.Flags().BoolVar(&sshKey, "ssh-key", false, "you gave the provider an SSH key, or will run the script over SSH: SSH stays on, keys only (without it, SSH is stopped on the server)")
	return c
}

// installLines are the install commands the site's button and
// docs/install-agent.md show, per system.
var installLines = [][2]string{
	{"macOS", "curl -fsSL https://caprock.dev/mac.sh | sh"},
	{"Windows", "irm https://caprock.dev/win.ps1 | iex"},
	{"Linux", "curl -fsSL https://caprock.dev/linux.sh | sh"},
}
