// caprock is the mission-control CLI and daemon: `caprock up` starts the local
// daemon (hook receiver + transcript ingest + API + dashboard), `caprock down`
// stops it, `caprock status` reports, `caprock hooks install|uninstall|status`
// manage the shim in ~/.claude/settings.json.
package main

import (
	"bufio"
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
	root.AddCommand(upCmd(), downCmd(), statusCmd(), tasksCmd(), hooksCmd(), hookCmd(), statuslineCmd(), versionCmd())
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
	c.Flags().StringVar(&hiveDir, "hive", "", "enable Phase 2 orchestration with a hive directory (tasks board + Stop-loop)")
	c.Flags().StringVar(&repoDir, "repo", "", "the repo the orchestrator + workers operate on (default: current directory)")
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
			if !noOpen && cfg.OpenBrowser {
				openBrowser(url)
			}
			return nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	return fmt.Errorf("daemon did not report ready within 10s; see %s", config.LogPath(dir))
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
	return &cobra.Command{
		Use:   "statusline",
		Short: "Status line for Claude Code (reads its status JSON on stdin, prints one line)",
		Run: func(cmd *cobra.Command, _ []string) {
			statusline.Run(cmd.InOrStdin(), cmd.OutOrStdout())
		},
	}
}

func tasksCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "tasks",
		Short: "List the Phase 2 task board (requires a daemon started with --hive)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			dir, err := config.DataDir()
			if err != nil {
				return err
			}
			rt, err := config.ReadRuntime(dir)
			if err != nil || !daemonAlive(rt) {
				return fmt.Errorf("caprock is not running")
			}
			resp, err := (&http.Client{Timeout: 3 * time.Second}).Get(fmt.Sprintf("http://127.0.0.1:%d/v1/tasks", rt.Port))
			if err != nil {
				return err
			}
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusNotImplemented {
				fmt.Fprintln(cmd.OutOrStdout(), "orchestration is off (start the daemon with --hive)")
				return nil
			}
			var tasks []struct {
				ID, Title, Status, Assignee string
				CostUSD                     float64 `json:"cost_usd"`
				BudgetUSD                   float64 `json:"budget_usd"`
			}
			body, _ := io.ReadAll(resp.Body)
			_ = json.Unmarshal(body, &tasks)
			if len(tasks) == 0 {
				fmt.Fprintln(cmd.OutOrStdout(), "no tasks")
				return nil
			}
			out := cmd.OutOrStdout()
			for _, t := range tasks {
				assignee := t.Assignee
				if assignee == "" {
					assignee = "-"
				}
				fmt.Fprintf(out, "%-14s %-12s %-10s $%.2f  %s\n", t.ID, t.Status, assignee, t.CostUSD, t.Title)
			}
			return nil
		},
	}
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
