package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/daemon"
)

// exitCodeError ends the process with a code and no "error:" line: the
// output already said what there is to say.
type exitCodeError struct{ code int }

func (e exitCodeError) Error() string { return fmt.Sprintf("exit status %d", e.code) }

// --- doctor ---

func doctorCmd() *cobra.Command {
	var (
		asJSON   bool
		dataDirF string
		stop     []int
		yes      bool
		force    bool
	)
	c := &cobra.Command{
		Use:   "doctor",
		Short: "What Caprock costs this machine, and duplicate or orphaned Caprock processes",
		Long: "Prints the memory, CPU and disk Caprock uses on this machine — the daemon, the desktop app and its window, the terminal holders, " +
			"the data directory, the daemon's own disk reads and writes — and flags another daemon, a second app, orphaned terminals and an " +
			"oversized database. Exits 1 when something is flagged. Works with no daemon running, from the process table and the data directory.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if dataDirF != "" {
				_ = os.Setenv(config.EnvDataDir, dataDirF)
			}
			dir, err := config.DataDir()
			if err != nil {
				return err
			}
			f := doctorReport(cmd, dir)
			out := cmd.OutOrStdout()
			if len(stop) > 0 {
				return doctorStop(cmd, dir, f, stop, yes, force)
			}
			if force {
				return errors.New("--force goes with --stop <pid>")
			}
			if asJSON {
				enc := json.NewEncoder(out)
				enc.SetIndent("", "  ")
				if err := enc.Encode(f); err != nil {
					return err
				}
			} else {
				printDoctor(out, f)
			}
			if f.Warns() {
				return exitCodeError{code: 1}
			}
			return nil
		},
	}
	c.Flags().BoolVar(&asJSON, "json", false, "print the footprint as JSON (the shape of GET /v1/footprint)")
	c.Flags().StringVar(&dataDirF, "data-dir", "", "the data directory to check (also $CAPROCK_DATA_DIR)")
	c.Flags().IntSliceVar(&stop, "stop", nil, "stop a process from the Orphans list by pid (repeatable); asks first")
	c.Flags().BoolVar(&yes, "yes", false, "with --stop: do not ask")
	c.Flags().BoolVar(&force, "force", false, "with --stop: send SIGKILL (Windows: TerminateProcess) — for a process a stop reported still running after SIGTERM")
	return c
}

// doctorReport asks the running daemon, and reads what it can itself when
// none answers — or when the one that answers predates /v1/footprint.
func doctorReport(cmd *cobra.Command, dir string) *daemon.FootprintReport {
	rt, err := config.ReadRuntime(dir)
	if err == nil && daemonAlive(rt) {
		var f daemon.FootprintReport
		if err := getJSON(rt.Port, "/v1/footprint?orphans=1&fresh=1", &f); err == nil {
			if f.Orphans == nil {
				// A daemon from before the orphan scan: take it here.
				f.SetOrphans(daemon.OfflineOrphans(cmd.Context(), dir, int32(rt.PID)))
			}
			return &f
		}
		return daemon.OfflineFootprint(cmd.Context(), dir, int32(rt.PID))
	}
	return daemon.OfflineFootprint(cmd.Context(), dir, 0)
}

