package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/user"
	"runtime"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/hidewin"
	"github.com/dspv/caprock/internal/pairing"
	"github.com/dspv/caprock/internal/peers"
)

// Other computers, from a terminal (ADR-067). Two directions, one command:
//
//   - the computers this one reaches — `ls`, `add <link>`, `forget <name>`;
//   - the computers that reach this one — `pending`, `allow <name>`,
//     `deny <name>`, `revoke <name>`. Run here, by whoever holds a shell on
//     this machine, `allow` is the owner's Allow, exactly as the button is:
//     on a Mac mini in a cupboard, SSH is the screen.

func machinesCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "machines",
		Short: "Other computers: the ones this one reaches, and the ones that reach it",
		Long: "Your other computers' Caprock, through the relay each of them chose (ADR-067).\n\n" +
			"This computer reaches another after you paste the link it shows\n" +
			"(`caprock pair --computer` there) into `caprock machines add`; that computer's\n" +
			"owner then allows it by name. Pairing is one way: the other computer reaches\n" +
			"nothing here unless it is paired the other way too.",
		RunE: func(cmd *cobra.Command, _ []string) error { return machinesList(cmd.OutOrStdout()) },
	}
	ls := &cobra.Command{
		Use:   "ls",
		Short: "List the computers this one reaches, and the ones that reach it",
		RunE:  func(cmd *cobra.Command, _ []string) error { return machinesList(cmd.OutOrStdout()) },
	}
	add := &cobra.Command{
		Use:   "add <link>",
		Short: "Reach another computer: paste the link `caprock pair --computer` printed there",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			rt, err := runningDaemon()
			if err != nil {
				return err
			}
			var st peers.Status
			if err := daemonJSONWait(rt, http.MethodPost, "/v1/machines", map[string]string{"link": args[0]}, &st, 75*time.Second); err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			fmt.Fprintf(out, "paired with %s (%s)\n", st.Name, st.Status)
			switch {
			case st.Status == peers.StatusPending:
				fmt.Fprintf(out, "On %s, allow this computer: press Allow there, or run\n  caprock machines allow %s\n", st.Name, shellQuote(hostLabel()))
			case st.Kind != pairing.KindMachine && st.Role != "":
				// A computer from before ADR-067's PR2 pairs one as a phone.
				fmt.Fprintf(out, "%s paired this computer as a phone (%s): update Caprock there for full control.\n", st.Name, st.Role)
			}
			return nil
		},
	}
	forget := &cobra.Command{
		Use:   "forget <name|id>",
		Short: "Stop reaching a computer: delete its token here, and ask it to drop this one",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			rt, err := runningDaemon()
			if err != nil {
				return err
			}
			var list struct {
				Machines []peers.Status `json:"machines"`
			}
			if err := daemonJSON(rt, http.MethodGet, "/v1/machines", nil, &list); err != nil {
				return err
			}
			var ids, names []string
			for _, m := range list.Machines {
				ids, names = append(ids, m.ID), append(names, m.Name)
			}
			i, err := pick(args[0], ids, names)
			if err != nil {
				return err
			}
			var got struct {
				Released bool `json:"released"`
			}
			if err := daemonJSONWait(rt, http.MethodDelete, "/v1/machines/"+url.PathEscape(ids[i]), nil, &got, 30*time.Second); err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			fmt.Fprintf(out, "forgot %s\n", names[i])
			if !got.Released {
				fmt.Fprintf(out, "%s could not be told (offline?): it still lists this computer until its owner removes it there.\n", names[i])
			}
			return nil
		},
	}
	pending := &cobra.Command{
		Use:   "pending",
		Short: "List the computers waiting to be allowed to control this one",
		RunE: func(cmd *cobra.Command, _ []string) error {
			rt, err := runningDaemon()
			if err != nil {
				return err
			}
			ds, err := computersHere(rt)
			if err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			n := 0
			for _, d := range ds {
				if d.Pending {
					n++
					fmt.Fprintf(out, "%s  (id %s, asked %s)\n", d.Name, d.ID, ago(d.PairedAt))
				}
			}
			if n == 0 {
				fmt.Fprintln(out, "no computer is waiting")
				return nil
			}
			fmt.Fprintln(out, "allow one with: caprock machines allow <name>   (or deny <name>)")
			return nil
		},
	}
	decide := func(use, short string, wantPending bool, do func(rt config.Runtime, d pairing.Public) error, said string) *cobra.Command {
		return &cobra.Command{
			Use:   use + " <name|id>",
			Short: short,
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				rt, err := runningDaemon()
				if err != nil {
					return err
				}
				ds, err := computersHere(rt)
				if err != nil {
					return err
				}
				var ids, names []string
				var cand []pairing.Public
				for _, d := range ds {
					if wantPending && !d.Pending {
						continue
					}
					cand = append(cand, d)
					ids, names = append(ids, d.ID), append(names, d.Name)
				}
				i, err := pick(args[0], ids, names)
				if err != nil {
					if wantPending {
						return fmt.Errorf("%w (waiting: caprock machines pending)", err)
					}
					return err
				}
				if err := do(rt, cand[i]); err != nil {
					return err
				}
				fmt.Fprintf(cmd.OutOrStdout(), said+"\n", cand[i].Name)
				return nil
			},
		}
	}
	allow := decide("allow", "Allow a waiting computer to control this one (the owner's Allow, as the button)", true,
		func(rt config.Runtime, d pairing.Public) error {
			return daemonJSON(rt, http.MethodPost, "/v1/pair/devices/"+url.PathEscape(d.ID)+"/allow", nil, nil)
		}, "allowed %s: it can now work on this computer's sessions")
	deny := decide("deny", "Refuse a waiting computer", true,
		func(rt config.Runtime, d pairing.Public) error {
			return daemonJSON(rt, http.MethodDelete, "/v1/pair/devices/"+url.PathEscape(d.ID), nil, nil)
		}, "denied %s")
	revoke := decide("revoke", "Remove a computer that reaches this one; its token stops now", false,
		func(rt config.Runtime, d pairing.Public) error {
			return daemonJSON(rt, http.MethodDelete, "/v1/pair/devices/"+url.PathEscape(d.ID), nil, nil)
		}, "removed %s: it reaches nothing here any more")
	c.AddCommand(ls, add, forget, pending, allow, deny, revoke)
	return c
}

