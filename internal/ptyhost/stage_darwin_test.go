package ptyhost

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

// The daemon on macOS: the helper beside it is staged under the data
// directory, and holders start from the copy.
func TestStageHelperStartsHoldersFromACopy(t *testing.T) {
	bin, data := t.TempDir(), t.TempDir()
	fakeBundle(t, bin, "v1")
	exe := HelperExe(bin)
	if !IsHelper(exe) {
		t.Fatal("the test bundle is not laid out as the helper")
	}
	got := StageHelper(exe, data)
	if got == exe || !IsHelper(got) {
		t.Fatalf("StageHelper = %q, want a staged helper", got)
	}
	if b, _ := os.ReadFile(got); string(b) != "holder v1" {
		t.Fatalf("staged helper says %q", b)
	}
	m := &Manager{Exe: got, DataDir: data}
	if !m.staged() {
		t.Fatal("a manager on the staged copy does not know it")
	}
	if dirs := StagedHelperDirs(data); !slices.Contains(dirs, filepath.Dir(got)) {
		t.Fatalf("StagedHelperDirs = %v, missing %q", dirs, filepath.Dir(got))
	}
	// The installed bundle is replaced the way the app does it (renamed
	// aside and deleted): the staged copy is a separate tree and stays.
	if err := os.RemoveAll(filepath.Join(bin, HelperBundle)); err != nil {
		t.Fatal(err)
	}
	if !executable(got) {
		t.Fatal("deleting the installed bundle took the staged copy with it")
	}
}

// A copy a running holder was started from is kept until that holder is
// gone, whichever daemon started it; the process table says which.
func TestPruneHelpersKeepsACopyARunningHolderUses(t *testing.T) {
	bin := t.TempDir()
	old := filepath.Join(bin, stagedPrefix+"0000000000000001")
	fakeBundle(t, old, "v1")
	// A stand-in holder: this test binary under the holder's name, waiting
	// on its stdin as the test child (TestMain). A copied system binary
	// will not do: macOS kills a platform binary run from another path.
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(self) //nolint:gosec // this test binary
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(HelperExe(old), b, 0o755); err != nil { //nolint:gosec // a test executable
		t.Fatal(err)
	}
	cmd := exec.Command(HelperExe(old))
	cmd.Env = append(os.Environ(), envChild+"=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = stdin.Close() })
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })

	deadline := time.Now().Add(5 * time.Second)
	for {
		exes, err := runningHolderExes()
		if err != nil {
			t.Fatal(err)
		}
		if runsFrom(exes, old) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the running stand-in is not among the holders: %v", exes)
		}
		time.Sleep(20 * time.Millisecond)
	}
	pruneHelpers(bin, stagedPrefix+"0000000000000002")
	if _, err := os.Stat(old); err != nil {
		t.Fatal("the copy a running holder uses was deleted")
	}

	_ = cmd.Process.Kill()
	_, _ = cmd.Process.Wait()
	pruneHelpers(bin, stagedPrefix+"0000000000000002")
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("the copy no holder uses any more was kept")
	}
}

// A session's end prunes, a moment later, the copies nothing runs from.
func TestHolderExitedPrunesOlderCopies(t *testing.T) {
	defer func(d time.Duration) { pruneDelay = d }(pruneDelay)
	pruneDelay = 10 * time.Millisecond

	data := t.TempDir()
	bin := stagedDir(data)
	old := filepath.Join(bin, stagedPrefix+"0000000000000001")
	cur := filepath.Join(bin, stagedPrefix+"0000000000000002")
	fakeBundle(t, old, "v1")
	fakeBundle(t, cur, "v2")
	m := &Manager{Exe: HelperExe(cur), DataDir: data}
	m.HolderExited()
	m.HolderExited()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(old); os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the idle older copy was not pruned after a holder exited")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !executable(HelperExe(cur)) {
		t.Fatal("the copy holders start from was pruned")
	}
}
