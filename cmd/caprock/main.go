// caprock is the mission-control CLI and daemon: `caprock up` starts the local
// daemon (hook receiver + transcript ingest + API + dashboard), `caprock down`
// stops it, `caprock status` reports, `caprock hooks install|uninstall|status`
// manage the shim in ~/.claude/settings.json, and
// `caprock service install|uninstall|status` registers the daemon with the OS's
// login-time supervisor so it survives a reboot.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/daemon"
	"github.com/dspv/caprock/internal/hooks"
	"github.com/dspv/caprock/internal/shim"
	"github.com/dspv/caprock/internal/statusline"
	"github.com/dspv/caprock/internal/version"
)

func main() {
	if err := newRoot().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func newRoot() *cobra.Command {
	root := &cobra.Command{
		Use:           "caprock",
		Short:         "Mission control for Claude Code — local, observe-first",
		Long:          "Caprock watches every Claude Code session on this machine (hooks + transcripts), shows live activity, cost and loop alerts at http://127.0.0.1:4173, and keeps all data local.",
		SilenceUsage:  true,
		SilenceErrors: true,
		Version:       version.Version,
	}
	root.AddCommand(upCmd(), downCmd(), statusCmd(), tasksCmd(), taskCmd(), hooksCmd(), hookCmd(), statuslineCmd(), serviceCmd(), versionCmd())
	return root
}

// --- up ---

func upCmd() *cobra.Command {
	var (
		port       int
		noOpen     bool
		noHooks    bool
		yes        bool
		foreground bool
		dataDirF   string
		hiveDir    string
		repoDir    string
	)
	c := &cobra.Command{
		Use:   "up",
		Short: "Start the daemon, install the hook shim (with consent), open the dashboard",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if dataDirF != "" {
				_ = os.Setenv(config.EnvDataDir, dataDirF)
			}
			dir, err := config.EnsureDataDir()
			if err != nil {
				return err
			}
			cfg, err := config.Load(dir)
			if err != nil {
				return err
			}
			if port != 0 {
				cfg.Port = port
			}
			// Already running?
			if rt, err := config.ReadRuntime(dir); err == nil && daemonAlive(rt) {
				fmt.Fprintf(cmd.OutOrStdout(), "caprock is already running at http://127.0.0.1:%d (pid %d)\n", rt.Port, rt.PID)
				if !noOpen && cfg.OpenBrowser {
					openBrowser(fmt.Sprintf("http://127.0.0.1:%d", rt.Port))
				}
				return nil
			}
			_ = config.RemoveRuntime(dir) // stale file from a crashed run

			// Shim: place it in the data dir and register it.
			if !noHooks {
				if err := ensureShim(dir); err != nil {
					fmt.Fprintf(cmd.ErrOrStderr(), "warning: %v\n", err)
				} else if err := maybeInstallHooks(cmd, dir, yes); err != nil {
					fmt.Fprintf(cmd.ErrOrStderr(), "warning: hooks not installed: %v\n", err)
				}
				// The statusLine feeds plan-limit windows (Pro/Max) to the Cost
				// screen; offer it the same way as hooks. Non-fatal if declined.
				if err := maybeInstallStatusline(cmd, yes); err != nil {
					fmt.Fprintf(cmd.ErrOrStderr(), "warning: statusline not installed: %v\n", err)
				}
			}

			if !foreground {
				return detach(cmd, dir, cfg, noOpen, hiveDir, repoDir)
			}
			return runForeground(cmd, dir, cfg, noOpen, hiveDir, repoDir)
		},
	}
	c.Flags().IntVar(&port, "port", 0, "listen port (default from config.json, 4173)")
	c.Flags().BoolVar(&noOpen, "no-open", false, "do not open the dashboard in a browser")
	c.Flags().BoolVar(&noHooks, "no-hooks", false, "do not install/verify the hook shim")
	c.Flags().BoolVarP(&yes, "yes", "y", false, "assume yes for the hook install prompt")
	c.Flags().BoolVar(&foreground, "foreground", false, "run in the foreground (logs to stderr) instead of detaching")
	c.Flags().StringVar(&dataDirF, "data-dir", "", "override the data directory (also $CAPROCK_DATA_DIR)")
	c.Flags().StringVar(&hiveDir, "hive", "", "run tasks unattended: queue directory for the task runner (created if missing)")
	c.Flags().StringVar(&repoDir, "repo", "", "the repo workers operate on, one git worktree each (default: current directory)")
	return c
}