// doctorStop is `caprock doctor --stop <pid>`: each pid must be on the
// Orphans list just taken, it is shown, and it is stopped only after a yes
// (ADR-059). The daemon stops it when one answers; otherwise the doctor
// does, against a scan of its own. Either way the pid's start time is
// checked again before the signal. It gets SIGTERM; one still running five
// seconds later is reported, and only `--force` (a second, deliberate
// command) sends SIGKILL.
func doctorStop(cmd *cobra.Command, dir string, f *daemon.FootprintReport, pids []int, yes, force bool) error {
	out := cmd.OutOrStdout()
	byPID := map[int32]daemon.Orphan{}
	if f.Orphans != nil {
		for _, o := range f.Orphans.List {
			byPID[o.PID] = o
		}
	}
	var targets []daemon.OrphanTarget
	for _, p := range pids {
		o, ok := byPID[int32(p)]
		if !ok {
			return fmt.Errorf("pid %d is not on the doctor's Orphans list; Caprock stops only what it lists (run `caprock doctor` to see the list)", p)
		}
		printOrphan(out, f.At, o, "")
		targets = append(targets, daemon.OrphanTarget{PID: o.PID, StartedAt: o.StartedAt})
	}
	if !yes {
		it := map[bool]string{true: "it", false: "them"}[len(targets) == 1]
		how := "It gets SIGTERM; if it is still running 5 seconds later, the doctor says so and sends nothing more."
		if force {
			how = "It gets SIGKILL: it cannot save anything first."
		}
		fmt.Fprintf(out, "Stop %s? %s [y/N] ", it, how)
		line, _ := bufio.NewReader(cmd.InOrStdin()).ReadString('\n')
		if a := strings.ToLower(strings.TrimSpace(line)); a != "y" && a != "yes" {
			fmt.Fprintln(out, "Nothing stopped.")
			return nil
		}
	}
	var res daemon.OrphanStopResult
	rt, err := config.ReadRuntime(dir)
	if err == nil && daemonAlive(rt) && f.DiskIO != nil {
		err := postJSON(rt.Port, "/v1/footprint/orphans/stop", map[string]any{"targets": targets, "force": force}, &res)
		var se statusError
		switch {
		case errors.As(err, &se) && (se.code == http.StatusNotFound || se.code == http.StatusMethodNotAllowed):
			// A daemon from before the stop: the doctor stops it itself.
			res = daemon.StopOrphansOffline(cmd.Context(), dir, targets, int32(rt.PID), force)
		case err != nil:
			return err
		}
	} else {
		running := int32(0)
		if err == nil {
			running = int32(rt.PID)
		}
		res = daemon.StopOrphansOffline(cmd.Context(), dir, targets, running, force)
	}
	return printStopResult(out, res, force)
}

// printStopResult says what a stop did, one line per process, and how to
// finish one that outlived SIGTERM. Exit 1 when any is still there.
func printStopResult(out io.Writer, res daemon.OrphanStopResult, force bool) error {
	for _, o := range res.Stopped {
		fmt.Fprintf(out, "stopped pid %d (%s)\n", o.PID, o.Label)
	}
	for _, o := range res.Running {
		if force {
			fmt.Fprintf(out, "pid %d (%s) is still running after SIGKILL\n", o.PID, o.Label)
			continue
		}
		fmt.Fprintf(out, "pid %d (%s) is still running after SIGTERM; nothing more was sent. To kill it: caprock doctor --stop %d --force\n", o.PID, o.Label, o.PID)
	}
	for _, x := range res.Failed {
		fmt.Fprintf(out, "pid %d not stopped: %s\n", x.PID, x.Error)
	}
	if len(res.Failed) > 0 || len(res.Running) > 0 {
		return exitCodeError{code: 1}
	}
	return nil
}

// postJSON posts body to the daemon and decodes its answer into v.
func postJSON(port int, path string, body, v any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	resp, err := (&http.Client{Timeout: time.Minute}).Post(fmt.Sprintf("http://127.0.0.1:%d%s", port, path), "application/json", bytes.NewReader(raw))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	got, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return statusError{code: resp.StatusCode, msg: fmt.Sprintf("POST %s: %s", path, strings.TrimSpace(string(got)))}
	}
	return json.Unmarshal(got, v)
}

// statusError is a daemon's answer other than 200.
type statusError struct {
	code int
	msg  string
}

func (e statusError) Error() string { return e.msg }

