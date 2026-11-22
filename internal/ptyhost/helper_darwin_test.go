package ptyhost

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/disclaim"
	"github.com/dspv/caprock/internal/ptyman"
)

// The Caprock Terminal helper (ADR-101), with the real holder binary: built
// from cmd/caprock-pty-host into a bundle laid out as the app installs it,
// started the way the daemon starts it (this test binary is the daemon's
// disclaim trampoline, TestMain). Every check reads the kernel's
// responsibility record only; nothing here asks macOS for anything, so no
// dialog can appear.
func TestTheTerminalHelper(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the holder binary")
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	defer disclaim.EnableWith(self)()

	bin := t.TempDir()
	plain := filepath.Join(bin, BinaryName())
	buildHolder(t, plain)
	helper := installHelper(t, bin, plain)
	if got := Binary(filepath.Join(bin, "caprock")); got != helper {
		t.Fatalf("the daemon would start holders from %q, want the helper %q", got, helper)
	}

	t.Run("a shell in the helper is the helper's", func(t *testing.T) {
		m := holderManager(t.TempDir(), helper)
		s, host := spawnShell(t, m, "h-helper")
		if got := disclaim.ResponsibleFor(host); got != host {
			t.Errorf("the helper (pid %d) is answered for by %d, want itself", host, got)
		}
		if got := disclaim.ResponsibleFor(s.PID()); got != host {
			t.Errorf("the shell (pid %d) is answered for by %d, want the helper %d", s.PID(), got, host)
		}
	})

	// Without the helper (a Homebrew install, a build without the app) the
	// holder starts plainly and its shell answers for itself, as before.
	t.Run("a shell in the plain holder answers for itself", func(t *testing.T) {
		m := holderManager(t.TempDir(), plain)
		s, host := spawnShell(t, m, "h-plain")
		if got := disclaim.ResponsibleFor(s.PID()); got != s.PID() {
			t.Errorf("the shell (pid %d) is answered for by %d, want itself", s.PID(), got)
		}
		if got := disclaim.ResponsibleFor(host); got == host {
			t.Errorf("the plain holder (pid %d) answers for itself; only the helper is started disclaimed", host)
		}
	})

	// An update must not end a session. A holder from before the helper
	// keeps running and is reattached by the daemon that has one; a helper
	// keeps running while its bundle is replaced beside it, and new
	// terminals start from the new bundle.
	t.Run("an update keeps every running session", func(t *testing.T) {
		data := t.TempDir()
		old := holderManager(data, plain)
		before, _ := spawnShell(t, old, "h-before")
		detach(t, before)

		updated := holderManager(data, helper)
		running, _ := spawnShell(t, updated, "h-running")
		detach(t, running)

		// The next release's helper goes in place the way the app installs
		// it: the old bundle set aside and deleted, the new one renamed in.
		next := installHelper(t, bin, plain)
		if next != helper {
			t.Fatalf("the reinstalled helper is at %q, want %q", next, helper)
		}

		again := holderManager(data, helper)
		att, exits := again.Reattach()
		if len(exits) != 0 || len(att) != 2 {
			t.Fatalf("after the update: %d sessions and %d exits, want 2 and 0", len(att), len(exits))
		}
		for _, a := range att {
			t.Cleanup(func() { _ = a.Session.Close() })
			out := readAll(a.Session.Output())
			if _, err := a.Session.Write([]byte("still-" + a.Record.SessionID + "\r")); err != nil {
				t.Fatal(err)
			}
			out.waitFor(t, "echo:still-"+a.Record.SessionID)
		}
		_, host := spawnShell(t, again, "h-after")
		if got := disclaim.ResponsibleFor(host); got != host {
			t.Errorf("a terminal opened after the update is not the helper's own: %d answers for %d", got, host)
		}
	})
}