func runForeground(cmd *cobra.Command, dir string, cfg config.Config, noOpen bool, hiveDir, repoDir string) error {
	log := slog.New(slog.NewTextHandler(cmd.ErrOrStderr(), &slog.HandlerOptions{Level: slog.LevelInfo}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return daemon.Run(ctx, daemon.Options{
		DataDir: dir, Config: cfg, Version: version.Version, Log: log, HiveDir: hiveDir, RepoCwd: repoDir,
		OnReady: func(url string) {
			fmt.Fprintf(cmd.OutOrStdout(), "caprock is up at %s  (data: %s)\n", url, dir)
			printHive(cmd, hiveDir)
			if !noOpen && cfg.OpenBrowser {
				openBrowser(url)
			}
		},
	})
}

// detach re-executes this binary with `up --foreground` as a background
// process whose stdout/stderr go to <data_dir>/caprock.log, then waits until
// runtime.json appears.
func detach(cmd *cobra.Command, dir string, cfg config.Config, noOpen bool, hiveDir, repoDir string) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	logf, err := os.OpenFile(config.LogPath(dir), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer logf.Close()
	childArgs := []string{"up", "--foreground", "--no-open", "--no-hooks", "--port", fmt.Sprint(cfg.Port)}
	if hiveDir != "" {
		childArgs = append(childArgs, "--hive", hiveDir)
	}
	if repoDir != "" {
		childArgs = append(childArgs, "--repo", repoDir)
	}
	child := exec.Command(self, childArgs...)
	child.Env = append(os.Environ(), config.EnvDataDir+"="+dir)
	child.Stdout, child.Stderr = logf, logf
	child.Stdin = nil
	setDetached(child)
	if err := child.Start(); err != nil {
		return fmt.Errorf("start daemon: %w", err)
	}
	_ = child.Process.Release()
	// Wait for runtime.json (up to 10s).
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if rt, err := config.ReadRuntime(dir); err == nil && daemonAlive(rt) {
			url := fmt.Sprintf("http://127.0.0.1:%d", rt.Port)
			fmt.Fprintf(cmd.OutOrStdout(), "caprock is up at %s  (pid %d, log: %s)\n", url, rt.PID, config.LogPath(dir))
			printHive(cmd, hiveDir)
			if !noOpen && cfg.OpenBrowser {
				openBrowser(url)
			}
			return nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	// The child failed to come up. Surface the real cause from its log (the most
	// common one is the port already being in use) instead of a bare timeout.
	if cause := lastLogError(config.LogPath(dir)); cause != "" {
		return fmt.Errorf("daemon did not start: %s\n(full log: %s)", cause, config.LogPath(dir))
	}
	return fmt.Errorf("daemon did not report ready within 10s; see %s", config.LogPath(dir))
}

// lastLogError returns the most recent error-ish line from the daemon log, made
// friendly where we recognize it (a taken port is the usual first-run footgun),
// or "" if nothing useful is there. Best-effort: any read error yields "".
func lastLogError(logPath string) string {
	b, err := os.ReadFile(logPath)
	if err != nil {
		return ""
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	// Scan from the end for the last line that looks like a failure.
	for i := len(lines) - 1; i >= 0 && i >= len(lines)-40; i-- {
		l := strings.TrimSpace(lines[i])
		low := strings.ToLower(l)
		if strings.Contains(low, "address already in use") || strings.Contains(low, "bind:") {
			return "port 127.0.0.1 is already in use — another caprock may be running (try `caprock status`, or `caprock down`), or pass `--port <n>`"
		}
		if strings.Contains(low, "level=error") || strings.Contains(low, "level=fatal") || strings.Contains(low, "panic:") {
			return l
		}
	}
	return ""
}

// ensureShim copies caprock-hook from beside this executable into the data dir
// (if present and different). When no sibling shim exists, `caprock hook` is
// used as the fallback command.
func ensureShim(dir string) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	src := filepath.Join(filepath.Dir(self), filepath.Base(config.ShimPath(dir)))
	dst := config.ShimPath(dir)
	sb, err := os.ReadFile(src)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil // fallback handled by shimCommand
		}
		return err
	}
	if db, err := os.ReadFile(dst); err == nil && string(db) == string(sb) {
		return nil
	}
	if err := config.WriteFileAtomic(dst, sb, 0o755); err != nil {
		return fmt.Errorf("install shim into data dir: %w", err)
	}
	return nil
}

// shimCommand returns the command to register in settings.json: the shim binary
// in the data dir when it exists, else `<self> hook`.
func shimCommand(dir string) string {
	if _, err := os.Stat(config.ShimPath(dir)); err == nil {
		return config.ShimPath(dir)
	}
	self, err := os.Executable()
	if err != nil {
		return config.ShimPath(dir)
	}
	return self + " hook"
}

func maybeInstallHooks(cmd *cobra.Command, dir string, yes bool) error {
	sp, err := hooks.DefaultSettingsPath()
	if err != nil {
		return err
	}
	shimPath := shimCommand(dir)
	st, err := hooks.Inspect(sp, shimPath)
	if err != nil {
		return err
	}
	if len(st.Missing) == 0 {
		return nil
	}
	if !yes {
		fmt.Fprintf(cmd.OutOrStdout(), "Caprock needs a hook entry in %s so it can see Claude Code sessions.\n", sp)
		fmt.Fprintf(cmd.OutOrStdout(), "It appends `%s` under %d events, backs the file up first, and never touches your other hooks.\n", shimPath, len(hooks.Events))
		if !confirm(cmd, "Install now? [Y/n] ") {
			fmt.Fprintln(cmd.OutOrStdout(), "Skipped. Run `caprock hooks install` later; transcript tailing still works (delayed).")
			return nil
		}
	}
	backup, err := hooks.Install(sp, shimPath)
	if err != nil {
		return err
	}
	if backup != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "hooks installed (backup: %s)\n", backup)
	} else {
		fmt.Fprintln(cmd.OutOrStdout(), "hooks installed")
	}
	return nil
}