func printDoctor(w io.Writer, f *daemon.FootprintReport) {
	mem := daemon.Bytes
	cpu := func(p float64) string { return fmt.Sprintf("%.1f%%", p) }
	fmt.Fprintf(w, "data directory  %s\n", f.DataDir)
	m := f.Memory
	switch {
	case f.DaemonRunning && m.Daemon != nil:
		fmt.Fprintf(w, "daemon          running, pid %d\n", m.Daemon.PID)
	case f.DaemonRunning:
		fmt.Fprintln(w, "daemon          running")
	default:
		fmt.Fprintln(w, "daemon          not running (figures read from the process table and the disk)")
	}

	fmt.Fprintln(w, "\nMemory and CPU")
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	if m.Daemon != nil {
		fmt.Fprintf(tw, "  daemon\t%s\t%s\t\n", mem(m.Daemon.MemBytes), cpu(m.Daemon.CPUPct))
	}
	if m.App != nil {
		fmt.Fprintf(tw, "  desktop app\t%s\t%s\t\n", mem(m.App.MemBytes), cpu(m.App.CPUPct))
	}
	if m.Webview != nil {
		fmt.Fprintf(tw, "  app window\t%s\t%s\t%d web view processes\n", mem(m.Webview.MemBytes), cpu(m.Webview.CPUPct), m.Webview.Count)
	}
	h := m.Hosts
	fmt.Fprintf(tw, "  terminal holders\t%s\t%s\t%d, %d orphaned, %d reapable\n", mem(h.MemBytes), cpu(h.CPUPct), h.Count, h.Orphans, h.Reapable)
	if n := len(f.Duplicates.Daemons); n > 0 {
		fmt.Fprintf(tw, "  other daemons\t%s\t\t%d\n", mem(m.OtherDaemonsMemBytes), n)
	}
	fmt.Fprintf(tw, "  total\t%s\t%s\t\n", mem(m.TotalMemBytes), cpu(m.TotalCPUPct))
	_ = tw.Flush()
	if !f.DaemonRunning {
		fmt.Fprintln(w, "  (CPU needs two samples; with no daemon it is not measured)")
	}

	d := f.Disk
	fmt.Fprintf(w, "\nDisk (%s in the data directory)\n", mem(uint64(d.TotalBytes)))
	tw = tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	fmt.Fprintf(tw, "  database\t%s\twrite-ahead log %s\n", mem(uint64(d.DatabaseBytes)), mem(uint64(d.WALBytes)))
	fmt.Fprintf(tw, "  pastes\t%s\t\n", mem(uint64(d.PastesBytes)))
	fmt.Fprintf(tw, "  logs\t%s\t\n", mem(uint64(d.LogsBytes)))
	fmt.Fprintf(tw, "  binaries\t%s\t\n", mem(uint64(d.BinariesBytes)))
	fmt.Fprintf(tw, "  other\t%s\t\n", mem(uint64(d.OtherBytes)))
	_ = tw.Flush()

	if dio := f.DiskIO; dio != nil {
		fmt.Fprintln(w, "\nThe daemon's disk I/O")
		tw = tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
		win := func(label string, x *daemon.IOWindow) {
			if x == nil {
				return
			}
			fmt.Fprintf(tw, "  %s\tread %s\twritten %s\tover %s\n", label, mem(x.ReadBytes), mem(x.WriteBytes), span(x.Seconds))
		}
		win("last minute", dio.LastMinute)
		win("last hour", dio.LastHour)
		win("since start", dio.SinceStart)
		_ = tw.Flush()
		if dio.LastMinute == nil {
			fmt.Fprintln(w, "  (read once a minute; the first interval is not over yet)")
		}
		if dio.Error != "" {
			fmt.Fprintf(w, "  not measured: %s\n", dio.Error)
		}
	}

	fmt.Fprintln(w, "\nDuplicates")
	if len(f.Duplicates.Daemons) == 0 {
		fmt.Fprintln(w, "  other daemons: none")
	}
	for _, p := range f.Duplicates.Daemons {
		fmt.Fprintf(w, "  other daemon: pid %d %s %s%s\n", p.PID, p.Exe, mem(p.MemBytes), dataDirNote(p.DataDir))
	}
	fmt.Fprintf(w, "  desktop apps: %d\n", len(f.Duplicates.Apps))
	o := f.Duplicates.OtherInstallHolders
	fmt.Fprintf(w, "  terminal holders from another install: %d", o.Count)
	if o.Count > 0 {
		fmt.Fprintf(w, " (%d orphaned)", o.Orphans)
	}
	fmt.Fprintln(w)
	for _, e := range o.Exes {
		fmt.Fprintf(w, "    %d  %s\n", e.Count, e.Exe)
	}

	printOrphans(w, f)

	if f.DiskIO != nil { // the daemon's own report, not one read from outside
		fmt.Fprintln(w, "\nDone on its own (since the daemon started)")
		if len(f.Actions) == 0 {
			fmt.Fprintln(w, "  nothing needed doing")
		}
		for _, a := range f.Actions {
			fmt.Fprintf(w, "  %s  %s\n", time.UnixMilli(a.At).Format("Jan 2 15:04"), a.What)
		}
	}

	fmt.Fprintln(w, "\nVerdict")
	for _, v := range f.Verdicts {
		fmt.Fprintf(w, "  %-4s  %s\n", strings.ToUpper(v.Level), v.Text)
	}
	if f.Error != "" {
		fmt.Fprintf(w, "\nnote: %s\n", f.Error)
	}
}

