package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/daemon"
)

// With no daemon, doctor still reports — the data directory's size and the
// process table — says the daemon is not running, and exits 1.
func TestDoctorWithNoDaemon(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CAPROCK_DATA_DIR", dir)
	for _, asJSON := range []bool{false, true} {
		root := newRoot()
		var out bytes.Buffer
		root.SetOut(&out)
		args := []string{"doctor"}
		if asJSON {
			args = append(args, "--json")
		}
		root.SetArgs(args)
		err := root.Execute()
		var ec exitCodeError
		if !errors.As(err, &ec) || ec.code != 1 {
			t.Fatalf("exit: %v", err)
		}
		if asJSON {
			var f daemon.FootprintReport
			if err := json.Unmarshal(out.Bytes(), &f); err != nil {
				t.Fatalf("not JSON: %v\n%s", err, out.String())
			}
			if f.DaemonRunning || f.DataDir != dir || f.Verdicts[0].Code != "daemon_not_running" {
				t.Errorf("report: %+v", f)
			}
			continue
		}
		s := out.String()
		for _, want := range []string{"daemon          not running", "Memory and CPU", "Disk (", "Duplicates", "WARN  No Caprock daemon answers"} {
			if !strings.Contains(s, want) {
				t.Errorf("missing %q in:\n%s", want, s)
			}
		}
	}
}