// statuslineCommandStr is the command to register as Claude Code's
// statusLine.command: this executable plus the `statusline` subcommand.
func statuslineCommandStr() string {
	self, err := os.Executable()
	if err != nil {
		return "caprock statusline"
	}
	// Quote only the path, not the whole command — else a caprock installed under
	// a path with spaces produces `"…/caprock statusline"` (one quoted token,
	// which Claude Code runs as a binary literally named "caprock statusline").
	if strings.ContainsAny(self, " \t") {
		return `"` + self + `" statusline`
	}
	return self + " statusline"
}

// maybeInstallStatusline offers to register `caprock statusline` as Claude Code's
// statusLine command, which feeds plan-limit windows (Pro/Max) to the Cost
// screen. Same consent contract as hooks: TTY prompt, or `--yes` for scripts. It
// never clobbers a statusLine the user already set to something else.
func maybeInstallStatusline(cmd *cobra.Command, yes bool) error {
	sp, err := hooks.DefaultSettingsPath()
	if err != nil {
		return err
	}
	cmdStr := statuslineCommandStr()
	ours, present, err := hooks.StatuslineInstalled(sp, cmdStr)
	if err != nil {
		return err
	}
	if ours {
		return nil // already ours
	}
	if present {
		// The user has their own statusLine — don't touch it, just hint.
		if !yes {
			fmt.Fprintln(cmd.OutOrStdout(), "You already have a statusLine set; leaving it. For Caprock's plan-limit view, add `caprock statusline` yourself, or run `caprock statusline install`.")
		}
		return nil
	}
	if !yes {
		fmt.Fprintf(cmd.OutOrStdout(), "Caprock can also show your plan limits (5h/7d, Pro/Max) on the Cost screen via Claude Code's status line.\n")
		fmt.Fprintf(cmd.OutOrStdout(), "It sets `statusLine.command` to `%s` in %s (backed up first). Skip if you use your own status line.\n", cmdStr, sp)
		if !confirm(cmd, "Add it? [Y/n] ") {
			fmt.Fprintln(cmd.OutOrStdout(), "Skipped. Run `caprock statusline install` later to enable plan limits.")
			return nil
		}
	}
	backup, err := hooks.InstallStatusline(sp, cmdStr)
	if err != nil {
		return err
	}
	if backup != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "statusline installed (backup: %s)\n", backup)
	} else {
		fmt.Fprintln(cmd.OutOrStdout(), "statusline installed")
	}
	return nil
}

