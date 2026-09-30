//go:build unix

package logcap

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The daemon's stderr is its log file. Past the limit the file is moved to
// .1, a new one takes its place, and the next write lands in the new file
// through the same descriptor — nothing else in the process changes.
func TestRotateMovesTheLogAsideAndKeepsWriting(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "service.log")
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	out, err := os.CreateTemp(dir, "stdout")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = out.Close() }()
	origOut, origErr := stdout, stderr
	stdout, stderr = out, f
	t.Cleanup(func() { stdout, stderr = origOut, origErr; paths = nil })
	paths = nil
	Watch(logPath)

	if _, err := f.WriteString(strings.Repeat("old line\n", 100)); err != nil {
		t.Fatal(err)
	}
	// Under the limit: untouched.
	if err := rotate(1 << 20); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(logPath + ".1"); !os.IsNotExist(err) {
		t.Fatalf("rotated below the limit: %v", err)
	}

	if err := rotate(100); err != nil {
		t.Fatal(err)
	}
	old, err := os.ReadFile(logPath + ".1")
	if err != nil || !strings.Contains(string(old), "old line") {
		t.Fatalf("previous log not kept: %v", err)
	}
	if _, err := f.WriteString("new line\n"); err != nil {
		t.Fatal(err)
	}
	cur, err := os.ReadFile(logPath)
	if err != nil || string(cur) != "new line\n" {
		t.Fatalf("new log = %q, %v; want only the line written after rotating", cur, err)
	}
}

// A stderr that is not one of the watched names — a file the user
// redirected to, another program's log — is never moved.
func TestRotateLeavesAnUnwatchedFileAlone(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "somebody-else.log")
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	_, _ = f.WriteString(strings.Repeat("x", 1000))
	origErr := stderr
	stderr = f
	t.Cleanup(func() { stderr = origErr; paths = nil })
	paths = nil
	Watch(filepath.Join(dir, "service.log"))
	if err := rotate(10); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p + ".1"); !os.IsNotExist(err) {
		t.Fatal("rotated a file it was not told to watch")
	}
}

// A log the daemon no longer writes — caprock.log after launchd took over —
// is cut to its last lines rather than left at whatever size it reached.
func TestTrimIdleKeepsTheEndOfAnAbandonedLog(t *testing.T) {
	dir := t.TempDir()
	live := filepath.Join(dir, "service.log")
	old := filepath.Join(dir, "caprock.log")
	f, err := os.Create(live)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	var b strings.Builder
	for i := 0; i < 1000; i++ {
		b.WriteString("line ")
		b.WriteString(strings.Repeat("x", 10))
		b.WriteString("\n")
	}
	b.WriteString("the last line\n")
	if err := os.WriteFile(old, []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	origErr := stderr
	stderr = f
	t.Cleanup(func() { stderr = origErr; paths = nil })
	paths = nil
	Watch(old, live)
	if err := trimIdle(1000, 100); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(old)
	if len(got) > 100 || !strings.HasSuffix(string(got), "the last line\n") || !strings.HasPrefix(string(got), "line ") {
		t.Fatalf("trimmed log = %q", got)
	}
}
