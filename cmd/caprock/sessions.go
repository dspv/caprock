package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/spf13/cobra"

	"github.com/dspv/caprock/internal/api"
)

func sessionsCmd() *cobra.Command {
	c := &cobra.Command{Use: "sessions", Short: "Work with the sessions Caprock has recorded"}
	c.AddCommand(sessionsRmCmd())
	return c
}

func sessionsRmCmd() *cobra.Command {
	var (
		cwdPrefix string
		yes       bool
	)
	c := &cobra.Command{
		Use:   "rm [session-id...]",
		Short: "Remove sessions from Caprock: their events, costs and totals (requires a running daemon)",
		Long: "Remove sessions from Caprock — a test run's leftovers, say. Each one's events\n" +
			"and everything counted from them leave every screen and total, and the session\n" +
			"is never recorded again, even though its transcript stays on disk. This cannot\n" +
			"be undone.\n\n" +
			"Without --yes nothing is removed: it lists what would be. A session still\n" +
			"running is skipped.",
		Example: "  caprock sessions rm 3f2a…\n" +
			"  caprock sessions rm --cwd-prefix /private/tmp/claude-501\n" +
			"  caprock sessions rm --cwd-prefix /private/tmp/claude-501 --yes",
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 0 && cwdPrefix == "" {
				return errors.New("name the sessions to remove, or pass --cwd-prefix")
			}
			if len(args) > 0 && cwdPrefix != "" {
				return errors.New("pass session ids or --cwd-prefix, not both")
			}
			rt, err := runningDaemon()
			if err != nil {
				return err
			}
			res, err := postRemove(rt.Port, api.RemoveRequest{IDs: args, CwdPrefix: cwdPrefix, DryRun: !yes})
			if err != nil {
				return err
			}
			printRemoval(cmd.OutOrStdout(), res)
			return nil
		},
	}
	c.Flags().StringVar(&cwdPrefix, "cwd-prefix", "", "every session whose folder is this one or lies under it")
	c.Flags().BoolVar(&yes, "yes", false, "remove them; without it, only list what would be removed")
	return c
}

func postRemove(port int, req api.RemoveRequest) (api.RemoveResult, error) {
	var res api.RemoveResult
	body, err := json.Marshal(req)
	if err != nil {
		return res, err
	}
	resp, err := (&http.Client{Timeout: 2 * time.Minute}).Post(
		fmt.Sprintf("http://127.0.0.1:%d/v1/sessions/remove", port), "application/json", bytes.NewReader(body))
	if err != nil {
		return res, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(raw, &e) == nil && e.Error != "" {
			return res, errors.New(e.Error)
		}
		return res, fmt.Errorf("remove sessions: %s", resp.Status)
	}
	return res, json.Unmarshal(raw, &res)
}

func printRemoval(w io.Writer, res api.RemoveResult) {
	for _, s := range res.Sessions {
		fmt.Fprintf(w, "%s  %-8s %-7s $%8.2f  %s\n", s.SessionID, s.Agent, s.Status, s.CostUSD, s.Cwd)
	}
	for _, s := range res.Skipped {
		fmt.Fprintf(w, "%s  skipped: %s  %s\n", s.SessionID, s.Reason, s.Cwd)
	}
	switch {
	case len(res.Sessions) == 0:
		fmt.Fprintln(w, "nothing to remove")
	case res.DryRun:
		fmt.Fprintf(w, "would remove %d sessions, $%.2f — run again with --yes to remove them\n", len(res.Sessions), res.CostUSD)
	default:
		fmt.Fprintf(w, "removed %d sessions, $%.2f\n", len(res.Sessions), res.CostUSD)
		if res.UnmatchedUSD > 0.005 {
			fmt.Fprintf(w, "note: $%.2f of it was not found in the daily totals, which still count it\n", res.UnmatchedUSD)
		}
	}
}
