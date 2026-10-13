package ptyhost

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestClassify(t *testing.T) {
	now := time.Now()
	old := now.Add(-time.Hour).UnixMilli()
	root := t.TempDir()

	own := filepath.Join(root, "own", "ptyhost")
	other := filepath.Join(root, "other", "ptyhost") // a second Caprock, still running
	gone := filepath.Join(root, "deleted", "ptyhost")
	for _, d := range []string{own, other} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	reg := func(dir, id string, hostPID int) {
		if err := writeJSONAtomic(recordPath(dir, id), Record{Proto: 1, SessionID: id, HostPID: hostPID}); err != nil {
			t.Fatal(err)
		}
	}
	reg(own, "s-own", 100)
	reg(other, "s-other", 200)

	shell := []ChildProc{{PID: 1, Name: "zsh"}}
	agent := []ChildProc{{PID: 1, Name: "claude"}}
	busyShell := []ChildProc{{PID: 1, Name: "/bin/zsh", Busy: true}}
	envOf := func(dir string) []string { return []string{"HOME=/x", RegistryEnv + "=" + dir} }

	hosts := []HostProc{
		{PID: 100, StartMs: old, Env: envOf(own), Children: agent},                                         // ours
		{PID: 101, StartMs: now.UnixMilli(), Env: envOf(gone), Children: shell},                            // too new
		{PID: 102, StartMs: old, Env: envOf(own)},                                                          // child gone
		{PID: 103, StartMs: old, Env: envOf(gone), Children: shell},                                        // data dir deleted, idle shell
		{PID: 104, StartMs: old, Env: envOf(gone), Children: agent},                                        // data dir deleted, agent running
		{PID: 105, StartMs: old, Env: envOf(gone), Children: busyShell},                                    // deleted, shell running something
		{PID: 200, StartMs: old, Env: envOf(other), Children: shell},                                       // another live install
		{PID: 201, StartMs: old, Env: envOf(other), Children: shell},                                       // that install's dir, not listed
		{PID: 202, StartMs: old, Env: []string{"HOME=/x"}, Children: shell},                                // cannot tell
		{PID: 203, StartMs: old, Env: []string{"CAPROCK_DATA_DIR=" + filepath.Dir(gone)}, Children: shell}, // older holder, data dir env
		{PID: 204, StartMs: old, Env: envOf(own), Children: shell},                                         // our dir, not listed
	}
	want := map[int32]struct {
		state string
		reap  bool
	}{
		100: {"registered", false},
		101: {"young", false},
		102: {"dead", true},
		103: {"unreachable-idle", true},
		104: {"unreachable-busy", false},
		105: {"unreachable-busy", false},
		200: {"foreign", false},
		201: {"unreachable-idle", true},
		202: {"foreign", false},
		203: {"unreachable-idle", true},
		204: {"unreachable-idle", true},
	}
	got := Classify(hosts, own, now)
	ours := map[int32]bool{100: true, 102: true, 204: true}
	for _, v := range got {
		if v.Ours != ours[v.PID] {
			t.Errorf("host %d: ours=%v", v.PID, v.Ours)
		}
	}
	// Abandoned: the registry directory itself is gone, so no daemon can
	// ever attach. A live install's directory (201) is not abandoned.
	abandoned := map[int32]bool{103: true, 104: true, 105: true, 203: true}
	for _, v := range got {
		if v.Abandoned != abandoned[v.PID] {
			t.Errorf("host %d: abandoned=%v", v.PID, v.Abandoned)
		}
	}
	if len(got) != len(hosts) {
		t.Fatalf("got %d verdicts for %d hosts", len(got), len(hosts))
	}
	for _, v := range got {
		w := want[v.PID]
		if v.State != w.state || v.Reap != w.reap {
			t.Errorf("host %d: %s reap=%v, want %s reap=%v", v.PID, v.State, v.Reap, w.state, w.reap)
		}
	}
}

func TestIsShell(t *testing.T) {
	for name, want := range map[string]bool{
		"zsh": true, "-zsh": true, "/bin/bash": true, "pwsh.exe": true, "CMD.EXE": true,
		"claude": false, "node": false, "codex": false, "": false,
	} {
		if got := isShell(name); got != want {
			t.Errorf("isShell(%q) = %v, want %v", name, got, want)
		}
	}
}
