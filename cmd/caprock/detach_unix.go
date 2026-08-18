//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// setDetached puts the child in its own session so closing the terminal does not kill it.
func setDetached(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