func confirm(cmd *cobra.Command, prompt string) bool {
	in, ok := cmd.InOrStdin().(*os.File)
	if !ok {
		return false
	}
	if fi, err := in.Stat(); err != nil || fi.Mode()&os.ModeCharDevice == 0 {
		return false // not a TTY: do not block, do not assume
	}
	fmt.Fprint(cmd.OutOrStdout(), prompt)
	line, _ := bufio.NewReader(in).ReadString('\n')
	line = strings.ToLower(strings.TrimSpace(line))
	return line == "" || line == "y" || line == "yes"
}

// --- down ---

func downCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "down",
		Short: "Stop the daemon (keeps all data)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			dir, err := config.DataDir()
			if err != nil {
				return err
			}
			rt, rtErr := config.ReadRuntime(dir)
			running := rtErr == nil && daemonAlive(rt)
			if !running {
				// Absent/unreadable runtime.json, or a dead pid, both mean "not running".
				_ = config.RemoveRuntime(dir)
				fmt.Fprintln(cmd.OutOrStdout(), "caprock is not running")
				return nil
			}
			req, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/v1/shutdown", rt.Port), nil)
			req.Header.Set("Authorization", "Bearer "+rt.Token)
			resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
			if err != nil {
				return fmt.Errorf("shutdown request: %w", err)
			}
			_ = resp.Body.Close()
			deadline := time.Now().Add(10 * time.Second)
			for time.Now().Before(deadline) {
				if _, err := config.ReadRuntime(dir); errors.Is(err, os.ErrNotExist) {
					fmt.Fprintln(cmd.OutOrStdout(), "caprock stopped; your data is intact in", dir)
					return nil
				}
				time.Sleep(100 * time.Millisecond)
			}
			return errors.New("daemon did not stop within 10s")
		},
	}
}

// --- status ---