// computersHere is the computers paired with this machine (devices.json,
// kind "machine"), allowed or waiting.
func computersHere(rt config.Runtime) ([]pairing.Public, error) {
	var st struct {
		Devices []pairing.Public `json:"devices"`
	}
	if err := daemonJSON(rt, http.MethodGet, "/v1/pair/state", nil, &st); err != nil {
		return nil, err
	}
	var out []pairing.Public
	for _, d := range st.Devices {
		if d.Kind == pairing.KindMachine {
			out = append(out, d)
		}
	}
	return out, nil
}

// pick finds arg among names (case-insensitively) or ids (exactly). Two
// computers with one name are told apart by id.
func pick(arg string, ids, names []string) (int, error) {
	for i, id := range ids {
		if id == arg {
			return i, nil
		}
	}
	found := -1
	var same []string
	for i, n := range names {
		if strings.EqualFold(n, arg) {
			if found < 0 {
				found = i
			}
			same = append(same, ids[i])
		}
	}
	switch {
	case len(same) > 1:
		return 0, fmt.Errorf("%d computers are called %q; name one by id: %s", len(same), arg, strings.Join(same, ", "))
	case found < 0:
		return 0, fmt.Errorf("no computer called %q", arg)
	}
	return found, nil
}

func machinesList(out io.Writer) error {
	rt, err := runningDaemon()
	if err != nil {
		return err
	}
	var list struct {
		Machines []peers.Status `json:"machines"`
	}
	if err := daemonJSONWait(rt, http.MethodGet, "/v1/machines?check=1", nil, &list, 30*time.Second); err != nil {
		return err
	}
	fmt.Fprintln(out, "This computer reaches:")
	if len(list.Machines) == 0 {
		fmt.Fprintln(out, "  none — on the other computer run `caprock pair --computer`, then here `caprock machines add '<link>'`")
	}
	for _, m := range list.Machines {
		line := fmt.Sprintf("  %-20s %-10s", m.Name, m.Status)
		if m.Role != "" {
			line += " " + m.Role
		}
		if m.Error != "" {
			line += " — " + m.Error
		}
		fmt.Fprintf(out, "%s\n    relay %s  id %s\n", line, m.Relay, m.ID)
	}
	ds, err := computersHere(rt)
	if err != nil {
		return err
	}
	fmt.Fprintln(out, "Computers that reach this one:")
	if len(ds) == 0 {
		fmt.Fprintln(out, "  none")
	}
	for _, d := range ds {
		state := "allowed"
		if d.Pending {
			state = "waiting — caprock machines allow " + shellQuote(d.Name)
		} else if d.Role != pairing.RoleController {
			state = d.Role
		}
		fmt.Fprintf(out, "  %-20s %s  (last seen %s)\n", d.Name, state, ago(d.LastSeen))
	}
	return nil
}

