package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/export"
)

func exportCmd() *cobra.Command {
	var (
		format  string
		since   string
		agent   string
		outPath string
		payload bool
	)
	c := &cobra.Command{
		Use:   "export [events|sessions]",
		Short: "Write the normalized record out as TSV, CSV or JSON lines",
		Long: "Every agent Caprock reads — Claude Code, Codex, OpenCode, Gemini CLI, DeepSeek — " +
			"lands in the same tables. This writes one of them out with a stable column set " +
			"(docs/schema.md): events (one row per turn, tool call or lifecycle event) or " +
			"sessions. It reads the database read-only, so it works with the daemon stopped.",
		Example: "  caprock export --since 30d > events.tsv\n" +
			"  caprock export sessions --format csv --out sessions.csv\n" +
			"  caprock export --agent codex --format jsonl --payload",
		Args:      cobra.MaximumNArgs(1),
		ValidArgs: export.Tables,
		RunE: func(cmd *cobra.Command, args []string) error {
			o := export.Options{Table: "events", Format: format, Agent: agent, Payload: payload}
			if len(args) == 1 {
				o.Table = args[0]
			}
			t, err := export.ParseSince(since, time.Now())
			if err != nil {
				return err
			}
			o.Since = t

			dir, err := config.DataDir()
			if err != nil {
				return err
			}
			path := config.DBPath(dir)
			if _, err := os.Stat(path); err != nil {
				return fmt.Errorf("no Caprock database at %s — run `caprock up` once first", path)
			}
			db, err := export.OpenReadOnly(path)
			if err != nil {
				return err
			}
			defer db.Close()

			w := cmd.OutOrStdout()
			var f *os.File
			if outPath != "" && outPath != "-" {
				// 0600: the export carries what the agents did, which is the
				// owner's business — the same mode the database itself has.
				f, err = os.OpenFile(outPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
				if err != nil {
					return err
				}
				w = f
			}
			bw := bufio.NewWriterSize(w, 1<<16)
			n, err := export.Write(cmd.Context(), db, bw, o)
			if ferr := bw.Flush(); err == nil {
				err = ferr
			}
			if f != nil {
				if cerr := f.Close(); err == nil {
					err = cerr
				}
			}
			if err != nil {
				return err
			}
			if f != nil {
				fmt.Fprintf(cmd.ErrOrStderr(), "%d %s rows → %s\n", n, o.Table, outPath)
			}
			return nil
		},
	}
	c.Flags().StringVar(&format, "format", "tsv", "Output format: "+strings.Join(export.Formats, ", "))
	c.Flags().StringVar(&since, "since", "", "Only rows from this point: 30d, 12h or a date like 2026-09-01")
	c.Flags().StringVar(&agent, "agent", "", "Only one agent: "+strings.Join(export.Agents, ", "))
	c.Flags().StringVar(&outPath, "out", "", "Write to this file (mode 0600) instead of stdout")
	c.Flags().BoolVar(&payload, "payload", false, "Events as jsonl only: include each event's raw source payload (prompts, replies, tool output)")
	return c
}