func statusCmd() *cobra.Command {
	var asJSON bool
	c := &cobra.Command{
		Use:   "status",
		Short: "Show daemon, hooks and ingest status",
		RunE: func(cmd *cobra.Command, _ []string) error {
			dir, err := config.DataDir()
			if err != nil {
				return err
			}
			rt, err := config.ReadRuntime(dir)
			running := err == nil && daemonAlive(rt)
			out := cmd.OutOrStdout()
			if !running {
				sp, _ := hooks.DefaultSettingsPath()
				hs, _ := hooks.Inspect(sp, shimCommand(dir))
				if asJSON {
					return json.NewEncoder(out).Encode(map[string]any{"running": false, "data_dir": dir, "hooks": hs})
				}
				fmt.Fprintf(out, "daemon:  not running\ndata:    %s\nhooks:   %d/%d events registered in %s\n", dir, len(hs.Installed), len(hooks.Events), sp)
				return nil
			}
			resp, err := (&http.Client{Timeout: 3 * time.Second}).Get(fmt.Sprintf("http://127.0.0.1:%d/v1/status", rt.Port))
			if err != nil {
				return err
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			if asJSON {
				_, _ = out.Write(body)
				return nil
			}
			var st daemon.Status
			if err := json.Unmarshal(body, &st); err != nil {
				_, _ = out.Write(body)
				return nil
			}
			fmt.Fprintf(out, "daemon:  running  %s  (pid %d, up %s, %s)\n", st.URL, st.PID, (time.Duration(st.UptimeS) * time.Second).String(), st.Version)
			fmt.Fprintf(out, "data:    %s\n", st.DataDir)
			fmt.Fprintf(out, "pricing: %s (%d models%s)\n", st.Pricing.Version, st.Pricing.Models, map[bool]string{true: ", user override", false: ""}[st.Pricing.UserOverride])
			if st.Hooks != nil {
				fmt.Fprintf(out, "hooks:   %d/%d events registered in %s\n", len(st.Hooks.Installed), len(hooks.Events), st.Hooks.SettingsPath)
			}
			if st.Ingest != nil {
				fmt.Fprintf(out, "ingest:  %d transcripts, %d events stored, %d deduped, backfill %s\n", st.Ingest.FilesKnown, st.Ingest.EventsStored, st.Ingest.EventsDeduped, map[bool]string{true: "done", false: "running"}[st.Ingest.BackfillDone])
			}
			fmt.Fprintf(out, "ui:      %s\n", map[bool]string{true: "embedded", false: "placeholder (built without dashboard)"}[st.UIBuilt])
			// Which hive is in force was reported nowhere — not here, not in
			// /v1/status, not in the startup line — so there was no way to ask
			// a running daemon what it was orchestrating.
			if st.Orchestration {
				fmt.Fprintf(out, "hive:    %s (repo: %s)\n", st.Hive, st.Repo)
			} else {
				fmt.Fprintln(out, "hive:    off — `caprock up --hive <dir>` to run tasks unattended")
			}
			return nil
		},
	}
	c.Flags().BoolVar(&asJSON, "json", false, "print raw JSON")
	return c
}

// --- hooks ---

func hooksCmd() *cobra.Command {
	c := &cobra.Command{Use: "hooks", Short: "Manage the shim entry in ~/.claude/settings.json"}
	c.AddCommand(
		&cobra.Command{
			Use: "install", Short: "Register the shim for all Caprock events (non-destructive, backs up first)",
			RunE: func(cmd *cobra.Command, _ []string) error {
				dir, err := config.EnsureDataDir()
				if err != nil {
					return err
				}
				if err := ensureShim(dir); err != nil {
					return err
				}
				return maybeInstallHooks(cmd, dir, true)
			},
		},
		&cobra.Command{
			Use: "uninstall", Short: "Remove Caprock's entries; other hooks are untouched",
			RunE: func(cmd *cobra.Command, _ []string) error {
				dir, err := config.DataDir()
				if err != nil {
					return err
				}
				sp, err := hooks.DefaultSettingsPath()
				if err != nil {
					return err
				}
				removed, err := hooks.Uninstall(sp, shimCommand(dir))
				if err != nil {
					return err
				}
				if removed {
					fmt.Fprintln(cmd.OutOrStdout(), "hooks removed from", sp)
				} else {
					fmt.Fprintln(cmd.OutOrStdout(), "nothing to remove")
				}
				return nil
			},
		},
		&cobra.Command{
			Use: "status", Short: "Show which events carry the shim",
			RunE: func(cmd *cobra.Command, _ []string) error {
				dir, err := config.DataDir()
				if err != nil {
					return err
				}
				sp, err := hooks.DefaultSettingsPath()
				if err != nil {
					return err
				}
				st, err := hooks.Inspect(sp, shimCommand(dir))
				if err != nil {
					return err
				}
				fmt.Fprintf(cmd.OutOrStdout(), "settings: %s\nshim:     %s (exists: %v)\ninstalled: %v\nmissing:   %v\n", st.SettingsPath, st.ShimPath, st.ShimExists, st.Installed, st.Missing)
				return nil
			},
		},
	)
	return c
}

// hookCmd is the hidden fallback shim: `caprock hook` behaves exactly like caprock-hook.
func hookCmd() *cobra.Command {
	return &cobra.Command{
		Use:    "hook",
		Hidden: true,
		Short:  "Internal: hook shim (reads a Claude Code hook payload on stdin)",
		Run: func(cmd *cobra.Command, _ []string) {
			shim.Run(cmd.InOrStdin(), cmd.OutOrStdout())
		},
	}
}

// statuslineCmd is Claude Code's `statusLine.command`: it reads the status JSON on
// stdin, prints a one-line status, and best-effort forwards rate-limit windows to
// the daemon. Register in settings.json as `statusLine: {command: "caprock statusline"}`.
func statuslineCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "statusline",
		Short: "Status line for Claude Code (reads its status JSON on stdin, prints one line)",
		Run: func(cmd *cobra.Command, _ []string) {
			statusline.Run(cmd.InOrStdin(), cmd.OutOrStdout())
		},
	}
	c.AddCommand(
		&cobra.Command{
			Use:   "install",
			Short: "Register `caprock statusline` as Claude Code's statusLine (enables plan limits)",
			RunE: func(cmd *cobra.Command, _ []string) error {
				sp, err := hooks.DefaultSettingsPath()
				if err != nil {
					return err
				}
				if ours, _, _ := hooks.StatuslineInstalled(sp, statuslineCommandStr()); ours {
					fmt.Fprintln(cmd.OutOrStdout(), "statusline already installed")
					return nil
				}
				return maybeInstallStatusline(cmd, true)
			},
		},
		&cobra.Command{
			Use:   "uninstall",
			Short: "Remove Caprock's statusLine entry (leaves your own untouched)",
			RunE: func(cmd *cobra.Command, _ []string) error {
				sp, err := hooks.DefaultSettingsPath()
				if err != nil {
					return err
				}
				removed, err := hooks.UninstallStatusline(sp, statuslineCommandStr())
				if err != nil {
					return err
				}
				if removed {
					fmt.Fprintln(cmd.OutOrStdout(), "statusline removed from "+sp)
				} else {
					fmt.Fprintln(cmd.OutOrStdout(), "nothing to remove")
				}
				return nil
			},
		},
	)
	return c
}

