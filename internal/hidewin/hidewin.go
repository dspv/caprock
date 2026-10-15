// Package hidewin starts helper processes (git, gh, claude -p, tasklist …)
// without a console window on Windows.
//
// The daemon runs with no visible console. A console program started from a
// process like that gets a console window of its own — on Windows 10 it
// flashes up for a fraction of a second and takes the keyboard focus, so
// typing in any other window comes out ragged. The daemon polls git every few
// seconds, which made the release unusable there (user report, 2026-10-15).
// Every child the daemon starts goes through Command, CommandContext or Hide;
// TestEveryCommandIsHidden keeps it that way. On macOS and Linux they are
// exec.Command and exec.CommandContext.
package hidewin

import (
	"context"
	"os/exec"
)

// Command is exec.Command with the console window hidden on Windows.
func Command(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...) //nolint:gosec // callers pass their own fixed programs
	Hide(cmd)
	return cmd
}

// CommandContext is exec.CommandContext with the console window hidden on Windows.
func CommandContext(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...) //nolint:gosec // callers pass their own fixed programs
	Hide(cmd)
	return cmd
}