// printOrphans is the Orphans section: each process that looks abandoned,
// with why, its age at the report's time, its memory and its executable.
func printOrphans(w io.Writer, f *daemon.FootprintReport) {
	o := f.Orphans
	if o == nil {
		return
	}
	if o.Count > 0 {
		fmt.Fprintf(w, "\nOrphans: %d · %s (processes that look abandoned)\n", o.Count, daemon.Bytes(o.MemBytes))
	} else {
		fmt.Fprintln(w, "\nOrphans (processes that look abandoned)")
	}
	switch {
	case !o.Scanned && o.Count > 0:
		fmt.Fprintf(w, "  %d found at the last check; `caprock doctor` lists them\n", o.Count)
	case o.Count == 0:
		fmt.Fprintln(w, "  none")
	}
	for _, p := range o.List {
		printOrphan(w, f.At, p, "  ")
	}
	if len(o.List) > 0 {
		fmt.Fprintln(w, "  (stop one: caprock doctor --stop <pid>)")
	}
	if o.Note != "" {
		fmt.Fprintf(w, "  note: %s\n", o.Note)
	}
}

// printOrphan is one orphan in up to four lines: what, why, the command
// line, where.
func printOrphan(w io.Writer, at int64, p daemon.Orphan, indent string) {
	tail := ""
	if p.CPUPct != nil {
		tail += fmt.Sprintf(" · %.1f%% CPU", *p.CPUPct)
	}
	if p.Auto {
		tail += " · stopped on its own"
	}
	fmt.Fprintf(w, "%spid %d  %s · %s old · %s%s\n", indent, p.PID, p.Label, daemon.Age(time.Duration(at-p.StartedAt)*time.Millisecond), daemon.Bytes(p.MemBytes), tail)
	fmt.Fprintf(w, "%s  %s\n", indent, p.Why)
	if p.Cmd != "" {
		fmt.Fprintf(w, "%s  $ %s\n", indent, p.Cmd)
	}
	where := p.Exe
	if p.DataDir != "" {
		if where != "" {
			where += " · "
		}
		where += "data " + p.DataDir
		if p.DataDirGone {
			where += " (gone)"
		}
	}
	if where != "" {
		fmt.Fprintf(w, "%s  %s\n", indent, where)
	}
}

func dataDirNote(dir string) string {
	if dir == "" {
		return ""
	}
	return ", data " + dir
}

func span(sec int64) string {
	switch {
	case sec >= 3600:
		return fmt.Sprintf("%dh%02dm", sec/3600, sec%3600/60)
	case sec >= 60:
		return fmt.Sprintf("%dm", (sec+30)/60)
	}
	return fmt.Sprintf("%ds", sec)
}