// taskRow is the subset of GET /v1/tasks the CLI prints.
type taskRow struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Status    string  `json:"status"`
	Assignee  string  `json:"assignee"`
	CostUSD   float64 `json:"cost_usd"`
	BudgetUSD float64 `json:"budget_usd"`
}

const hiveOffMessage = "orchestration is off — start the daemon with `caprock up --hive <dir>` to run tasks unattended"

func tasksCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "tasks",
		Short: "List the task board (requires a daemon started with --hive)",
		// `caprock tasks whatever` used to ignore its arguments and print the
		// list — a fake success for a command that does not exist. Cobra's
		// NoArgs turns that into an error naming the real command.
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			rt, err := runningDaemon()
			if err != nil {
				return err
			}
			resp, err := (&http.Client{Timeout: 3 * time.Second}).Get(fmt.Sprintf("http://127.0.0.1:%d/v1/tasks", rt.Port))
			if err != nil {
				return err
			}
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusNotImplemented {
				fmt.Fprintln(cmd.OutOrStdout(), hiveOffMessage)
				return nil
			}
			var tasks []taskRow
			body, _ := io.ReadAll(resp.Body)
			_ = json.Unmarshal(body, &tasks)
			if len(tasks) == 0 {
				fmt.Fprintln(cmd.OutOrStdout(), "no tasks")
				return nil
			}
			out := cmd.OutOrStdout()
			// Ids are generated as `t-<unix-millis>-<n>` — 17 characters, against
			// a hard-coded %-14s width that misaligned every single row. Measure
			// the column instead of guessing it.
			w := 2
			for _, t := range tasks {
				if len(t.ID) > w {
					w = len(t.ID)
				}
			}
			for _, t := range tasks {
				assignee := t.Assignee
				if assignee == "" {
					assignee = "-"
				}
				fmt.Fprintf(out, "%-*s %-12s %-10s $%.2f  %s\n", w, t.ID, t.Status, assignee, t.CostUSD, t.Title)
			}
			return nil
		},
	}
}

// taskCmd groups the single-task verbs. `caprock tasks` lists the board; this is
// where you act on one. `caprock task create` existed only as a form in the
// dashboard, so a queue meant for unattended runs could not be filled from a
// script or a terminal.
func taskCmd() *cobra.Command {
	c := &cobra.Command{Use: "task", Short: "Work with a single task on the board"}
	c.AddCommand(taskCreateCmd())
	return c
}