// holderManager is a daemon's view of the holders in data, started from exe.
func holderManager(data, exe string) *Manager {
	var env []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, envHolder+"=") && !strings.HasPrefix(kv, envChild+"=") {
			env = append(env, kv)
		}
	}
	return &Manager{Exe: exe, Env: env, DataDir: data, Version: "test"}
}

// spawnShell opens a shell tab in m: a shell that echoes each line it reads,
// so a test can type into it. It returns once the shell has said it runs (a
// disclaimed child is the trampoline until then), with the session and its
// holder's pid.
func spawnShell(t *testing.T, m *Manager, id string) (ptyman.Session, int) {
	t.Helper()
	spec := ptyman.Spec{
		ID: id, Command: "/bin/sh", Dir: t.TempDir(), Cols: 100, Rows: 30,
		Args: []string{"-c", `echo ready; while read -r l; do echo "echo:$l"; done`},
		Env:  []string{"PATH=/usr/bin:/bin", "TERM=xterm-256color"},
		Meta: map[string]string{"kind": "shell"},
	}
	s, err := m.Spawn(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	readAll(s.Output()).waitFor(t, "ready")
	recs, _, err := readRecords(Dir(m.DataDir))
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range recs {
		if r.SessionID == id {
			waitStarted(t, r.HostPID)
			return s, r.HostPID
		}
	}
	t.Fatalf("no registry entry for %s", id)
	return nil, 0
}

// waitStarted waits until pid is the holder itself rather than the
// trampoline that becomes it: the trampoline's responsible process is the
// test's, the helper's is its own.
func waitStarted(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		out, err := exec.Command("/bin/ps", "-o", "comm=", "-p", strconv.Itoa(pid)).Output()
		if err == nil && strings.HasSuffix(strings.TrimSpace(string(out)), BinaryName()) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("pid %d never became the holder", pid)
}

func detach(t *testing.T, s ptyman.Session) {
	t.Helper()
	if err := s.(ptyman.Detacher).Detach(); err != nil {
		t.Fatal(err)
	}
	if err := s.Wait(); !errors.Is(err, ptyman.ErrDetached) {
		t.Fatalf("Wait after Detach = %v", err)
	}
}

func buildHolder(t *testing.T, out string) {
	t.Helper()
	cmd := exec.Command("go", "build", "-o", out, "github.com/dspv/caprock/cmd/caprock-pty-host")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build the holder: %v\n%s", err, b)
	}
}

// installHelper puts a helper bundle around a copy of exe in dir as the app
// does (app/src-tauri/src/supervisor.rs, install_helper): assembled beside,
// the previous bundle renamed aside and deleted, the new one renamed in.
func installHelper(t *testing.T, dir, exe string) string {
	t.Helper()
	tmp := filepath.Join(dir, "."+HelperBundle+".new")
	_ = os.RemoveAll(tmp)
	macos := filepath.Join(tmp, "Contents", "MacOS")
	if err := os.MkdirAll(macos, 0o755); err != nil { //nolint:gosec // a test bundle
		t.Fatal(err)
	}
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>` + HelperID + `</string>
<key>CFBundleExecutable</key><string>` + BinaryName() + `</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>
`
	if err := os.WriteFile(filepath.Join(tmp, "Contents", "Info.plist"), []byte(plist), 0o644); err != nil { //nolint:gosec // a test bundle
		t.Fatal(err)
	}
	b, err := os.ReadFile(exe) //nolint:gosec // the test's own build
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(macos, BinaryName()), b, 0o755); err != nil { //nolint:gosec // a test executable
		t.Fatal(err)
	}
	dst := filepath.Join(dir, HelperBundle)
	if _, err := os.Stat(dst); err == nil {
		aside := filepath.Join(dir, "."+HelperBundle+".old")
		if err := os.Rename(dst, aside); err != nil {
			t.Fatal(err)
		}
		if err := os.RemoveAll(aside); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Rename(tmp, dst); err != nil {
		t.Fatal(err)
	}
	return HelperExe(dir)
}
