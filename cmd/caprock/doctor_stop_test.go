package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/dspv/caprock/internal/daemon"
)

// `caprock doctor --stop` refuses a pid the list does not hold and stops
// nothing on a no. Neither path signals anything, so these run against
// made-up pids.
func TestDoctorStopAsksAndRefuses(t *testing.T) {
	f := &daemon.FootprintReport{At: 10_000_000, Orphans: &daemon.OrphanReport{Scanned: true, Count: 1, List: []daemon.Orphan{
		{PID: 999_991, StartedAt: 1_000, Kind: daemon.OrphanClaude, Label: "claude", Why: "A claude whose parent has exited.", Exe: "/x/claude"},
	}}}
	run := func(in string, pids ...int) (string, error) {
		var out bytes.Buffer
		cmd := &cobra.Command{}
		cmd.SetOut(&out)
		cmd.SetIn(strings.NewReader(in))
		err := doctorStop(cmd, t.TempDir(), f, pids, false, false)
		return out.String(), err
	}

	if _, err := run("y\n", 4242); err == nil || !strings.Contains(err.Error(), "not on the doctor's Orphans list") {
		t.Errorf("an unlisted pid: %v", err)
	}
	out, err := run("n\n", 999_991)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"pid 999991  claude · 2h old", "A claude whose parent has exited.", "[y/N]", "Nothing stopped."} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	if out, _ := run("", 999_991); !strings.Contains(out, "Nothing stopped.") {
		t.Errorf("no answer is a no:\n%s", out)
	}
	if out, _ := run("n\n", 999_991); !strings.Contains(out, "sends nothing more") {
		t.Errorf("the question says SIGKILL is not sent on its own:\n%s", out)
	}
}

// A process that outlives SIGTERM is reported with the command that kills
// it, and nothing more is sent; the stop exits 1 until it is gone.
func TestDoctorStopReportsWhatOutlivedSIGTERM(t *testing.T) {
	res := daemon.OrphanStopResult{
		Stopped: []daemon.Orphan{{PID: 11, Label: "claude"}},
		Running: []daemon.Orphan{{PID: 12, Label: "node index.js"}},
	}
	var out bytes.Buffer
	if err := printStopResult(&out, res, false); err == nil {
		t.Error("a process still running is not a clean stop")
	}
	for _, want := range []string{"stopped pid 11 (claude)", "pid 12 (node index.js) is still running after SIGTERM; nothing more was sent", "caprock doctor --stop 12 --force"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output lacks %q:\n%s", want, out.String())
		}
	}
	out.Reset()
	if err := printStopResult(&out, daemon.OrphanStopResult{Stopped: res.Stopped}, true); err != nil || strings.Contains(out.String(), "--force") {
		t.Errorf("a clean stop: %v\n%s", err, out.String())
	}
}