func taskCreateCmd() *cobra.Command {
	var (
		title    string
		budget   float64
		criteria []string
		body     string
	)
	c := &cobra.Command{
		Use:   "create",
		Short: "Add a task to the board (requires a daemon started with --hive)",
		Long: "Add a task to the board.\n\n" +
			"--done-criteria are shell commands. Caprock — not the agent — runs them in\n" +
			"the worker's git worktree when the worker says it is finished, and the task\n" +
			"only reaches `done` when every one of them exits 0. Repeat the flag, or pass\n" +
			"a comma-free list, for more than one command.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if strings.TrimSpace(title) == "" {
				return errors.New("--title is required")
			}
			if len(criteria) == 0 {
				// A task with no criteria cannot be verified, and the whole
				// point of the runner is that nothing is done until its checks
				// pass. Refusing here is cheaper than a task parked in
				// needs_you an hour later.
				return errors.New("--done-criteria is required: without a command to run, Caprock cannot verify the task")
			}
			rt, err := runningDaemon()
			if err != nil {
				return err
			}
			payload, err := json.Marshal(map[string]any{
				"title": strings.TrimSpace(title), "budget_usd": budget, "done_criteria": criteria, "body": body,
			})
			if err != nil {
				return err
			}
			resp, err := (&http.Client{Timeout: 5 * time.Second}).Post(
				fmt.Sprintf("http://127.0.0.1:%d/v1/tasks", rt.Port), "application/json", bytes.NewReader(payload))
			if err != nil {
				return err
			}
			defer resp.Body.Close()
			raw, _ := io.ReadAll(resp.Body)
			if resp.StatusCode == http.StatusNotImplemented {
				return errors.New(hiveOffMessage)
			}
			if resp.StatusCode != http.StatusOK {
				var e struct {
					Error string `json:"error"`
				}
				if json.Unmarshal(raw, &e) == nil && e.Error != "" {
					return errors.New(e.Error)
				}
				return fmt.Errorf("create task: %s", resp.Status)
			}
			var detail struct {
				Task taskRow `json:"task"`
			}
			_ = json.Unmarshal(raw, &detail)
			fmt.Fprintf(cmd.OutOrStdout(), "created %s  %s\n", detail.Task.ID, detail.Task.Title)
			fmt.Fprintln(cmd.OutOrStdout(), "It sits in the inbox until you start the orchestrator from the Tasks screen.")
			return nil
		},
	}
	c.Flags().StringVar(&title, "title", "", "what the task is (required)")
	c.Flags().Float64Var(&budget, "budget", 0, "spend ceiling in USD; the task is parked for your approval above it")
	c.Flags().StringArrayVar(&criteria, "done-criteria", nil, "shell command that must exit 0 before the task is done (repeatable, required)")
	c.Flags().StringVar(&body, "body", "", "the brief the worker reads")
	return c
}

// printHive names the queue directory on the startup line. Starting with --hive
// used to print exactly the same line as starting without it, so the one thing a
// user needed to confirm — that unattended running is on, and against which
// directory — was invisible at the only moment they were looking.
func printHive(cmd *cobra.Command, hiveDir string) {
	if hiveDir == "" {
		return
	}
	abs, err := filepath.Abs(hiveDir)
	if err != nil {
		abs = hiveDir
	}
	fmt.Fprintf(cmd.OutOrStdout(), "task runner is on   (hive: %s)\n", abs)
}

// runningDaemon resolves the live daemon's runtime, or explains that there is none.
func runningDaemon() (config.Runtime, error) {
	dir, err := config.DataDir()
	if err != nil {
		return config.Runtime{}, err
	}
	rt, err := config.ReadRuntime(dir)
	if err != nil || !daemonAlive(rt) {
		return config.Runtime{}, errors.New("caprock is not running")
	}
	return rt, nil
}

func versionCmd() *cobra.Command {
	return &cobra.Command{
		Use: "version", Short: "Print the version",
		Run: func(cmd *cobra.Command, _ []string) {
			fmt.Fprintf(cmd.OutOrStdout(), "caprock %s (%s/%s)\n", version.Version, runtime.GOOS, runtime.GOARCH)
		},
	}
}

// --- helpers ---

func daemonAlive(rt config.Runtime) bool {
	resp, err := (&http.Client{Timeout: 700 * time.Millisecond}).Get(fmt.Sprintf("http://127.0.0.1:%d/healthz", rt.Port))
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func openBrowser(url string) {
	var c *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		c = exec.Command("open", url)
	case "windows":
		c = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		c = exec.Command("xdg-open", url)
	}
	_ = c.Start()
}
