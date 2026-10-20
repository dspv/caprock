package main

import (
	"os"

	"golang.org/x/sys/windows"
)

// termSize is the console's size, 80x24 when it cannot be read.
func termSize() (cols, rows int) {
	var info windows.ConsoleScreenBufferInfo
	if err := windows.GetConsoleScreenBufferInfo(windows.Handle(os.Stdout.Fd()), &info); err != nil {
		return 80, 24
	}
	return int(info.Window.Right-info.Window.Left) + 1, int(info.Window.Bottom-info.Window.Top) + 1
}

// ConPTY sends no SIGWINCH: the frames keep the size they started with.
func watchResize() chan os.Signal { return make(chan os.Signal) }

func stopResize(chan os.Signal) {}
