//go:build !windows

package hidewin

import "os/exec"

// Hide does nothing off Windows: there is no console window to hide.
func Hide(*exec.Cmd) {}