// pairComputer shows a link for another computer and, when it may, waits
// here to ask whether to allow the computer that uses it (ADR-067): on a
// machine with no screen, this terminal is the screen.
func pairComputer(cmd *cobra.Command, rt config.Runtime, wait bool) error {
	out := cmd.OutOrStdout()
	before, err := computersHere(rt)
	if err != nil {
		return err
	}
	var got struct {
		Code         string           `json:"code"`
		ExpiresInSec int              `json:"expires_in_sec"`
		Remote       *api.RemoteState `json:"remote"`
	}
	if err := daemonJSON(rt, http.MethodPost, "/v1/pair/code", map[string]string{"kind": pairing.KindMachine}, &got); err != nil {
		return err
	}
	if got.Remote == nil || got.Remote.Link == "" {
		return errors.New("access from anywhere could not be turned on here: see `caprock remote`")
	}
	lingerNote(out)
	fmt.Fprintf(out, "On the other computer, run:\n\n  caprock machines add %s\n\n", shellQuote(got.Remote.Link))
	fmt.Fprintf(out, "The link is valid five minutes, once, and reaches this computer through %s.\n", got.Remote.Relay)
	if !wait || !stdinIsTerminal(cmd) {
		fmt.Fprintln(out, "Then allow it here: caprock machines allow <its name>   (caprock machines pending lists who waits)")
		return nil
	}
	fmt.Fprintln(out, "Waiting for it here… (Ctrl-C to stop; `caprock machines allow <name>` works later too)")
	known := map[string]bool{}
	for _, d := range before {
		known[d.ID] = true
	}
	ttl := time.Duration(got.ExpiresInSec)*time.Second + 30*time.Second
	ctx, cancel := context.WithTimeout(cmd.Context(), ttl)
	defer cancel()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			fmt.Fprintln(out, "No computer used the link in time. Run `caprock pair --computer` again for a new one.")
			return nil
		case <-tick.C:
		}
		ds, err := computersHere(rt)
		if err != nil {
			continue
		}
		for _, d := range ds {
			if !d.Pending || known[d.ID] {
				continue
			}
			known[d.ID] = true
			if askNo(cmd, fmt.Sprintf("%q wants to control this computer. Allow? [y/N] ", d.Name)) {
				if err := daemonJSON(rt, http.MethodPost, "/v1/pair/devices/"+url.PathEscape(d.ID)+"/allow", nil, nil); err != nil {
					return err
				}
				fmt.Fprintf(out, "allowed %s: it can now work on this computer's sessions. Remove it any time: caprock machines revoke %s\n", d.Name, shellQuote(d.Name))
				return nil
			}
			if err := daemonJSON(rt, http.MethodDelete, "/v1/pair/devices/"+url.PathEscape(d.ID), nil, nil); err != nil {
				return err
			}
			fmt.Fprintf(out, "denied %s\n", d.Name)
			return nil
		}
	}
}

// stdinIsTerminal reports whether the command can ask a question and get an
// answer.
func stdinIsTerminal(cmd *cobra.Command) bool {
	in, ok := cmd.InOrStdin().(*os.File)
	if !ok {
		return false
	}
	fi, err := in.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

// askNo asks a yes-or-no question whose default is no: letting a computer in
// is said, never assumed.
func askNo(cmd *cobra.Command, prompt string) bool {
	fmt.Fprint(cmd.OutOrStdout(), prompt)
	line, _ := bufio.NewReader(cmd.InOrStdin()).ReadString('\n')
	line = strings.ToLower(strings.TrimSpace(line))
	return line == "y" || line == "yes"
}

// hostLabel is what another computer lists this one as: its host name
// without the ".local" macOS appends (the daemon's machineName).
func hostLabel() string {
	n, err := os.Hostname()
	if err != nil || n == "" {
		return "Caprock"
	}
	return strings.TrimSuffix(n, ".local")
}

// shellQuote quotes s for a POSIX shell when it needs it.
func shellQuote(s string) string {
	plain := func(r rune) bool {
		return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("-_./:", r)
	}
	if s != "" && strings.IndexFunc(s, func(r rune) bool { return !plain(r) }) < 0 {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// ago says when a unix-millisecond time was, roughly.
func ago(ms int64) string {
	if ms <= 0 {
		return "never"
	}
	d := time.Since(time.UnixMilli(ms))
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	}
	return fmt.Sprintf("%dd ago", int(d.Hours()/24))
}

// lingerState asks systemd whether this user's services outlive their last
// session: "yes", "no", or "" when it cannot tell (not Linux, no loginctl).
// A variable so a test can answer for it.
var lingerState = func() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	u, err := user.Current()
	if err != nil || u.Username == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	b, err := hidewin.CommandContext(ctx, "loginctl", "show-user", u.Username, "--property=Linger", "--value").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// lingerNote says, on Linux with lingering off, that the systemd user unit
// stops when the last session of this user ends — so a target set up over
// SSH goes offline when that SSH session closes (ADR-067). It never turns
// lingering on: that is the owner's command to run, as root or with polkit.
func lingerNote(out io.Writer) {
	if lingerState() != "no" {
		return
	}
	name := "$USER"
	if u, err := user.Current(); err == nil && u.Username != "" {
		name = u.Username
	}
	fmt.Fprintf(out, "Note: lingering is off for %s, so Caprock stops when your last session here ends\n"+
		"(closing this SSH session takes the computer offline). To keep it running with\n"+
		"nobody logged in, run once:  loginctl enable-linger %s\n\n", name, name)
}
