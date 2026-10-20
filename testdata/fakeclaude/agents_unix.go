//go:build darwin || linux

package main

import (
	"os"
	"os/signal"
	"syscall"

	"golang.org/x/sys/unix"
)

// termSize is the PTY's size, 80x24 when it cannot be read.
func termSize() (cols, rows int) {
	ws, err := unix.IoctlGetWinsize(int(os.Stdout.Fd()), unix.TIOCGWINSZ)
	if err != nil || ws.Col == 0 {
		return 80, 24
	}
	return int(ws.Col), int(ws.Row)
}

// watchResize delivers a value on each SIGWINCH.
func watchResize() chan os.Signal {
	c := make(chan os.Signal, 4)
	signal.Notify(c, syscall.SIGWINCH)
	return c
}

func stopResize(c chan os.Signal) { signal.Stop(c) }
